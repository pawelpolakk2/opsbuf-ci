import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requireToken } from '../lib/api-token.mjs';
import { listJobs, readParams, toParamEnv } from '../lib/jobs.mjs';
import { Store } from '../lib/store.mjs';
import { Runner } from '../lib/runner.mjs';

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@t' };
const FINISHED = ['passed', 'failed', 'cancelled', 'interrupted'];

/** A project with one commit, a job that writes its param to a file, and a job that waits for a file to go on. */
async function createSetup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opsbuf-ci-jobs-'));
  const repo = path.join(root, 'repo');
  const gate = path.join(root, 'gate');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, env: GIT_ENV });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'file.txt'), 'one\n');
  git('add', '.');
  git('commit', '-q', '-m', 'one');
  const project = {
    id: 'demo',
    repo,
    steps: [{ name: 'Tests', run: 'true' }],
    release: [{ name: 'Release', run: 'true' }],
    jobs: {
      echo: { name: 'Echo', params: ['tests', 'mode'], run: `printf '%s' "$CI_PARAM_TESTS" > "$CI_ARTIFACTS/tests.txt"` },
      // gives up after 20 s, so a failed test never holds the suite
      slow: { name: 'Slow', run: `until [ -f ${gate} ] || [ $SECONDS -gt 20 ]; do sleep 0.05; done` },
    },
  };
  const store = new Store(path.join(root, 'data'), 50);
  await store.init();
  const runner = new Runner({ store, config: { projects: [project] }, dataDir: path.join(root, 'data'), publicUrl: 'https://ci.local' });
  const sha = git('rev-parse', 'HEAD').toString().trim();
  return { root, store, runner, sha, openGate: () => fs.writeFileSync(gate, '') };
}

async function waitFor(store, id, statuses) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (statuses.includes(store.find(id).status)) return store.find(id);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Run #${id} stayed ${store.find(id).status}.`);
}

test('a job runs on the given commit with Checkout and its step, its params in CI_PARAM_*', async () => {
  const setup = await createSetup();
  const started = await setup.runner.startJob({ project: 'demo', job: 'echo', params: { tests: 'T-12,T-40' }, sha: setup.sha });
  const run = await waitFor(setup.store, started.id, FINISHED);
  assert.equal(run.status, 'passed');
  assert.equal(run.kind, 'job');
  assert.equal(run.job, 'echo');
  assert.equal(run.trigger, 'api');
  assert.equal(run.sha, setup.sha);
  assert.deepEqual(run.params, { tests: 'T-12,T-40' });
  assert.deepEqual(run.steps.map((it) => [it.name, it.status]), [['Checkout', 'passed'], ['Echo', 'passed']]);
  assert.equal(fs.readFileSync(path.join(setup.store.artifactsDir(run.id), 'tests.txt'), 'utf8'), 'T-12,T-40');
});

test('a job without a commit runs on the released one, and refuses to start before any release', async () => {
  const setup = await createSetup();
  await assert.rejects(setup.runner.startJob({ project: 'demo', job: 'echo' }), { status: 409, message: /has released nothing yet/ });
  const release = await waitFor(setup.store, (await setup.runner.enqueue({ branch: 'main' })).id, FINISHED);
  assert.equal(release.released, true);
  const run = await waitFor(setup.store, (await setup.runner.startJob({ project: 'demo', job: 'echo' })).id, FINISHED);
  assert.equal(run.sha, release.sha);
});

test('takes only the params a job declares, as one line of text', () => {
  const job = { params: ['tests'] };
  assert.deepEqual(readParams(job, { tests: 'T-12' }), { tests: 'T-12' });
  assert.deepEqual(readParams(job, { tests: '' }), {});
  assert.throws(() => readParams(job, { other: 'x' }), { status: 400, message: /takes no param "other"/ });
  assert.throws(() => readParams(job, { tests: 'a\nb' }), { status: 400, message: /one line of text/ });
  assert.throws(() => readParams(job, { tests: 12 }), { status: 400 });
  assert.throws(() => readParams(job, ['T-12']), { status: 400 });
  assert.deepEqual(toParamEnv({ tests: 'T-1', 'run-mode': 'fast' }), { CI_PARAM_TESTS: 'T-1', CI_PARAM_RUN_MODE: 'fast' });
});

