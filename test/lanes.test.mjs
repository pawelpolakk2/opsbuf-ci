import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { Runner } from '../lib/runner.mjs';

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@t' };
const FINISHED = ['passed', 'failed', 'cancelled', 'interrupted'];

/** A project whose build waits for a file when asked to, and whose e2e job waits until the test lets it go. */
async function createSetup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opsbuf-ci-lanes-'));
  const repo = path.join(root, 'repo');
  const jobGate = path.join(root, 'job-gate');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, env: GIT_ENV });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'file.txt'), 'one\n');
  git('add', '.');
  git('commit', '-q', '-m', 'one');
  git('branch', 'other');
  const project = {
    id: 'demo',
    repo,
    steps: [{ name: 'Tests', run: 'sleep 0.3' }],
    release: [{ name: 'Release', run: 'true' }],
    jobs: {
      e2e: { name: 'End-to-end', every: '1h', run: `pwd > "$CI_ARTIFACTS/pwd.txt"; echo "$TMPDIR" > "$CI_ARTIFACTS/tmp.txt"; until [ -f ${jobGate} ] || [ $SECONDS -gt 20 ]; do sleep 0.05; done` },
    },
  };
  const dataDir = path.join(root, 'data');
  const store = new Store(dataDir, 50);
  await store.init();
  const exits = [];
  const runner = new Runner({ store, config: { projects: [project] }, dataDir, exit: () => exits.push(Date.now()) });
  const sha = git('rev-parse', 'HEAD').toString().trim();
  return { store, runner, sha, dataDir, exits, openJobGate: () => fs.writeFileSync(jobGate, '') };
}

async function waitFor(store, id, statuses) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (statuses.includes(store.find(id).status)) return store.find(id);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Run #${id} stayed ${store.find(id).status}.`);
}

const readArtifact = (store, run, name) => fs.readFileSync(path.join(store.artifactsDir(run.id), name), 'utf8').trim();

