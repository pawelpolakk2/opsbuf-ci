// Runs live as folders, data/runs/<id>/: run.json, one log per step, and the reports the steps wrote.
import fs from 'node:fs/promises';
import path from 'node:path';

export class Store {
  constructor(dataDir, keepRuns) {
    this.runsDir = path.join(dataDir, 'runs');
    this.keepRuns = keepRuns;
    this.runs = new Map();
  }

  async init() {
    await fs.mkdir(this.runsDir, { recursive: true });
    for (const name of await fs.readdir(this.runsDir)) {
      const run = await readRun(path.join(this.runsDir, name, 'run.json'));
      if (run) this.runs.set(run.id, run);
    }
  }

  nextId() {
    return Math.max(0, ...this.runs.keys()) + 1;
  }

  list() {
    return [...this.runs.values()].sort((a, b) => b.id - a.id);
  }

  find(id) {
    return this.runs.get(id);
  }

  runDir(id) {
    return path.join(this.runsDir, String(id));
  }

  logPath(id, stepIndex) {
    return path.join(this.runDir(id), `step-${stepIndex}.log`);
  }

  reportsDir(id) {
    return path.join(this.runDir(id), 'reports');
  }

  artifactsDir(id) {
    return path.join(this.runDir(id), 'artifacts');
  }

  async listArtifacts(id) {
    const names = await fs.readdir(this.artifactsDir(id)).catch(() => []);
    const artifacts = [];
    for (const name of names.sort()) {
      const stat = await fs.stat(path.join(this.artifactsDir(id), name));
      if (stat.isFile()) artifacts.push({ name, bytes: stat.size });
    }
    return artifacts;
  }

  async save(run) {
    this.runs.set(run.id, run);
    await fs.mkdir(this.reportsDir(run.id), { recursive: true });
    await fs.mkdir(this.artifactsDir(run.id), { recursive: true });
    const file = path.join(this.runDir(run.id), 'run.json');
    await fs.writeFile(`${file}.new`, JSON.stringify(run, null, 1));
    await fs.rename(`${file}.new`, file);
  }

  /** Builds are big, so only the newest runs with files keep them; the run itself stays. */
  async removeOldArtifacts(keepArtifacts) {
    for (const run of this.list().filter((it) => it.artifacts?.length).slice(keepArtifacts)) {
      await fs.rm(this.artifactsDir(run.id), { recursive: true, force: true });
      run.artifacts = [];
      run.artifactsRemoved = true;
      await this.save(run);
    }
  }

  async removeOldRuns() {
    for (const run of this.list().slice(this.keepRuns)) {
      if (run.status === 'running' || run.status === 'queued') continue;
      this.runs.delete(run.id);
      await fs.rm(this.runDir(run.id), { recursive: true, force: true });
    }
  }
}

async function readRun(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}
