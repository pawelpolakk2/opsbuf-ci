// Takes runs one at a time: checks out the commit in one kept workspace, runs the steps, reads their test reports.
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { countTests, parseCargoOutput, parseJunit } from './reports.mjs';

const run = promisify(execFile);
// the caches of the build survive between runs, so a run takes minutes, not a fresh build every time
const KEPT_BY_CLEAN = ['target', 'node_modules', '.angular'];

export class Runner {
  constructor({ store, config, dataDir }) {
    this.store = store;
    this.config = config;
    this.dataDir = dataDir;
    this.queue = [];
    this.isBusy = false;
  }

  requireProject(id) {
    const project = this.config.projects.find((it) => it.id === (id ?? this.config.projects[0].id));
    if (!project) throw Object.assign(new Error(`There is no project "${id}". Projects: ${this.config.projects.map((it) => it.id).join(', ')}.`), { status: 400 });
    return project;
  }

  workspaceOf(project) {
    return path.join(this.dataDir, 'workspaces', project.id);
  }

  /** Runs from before projects existed belong to the first project. */
  async assignProjectToOldRuns() {
    for (const it of this.store.list()) {
      if (it.project) continue;
      it.project = this.config.projects[0].id;
      await this.store.save(it);
    }
  }

  async markInterruptedRuns() {
    for (const it of this.store.list()) {
      if (it.status !== 'running' && it.status !== 'queued') continue;
      it.status = 'interrupted';
      it.finishedAt ??= new Date().toISOString();
      for (const step of it.steps) if (step.status === 'running' || step.status === 'waiting') step.status = 'skipped';
      await this.store.save(it);
    }
  }

  async enqueue({ project: projectId, branch, sha, trigger }) {
    const project = this.requireProject(projectId);
    const resolvedBranch = branch ?? project.defaultBranch ?? 'main';
    const resolvedSha = sha || (await this.findBranchSha(project, resolvedBranch));
    if (!resolvedSha) throw Object.assign(new Error(`There is no branch "${resolvedBranch}" in ${project.name ?? project.id}.`), { status: 400 });
    const created = createRun(this.store.nextId(), { project: project.id, branch: resolvedBranch, sha: resolvedSha, trigger }, project.steps);
    await this.store.save(created);
    this.queue.push(created.id);
    void this.startNextIfIdle();
    return created;
  }

  async listBranches(projectId) {
    const { stdout } = await run('git', ['ls-remote', '--heads', this.requireProject(projectId).repo]);
    return stdout.split('\n').filter(Boolean).map((line) => line.split('\trefs/heads/')[1]);
  }

  async findBranchSha(project, branch) {
    const { stdout } = await run('git', ['ls-remote', project.repo, `refs/heads/${branch}`]);
    return stdout.split('\t')[0] || null;
  }

  async startNextIfIdle() {
    if (this.isBusy || !this.queue.length) return;
    this.isBusy = true;
    const current = this.store.find(this.queue.shift());
    try {
      await this.execute(current);
    } catch (error) {
      await this.failOnError(current, error);
    } finally {
      this.isBusy = false;
      await this.store.removeOldRuns();
      void this.startNextIfIdle();
    }
  }

  async execute(current) {
    current.status = 'running';
    current.startedAt = new Date().toISOString();
    await this.store.save(current);
    let isStopped = false;
    for (const [index, step] of current.steps.entries()) {
      if (isStopped) {
        step.status = 'skipped';
        step.report = null;
        continue;
      }
      await this.runStep(current, index);
      isStopped = step.status === 'failed' && step.stopOnFailure;
      if (index === 0 && step.status === 'passed') current.commit = await this.readCommit(current);
      await this.store.save(current);
    }
    current.status = current.steps.some((it) => it.status === 'failed') ? 'failed' : 'passed';
    current.finishedAt = new Date().toISOString();
    current.ms = Date.parse(current.finishedAt) - Date.parse(current.startedAt);
    current.tests = sumTests(current.steps);
    await this.store.save(current);
  }

  /** A bug in the CI ends the run as failed with the reason; it never takes the server down. */
  async failOnError(current, error) {
    console.error(`run #${current.id}:`, error);
    current.status = 'failed';
    current.error = error.message;
    current.finishedAt = new Date().toISOString();
    for (const step of current.steps) if (step.status === 'running' || step.status === 'waiting') step.status = 'skipped';
    await this.store.save(current);
  }

  async runStep(current, index) {
    const step = current.steps[index];
    step.status = 'running';
    step.startedAt = new Date().toISOString();
    await this.store.save(current);
    const project = this.requireProject(current.project);
    const workspace = this.workspaceOf(project);
    await fsp.mkdir(path.dirname(workspace), { recursive: true });
    const logFile = this.store.logPath(current.id, index);
    const command = index === 0 ? this.checkoutCommand(project, current.sha) : step.run;
    const exitCode = await runShell(command, {
      cwd: index === 0 ? path.dirname(workspace) : workspace,
      env: this.buildEnv(project, current),
      logFile,
      timeoutMs: (this.config.stepTimeoutSec ?? 1800) * 1000,
    });
    step.exitCode = exitCode;
    step.ms = Date.now() - Date.parse(step.startedAt);
    step.status = exitCode === 0 ? 'passed' : 'failed';
    step.report = await this.readReport(current, index);
  }

