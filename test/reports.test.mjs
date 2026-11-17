import test from 'node:test';
import assert from 'node:assert/strict';
import { countTests, parseCargoOutput, parseJunit } from '../lib/reports.mjs';

const CARGO = `   Compiling ptx-core v0.1.0
    Finished \`test\` profile [unoptimized + debuginfo] target(s) in 3.2s
     Running unittests src/lib.rs (target/debug/deps/ptx_core-0123456789abcdef)

running 3 tests
test git::tests::reads_status ... ok
test keymap::tests::binds_commit ... FAILED
test slow::big ... ignored, takes a minute

failures:

---- keymap::tests::binds_commit stdout ----

thread 'keymap::tests::binds_commit' panicked at src/keymap.rs:12:5:
assertion failed: left == right

failures:
    keymap::tests::binds_commit

test result: FAILED. 1 passed; 1 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.01s

     Running tests/git.rs (target/debug/deps/git-fedcba9876543210)

running 1 test
test finds_the_repo ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.20s

   Doc-tests ptx_core

running 0 tests
`;

test('reads every cargo test binary as a suite, with the failure text', () => {
  const suites = parseCargoOutput(CARGO);
  assert.deepEqual(suites.map((it) => it.name), ['ptx_core · src/lib.rs', 'git · tests/git.rs']);
  assert.deepEqual(suites[0].tests.map((it) => it.status), ['passed', 'failed', 'skipped']);
  assert.match(suites[0].tests[1].message, /panicked at src\/keymap.rs:12:5:\nassertion failed/);
  assert.equal(suites[0].tests[0].message, '');
  assert.deepEqual(countTests(suites), { passed: 2, failed: 1, skipped: 1, total: 4 });
});

const JUNIT = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="3" failures="1" errors="0" time="1.2">
    <testsuite name="src/app/git/git-diff.spec.ts" timestamp="2026-11-15T14:00:00" hostname="mini" tests="3" failures="1" errors="0" skipped="1" time="0.4">
        <testcase classname="src/app/git/git-diff.spec.ts" name="git diff &gt; pairs a removed line" time="0.012">
        </testcase>
        <testcase classname="src/app/git/git-diff.spec.ts" name="git diff &gt; marks a new file" time="0.003">
            <failure message="expected 1 to be 2 // Object.is equality" type="AssertionError">
AssertionError: expected 1 to be 2 &amp; more
 ❯ src/app/git/git-diff.spec.ts:40:12
            </failure>
        </testcase>
        <testcase classname="src/app/git/git-diff.spec.ts" name="git diff &gt; later" time="0">
            <skipped/>
        </testcase>
    </testsuite>
</testsuites>`;

test('reads a vitest JUnit report with failures and skipped tests', () => {
  const [suite] = parseJunit(JUNIT);
  assert.equal(suite.name, 'src/app/git/git-diff.spec.ts');
  assert.deepEqual(suite.tests.map((it) => [it.name, it.status, it.ms]), [
    ['git diff > pairs a removed line', 'passed', 12],
    ['git diff > marks a new file', 'failed', 3],
    ['git diff > later', 'skipped', 0],
  ]);
  assert.match(suite.tests[1].message, /^expected 1 to be 2 \/\/ Object.is equality\nAssertionError: expected 1 to be 2 & more/);
});

test('an empty or broken report has no suites', () => {
  assert.deepEqual(parseJunit(''), []);
  assert.deepEqual(parseCargoOutput('error: could not compile `ptx-core`'), []);
});

test('groups the tests of Node\'s JUnit report by their file', () => {
  const xml = `<testsuites>
	<testcase name="reads a report" time="0.002" classname="test" file="/repo/test/reports.test.mjs"/>
	<testcase name="runs a branch" time="0.3" classname="test" file="/repo/test/runner.test.mjs">
		<failure type="testCodeFailure" message="The run did not finish.">Error: The run did not finish.</failure>
	</testcase>
</testsuites>`;
  const suites = parseJunit(xml);
  assert.deepEqual(suites.map((it) => [it.name, it.tests.map((test) => test.status)]), [
    ['test/reports.test.mjs', ['passed']],
    ['test/runner.test.mjs', ['failed']],
  ]);
});

test('keeps every test when a name or a message holds a ">", which Node does not escape', () => {
  const xml = `<testsuites>
	<testcase name="Logs: level > INFO shows the more severe lines" time="7.6" classname="test" file="/repo/a.test.ts"/>
	<testcase name="Logs: a level outside the order" time="6.1" classname="test" file="/repo/a.test.ts">
		<failure type="testCodeFailure" message="step 1: it is > 0 and < 5">Error: step 1</failure>
	</testcase>
	<testcase name="Logs: a new order" time="5.5" classname="test" file="/repo/a.test.ts"/>
</testsuites>`;
  const [suite] = parseJunit(xml);
  assert.deepEqual(suite.tests.map((it) => [it.name, it.status]), [
    ['Logs: level > INFO shows the more severe lines', 'passed'],
    ['Logs: a level outside the order', 'failed'],
    ['Logs: a new order', 'passed'],
  ]);
  assert.match(suite.tests[1].message, /^step 1: it is > 0 and < 5/);
});
