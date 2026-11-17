// Takes runs one at a time: checks out the commit in one kept workspace, runs the steps, reads their test reports.
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildRegressionIssue, parseEvery, summarize } from './e2e.mjs';
import { readParams, requireJob, toParamEnv } from './jobs.mjs';
import { countTests, parseCargoOutput, parseJunit } from './reports.mjs';

const run = promisify(execFile);
// the caches of the build survive between runs, so a run takes minutes, not a fresh build every time
const KEPT_BY_CLEAN = ['target', 'node_modules', '.angular'];
const MERGE_SCRIPT = fileURLToPath(new URL('../scripts/merge-into-main.sh', import.meta.url));
// a ticket branch, e.g. fix/PTX-42-short-name, merges into main once green; other branches are only tested
const TICKET_BRANCH = /^[a-z]+\/(PTX|OPS)-(\d+)-/;
const MERGE_FAILURES = { 2: 'it does not merge without a conflict', 3: 'main kept moving while it merged', 4: 'it merged, but the GitHub mirror refused main' };
const LOG_LINES_IN_NOTE = 12;
const ACTIVE = ['queued', 'running'];

export class Runner {
  constructor({ store, config, dataDir, tracker = null, publicUrl = '' }) {
    this.store = store;
    this.config = config;
    this.dataDir = dataDir;
    this.tracker = tracker;
    this.publicUrl = publicUrl;
    this.queue = [];
    this.isBusy = false;
    this.runningPid = null;
    this.cancelledRunId = null;
    this.restartRequestFile = path.join(dataDir, 'restart-requested');
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

  async enqueue({ project: projectId, branch, sha, trigger, kind, job: jobKey, params }) {
    const project = this.requireProject(projectId);
    const resolvedBranch = branch ?? project.defaultBranch ?? 'main';
    const resolvedSha = sha || (await this.findBranchSha(project, resolvedBranch));
    if (!resolvedSha) throw Object.assign(new Error(`There is no branch "${resolvedBranch}" in ${project.name ?? project.id}.`), { status: 400 });
    const job = kind === 'job' ? requireJob(project, jobKey) : null;
    const jobParams = job ? readParams(job, params) : undefined;
    const steps = job ? [toJobStep(job, jobKey)] : buildSteps(project, resolvedBranch);
    const created = createRun(this.store.nextId(), { project: project.id, branch: resolvedBranch, sha: resolvedSha, trigger, kind, job: jobKey, params: jobParams }, steps);
    await this.store.save(created);
    this.queue.push(created.id);
    void this.startNextIfIdle();
    return created;
  }

  /** Starts a job on a commit, by default the one the project released last; the answer is its run. */
  async startJob({ project: projectId, job: jobKey, params, sha, trigger = 'api' }) {
    const project = this.requireProject(projectId);
    requireJob(project, jobKey);
    const released = this.findLastReleased(project);
    const commit = sha ?? released?.sha;
    if (!commit) throw Object.assign(new Error(`${project.name ?? project.id} has released nothing yet; give the job a commit ("sha").`), { status: 409 });
    return this.enqueue({ project: project.id, branch: project.defaultBranch ?? 'main', sha: commit, trigger, kind: 'job', job: jobKey, params });
  }

  /** Starts the jobs with an "every" that are due; the server asks every minute. The answer lists the runs it started. */
  async scheduleJobs(now = Date.now()) {
    const started = [];
    for (const project of this.config.projects) {
      for (const [key, job] of Object.entries(project.jobs ?? {}).filter(([, it]) => it.every)) {
        const created = await this.scheduleJob(project, key, job, now);
        if (created) started.push(created);
      }
    }
    return started;
  }

  // a scheduled job follows the released commit, not main: it tests the build the release installed
  async scheduleJob(project, key, job, now) {
    const runs = this.store.list().filter((it) => it.project === project.id && isRunOfJob(it, key));
    if (runs.some((it) => ACTIVE.includes(it.status))) return null;
    const released = this.findLastReleased(project);
    const last = runs.find((it) => it.trigger === 'schedule');
    if (!released || last?.sha === released.sha) return null;
    if (last && now - Date.parse(last.queuedAt) < parseEvery(job.every)) return null;
    return this.startJob({ project: project.id, job: key, sha: released.sha, trigger: 'schedule' });
  }

  findLastReleased(project) {
    return this.store.list().find((it) => it.project === project.id && it.released);
  }

  /** A waiting run leaves the queue; a running one has its step stopped. Either way it ends as cancelled. */
  async cancel(id) {
    const current = this.store.find(id);
    if (!current) throw Object.assign(new Error(`There is no run #${id}.`), { status: 404 });
    if (current.status === 'queued') {
      this.queue = this.queue.filter((it) => it !== id);
      endAsCancelled(current);
      await this.store.save(current);
      return current;
    }
    if (current.status !== 'running') throw Object.assign(new Error(`Run #${id} has ended: ${current.status}.`), { status: 409 });
    this.cancelledRunId = id;
    if (this.runningPid) killGroup(this.runningPid);
    return current;
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
      await this.store.removeOldArtifacts(this.config.keepArtifacts ?? 10);
      this.exitIfRestartRequested();
      void this.startNextIfIdle();
    }
  }

