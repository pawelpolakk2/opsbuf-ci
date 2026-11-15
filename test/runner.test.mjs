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
