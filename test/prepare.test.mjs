import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hashInputs } from '../lib/stamps.mjs';
import { Store } from '../lib/store.mjs';
import { Runner } from '../lib/runner.mjs';

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@t' };
const FINISHED = ['passed', 'failed', 'cancelled', 'interrupted'];

/**
 * A project whose e2e job applies the dev-env manifests, then seeds the logs and Redis; each counts its runs in a file,
 * and fails while the test says so.
 */
async function createSetup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opsbuf-ci-prepare-'));
  const repo = path.join(root, 'repo');
  const seeds = path.join(root, 'seeds.txt');
  const applies = path.join(root, 'applies.txt');
  const failFlag = path.join(root, 'fail-seed');
  const applyFailFlag = path.join(root, 'fail-apply');
  const redisSeeds = path.join(root, 'redis-seeds.txt');
  const redisFailFlag = path.join(root, 'fail-redis-seed');
  fs.mkdirSync(path.join(repo, 'dev-env', 'seed'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'dev-env', 'k8s'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'dev-env', 'redis'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'dev-env', 'redis', 'seed.sh'), 'SET feature:new-checkout on\n');
  fs.writeFileSync(path.join(repo, 'dev-env', 'k8s', 'redis.yaml'), 'kind: ConfigMap\n');
  const git = (...args) => execFileSync('git', args, { cwd: repo, env: GIT_ENV }).toString().trim();
  git('init', '-q', '-b', 'main');
  const commit = (file, text) => {
    fs.writeFileSync(path.join(repo, file), text);
    git('add', '.');
    git('commit', '-q', '-m', `change ${file}`);
    return git('rev-parse', 'HEAD');
  };
  const firstSha = commit('dev-env/seed/seed-logs.ts', 'one\n');
  const project = {
    id: 'demo',
    repo,
    steps: [{ name: 'Tests', run: 'true' }],
    jobs: {
      e2e: {
        name: 'End-to-end',
        run: 'true',
        prepare: [
          {
            name: 'dev-env manifests',
            inputs: ['dev-env/k8s'],
            run: `if [ -f ${applyFailFlag} ]; then echo 'error: unable to recognize "k8s/redis.yaml": no matches for kind "CronJobb"' >&2; exit 1; fi; echo 'cronjob.batch/redis-heal configured'; echo applied >> ${applies}`,
          },
          { name: 'dev-env seed', inputs: ['dev-env/seed', 'dev-env/seed.sh'], run: `[ ! -f ${failFlag} ] && echo seeded >> ${seeds}` },
          {
            name: 'dev-env redis seed',
            inputs: ['dev-env/redis'],
            run: `echo 'started job redis/redis-seed-1'; if [ -f ${redisFailFlag} ]; then echo 'The cluster is not whole; pnpm dev-env:up builds it again'; echo 'The job redis/redis-seed-1 failed; its log is above.' >&2; exit 1; fi; echo 'Seeded: 1363 keys on the first master'; echo seeded >> ${redisSeeds}`,
          },
        ],
      },
    },
  };
  const store = new Store(path.join(root, 'data'), 50);
  await store.init();
  const runner = new Runner({ store, config: { projects: [project] }, dataDir: path.join(root, 'data') });
  return {
    store,
    firstSha,
    commit,
    countSeeds: () => countLines(seeds),
    countApplies: () => countLines(applies),
    countRedisSeeds: () => countLines(redisSeeds),
    setSeedFailing: (isFailing) => toggleFlag(failFlag, isFailing),
    setApplyFailing: (isFailing) => toggleFlag(applyFailFlag, isFailing),
    setRedisSeedFailing: (isFailing) => toggleFlag(redisFailFlag, isFailing),
    runJob: async (sha) => waitFor(store, (await runner.startJob({ project: 'demo', job: 'e2e', sha })).id),
  };
}

const countLines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').length : 0);
const toggleFlag = (file, isOn) => (isOn ? fs.writeFileSync(file, '') : fs.rmSync(file, { force: true }));

async function waitFor(store, id) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (FINISHED.includes(store.find(id).status)) return store.find(id);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Run #${id} did not end.`);
}