  /** The CI's own release asks for a restart; launchd starts the new code once nothing waits in the queue. */
  exitIfRestartRequested() {
    if (this.queue.length || !fs.existsSync(this.restartRequestFile)) return;
    fs.rmSync(this.restartRequestFile);
    console.log('restart requested by a release: exiting, launchd starts the new code');
    process.exit(0);
  }

  async execute(current) {
    current.status = 'running';
    current.startedAt = new Date().toISOString();
    await this.store.save(current);
    let isStopped = false;
    for (const [index, step] of current.steps.entries()) {
      // a release ships only what built and tested green
      const hasFailed = current.steps.some((it) => it.status === 'failed');
      if (isStopped || ((step.isRelease || step.isMerge) && hasFailed)) {
        step.status = 'skipped';
        step.report = null;
        continue;
      }
      if (this.cancelledRunId === current.id) {
        step.status = 'skipped';
        continue;
      }
      await this.runStep(current, index);
      if (this.cancelledRunId === current.id) step.status = 'cancelled';
      isStopped = step.status === 'failed' && step.stopOnFailure;
      if (index === 0 && step.status === 'passed') current.commit = await this.readCommit(current);
      await this.store.save(current);
    }
    const isCancelled = this.cancelledRunId === current.id;
    this.cancelledRunId = null;
    current.status = isCancelled ? 'cancelled' : current.steps.some((it) => it.status === 'failed') ? 'failed' : 'passed';
    current.released = current.steps.some((it) => it.isRelease) && current.steps.filter((it) => it.isRelease).every((it) => it.status === 'passed');
    const mergeStep = findMergeStep(current);
    // exit 4: main took the branch, only the mirror stayed behind
    current.merged = mergeStep?.status === 'passed' || mergeStep?.exitCode === 4;
    current.finishedAt = new Date().toISOString();
    current.ms = Date.parse(current.finishedAt) - Date.parse(current.startedAt);
    current.tests = sumTests(current.steps);
    current.artifacts = await this.store.listArtifacts(current.id);
    if (!isCancelled) {
      await this.noteTicketIfNotMerged(current);
      await this.reportJob(current);
    }
    // the run shows as ended only once its note and its tickets are out
    await this.store.save(current);
  }

  /**
   * The summary of a job run against the last scheduled run of the job. Only a scheduled run opens tickets: one for main per
   * test that passed on the last scheduled run and fails now; a run started by hand may test anything, on any commit.
   */
  async reportJob(current) {
    const key = current.kind === 'job' ? current.job : null;
    if (!key) return;
    const previous = this.store.list().find((it) => it.project === current.project && isRunOfJob(it, key) && it.trigger === 'schedule' && it.id < current.id && !ACTIVE.includes(it.status));
    current.summary = { ...summarize(previous, current), tickets: [] };
    if (current.trigger === 'schedule') {
      for (const regression of current.summary.regressions) {
        const ticket = await this.openRegressionTicket({ regression, previous, current, jobKey: key });
        if (ticket) current.summary.tickets.push(ticket);
      }
    }
  }

  async openRegressionTicket({ regression, previous, current, jobKey }) {
    if (!this.tracker) return null;
    try {
      const answer = await this.tracker.addIssue(buildRegressionIssue({ regression, previous, current, jobKey, publicUrl: this.publicUrl }));
      return { test: regression.name, id: answer.id, isExisting: Boolean(answer.existing) };
    } catch (error) {
      console.error(`run #${current.id}: no ticket for "${regression.name}":`, error.message);
      return null;
    }
  }

