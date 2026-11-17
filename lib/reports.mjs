// Turns test output into one shape, suites with their tests, so the page shows Rust and UI tests the same way.

const CARGO_RUNNING = /^\s*Running (?:unittests )?(\S+) \(([^)]+)\)\s*$/;
const CARGO_DOC_TESTS = /^\s*Doc-tests (\S+)\s*$/;
const CARGO_TEST = /^test (.+?) \.\.\. (ok|FAILED|ignored)\b/;
const CARGO_FAILURE = /^---- (.+?) stdout ----$/;
const CARGO_STATUS = { ok: 'passed', FAILED: 'failed', ignored: 'skipped' };

export function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

/** Reads `cargo test` output: one suite per test binary, failures with what they printed. */
export function parseCargoOutput(text) {
  const suites = [];
  let suite = null;
  let failing = null;
  for (const line of stripAnsi(text).split('\n')) {
    const suiteName = findCargoSuiteName(line);
    if (suiteName) {
      suite = { name: suiteName, tests: [] };
      suites.push(suite);
      failing = null;
      continue;
    }
    if (!suite) continue;
    const test = CARGO_TEST.exec(line);
    if (test) {
      suite.tests.push({ name: test[1], status: CARGO_STATUS[test[2]], ms: null, message: '' });
      continue;
    }
    const failure = CARGO_FAILURE.exec(line);
    if (failure) {
      failing = suite.tests.find((it) => it.name === failure[1]) ?? null;
      continue;
    }
    if (line === 'failures:' || line.startsWith('test result:')) failing = null;
    else if (failing) failing.message += `${line}\n`;
  }
  return suites.filter((it) => it.tests.length).map(trimMessages);
}

function findCargoSuiteName(line) {
  const running = CARGO_RUNNING.exec(line);
  if (running) return `${running[2].split('/').at(-1).replace(/-[0-9a-f]{16}$/, '')} · ${running[1]}`;
  const docTests = CARGO_DOC_TESTS.exec(line);
  return docTests ? `${docTests[1]} · doc tests` : null;
}

// Node's runner leaves a ">" unescaped inside an attribute value, so a tag ends at the first ">" outside quotes
const ATTRIBUTES = '(?:[^>"]|"[^"]*")*';
const TESTSUITE = new RegExp(`<testsuite\\b(${ATTRIBUTES})>([\\s\\S]*?)<\\/testsuite>`, 'g');
const TESTCASE = new RegExp(`<testcase\\b(${ATTRIBUTES}?)(?:\\/>|>([\\s\\S]*?)<\\/testcase>)`, 'g');
const FAILURE = new RegExp(`<(failure|error)\\b(${ATTRIBUTES}?)(?:\\/>|>([\\s\\S]*?)<\\/\\1>)`);

/** Reads a JUnit XML report: vitest and Gradle wrap tests in <testsuite>, Node's runner names the file on each test. */
export function parseJunit(xml) {
  const suites = [];
  for (const [, attributeText, body] of xml.matchAll(TESTSUITE)) {
    const tests = [...body.matchAll(TESTCASE)].map(toJunitTest);
    if (tests.length) suites.push({ name: decodeXml(readAttributes(attributeText).name ?? 'tests'), tests });
  }
  return [...suites, ...groupLooseTests(xml.replace(TESTSUITE, ''))].map(trimMessages);
}

function groupLooseTests(xml) {
  const testsBySuite = new Map();
  for (const match of xml.matchAll(TESTCASE)) {
    const attributes = readAttributes(match[1]);
    const name = decodeXml(attributes.file?.split('/').slice(-2).join('/') ?? attributes.classname ?? 'tests');
    testsBySuite.set(name, [...(testsBySuite.get(name) ?? []), toJunitTest(match)]);
  }
  return [...testsBySuite].map(([name, tests]) => ({ name, tests }));
}

function toJunitTest([, attributeText, body = '']) {
  const attributes = readAttributes(attributeText);
  const failure = FAILURE.exec(body);
  const status = failure ? 'failed' : /<skipped\b/.test(body) ? 'skipped' : 'passed';
  const message = failure ? [readAttributes(failure[2]).message, failure[3]].map((it) => decodeXml(it ?? '').trim()).filter(Boolean).join('\n') : '';
  return { name: decodeXml(attributes.name ?? ''), status, ms: Math.round(Number(attributes.time ?? 0) * 1000), message };
}

function readAttributes(text) {
  return Object.fromEntries([...text.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, name, value]) => [name, value]));
}

function decodeXml(text) {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (ignored, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (ignored, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

function trimMessages(suite) {
  return { ...suite, tests: suite.tests.map((it) => ({ ...it, message: stripAnsi(it.message).trim() })) };
}

export function countTests(suites) {
  const counts = { passed: 0, failed: 0, skipped: 0, total: 0 };
  for (const suite of suites) {
    for (const test of suite.tests) {
      counts[test.status] += 1;
      counts.total += 1;
    }
  }
  return counts;
}
