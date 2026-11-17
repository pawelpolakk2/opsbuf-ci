import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { Runner } from '../lib/runner.mjs';

function createRepo(root) {
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@t' } });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'cargo.out'), 'Running unittests src/lib.rs (target/debug/deps/demo-0123456789abcdef)\ntest a ... ok\ntest b ... FAILED\n');
  git('add', '.');
  git('commit', '-q', '-m', 'add the demo');
  return repo;
}

async function waitUntilFinished(store, id) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (['passed', 'failed'].includes(store.find(id).status)) return store.find(id);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('The run did not finish.');
}

test('runs the steps of a branch, keeps going after a failed test step and stops after a failed required one', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opsbuf-ci-'));
  const config = {
    projects: [{ id: 'demo', repo: createRepo(root), steps: [
      { name: 'Tests', run: 'cat cargo.out; exit 1', report: { type: 'cargo', title: 'Rust' } },
      { name: 'Install', run: 'echo installing; exit 3', stopOnFailure: true },
      { name: 'Build', run: 'echo never', report: { type: 'junit', file: 'never.xml' } },
    ] }],
  };
  const store = new Store(path.join(root, 'data'), 10);
  await store.init();
  const runner = new Runner({ store, config, dataDir: path.join(root, 'data') });

  const created = await runner.enqueue({ branch: 'main', trigger: 'test' });
  const finished = await waitUntilFinished(store, created.id);

  assert.equal(finished.project, 'demo');
  assert.equal(finished.status, 'failed');
  assert.equal(finished.commit.subject, 'add the demo');
  assert.deepEqual(finished.steps.map((it) => it.status), ['passed', 'failed', 'failed', 'skipped']);
  assert.deepEqual(finished.tests, { passed: 1, failed: 1, skipped: 0, total: 2 });
  assert.match(fs.readFileSync(store.logPath(created.id, 2), 'utf8'), /installing\n\n\[exit 3\]/);
});

test('refuses a branch the repo does not have', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opsbuf-ci-'));
  const store = new Store(path.join(root, 'data'), 10);
  await store.init();
  const runner = new Runner({ store, config: { projects: [{ id: 'demo', repo: createRepo(root), steps: [] }] }, dataDir: path.join(root, 'data') });
  await assert.rejects(runner.enqueue({ branch: 'nope' }), /There is no branch "nope" in demo/);
  await assert.rejects(runner.enqueue({ project: 'other', branch: 'main' }), /There is no project "other"/);
});

test('releases a green main build, never a red one, and never another branch', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opsbuf-ci-'));
  const repo = createRepo(root);
  execFileSync('git', ['branch', 'feature'], { cwd: repo });
  const marker = path.join(root, 'released');
  const project = (testRun) => ({ id: 'demo', repo, steps: [{ name: 'Tests', run: testRun }], release: [{ name: 'Release', run: `touch ${marker} && echo zip > "$CI_ARTIFACTS/app.zip"` }] });
  const store = new Store(path.join(root, 'data'), 10);
  await store.init();

  const red = new Runner({ store, config: { projects: [project('exit 1')] }, dataDir: path.join(root, 'data') });
  const redRun = await waitUntilFinished(store, (await red.enqueue({ branch: 'main' })).id);
  assert.deepEqual(redRun.steps.map((it) => it.status), ['passed', 'failed', 'skipped']);
  assert.equal(redRun.released, false);
  assert.equal(fs.existsSync(marker), false);

  const green = new Runner({ store, config: { projects: [project('true')] }, dataDir: path.join(root, 'data') });
  const featureRun = await waitUntilFinished(store, (await green.enqueue({ branch: 'feature' })).id);
  assert.deepEqual(featureRun.steps.map((it) => it.name), ['Checkout', 'Tests']);
  const mainRun = await waitUntilFinished(store, (await green.enqueue({ branch: 'main' })).id);
  assert.deepEqual(mainRun.steps.map((it) => [it.name, it.status, it.isRelease]), [['Checkout', 'passed', false], ['Tests', 'passed', false], ['Release', 'passed', true]]);
  assert.equal(mainRun.released, true);
  assert.equal(fs.existsSync(marker), true);
  assert.deepEqual(mainRun.artifacts, [{ name: 'app.zip', bytes: 4 }]);
  assert.deepEqual(redRun.artifacts, []);
});