test('an unknown job is refused, and the list names the jobs', async () => {
  const setup = await createSetup();
  await assert.rejects(setup.runner.startJob({ project: 'demo', job: 'nope', sha: setup.sha }), { status: 404, message: /has no job "nope"\. Jobs: echo, slow/ });
  assert.deepEqual(listJobs(setup.runner.requireProject('demo')).map((it) => [it.key, it.name, it.params]), [['echo', 'Echo', ['tests', 'mode']], ['slow', 'Slow', []]]);
});

test('a second start of a job waits in the queue until the first one ends', async () => {
  const setup = await createSetup();
  const first = await setup.runner.startJob({ project: 'demo', job: 'slow', sha: setup.sha });
  const second = await setup.runner.startJob({ project: 'demo', job: 'slow', sha: setup.sha });
  await waitFor(setup.store, first.id, ['running']);
  assert.equal(setup.store.find(second.id).status, 'queued');
  setup.openGate();
  assert.equal((await waitFor(setup.store, first.id, FINISHED)).status, 'passed');
  assert.equal((await waitFor(setup.store, second.id, FINISHED)).status, 'passed');
});

test('cancel takes a waiting run out of the queue and stops a running one', async () => {
  const setup = await createSetup();
  const running = await setup.runner.startJob({ project: 'demo', job: 'slow', sha: setup.sha });
  const waiting = await setup.runner.startJob({ project: 'demo', job: 'slow', sha: setup.sha });
  await waitFor(setup.store, running.id, ['running']);

  const cancelledWaiting = await setup.runner.cancel(waiting.id);
  assert.equal(cancelledWaiting.status, 'cancelled');
  assert.deepEqual(cancelledWaiting.steps.map((it) => it.status), ['skipped', 'skipped']);
  assert.equal(setup.runner.lanes.job.queue.includes(waiting.id), false);

  await waitForStep(setup.store, running.id, 'Slow', 'running');
  await setup.runner.cancel(running.id);
  const stopped = await waitFor(setup.store, running.id, FINISHED);
  assert.equal(stopped.status, 'cancelled');
  assert.deepEqual(stopped.steps.map((it) => [it.name, it.status]), [['Checkout', 'passed'], ['Slow', 'cancelled']]);
  await assert.rejects(setup.runner.cancel(running.id), { status: 409, message: /has ended: cancelled/ });
});

test('a cancel just before the step starts its process stops that process as it starts', async () => {
  const setup = await createSetup();
  const save = setup.store.save.bind(setup.store);
  let cancelled = null;
  // runStep saves the step as running before it starts the process: the cancel lands right there
  setup.store.save = async (run) => {
    if (!cancelled && run.steps.some((it) => it.name === 'Slow' && it.status === 'running')) cancelled = setup.runner.cancel(run.id);
    return save(run);
  };
  const started = Date.now();
  const run = await setup.runner.startJob({ project: 'demo', job: 'slow', sha: setup.sha });
  const stopped = await waitFor(setup.store, run.id, FINISHED);
  await cancelled;
  assert.equal(stopped.status, 'cancelled');
  assert.deepEqual(stopped.steps.map((it) => [it.name, it.status]), [['Checkout', 'passed'], ['Slow', 'cancelled']]);
  assert.ok(Date.now() - started < 5000);
});

async function waitForStep(store, id, name, status) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (store.find(id).steps.find((it) => it.name === name)?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`The step ${name} of run #${id} never got ${status}.`);
}

test('the API token: the right one passes; a wrong, missing or unconfigured one is a 401', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opsbuf-ci-token-'));
  const tokenFile = path.join(root, 'token');
  fs.writeFileSync(tokenFile, 'secret-token\n');
  await requireToken('Bearer secret-token', tokenFile);
  await assert.rejects(requireToken('Bearer wrong', tokenFile), { status: 401, message: /needs the CI token/ });
  await assert.rejects(requireToken(undefined, tokenFile), { status: 401 });
  await assert.rejects(requireToken('secret-token', tokenFile), { status: 401 });
  await assert.rejects(requireToken('Bearer secret-token', undefined), { status: 401, message: /has no token/ });
  await assert.rejects(requireToken('Bearer secret-token', path.join(root, 'missing')), { status: 401, message: /has no token/ });
  fs.writeFileSync(tokenFile, '');
  await assert.rejects(requireToken('Bearer ', tokenFile), { status: 401, message: /has no token/ });
});