const readStepLog = (store, run, name) => fs.readFileSync(store.logPath(run.id, run.steps.findIndex((it) => it.name === name)), 'utf8');
const readPrepareLog = (store, run) => readStepLog(store, run, 'dev-env seed');
const stepStatuses = (run) => run.steps.map((it) => [it.name, it.status]);

test('a job seeds before its step the first time, then skips the seed while the seed inputs stay the same', async () => {
  const setup = await createSetup();
  const first = await setup.runJob(setup.firstSha);
  assert.deepEqual(stepStatuses(first), [['Checkout', 'passed'], ['dev-env manifests', 'passed'], ['dev-env seed', 'passed'], ['dev-env redis seed', 'passed'], ['End-to-end', 'passed']]);
  assert.match(readPrepareLog(setup.store, first), /^dev-env seed runs: it has not run yet \([0-9a-f]{12}\)\./);
  assert.equal(setup.countSeeds(), 1);

  const second = await setup.runJob(setup.firstSha);
  assert.deepEqual(stepStatuses(second), [['Checkout', 'passed'], ['dev-env manifests', 'skipped'], ['dev-env seed', 'skipped'], ['dev-env redis seed', 'skipped'], ['End-to-end', 'passed']]);
  assert.match(readPrepareLog(setup.store, second), /^dev-env seed is up to date: its inputs \(dev-env\/seed, dev-env\/seed\.sh\) have the hash [0-9a-f]{12}/);
  assert.equal(setup.countSeeds(), 1);
});

test('a new seed seeds once; a change outside the seed inputs seeds nothing', async () => {
  const setup = await createSetup();
  await setup.runJob(setup.firstSha);
  const newSeed = setup.commit('dev-env/seed/seed-logs.ts', 'two: with NOTICE lines\n');
  const reseeded = await setup.runJob(newSeed);
  assert.match(readPrepareLog(setup.store, reseeded), /^dev-env seed runs: its inputs changed \([0-9a-f]{12} -> [0-9a-f]{12}\)\./);
  assert.equal(setup.countSeeds(), 2);

  await setup.runJob(newSeed);
  const otherChange = setup.commit('README.md', 'docs\n');
  const unrelated = await setup.runJob(otherChange);
  assert.equal(unrelated.steps[2].status, 'skipped');
  assert.equal(setup.countSeeds(), 2);
});

test('a failed seed stops the job and stores no stamp, so the next run seeds again', async () => {
  const setup = await createSetup();
  setup.setSeedFailing(true);
  const failed = await setup.runJob(setup.firstSha);
  assert.equal(failed.status, 'failed');
  assert.deepEqual(stepStatuses(failed), [['Checkout', 'passed'], ['dev-env manifests', 'passed'], ['dev-env seed', 'failed'], ['dev-env redis seed', 'skipped'], ['End-to-end', 'skipped']]);

  setup.setSeedFailing(false);
  const retried = await setup.runJob(setup.firstSha);
  assert.equal(retried.steps[2].status, 'passed');
  assert.equal(setup.countSeeds(), 1);
});

test('changed manifests apply once, before the seed, and the log names what changed', async () => {
  const setup = await createSetup();
  await setup.runJob(setup.firstSha);
  const newManifests = setup.commit('dev-env/k8s/redis.yaml', 'kind: CronJob\n');
  const applied = await setup.runJob(newManifests);
  assert.deepEqual(stepStatuses(applied), [['Checkout', 'passed'], ['dev-env manifests', 'passed'], ['dev-env seed', 'skipped'], ['dev-env redis seed', 'skipped'], ['End-to-end', 'passed']]);
  assert.match(readStepLog(setup.store, applied, 'dev-env manifests'), /^dev-env manifests runs: its inputs changed[^\n]*\n[\s\S]*cronjob\.batch\/redis-heal configured/);
  assert.equal(setup.countApplies(), 2);

  const again = await setup.runJob(newManifests);
  assert.equal(again.steps[1].status, 'skipped');
  assert.equal(setup.countApplies(), 2);
});

