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
      e2e: { name: 'End-to-end', every: '1h', stopOnRelease: true, run: `pwd > "$CI_ARTIFACTS/pwd.txt"; echo "$TMPDIR" > "$CI_ARTIFACTS/tmp.txt"; until [ -f ${jobGate} ]; do sleep 0.05; done` },
    },
  };
  const dataDir = path.join(root, 'data');
  const store = new Store(dataDir, 50);
  await store.init();
  const exits = [];
  const runner = new Runner({ store, config: { projects: [project] }, dataDir, exit: () => exits.push(Date.now()) });
  const sha = git('rev-parse', 'HEAD').toString().trim();
  const commit = (text) => {
    fs.writeFileSync(path.join(repo, 'file.txt'), `${text}\n`);
    git('commit', '-q', '-am', text);
  };
  return { store, runner, sha, dataDir, exits, commit, openJobGate: () => fs.writeFileSync(jobGate, '') };
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

test('a release of the project first stops its running e2e job, which shows why', async () => {
  const setup = await createSetup();
  const job = await setup.runner.startJob({ project: 'demo', job: 'e2e', sha: setup.sha });
  await waitFor(setup.store, job.id, ['running']);
  const release = await setup.runner.enqueue({ branch: 'main' });
  const released = await waitFor(setup.store, release.id, FINISHED);
  assert.equal(released.released, true);
  const stopped = await waitFor(setup.store, job.id, FINISHED);
  assert.equal(stopped.status, 'cancelled');
  assert.equal(stopped.cancelReason, `Run #${release.id} released a new build of demo while it ran.`);
  assert.ok(Date.parse(stopped.finishedAt) <= Date.parse(released.steps.at(-1).startedAt) + 100);
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

test('the schedule tests a new release at once when the release stopped the last scheduled run', async () => {
  const setup = await createSetup();
  await waitFor(setup.store, (await setup.runner.enqueue({ branch: 'main' })).id, FINISHED);
  const [stopped] = await setup.runner.scheduleJobs();
  await waitFor(setup.store, stopped.id, ['running']);
  setup.commit('two');
  const release = await waitFor(setup.store, (await setup.runner.enqueue({ branch: 'main' })).id, FINISHED);
  assert.equal((await waitFor(setup.store, stopped.id, FINISHED)).status, 'cancelled');
  const [next] = await setup.runner.scheduleJobs();
  assert.equal(next.sha, release.sha);
  setup.openJobGate();
  await waitFor(setup.store, next.id, FINISHED);
});
