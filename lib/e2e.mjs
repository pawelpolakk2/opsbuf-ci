// The tests of job runs: a run's tests compared with the last scheduled run of its job, so a test that passed then and
// fails now becomes one ticket.
const UNITS = { m: 60_000, h: 3_600_000, d: 86_400_000 };
const TITLE_LENGTH = 70;
const MESSAGE_LINES = 12;

/** "30m", "1h", "1d" as milliseconds. */
export function parseEvery(text) {
  const match = /^(\d+)\s*([mhd])$/.exec(String(text ?? '').trim());
  if (!match) throw new Error(`"every" takes a number and m, h or d, e.g. 1h; it got "${text}".`);
  return Number(match[1]) * UNITS[match[2]];
}

/** The tests of a run's reports by name: what failed, what passed, and why. */
export function readTests(run) {
  const byName = new Map();
  for (const step of run?.steps ?? []) {
    for (const suite of step.report?.suites ?? []) {
      // Node's JUnit report adds the test file itself without a name; it fails whenever one of its tests does
      for (const test of suite.tests.filter((it) => it.name)) byName.set(test.name, test);
    }
  }
  return byName;
}

/** Passed and failed counts, the regressions (passed on the previous run, fail now) and what failed before too. */
export function summarize(previous, current) {
  const before = readTests(previous);
  const now = [...readTests(current).values()];
  const failed = now.filter((it) => it.status === 'failed');
  const isRegression = (test) => before.get(test.name)?.status === 'passed';
  return {
    passed: now.filter((it) => it.status === 'passed').length,
    failed: failed.length,
    regressions: failed.filter(isRegression).map((it) => ({ name: it.name, message: it.message })),
    failing: failed.filter((it) => !isRegression(it)).map((it) => it.name),
  };
}

/** The tracker's light form of a ticket for main about one regression. */
export function buildRegressionIssue({ regression, previous, current, jobKey, publicUrl }) {
  const title = `${jobKey.toUpperCase()}: ${regression.name}`.slice(0, TITLE_LENGTH);
  const message = regression.message.split('\n').slice(0, MESSAGE_LINES).join('\n');
  return [
    title,
    'kind: bug · p1 · agent: main · source: ci',
    `labels: ${jobKey}`,
    `dedupe_key: ${jobKey}-${toSlug(regression.name)}`,
    '',
    `The test "${regression.name}" of the job ${jobKey} passed on CI run #${previous.id} (${previous.sha.slice(0, 7)}) and fails on CI run #${current.id} (${current.sha.slice(0, 7)}): ${publicUrl}/#/runs/${current.id}`,
    '',
    '```',
    message,
    '```',
  ].join('\n');
}

export const toSlug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
