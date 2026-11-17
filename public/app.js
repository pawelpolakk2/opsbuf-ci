// The page of the CI: the list of runs, and one run with its steps, logs and test results.
const page = document.getElementById('page');
const LIST_REFRESH_MS = 3000;
const RUN_REFRESH_MS = 1500;
const FINISHED = new Set(['passed', 'failed', 'interrupted']);

const view = {
  timer: null,
  runId: null,
  run: null,
  testsKey: '',
  filter: null,
  search: '',
  openSteps: new Set(),
  logs: new Map(),
  projects: [],
};

window.addEventListener('hashchange', showRoute);
document.getElementById('start').addEventListener('submit', startRun);
document.getElementById('project').addEventListener('change', () => loadBranches());
await loadProjects();
showRoute();

function findProjectFilter() {
  return new URLSearchParams(location.hash.split('?')[1] ?? '').get('project');
}

function findProjectName(id) {
  return view.projects.find((it) => it.id === id)?.name ?? id;
}

async function loadProjects() {
  view.projects = await fetchJson('/api/projects').catch(() => []);
  const select = document.getElementById('project');
  select.innerHTML = view.projects.map((it) => `<option value="${escape(it.id)}">${escape(it.name)}</option>`).join('');
  select.hidden = view.projects.length < 2;
  const filtered = findProjectFilter();
  if (filtered) select.value = filtered;
  await loadBranches();
}