test('a build runs and ends while a job runs next to it', async () => {
  const setup = await createSetup();
  const job = await setup.runner.startJob({ project: 'demo', job: 'e2e', sha: setup.sha });
  await waitFor(setup.store, job.id, ['running']);
  const build = await setup.runner.enqueue({ branch: 'other' });
  assert.equal((await waitFor(setup.store, build.id, FINISHED)).status, 'passed');
  assert.equal(setup.store.find(job.id).status, 'running');
  // the lane lets go of a run once its TMPDIR is gone, a moment after the run shows as ended
  for (let attempt = 0; attempt < 40 && setup.runner.describeLanes().build.running; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(setup.runner.describeLanes(), { build: { running: null, queued: [] }, job: { running: job.id, queued: [] } });
  setup.openJobGate();
  assert.equal((await waitFor(setup.store, job.id, FINISHED)).status, 'passed');
});

test('a job checks out in its own workspace and gets a TMPDIR of its own, gone when it ends', async () => {
  const setup = await createSetup();
  setup.openJobGate();
  const job = await waitFor(setup.store, (await setup.runner.startJob({ project: 'demo', job: 'e2e', sha: setup.sha })).id, FINISHED);
  assert.equal(job.lane, 'job');
  assert.equal(fs.realpathSync(readArtifact(setup.store, job, 'pwd.txt')), fs.realpathSync(path.join(setup.dataDir, 'workspaces', 'demo-jobs')));
  const tmpDir = readArtifact(setup.store, job, 'tmp.txt');
  assert.match(path.basename(tmpDir), new RegExp(`^opsbuf-ci-run-${job.id}-`));
  for (let attempt = 0; attempt < 40 && fs.existsSync(tmpDir); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fs.existsSync(tmpDir), false);
});

test('two jobs queue in the job lane while a build passes them', async () => {
  const setup = await createSetup();
  const first = await setup.runner.startJob({ project: 'demo', job: 'e2e', sha: setup.sha });
  const second = await setup.runner.startJob({ project: 'demo', job: 'e2e', sha: setup.sha });
  await waitFor(setup.store, first.id, ['running']);
  const build = await setup.runner.enqueue({ branch: 'other' });
  await waitFor(setup.store, build.id, FINISHED);
  assert.equal(setup.store.find(second.id).status, 'queued');
  setup.openJobGate();
  await waitFor(setup.store, second.id, FINISHED);
  assert.ok(Date.parse(setup.store.find(second.id).startedAt) >= Date.parse(setup.store.find(first.id).finishedAt));
});

test('two builds keep their order', async () => {
  const setup = await createSetup();
  const first = await setup.runner.enqueue({ branch: 'other' });
  const second = await setup.runner.enqueue({ branch: 'other', trigger: 'manual' });
  assert.equal(setup.store.find(second.id).status, 'queued');
  await waitFor(setup.store, second.id, FINISHED);
  assert.ok(Date.parse(setup.store.find(second.id).startedAt) >= Date.parse(setup.store.find(first.id).finishedAt));
});

test('a release of the project runs to its end while a job of the project keeps running', async () => {
  const setup = await createSetup();
  const job = await setup.runner.startJob({ project: 'demo', job: 'e2e', sha: setup.sha });
  await waitFor(setup.store, job.id, ['running']);
  const release = await waitFor(setup.store, (await setup.runner.enqueue({ branch: 'main' })).id, FINISHED);
  assert.equal(release.released, true);
  assert.equal(setup.store.find(job.id).status, 'running');
  setup.openJobGate();
  assert.equal((await waitFor(setup.store, job.id, FINISHED)).status, 'passed');
});

test('a scheduled run that was cancelled does not count, so the schedule starts the job again', async () => {
  const setup = await createSetup();
  const release = await waitFor(setup.store, (await setup.runner.enqueue({ branch: 'main' })).id, FINISHED);
  const [cancelled] = await setup.runner.scheduleJobs();
  await waitFor(setup.store, cancelled.id, ['running']);
  await setup.runner.cancel(cancelled.id, 'The CI restarted on its new code.');
  await waitFor(setup.store, cancelled.id, FINISHED);
  const [next] = await setup.runner.scheduleJobs();
  assert.equal(next.sha, release.sha);
  setup.openJobGate();
  await waitFor(setup.store, next.id, FINISHED);
});

test('a restart waits for the builds, then cancels the jobs, so none stays running', async () => {
  const setup = await createSetup();
  const running = await setup.runner.startJob({ project: 'demo', job: 'e2e', sha: setup.sha });
  const waiting = await setup.runner.startJob({ project: 'demo', job: 'e2e', sha: setup.sha });
  await waitFor(setup.store, running.id, ['running']);
  fs.writeFileSync(path.join(setup.dataDir, 'restart-requested'), '');
  const build = await setup.runner.enqueue({ branch: 'other' });
  await waitFor(setup.store, build.id, FINISHED);
  for (const id of [running.id, waiting.id]) {
    const cancelled = await waitFor(setup.store, id, FINISHED);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.cancelReason, 'The CI restarted on its new code.');
  }
  for (let attempt = 0; attempt < 40 && !setup.exits.length; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(setup.exits.length, 1);
  assert.equal(fs.existsSync(path.join(setup.dataDir, 'restart-requested')), false);
});

test('a run gets its TMPDIR under the tmpRoot of the config, so socket paths stay short', async () => {
  const setup = await createSetup();
  const tmpRoot = path.join(setup.dataDir, 'short-tmp');
  setup.runner.tmpRoot = tmpRoot;
  setup.openJobGate();
  const job = await waitFor(setup.store, (await setup.runner.startJob({ project: 'demo', job: 'e2e', sha: setup.sha })).id, FINISHED);
  assert.equal(path.dirname(readArtifact(setup.store, job, 'tmp.txt')), tmpRoot);
});

test('a step whose process still writes to its TMPDIR after it ended does not stop the lane', async () => {
  const setup = await createSetup();
  setup.runner.config.projects[0].jobs.late = { name: 'Late', run: 'end=$((SECONDS + 2)); (while [ $SECONDS -lt $end ]; do mkdir -p "$TMPDIR/late/$RANDOM" 2>/dev/null; done) >/dev/null 2>&1 & sleep 0.2' };
  const late = await setup.runner.startJob({ project: 'demo', job: 'late', sha: setup.sha });
  const next = await setup.runner.startJob({ project: 'demo', job: 'late', sha: setup.sha });
  assert.equal((await waitFor(setup.store, late.id, FINISHED)).status, 'passed');
  assert.equal((await waitFor(setup.store, next.id, FINISHED)).status, 'passed');
});

test('removes the run folders a crash left in the temp folder, and nothing else', async () => {
  const setup = await createSetup();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opsbuf-ci-sweep-'));
  fs.mkdirSync(path.join(root, 'opsbuf-ci-run-224-abc', 'opsbuf-release'), { recursive: true });
  fs.writeFileSync(path.join(root, 'opsbuf-ci-run-224-abc', 'opsbuf-release', 'file'), 'x');
  fs.mkdirSync(path.join(root, 'someone-else'));
  await setup.runner.removeLeftoverTmpDirs(root);
  assert.deepEqual(fs.readdirSync(root), ['someone-else']);
});

test('a process a run left running is stopped when the run ends, also one outside its process group', async () => {
  const setup = await createSetup();
  setup.runner.config.projects[0].jobs.leaky = { name: 'Leaky', run: `echo "$TMPDIR" > "$CI_ARTIFACTS/tmp.txt"; (perl -MPOSIX -e 'setsid(); sleep 60' "$TMPDIR/leftover" >/dev/null 2>&1 &); sleep 0.2` };
  const leaky = await waitFor(setup.store, (await setup.runner.startJob({ project: 'demo', job: 'leaky', sha: setup.sha })).id, FINISHED);
  assert.equal(leaky.status, 'passed');
  const tmpName = path.basename(readArtifact(setup.store, leaky, 'tmp.txt'));
  for (let attempt = 0; attempt < 60 && hasProcess(tmpName); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(hasProcess(tmpName), false);
});

function hasProcess(pattern) {
  try {
    execFileSync('pgrep', ['-f', pattern]);
    return true;
  } catch {
    return false;
  }
}