  /** A ticket branch that did not reach main tells its ticket why; a tracker that is away costs only the note. */
  async noteTicketIfNotMerged(current) {
    const ticket = findTicket(current.branch);
    if (!this.tracker || ticket?.prefix !== 'PTX' || current.status !== 'failed' || !findMergeStep(current)) return;
    try {
      await this.tracker.addNote(ticket.id, await this.describeFailure(current));
    } catch (error) {
      console.error(`run #${current.id}: no note on PTX-${ticket.id}:`, error.message);
    }
  }

  async describeFailure(current) {
    const link = `CI run #${current.id} (${current.branch} ${current.sha.slice(0, 7)}): ${this.publicUrl}/#/runs/${current.id}`;
    const mergeIndex = current.steps.findIndex((it) => it.isMerge);
    const mergeStep = current.steps[mergeIndex];
    if (mergeStep?.status !== 'failed') {
      const red = current.steps.filter((it) => it.status === 'failed').map((it) => it.name);
      return `Not merged into main: red at ${red.join(', ')}. ${link}`;
    }
    const reason = MERGE_FAILURES[mergeStep.exitCode] ?? `the merge step ended with exit ${mergeStep.exitCode}`;
    const log = await this.readLogTail(current.id, mergeIndex);
    return `Not merged into main: ${reason}. ${link}\n${log}`;
  }

  async readLogTail(runId, index) {
    const lines = (await fsp.readFile(this.store.logPath(runId, index), 'utf8')).split('\n');
    return lines.filter((it) => it.trim() && !it.startsWith('$ ') && !it.startsWith('[exit ')).slice(-LOG_LINES_IN_NOTE).join('\n');
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
      onStart: (pid) => (this.runningPid = pid),
    });
    this.runningPid = null;
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
      CI_DATA: this.dataDir,
      CI_ARTIFACTS: this.store.artifactsDir(current.id),
      ...toParamEnv(current.params),
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

function toReleaseStep(step) {
  return { ...step, isRelease: true, stopOnFailure: true };
}

function toJobStep(job, key) {
  return { name: job.name ?? key, run: job.run, report: job.report, stopOnFailure: false };
}

// runs from before jobs were the end-to-end runs of PTX-245: kind e2e
function isRunOfJob(run, key) {
  return (run.kind === 'job' && run.job === key) || (key === 'e2e' && run.kind === 'e2e');
}

function endAsCancelled(current) {
  current.status = 'cancelled';
  current.finishedAt = new Date().toISOString();
  for (const step of current.steps) if (step.status === 'waiting' || step.status === 'running') step.status = 'skipped';
}

function buildSteps(project, branch) {
  const main = project.defaultBranch ?? 'main';
  if (branch === main) return [...project.steps, ...(project.release ?? []).map(toReleaseStep)];
  // opt-in: a branch pushed before a question must not reach main unfinished
  if (project.autoMerge && findTicket(branch)) return [...project.steps, buildMergeStep(project, main)];
  return project.steps;
}

function buildMergeStep(project, main) {
  const args = [MERGE_SCRIPT, main, ...(project.mirror ? [project.mirror] : [])].map(quote).join(' ');
  return { name: `Merge into ${main}`, run: `bash ${args}`, isMerge: true, stopOnFailure: true };
}

function findTicket(branch) {
  const match = TICKET_BRANCH.exec(branch ?? '');
  return match ? { prefix: match[1], id: Number(match[2]) } : undefined;
}

function findMergeStep(current) {
  return current.steps.find((it) => it.isMerge);
}

const quote = (text) => `'${String(text).replaceAll("'", "'\\''")}'`;

function createRun(id, { project, branch, sha, trigger, kind, job, params }, steps) {
  return {
    id,
    project,
    kind: kind ?? 'build',
    ...(job ? { job, params: params ?? {} } : {}),
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
      isRelease: Boolean(it.isRelease),
      isMerge: Boolean(it.isMerge),
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
function runShell(command, { cwd, env, logFile, timeoutMs, onStart = () => {} }) {
  return new Promise((resolve) => {
    const log = fs.createWriteStream(logFile, { flags: 'a' });
    log.write(`$ ${command.replaceAll('\n', '\n  ')}\n`);
    const child = spawn('/bin/bash', ['-c', command], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    onStart(child.pid);
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