test('keeps the files of the newest runs only', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opsbuf-ci-'));
  const store = new Store(path.join(root, 'data'), 10);
  await store.init();
  for (const id of [1, 2, 3]) {
    await store.save({ id, status: 'passed', steps: [], artifacts: [{ name: 'app.zip', bytes: 1 }] });
    fs.writeFileSync(path.join(store.artifactsDir(id), 'app.zip'), 'x');
  }
  await store.removeOldArtifacts(2);
  assert.deepEqual(store.list().map((it) => [it.id, it.artifacts.length]), [[3, 1], [2, 1], [1, 0]]);
  assert.equal(fs.existsSync(path.join(store.artifactsDir(1), 'app.zip')), false);
});

async function createPushRunner(testRun = 'true') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opsbuf-ci-'));
  const repo = createRepo(root);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@t' } });
  git('branch', 'fix/PTX-1-demo');
  git('checkout', '-q', '-b', 'other');
  git('commit', '-q', '--allow-empty', '-m', 'another commit');
  git('checkout', '-q', 'main');
  const sha = git('rev-parse', 'HEAD').trim();
  const project = { id: 'demo', repo, steps: [{ name: 'Tests', run: testRun }], release: [{ name: 'Release', run: 'true' }] };
  const store = new Store(path.join(root, 'data'), 10);
  await store.init();
  return { store, runner: new Runner({ store, config: { projects: [project] }, dataDir: path.join(root, 'data') }), sha, git };
}

test('a main push of a commit takes the place of its queued branch build', async () => {
  const { store, runner, sha } = await createPushRunner('sleep 5');
  const blocker = await runner.enqueue({ branch: 'other', trigger: 'manual' });
  const queuedBranch = await runner.enqueue({ branch: 'fix/PTX-1-demo', sha, trigger: 'push' });
  const mainRun = await runner.enqueue({ branch: 'main', sha, trigger: 'push' });

  assert.equal(store.find(queuedBranch.id).status, 'cancelled');
  assert.equal(store.find(queuedBranch.id).replacedBy, mainRun.id);
  assert.equal(mainRun.isReused, undefined);
  assert.deepEqual(runner.lanes.build.queue, [mainRun.id]);
  await runner.cancel(blocker.id);
  await runner.cancel(mainRun.id);
});

test('a main push stops a running branch build of the same commit and releases it itself', async () => {
  const { store, runner, sha } = await createPushRunner('sleep 5');
  const branchRun = await runner.enqueue({ branch: 'fix/PTX-1-demo', sha, trigger: 'push' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(store.find(branchRun.id).status, 'running');
  runner.config.projects[0].steps = [{ name: 'Tests', run: 'true' }];

  const mainRun = await runner.enqueue({ branch: 'main', sha, trigger: 'push' });
  const finished = await waitUntilFinished(store, mainRun.id);

  assert.equal(store.find(branchRun.id).status, 'cancelled');
  assert.equal(store.find(branchRun.id).replacedBy, mainRun.id);
  assert.equal(finished.released, true);
});

test('a commit pushed twice, or to a branch after main, builds once; a new commit builds', async () => {
  const { store, runner, sha, git } = await createPushRunner();
  const first = await runner.enqueue({ branch: 'main', sha, trigger: 'push' });
  const again = await runner.enqueue({ branch: 'main', sha, trigger: 'push' });
  await waitUntilFinished(store, first.id);
  const branchAfterMain = await runner.enqueue({ branch: 'fix/PTX-1-demo', sha, trigger: 'push' });
  const manual = await runner.enqueue({ branch: 'main', sha, trigger: 'manual' });
  git('commit', '-q', '--allow-empty', '-m', 'next');
  const next = git('rev-parse', 'HEAD').trim();
  const newCommit = await runner.enqueue({ branch: 'main', sha: next, trigger: 'push' });

  assert.deepEqual([again.id, again.isReused], [first.id, true]);
  assert.deepEqual([branchAfterMain.id, branchAfterMain.isReused], [first.id, true]);
  assert.notEqual(manual.id, first.id);
  assert.notEqual(newCommit.id, first.id);
  assert.equal(newCommit.isReused, undefined);
  await waitUntilFinished(store, manual.id);
  await waitUntilFinished(store, newCommit.id);
});
