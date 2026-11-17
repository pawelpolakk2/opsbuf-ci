import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { Runner } from '../lib/runner.mjs';

const BRANCH = 'feat/PTX-7-short-name';
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@t' };

/** A CI repo (bare, like the mini's), a work clone that pushes to it, and a bare mirror like GitHub. */
function createRepos() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opsbuf-ci-merge-'));
  const repo = path.join(root, 'repo.git');
  const mirror = path.join(root, 'mirror.git');
  const work = path.join(root, 'work');
  const git = (...args) => execFileSync('git', args, { cwd: work, env: GIT_ENV }).toString().trim();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', repo]);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', mirror]);
  fs.mkdirSync(work);
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', repo);
  commit(git, 'a.txt', 'one\n', 'start');
  git('push', '-q', 'origin', 'main');
  return { root, repo, mirror, git };
}

function commit(git, file, text, message) {
  fs.writeFileSync(path.join(git('rev-parse', '--show-toplevel'), file), text);
  git('add', file);
  git('commit', '-q', '-m', message);
  return git('rev-parse', 'HEAD');
}

const readMain = (bareRepo) => execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: bareRepo }).toString().trim();

async function runBranch({ root, repo, mirror }, testRun = 'true', autoMerge = true) {
  const notes = [];
  const tracker = { addNote: async (id, text) => notes.push({ id, text }) };
  const store = new Store(path.join(root, 'data'), 10);
  await store.init();
  const config = { projects: [{ id: 'demo', repo, mirror, autoMerge, steps: [{ name: 'Tests', run: testRun }] }] };
  const runner = new Runner({ store, config, dataDir: path.join(root, 'data'), tracker, publicUrl: 'https://ci.local' });
  const created = await runner.enqueue({ branch: BRANCH, trigger: 'push' });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const current = store.find(created.id);
    if (['passed', 'failed'].includes(current.status)) return { run: current, notes, store };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('The run did not finish.');
}

test('a green ticket branch ahead of main fast-forwards main and its mirror', async () => {
  const repos = createRepos();
  repos.git('checkout', '-q', '-b', BRANCH);
  const branchSha = commit(repos.git, 'b.txt', 'two\n', 'add b');
  repos.git('push', '-q', 'origin', BRANCH);

  const { run, notes } = await runBranch(repos);

  assert.deepEqual(run.steps.map((it) => [it.name, it.status]), [['Checkout', 'passed'], ['Tests', 'passed'], ['Merge into main', 'passed']]);
  assert.equal(run.merged, true);
  assert.equal(readMain(repos.repo), branchSha);
  assert.equal(readMain(repos.mirror), branchSha);
  assert.deepEqual(notes, []);
});

test('a green ticket branch behind a moved main merges with a merge commit, never a force push', async () => {
  const repos = createRepos();
  repos.git('checkout', '-q', '-b', BRANCH);
  const branchSha = commit(repos.git, 'b.txt', 'two\n', 'add b');
  repos.git('push', '-q', 'origin', BRANCH);
  repos.git('checkout', '-q', 'main');
  const movedMain = commit(repos.git, 'c.txt', 'three\n', 'add c on main');
  repos.git('push', '-q', 'origin', 'main');

  const { run } = await runBranch(repos);

  assert.equal(run.merged, true);
  const parents = execFileSync('git', ['log', '-1', '--format=%P%n%s', 'main'], { cwd: repos.repo }).toString().trim().split('\n');
  assert.deepEqual(parents[0].split(' '), [movedMain, branchSha]);
  assert.equal(parents[1], `Merge ${BRANCH} into main`);
});

test('a conflict leaves main alone, fails the run and tells the ticket which files', async () => {
  const repos = createRepos();
  repos.git('checkout', '-q', '-b', BRANCH);
  commit(repos.git, 'a.txt', 'from the branch\n', 'change a on the branch');
  repos.git('push', '-q', 'origin', BRANCH);
  repos.git('checkout', '-q', 'main');
  const movedMain = commit(repos.git, 'a.txt', 'from main\n', 'change a on main');
  repos.git('push', '-q', 'origin', 'main');

  const { run, notes } = await runBranch(repos);

  assert.equal(run.status, 'failed');
  assert.equal(run.merged, false);
  assert.deepEqual(run.steps.map((it) => [it.name, it.status, it.exitCode]).at(-1), ['Merge into main', 'failed', 2]);
  assert.equal(readMain(repos.repo), movedMain);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].id, 7);
  assert.match(notes[0].text, /^Not merged into main: it does not merge without a conflict\. CI run #\d+ \(feat\/PTX-7-short-name [0-9a-f]{7}\): https:\/\/ci\.local\/#\/runs\/\d+/);
  assert.match(notes[0].text, /a\.txt/);
});

test('a red ticket branch never merges and tells the ticket which check was red', async () => {
  const repos = createRepos();
  repos.git('checkout', '-q', '-b', BRANCH);
  commit(repos.git, 'b.txt', 'two\n', 'add b');
  repos.git('push', '-q', 'origin', BRANCH);
  const mainBefore = readMain(repos.repo);

  const { run, notes } = await runBranch(repos, 'exit 1');

  assert.deepEqual(run.steps.map((it) => [it.name, it.status]), [['Checkout', 'passed'], ['Tests', 'failed'], ['Merge into main', 'skipped']]);
  assert.equal(run.merged, false);
  assert.equal(readMain(repos.repo), mainBefore);
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /^Not merged into main: red at Tests\. CI run #\d+/);
});

test('without autoMerge a ticket branch is only tested: no merge, and no note when it is red', async () => {
  const repos = createRepos();
  repos.git('checkout', '-q', '-b', BRANCH);
  commit(repos.git, 'b.txt', 'two\n', 'add b');
  repos.git('push', '-q', 'origin', BRANCH);
  const mainBefore = readMain(repos.repo);

  const green = await runBranch(repos, 'true', false);
  const red = await runBranch(repos, 'exit 1', false);

  assert.deepEqual(green.run.steps.map((it) => [it.name, it.status]), [['Checkout', 'passed'], ['Tests', 'passed']]);
  assert.equal(green.run.merged, false);
  assert.equal(red.run.status, 'failed');
  assert.equal(readMain(repos.repo), mainBefore);
  assert.deepEqual([...green.notes, ...red.notes], []);
});
