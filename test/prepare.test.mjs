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

/** A project whose e2e job seeds first; the seed counts its runs in a file, and fails while the test says so. */
async function createSetup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opsbuf-ci-prepare-'));
  const repo = path.join(root, 'repo');
  const seeds = path.join(root, 'seeds.txt');
  const failFlag = path.join(root, 'fail-seed');
  fs.mkdirSync(path.join(repo, 'dev-env', 'seed'), { recursive: true });
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
        prepare: { name: 'dev-env seed', inputs: ['dev-env/seed', 'dev-env/seed.sh'], run: `[ ! -f ${failFlag} ] && echo seeded >> ${seeds}` },
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
    countSeeds: () => (fs.existsSync(seeds) ? fs.readFileSync(seeds, 'utf8').trim().split('\n').length : 0),
    setSeedFailing: (isFailing) => (isFailing ? fs.writeFileSync(failFlag, '') : fs.rmSync(failFlag, { force: true })),
    runJob: async (sha) => waitFor(store, (await runner.startJob({ project: 'demo', job: 'e2e', sha })).id),
  };
}

async function waitFor(store, id) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (FINISHED.includes(store.find(id).status)) return store.find(id);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Run #${id} did not end.`);
}

const readPrepareLog = (store, run) => fs.readFileSync(store.logPath(run.id, 1), 'utf8');
const stepStatuses = (run) => run.steps.map((it) => [it.name, it.status]);

test('a job seeds before its step the first time, then skips the seed while the seed inputs stay the same', async () => {
  const setup = await createSetup();
  const first = await setup.runJob(setup.firstSha);
  assert.deepEqual(stepStatuses(first), [['Checkout', 'passed'], ['dev-env seed', 'passed'], ['End-to-end', 'passed']]);
  assert.match(readPrepareLog(setup.store, first), /^dev-env seed runs: it has not run yet \([0-9a-f]{12}\)\./);
  assert.equal(setup.countSeeds(), 1);

  const second = await setup.runJob(setup.firstSha);
  assert.deepEqual(stepStatuses(second), [['Checkout', 'passed'], ['dev-env seed', 'skipped'], ['End-to-end', 'passed']]);
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
  assert.equal(unrelated.steps[1].status, 'skipped');
  assert.equal(setup.countSeeds(), 2);
});

test('a failed seed stops the job and stores no stamp, so the next run seeds again', async () => {
  const setup = await createSetup();
  setup.setSeedFailing(true);
  const failed = await setup.runJob(setup.firstSha);
  assert.equal(failed.status, 'failed');
  assert.deepEqual(stepStatuses(failed), [['Checkout', 'passed'], ['dev-env seed', 'failed'], ['End-to-end', 'skipped']]);

  setup.setSeedFailing(false);
  const retried = await setup.runJob(setup.firstSha);
  assert.equal(retried.steps[1].status, 'passed');
  assert.equal(setup.countSeeds(), 1);
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