  checkoutCommand(project, sha) {
    const workspace = JSON.stringify(this.workspaceOf(project));
    const repo = JSON.stringify(project.repo);
    const kept = [...KEPT_BY_CLEAN, ...(project.keep ?? [])].map((it) => `-e ${it}`).join(' ');
    return [
      `set -e`,
      `[ -d ${workspace}/.git ] || git clone --no-checkout ${repo} ${workspace}`,
      `cd ${workspace}`,
      `git remote set-url origin ${repo}`,
      `git fetch --prune origin '+refs/heads/*:refs/remotes/origin/*'`,
      `git checkout -f --detach ${sha}`,
      `git clean -ffdx ${kept}`,
      `git log -1 --format='%h %s (%an)'`,
    ].join('\n');
  }

  buildEnv(project, current) {
    return {
      ...process.env,
      ...this.config.env,
      ...project.env,
      CI_PROJECT: project.id,
      CI: 'true',
      CI_RUN: String(current.id),
      CI_SHA: current.sha,
      CI_BRANCH: current.branch ?? '',
      CI_REPORTS: this.store.reportsDir(current.id),
    };
  }

  async readCommit(current) {
    const workspace = this.workspaceOf(this.requireProject(current.project));
    const { stdout } = await run('git', ['log', '-1', '--format=%s%x00%an%x00%cI', current.sha], { cwd: workspace });
    const [subject, author, date] = stdout.trim().split('\0');
    return { subject, author, date };
  }

  async readReport(current, index) {
    const step = current.steps[index];
    if (!step.report) return null;
    const places = { logFile: this.store.logPath(current.id, index), reportsDir: this.store.reportsDir(current.id), workspace: this.workspaceOf(this.requireProject(current.project)) };
    const suites = await readSuites(step.report, places);
    return { ...step.report, title: step.report.title ?? step.name, counts: countTests(suites), suites };
  }
}

function createRun(id, { project, branch, sha, trigger }, steps) {
  return {
    id,
    project,
    branch: branch ?? null,
    sha,
    trigger: trigger ?? 'manual',
    status: 'queued',
    queuedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    ms: null,
    commit: null,
    tests: null,
    steps: [{ name: 'Checkout', stopOnFailure: true, report: null }, ...steps].map((it) => ({
      name: it.name,
      run: it.run ?? null,
      stopOnFailure: Boolean(it.stopOnFailure),
      report: it.report ?? null,
      status: 'waiting',
      startedAt: null,
      ms: null,
      exitCode: null,
    })),
  };
}

async function readSuites(report, { logFile, reportsDir, workspace }) {
  try {
    if (report.type === 'cargo') return parseCargoOutput(await fsp.readFile(logFile, 'utf8'));
    if (report.type === 'junit' && report.file) return parseJunit(await fsp.readFile(path.join(reportsDir, report.file), 'utf8'));
    if (report.type === 'junit' && report.dir) return await readJunitFolder(path.join(workspace, report.dir));
  } catch {
    // a step that died before its report leaves only its log
  }
  return [];
}

/** Gradle writes one JUnit file per test class into a folder. */
async function readJunitFolder(folder) {
  const suites = [];
  for (const name of (await fsp.readdir(folder)).filter((it) => it.endsWith('.xml')).sort()) {
    suites.push(...parseJunit(await fsp.readFile(path.join(folder, name), 'utf8')));
  }
  return suites;
}

function sumTests(steps) {
  const sum = { passed: 0, failed: 0, skipped: 0, total: 0 };
  for (const step of steps) {
    if (!step.report?.counts) continue;
    for (const key of Object.keys(sum)) sum[key] += step.report.counts[key];
  }
  return sum;
}

/** Runs one shell command with its output in the log file; the exit code, or 124 after the timeout. */
function runShell(command, { cwd, env, logFile, timeoutMs }) {
  return new Promise((resolve) => {
    const log = fs.createWriteStream(logFile, { flags: 'a' });
    log.write(`$ ${command.replaceAll('\n', '\n  ')}\n`);
    const child = spawn('/bin/bash', ['-c', command], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    const timer = setTimeout(() => {
      log.write(`\n… stopped after ${timeoutMs / 1000} s\n`);
      killGroup(child.pid);
    }, timeoutMs);
    const finish = (code) => {
      clearTimeout(timer);
      log.end(`\n[exit ${code}]\n`, () => resolve(code));
    };
    child.on('error', (error) => {
      log.write(`${error.message}\n`);
      finish(127);
    });
    child.on('close', (code, signal) => finish(code ?? (signal ? 124 : 1)));
  });
}

function killGroup(pid) {
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    // already gone
  }
}