function showRoute() {
  clearTimeout(view.timer);
  const match = /^#\/runs\/(\d+)/.exec(location.hash);
  if (match) return openRun(Number(match[1]));
  view.runId = null;
  const filtered = findProjectFilter();
  if (filtered && document.getElementById('project').value !== filtered) {
    document.getElementById('project').value = filtered;
    void loadBranches();
  }
  void refreshList();
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

async function loadBranches() {
  const select = document.getElementById('branch');
  const project = document.getElementById('project').value;
  const branches = await fetchJson(`/api/branches?project=${encodeURIComponent(project)}`).catch(() => ['main']);
  const sorted = [...branches].sort((a, b) => (a === 'main' ? -1 : b === 'main' ? 1 : a.localeCompare(b)));
  select.innerHTML = sorted.map((it) => `<option>${escape(it)}</option>`).join('');
}

async function startRun(event) {
  event.preventDefault();
  const branch = document.getElementById('branch').value;
  const project = document.getElementById('project').value;
  try {
    const created = await fetchJson('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project, branch }) });
    location.hash = `#/runs/${created.id}`;
  } catch (error) {
    showToast(error.message);
  }
}

// ── the list ──

async function refreshList() {
  try {
    renderList(await fetchJson('/api/runs'));
  } catch (error) {
    page.innerHTML = `<p class="empty">The CI does not answer: ${escape(error.message)}</p>`;
  }
  if (view.runId === null) view.timer = setTimeout(refreshList, LIST_REFRESH_MS);
}

function renderList(allRuns) {
  const filter = findProjectFilter();
  const runs = filter ? allRuns.filter((it) => it.project === filter) : allRuns;
  const tabs = view.projects.length < 2 ? '' : `
    <nav class="project-tabs">
      <a href="#/" class="${filter ? '' : 'on'}">All projects</a>
      ${view.projects.map((it) => `<a href="#/?project=${encodeURIComponent(it.id)}" class="${filter === it.id ? 'on' : ''}">${escape(it.name)}<span>${allRuns.filter((run) => run.project === it.id).length}</span></a>`).join('')}
    </nav>`;
  if (!runs.length) {
    page.innerHTML = `${tabs}<section class="hero"><h1>No runs yet</h1><p>Push to the <code>ci</code> remote, or pick a project and a branch and press <b>Run</b>.</p></section>`;
    return;
  }
  const finished = runs.filter((it) => FINISHED.has(it.status));
  const passRate = finished.length ? Math.round((100 * finished.filter((it) => it.status === 'passed').length) / finished.length) : null;
  page.innerHTML = `${tabs}
    <section class="overview">
      <div class="stat"><span class="label">Last run</span>${statusBadge(runs[0].status)}</div>
      <div class="stat"><span class="label">Passing</span><b>${passRate === null ? '–' : `${passRate}%`}</b><span class="hint">of the last ${finished.length}</span></div>
      <div class="stat wide"><span class="label">History</span><div class="history">${[...runs].slice(0, 40).reverse().map(historyCell).join('')}</div></div>
    </section>
    <section class="runs">${runs.map(runRow).join('')}</section>`;
}

function historyCell(run) {
  return `<a class="cell ${run.status}" href="#/runs/${run.id}" title="#${run.id} ${escape(run.status)}"></a>`;
}

function runRow(run) {
  return `
    <a class="run-row" href="#/runs/${run.id}">
      ${statusIcon(run.status)}
      <span class="id">#${run.id}</span>
      <span class="what">
        <span class="subject">${escape(run.commit?.subject ?? run.sha.slice(0, 10))}</span>
        <span class="meta">${projectChip(run.project)}${branchChip(run.branch)}${outcomeChip(run)}<code>${run.sha.slice(0, 7)}</code>${run.commit ? `<span>${escape(run.commit.author)}</span>` : ''}<span>${escape(run.trigger)}</span></span>
      </span>
      ${testBar(run.tests, run.artifacts)}
      <span class="when"><span>${formatDuration(run.ms ?? runningFor(run))}</span><span class="dim">${formatAgo(run.startedAt ?? run.queuedAt)}</span></span>
    </a>`;
}

function testBar(counts, artifacts) {
  const files = artifacts?.length ? `<span class="has-files" title="${artifacts.length} file(s) to download">⬇ ${artifacts.length}</span>` : '';
  if (!counts?.total) return `<span class="tests none">${files}</span>`;
  const width = (count) => `${(100 * count) / counts.total}%`;
  return `
    <span class="tests">
      <span class="bar"><i class="passed" style="width:${width(counts.passed)}"></i><i class="failed" style="width:${width(counts.failed)}"></i><i class="skipped" style="width:${width(counts.skipped)}"></i></span>
      <span class="numbers"><span class="ok">✓ ${counts.passed}</span>${counts.failed ? `<span class="bad">✕ ${counts.failed}</span>` : ''}${counts.skipped ? `<span class="dim">○ ${counts.skipped}</span>` : ''}${files}</span>
    </span>`;
}

// ── one run ──

async function openRun(id) {
  if (view.runId !== id) {
    Object.assign(view, { runId: id, run: null, testsKey: '', filter: null, search: '', openSteps: new Set(), logs: new Map() });
    page.innerHTML = `
      <a class="back" href="#/">← All runs</a>
      <section id="run-head" class="run-head"></section>
      <section id="summary" class="summary"></section>
      <section id="artifacts"></section>
      <h2>Steps</h2>
      <section id="steps" class="steps"></section>
      <div class="tests-head">
        <h2>Tests</h2>
        <div id="filters" class="filters"></div>
        <input id="search" type="search" placeholder="Find a test" autocomplete="off">
      </div>
      <section id="tests" class="test-list"></section>`;
    document.getElementById('search').addEventListener('input', (event) => {
      view.search = event.target.value.trim().toLowerCase();
      renderTests(true);
    });
  }
  await refreshRun();
}

async function refreshRun() {
  const id = view.runId;
  try {
    const run = await fetchJson(`/api/runs/${id}`);
    if (view.runId !== id) return;
    view.run = run;
    renderRunHead(run);
    renderSummary(run);
    renderArtifacts(run);
    renderSteps(run);
    renderTests(false);
    await refreshOpenLogs(run);
  } catch (error) {
    document.getElementById('run-head').innerHTML = `<p class="empty">${escape(error.message)}</p>`;
    return;
  }
  if (view.runId === id && !FINISHED.has(view.run.status)) view.timer = setTimeout(refreshRun, RUN_REFRESH_MS);
}

function renderRunHead(run) {
  document.getElementById('run-head').innerHTML = `
    <div class="title">${statusIcon(run.status, 22)}<h1>${escape(run.commit?.subject ?? `Run #${run.id}`)}</h1></div>
    <div class="meta">
      <span>#${run.id}</span>${projectChip(run.project)}${branchChip(run.branch)}${outcomeChip(run)}<code title="${run.sha}">${run.sha.slice(0, 10)}</code>
      ${run.commit ? `<span>${escape(run.commit.author)}</span>` : ''}
      <span>${escape(run.trigger)}</span>
      <span>${run.startedAt ? `started ${formatAgo(run.startedAt)}` : 'waiting in the queue'}</span>
      <span class="grow"></span>
      ${FINISHED.has(run.status) ? `<button type="button" class="ghost" id="rerun">Run again</button>` : ''}
    </div>
    ${run.error ? `<p class="run-error">The CI failed on its own: ${escape(run.error)}</p>` : ''}`;
  document.getElementById('rerun')?.addEventListener('click', () => rerun(run));
}

async function rerun(run) {
  try {
    const created = await fetchJson('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: run.project, branch: run.branch, sha: run.sha }) });
    location.hash = `#/runs/${created.id}`;
  } catch (error) {
    showToast(error.message);
  }
}

function renderSummary(run) {
  const counts = sumCounts(run.steps);
  const ms = run.ms ?? runningFor(run);
  document.getElementById('summary').innerHTML = `
    <div class="card status-${run.status}"><span class="label">Status</span>${statusBadge(run.status)}</div>
    <div class="card"><span class="label">Tests</span>${ring(counts)}
      <div class="ring-legend"><span class="ok">${counts.passed} passed</span><span class="${counts.failed ? 'bad' : 'dim'}">${counts.failed} failed</span><span class="dim">${counts.skipped} skipped</span></div></div>
    <div class="card"><span class="label">Duration</span><b class="big">${formatDuration(ms)}</b><span class="hint">${run.steps.filter((it) => it.status === 'passed' || it.status === 'failed').length} of ${run.steps.length} steps done</span></div>`;
}

function renderArtifacts(run) {
  const container = document.getElementById('artifacts');
  if (!run.artifacts?.length) {
    container.innerHTML = run.artifactsRemoved ? '<p class="hint artifacts-gone">The files of this run were removed; only the newest runs keep theirs.</p>' : '';
    return;
  }
  container.innerHTML = `
    <h2>Files</h2>
    <div class="artifacts">${run.artifacts.map((it) => `
      <a class="artifact" href="/api/runs/${run.id}/artifacts/${encodeURIComponent(it.name)}" download>
        <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.5v8m0 0L4.8 7.3M8 10.5l3.2-3.2M3 13.5h10"/></svg>
        <span class="artifact-name">${escape(it.name)}</span><span class="dim">${formatBytes(it.bytes)}</span>
      </a>`).join('')}
    </div>`;
}

function formatBytes(bytes) {
  return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function ring(counts) {
  if (!counts.total) return '<b class="big dim">–</b>';
  const circumference = 2 * Math.PI * 22;
  let offset = 0;
  const arcs = ['passed', 'failed', 'skipped'].map((status) => {
    const length = (circumference * counts[status]) / counts.total;
    const arc = `<circle class="${status}" r="22" cx="28" cy="28" stroke-dasharray="${length} ${circumference - length}" stroke-dashoffset="${-offset}"/>`;
    offset += length;
    return arc;
  });
  const percent = Math.floor((100 * counts.passed) / Math.max(1, counts.passed + counts.failed));
  return `<span class="ring"><svg viewBox="0 0 56 56" width="64" height="64"><circle class="track" r="22" cx="28" cy="28"/>${arcs.join('')}</svg><b>${percent}%</b></span>`;
}

function renderSteps(run) {
  const container = document.getElementById('steps');
  const existing = container.querySelectorAll('.step');
  if (existing.length !== run.steps.length) container.innerHTML = run.steps.map((ignored, index) => `<div class="step" data-index="${index}"></div>`).join('');
  for (const [index, step] of run.steps.entries()) renderStep(container.querySelector(`.step[data-index="${index}"]`), step, index);
}

function renderStep(element, step, index) {
  const isOpen = view.openSteps.has(index);
  const counts = step.report?.counts;
  const header = `
    <button type="button" class="step-head" aria-expanded="${isOpen}">
      ${statusIcon(step.status)}
      <span class="name">${escape(step.name)}</span>${step.isRelease ? '<span class="release-tag">release</span>' : ''}
      ${step.run ? `<code class="cmd">${escape(step.run)}</code>` : ''}
      <span class="grow"></span>
      ${counts?.total ? `<span class="step-tests"><span class="ok">✓ ${counts.passed}</span>${counts.failed ? ` <span class="bad">✕ ${counts.failed}</span>` : ''}</span>` : ''}
      <span class="dim">${step.status === 'running' ? formatDuration(Date.now() - Date.parse(step.startedAt)) : step.ms !== null ? formatDuration(step.ms) : ''}</span>
      <span class="chevron">${isOpen ? '▾' : '▸'}</span>
    </button>`;
  let head = element.querySelector('.step-head');
  if (!head) {
    element.innerHTML = `${header}<pre class="log" hidden></pre>`;
    head = element.querySelector('.step-head');
  } else {
    head.outerHTML = header;
    head = element.querySelector('.step-head');
  }
  element.className = `step ${step.status}`;
  head.addEventListener('click', () => toggleStep(index));
  element.querySelector('.log').hidden = !isOpen;
}

async function toggleStep(index) {
  if (view.openSteps.has(index)) view.openSteps.delete(index);
  else view.openSteps.add(index);
  renderSteps(view.run);
  if (view.openSteps.has(index)) await refreshLog(view.run, index);
}

async function refreshOpenLogs(run) {
  for (const index of view.openSteps) await refreshLog(run, index);
}

async function refreshLog(run, index) {
  const cached = view.logs.get(index) ?? { size: 0, text: '' };
  if (cached.isComplete) return;
  const response = await fetch(`/api/runs/${run.id}/steps/${index}/log?from=${cached.size}`);
  const added = await response.text();
  const size = Number(response.headers.get('x-log-size') ?? cached.size);
  const isComplete = FINISHED.has(run.steps[index].status) || run.steps[index].status === 'skipped';
  const updated = { size, text: cached.text + added, isComplete };
  view.logs.set(index, updated);
  const pre = document.querySelector(`.step[data-index="${index}"] .log`);
  if (!pre) return;
  const isAtBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
  if (added || !pre.textContent) pre.innerHTML = colorLog(updated.text) || '<span class="dim">No output yet.</span>';
  if (isAtBottom || !cached.text) pre.scrollTop = pre.scrollHeight;
}

function colorLog(text) {
  return escape(text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''))
    .split('\n')
    .map((line) => {
      if (/^\$ /.test(line)) return `<span class="log-cmd">${line}</span>`;
      if (/\b(FAILED|FAIL|failed|error(\[E\d+\])?:|panicked)\b|✗|×/.test(line)) return `<span class="log-bad">${line}</span>`;
      if (/^test .* \.\.\. ok$|✓|\bpassed\b|test result: ok/.test(line)) return `<span class="log-ok">${line}</span>`;
      if (/\bwarning\b/.test(line)) return `<span class="log-warn">${line}</span>`;
      return line;
    })
    .join('\n');
}

function renderTests(isForced) {
  const run = view.run;
  const reports = run.steps.filter((it) => it.report?.suites?.length).map((it) => it.report);
  const key = reports.map((it) => `${it.title}:${it.counts.total}:${it.counts.failed}`).join('|');
  const counts = sumCounts(run.steps);
  const filter = view.filter ?? (counts.failed ? 'failed' : 'all');
  if (!isForced && key === view.testsKey) return;
  view.testsKey = key;
  document.getElementById('filters').innerHTML = [
    ['failed', 'Failed', counts.failed],
    ['all', 'All', counts.total],
    ['skipped', 'Skipped', counts.skipped],
  ]
    .map(([value, label, count]) => `<button type="button" data-filter="${value}" class="${filter === value ? 'on' : ''} ${value}">${label}<span>${count}</span></button>`)
    .join('');
  for (const button of document.querySelectorAll('#filters button')) {
    button.addEventListener('click', () => {
      view.filter = button.dataset.filter;
      renderTests(true);
    });
  }
  document.getElementById('tests').innerHTML = reports.length ? reports.map((it) => reportBlock(it, filter)).join('') : `<p class="empty">${FINISHED.has(run.status) ? 'This run has no test results.' : 'The results show up when a test step ends.'}</p>`;
}

function reportBlock(report, filter) {
  const suites = report.suites.map((suite) => ({ ...suite, shown: suite.tests.filter((test) => isShown(test, suite, filter)) })).filter((it) => it.shown.length);
  if (!suites.length) return `<div class="report"><h3>${escape(report.title)} <span class="dim">${report.counts.total} tests</span></h3><p class="empty small">${filter === 'failed' ? 'Nothing failed here.' : 'No test matches.'}</p></div>`;
  return `
    <div class="report">
      <h3>${escape(report.title)} <span class="dim">${report.counts.total} tests · ${report.suites.length} suites</span></h3>
      ${suites.map((it) => suiteBlock(it, filter)).join('')}
    </div>`;
}

function isShown(test, suite, filter) {
  if (filter !== 'all' && test.status !== filter) return false;
  return !view.search || test.name.toLowerCase().includes(view.search) || suite.name.toLowerCase().includes(view.search);
}

function suiteBlock(suite, filter) {
  const failed = suite.tests.filter((it) => it.status === 'failed').length;
  const isOpen = filter !== 'all' || failed > 0 || view.search;
  return `
    <details class="suite ${failed ? 'has-failed' : ''}" ${isOpen ? 'open' : ''}>
      <summary>
        ${statusIcon(failed ? 'failed' : 'passed', 14)}
        <span class="suite-name">${escape(suite.name)}</span>
        <span class="grow"></span>
        <span class="dim">${failed ? `<span class="bad">${failed} failed</span> · ` : ''}${suite.tests.length} tests</span>
      </summary>
      <ul>${suite.shown.map(testItem).join('')}</ul>
    </details>`;
}

function testItem(test) {
  return `
    <li class="test ${test.status}">
      <div class="test-line">${statusIcon(test.status, 13)}<span class="test-name">${highlight(test.name)}</span><span class="grow"></span>${test.ms ? `<span class="dim">${formatDuration(test.ms)}</span>` : ''}</div>
      ${test.message && test.status === 'failed' ? `<pre class="failure">${escape(test.message)}</pre>` : ''}
    </li>`;
}

function highlight(name) {
  const text = escape(name);
  if (!view.search) return text.replace(/ (&gt;|›) /g, ' <span class="sep">›</span> ');
  const escapedSearch = escape(view.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(escapedSearch, 'gi'), (found) => `<mark>${found}</mark>`);
}

// ── small parts ──

function sumCounts(steps) {
  const sum = { passed: 0, failed: 0, skipped: 0, total: 0 };
  for (const step of steps) {
    const counts = step.report?.counts ?? step.counts;
    if (!counts) continue;
    for (const key of Object.keys(sum)) sum[key] += counts[key];
  }
  return sum;
}

function runningFor(run) {
  return run.startedAt && !run.finishedAt ? Date.now() - Date.parse(run.startedAt) : null;
}

const STATUS_TEXT = { passed: 'Passed', failed: 'Failed', running: 'Running', queued: 'Queued', waiting: 'Waiting', skipped: 'Skipped', interrupted: 'Interrupted' };

function statusBadge(status) {
  return `<span class="badge ${status}">${statusIcon(status, 14)}${STATUS_TEXT[status] ?? status}</span>`;
}

function statusIcon(status, size = 16) {
  const shapes = {
    passed: '<circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M4.8 8.3l2.2 2.2 4.2-4.6" stroke="var(--icon-ink)" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    failed: '<circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M5.5 5.5l5 5m0-5l-5 5" stroke="var(--icon-ink)" stroke-width="1.8" stroke-linecap="round"/>',
    running: '<circle cx="8" cy="8" r="6.2" stroke="currentColor" stroke-opacity=".25" stroke-width="2" fill="none"/><path d="M8 1.8a6.2 6.2 0 0 1 6.2 6.2" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>',
    queued: '<circle cx="8" cy="8" r="6.2" stroke="currentColor" stroke-width="1.6" fill="none" stroke-dasharray="2.4 2.2"/>',
    waiting: '<circle cx="8" cy="8" r="6.2" stroke="currentColor" stroke-width="1.6" fill="none" stroke-dasharray="2.4 2.2"/>',
    skipped: '<circle cx="8" cy="8" r="6.2" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M5.2 8h5.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    interrupted: '<circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M8 4.5v4.2M8 11.2v.3" stroke="var(--icon-ink)" stroke-width="1.8" stroke-linecap="round"/>',
  };
  return `<svg class="icon ${status}" width="${size}" height="${size}" viewBox="0 0 16 16" aria-label="${status}">${shapes[status] ?? shapes.waiting}</svg>`;
}

function outcomeChip(run) {
  if (run.released) return '<span class="released">released</span>';
  return run.merged ? '<span class="released">merged into main</span>' : '';
}

function projectChip(project) {
  return view.projects.length > 1 && project ? `<span class="project">${escape(findProjectName(project))}</span>` : '';
}

function branchChip(branch) {
  const icon = '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="4" cy="3.5" r="1.8"/><circle cx="4" cy="12.5" r="1.8"/><circle cx="12" cy="5" r="1.8"/><path d="M4 5.3v5.4M12 6.8c0 3-8 2-8 3.9"/></svg>';
  return branch ? `<span class="branch">${icon}${escape(branch)}</span>` : '';
}

function formatDuration(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '–';
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} min ${seconds % 60} s` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function formatAgo(iso) {
  if (!iso) return '';
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function showToast(text) {
  const toast = Object.assign(document.createElement('div'), { className: 'toast', textContent: text });
  document.body.append(toast);
  setTimeout(() => toast.remove(), 5000);
}

function escape(text) {
  return String(text ?? '').replace(/[&<>"']/g, (it) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[it]);
}