test('a failed apply fails the job with its output; the seed and the suite do not run', async () => {
  const setup = await createSetup();
  setup.setApplyFailing(true);
  const failed = await setup.runJob(setup.firstSha);
  assert.equal(failed.status, 'failed');
  assert.deepEqual(stepStatuses(failed), [['Checkout', 'passed'], ['dev-env manifests', 'failed'], ['dev-env seed', 'skipped'], ['dev-env redis seed', 'skipped'], ['End-to-end', 'skipped']]);
  assert.match(readStepLog(setup.store, failed, 'dev-env manifests'), /error: unable to recognize "k8s\/redis\.yaml": no matches for kind "CronJobb"/);
  assert.equal(setup.countSeeds(), 0);

  setup.setApplyFailing(false);
  const retried = await setup.runJob(setup.firstSha);
  assert.equal(retried.steps[1].status, 'passed');
  assert.equal(setup.countApplies(), 1);
});

test('a new Redis seed seeds Redis once and leaves the logs seed skipped', async () => {
  const setup = await createSetup();
  await setup.runJob(setup.firstSha);
  const newSeed = setup.commit('dev-env/redis/seed.sh', 'PERSIST cart:7f3a9c12:c0007\n');
  const reseeded = await setup.runJob(newSeed);
  assert.deepEqual(stepStatuses(reseeded), [['Checkout', 'passed'], ['dev-env manifests', 'skipped'], ['dev-env seed', 'skipped'], ['dev-env redis seed', 'passed'], ['End-to-end', 'passed']]);
  assert.match(readStepLog(setup.store, reseeded, 'dev-env redis seed'), /^dev-env redis seed runs: its inputs changed[^\n]*\n[\s\S]*Seeded: 1363 keys/);
  assert.equal(setup.countRedisSeeds(), 2);

  const again = await setup.runJob(newSeed);
  assert.equal(again.steps[3].status, 'skipped');
  assert.match(readStepLog(setup.store, again, 'dev-env redis seed'), /^dev-env redis seed is up to date: its inputs \(dev-env\/redis\)/);
  assert.equal(setup.countRedisSeeds(), 2);
});

test('a failed Redis seed fails the job with the log of its seed job, and the next run seeds again', async () => {
  const setup = await createSetup();
  setup.setRedisSeedFailing(true);
  const failed = await setup.runJob(setup.firstSha);
  assert.equal(failed.status, 'failed');
  assert.deepEqual(stepStatuses(failed), [['Checkout', 'passed'], ['dev-env manifests', 'passed'], ['dev-env seed', 'passed'], ['dev-env redis seed', 'failed'], ['End-to-end', 'skipped']]);
  assert.match(readStepLog(setup.store, failed, 'dev-env redis seed'), /The cluster is not whole[\s\S]*The job redis\/redis-seed-1 failed; its log is above\./);

  setup.setRedisSeedFailing(false);
  const retried = await setup.runJob(setup.firstSha);
  assert.equal(retried.steps[3].status, 'passed');
  assert.equal(setup.countRedisSeeds(), 1);
});

test('opsbuf-app seeds Redis before its e2e suite when dev-env/redis changed, after the manifests', () => {
  const config = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  const prepares = config.projects.find((it) => it.id === 'opsbuf-app').jobs.e2e.prepare;
  const names = prepares.map((it) => it.name);
  const redisSeed = prepares.find((it) => it.name === 'dev-env redis seed');
  assert.deepEqual(redisSeed, { name: 'dev-env redis seed', inputs: ['dev-env/redis'], run: 'bash dev-env/redis-seed.sh' });
  assert.ok(names.indexOf('dev-env manifests') < names.indexOf('dev-env redis seed'), names.join(', '));
});

test('the hash of the inputs covers paths, contents and missing inputs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opsbuf-ci-hash-'));
  fs.mkdirSync(path.join(root, 'seed', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(root, 'seed', 'nested', 'a.ts'), 'a');
  const first = await hashInputs(root, ['seed', 'seed.sh']);
  assert.equal(await hashInputs(root, ['seed.sh', 'seed']), first);
  fs.writeFileSync(path.join(root, 'seed.sh'), '');
  assert.notEqual(await hashInputs(root, ['seed', 'seed.sh']), first);
  fs.rmSync(path.join(root, 'seed.sh'));
  fs.renameSync(path.join(root, 'seed', 'nested', 'a.ts'), path.join(root, 'seed', 'nested', 'b.ts'));
  assert.notEqual(await hashInputs(root, ['seed', 'seed.sh']), first);
});
