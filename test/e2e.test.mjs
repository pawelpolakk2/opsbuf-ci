import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEvery, summarize } from '../lib/e2e.mjs';
import { Store } from '../lib/store.mjs';
import { Runner } from '../lib/runner.mjs';

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@t' };
const HOUR_MS = 3_600_000;

const junit = (isScenarioAPassing) => `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
  <testcase name="Scenario A" time="1" classname="test">${isScenarioAPassing ? '' : '<failure message="T-1 step 2 &quot;Open it&quot;: boom">boom</failure>'}</testcase>
  <testcase name="Scenario B" time="1" classname="test"><failure message="T-2 step 1: a known gap">gap</failure></testcase>
</testsuites>`;

/** A project whose release does nothing and whose end-to-end step copies the JUnit file the test prepared. */
async function createSetup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opsbuf-ci-e2e-'));
  const repo = path.join(root, 'repo');
  const results = path.join(root, 'e2e.xml');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, env: GIT_ENV });
  git('init', '-q', '-b', 'main');
  const project = {
    id: 'demo',
    repo,
    steps: [{ name: 'Tests', run: 'true' }],
    release: [{ name: 'Release', run: 'true' }],
    e2e: { every: '1h', run: `cp ${results} "$CI_REPORTS/e2e.xml"`, report: { type: 'junit', file: 'e2e.xml', title: 'End-to-end' } },
  };
  const tickets = [];
  const tracker = { addIssue: async (text) => (tickets.push(text), { id: 100 + tickets.length, existing: false }) };
  const store = new Store(path.join(root, 'data'), 50);
  await store.init();
  const runner = new Runner({ store, config: { projects: [project] }, dataDir: path.join(root, 'data'), tracker, publicUrl: 'https://ci.local' });
  let commits = 0;
  return {
    store,
    runner,
    tickets,
    /** A new commit on main, built and released green. */
    release: async () => {
      commits += 1;
      fs.writeFileSync(path.join(repo, 'file.txt'), `${commits}\n`);
      git('add', '.');
      git('commit', '-q', '-m', `change ${commits}`);
      return waitUntilFinished(store, (await runner.enqueue({ branch: 'main' })).id);
    },
    prepareResults: (isScenarioAPassing) => fs.writeFileSync(results, junit(isScenarioAPassing)),
  };
}

async function waitUntilFinished(store, id) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (['passed', 'failed'].includes(store.find(id).status)) return store.find(id);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('The run did not finish.');
}

async function scheduleAndFinish(setup, now) {
  const [started] = await setup.runner.scheduleEndToEnd(now);
  return started ? waitUntilFinished(setup.store, started.id) : null;
}

test('reads "every" as minutes, hours or days', () => {
  assert.equal(parseEvery('30m'), 30 * 60_000);
  assert.equal(parseEvery('1h'), HOUR_MS);
  assert.equal(parseEvery('2d'), 2 * 24 * HOUR_MS);
  assert.throws(() => parseEvery('hourly'), /"every" takes a number and m, h or d/);
});

test('starts no end-to-end run before a release, and none while the released commit stays the same', async () => {
  const setup = await createSetup();
  setup.prepareResults(true);
  assert.equal(await scheduleAndFinish(setup, Date.now()), null);

  const released = await setup.release();
  const first = await scheduleAndFinish(setup, Date.now());
  assert.equal(first.kind, 'e2e');
  assert.equal(first.trigger, 'schedule');
  assert.equal(first.sha, released.sha);
  assert.deepEqual(first.steps.map((it) => it.name), ['Checkout', 'End-to-end']);

  assert.equal(await scheduleAndFinish(setup, Date.now() + 3 * HOUR_MS), null);
});

test('a new release starts one once "every" has passed since the last end-to-end run', async () => {
  const setup = await createSetup();
  setup.prepareResults(true);
  await setup.release();
  const first = await scheduleAndFinish(setup, Date.now());

  const second = await setup.release();
  assert.equal(await scheduleAndFinish(setup, Date.parse(first.queuedAt) + 10 * 60_000), null);
  const next = await scheduleAndFinish(setup, Date.parse(first.queuedAt) + HOUR_MS + 1);
  assert.equal(next.sha, second.sha);
});

test('a regression opens exactly one ticket for main; a test that failed before only shows in the summary', async () => {
  const setup = await createSetup();
  let now = Date.now();
  const nextHour = () => (now += HOUR_MS + 1);

  setup.prepareResults(true);
  await setup.release();
  const green = await scheduleAndFinish(setup, nextHour());
  assert.deepEqual(green.e2e, { passed: 1, failed: 1, regressions: [], failing: ['Scenario B'], tickets: [] });

  setup.prepareResults(false);
  await setup.release();
  const red = await scheduleAndFinish(setup, nextHour());
  assert.equal(red.e2e.regressions.length, 1);
  assert.equal(red.e2e.regressions[0].name, 'Scenario A');
  assert.deepEqual(red.e2e.failing, ['Scenario B']);
  assert.deepEqual(red.e2e.tickets, [{ test: 'Scenario A', id: 101, isExisting: false }]);
  assert.equal(setup.tickets.length, 1);
  assert.match(setup.tickets[0], /^E2E: Scenario A\nkind: bug · p1 · agent: main · source: ci\nlabels: e2e\ndedupe_key: e2e-scenario-a\n/);
  assert.match(setup.tickets[0], new RegExp(`passed on CI run #${green.id} \\(\\w{7}\\) and fails on CI run #${red.id} \\(\\w{7}\\): https://ci.local/#/runs/${red.id}`));
  assert.match(setup.tickets[0], /T-1 step 2 "Open it": boom/);

  await setup.release();
  const stillRed = await scheduleAndFinish(setup, nextHour());
  assert.deepEqual(stillRed.e2e.regressions, []);
  assert.deepEqual(stillRed.e2e.failing, ['Scenario A', 'Scenario B']);
  assert.equal(setup.tickets.length, 1);
});

test('the summary of a first end-to-end run has nothing to compare with', () => {
  const run = { steps: [{ report: { suites: [{ name: 'test', tests: [{ name: 'A', status: 'failed', message: 'x' }] }] } }] };
  assert.deepEqual(summarize(undefined, run), { passed: 0, failed: 1, regressions: [], failing: ['A'] });
});
