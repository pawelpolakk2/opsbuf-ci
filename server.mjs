#!/usr/bin/env node
// opsbuf-ci: a small CI for the opsbuf repo. One process serves the page (public/) and the API (/api) on 127.0.0.1.
import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './lib/store.mjs';
import { Runner } from './lib/runner.mjs';

const appDir = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await fs.readFile(process.env.OPSBUF_CI_CONFIG || path.join(appDir, 'config.json'), 'utf8'));
const port = Number(process.env.OPSBUF_CI_PORT || config.port || 7460);
const dataDir = path.resolve(appDir, process.env.OPSBUF_CI_DATA || config.data || 'data');
const publicUrl = process.env.OPSBUF_CI_PUBLIC_URL || `http://127.0.0.1:${port}`;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const store = new Store(dataDir, config.keepRuns ?? 100);
await store.init();
await fs.mkdir(dataDir, { recursive: true });
const runner = new Runner({ store, config, dataDir });
await runner.assignProjectToOldRuns();
await runner.markInterruptedRuns();

const routes = [
  ['GET', /^\/api\/health$/, () => ({ status: 'ok', projects: config.projects.map((it) => it.id), isBusy: runner.isBusy, queued: runner.queue.length })],
  ['GET', /^\/api\/projects$/, () => config.projects.map(({ id, name, defaultBranch }) => ({ id, name: name ?? id, defaultBranch: defaultBranch ?? 'main' }))],
  ['GET', /^\/api\/runs$/, () => store.list().map(toSummary)],
  ['GET', /^\/api\/runs\/(\d+)$/, (request, [id]) => requireRun(id)],
  ['GET', /^\/api\/branches$/, (request, ignored, url) => runner.listBranches(url.searchParams.get('project'))],
  ['POST', /^\/api\/runs$/, async (request) => enqueueFrom(await readJson(request))],
];

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, publicUrl);
  try {
    if (url.pathname.startsWith('/api/')) return await answerApi(request, response, url);
    return await serveStatic(response, url.pathname);
  } catch (error) {
    sendJson(response, error.status ?? 500, { error: error.message });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`opsbuf-ci  ${publicUrl}`);
  console.log(`projects   ${config.projects.map((it) => `${it.id} (${it.repo})`).join(', ')}`);
  console.log(`data       ${dataDir} (${store.list().length} runs)`);
});

async function answerApi(request, response, url) {
  refuseOtherSites(request);
  const artifact = /^\/api\/runs\/(\d+)\/artifacts\/([^/]+)$/.exec(url.pathname);
  if (artifact && request.method === 'GET') return sendArtifact(response, Number(artifact[1]), decodeURIComponent(artifact[2]));
  const latest = /^\/api\/projects\/([\w.-]+)\/latest$/.exec(url.pathname);
  if (latest && request.method === 'GET') return redirectToLatestArtifact(response, latest[1]);
  const log = /^\/api\/runs\/(\d+)\/steps\/(\d+)\/log$/.exec(url.pathname);
  if (log && request.method === 'GET') return sendLog(response, Number(log[1]), Number(log[2]), Number(url.searchParams.get('from') || 0));
  for (const [method, pattern, answer] of routes) {
    const match = pattern.exec(url.pathname);
    if (match && method === request.method) {
      const body = await answer(request, match.slice(1), url);
      return sendJson(response, method === 'POST' ? 201 : 200, body);
    }
  }
  sendJson(response, 404, { error: `No ${request.method} ${url.pathname}. The API: GET /api/runs, /api/runs/12, POST /api/runs {"project": "opsbuf-app", "branch": "main"}.` });
}

function refuseOtherSites(request) {
  const origin = request.headers.origin;
  if (request.method !== 'GET' && origin && new URL(origin).host !== request.headers.host) {
    throw Object.assign(new Error('This request came from another site.'), { status: 403 });
  }
}

function requireRun(id) {
  const found = store.find(Number(id));
  if (!found) throw Object.assign(new Error(`There is no run #${id}.`), { status: 404 });
  return found;
}

function enqueueFrom(body) {
  const readText = (key) => (typeof body[key] === 'string' && body[key] ? body[key] : undefined);
  const sha = /^[0-9a-f]{7,40}$/.test(readText('sha') ?? '') ? body.sha : null;
  return runner.enqueue({ project: readText('project'), branch: readText('branch'), sha, trigger: readText('trigger') ?? 'manual' });
}

function toSummary(run) {
  return { ...run, steps: run.steps.map(({ report, ...step }) => ({ ...step, counts: report?.counts ?? null })) };
}

async function sendLog(response, id, stepIndex, from) {
  requireRun(id);
  const text = await fs.readFile(store.logPath(id, stepIndex)).catch(() => Buffer.alloc(0));
  response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'x-log-size': String(text.length), 'cache-control': 'no-store' });
  response.end(text.subarray(Math.min(from, text.length)));
}

async function sendArtifact(response, id, name) {
  requireRun(id);
  if (name.includes('/') || name.startsWith('.')) throw Object.assign(new Error('Not found.'), { status: 404 });
  const file = path.join(store.artifactsDir(id), name);
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) throw Object.assign(new Error(`Run #${id} has no file ${name}.`), { status: 404 });
  response.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': String(stat.size),
    'content-disposition': `attachment; filename="${name.replace(/"/g, '')}"`,
  });
  createReadStream(file).pipe(response);
}

/** The newest released file of a project, at a link that never changes: /api/projects/opsbuf-app/latest. */
function redirectToLatestArtifact(response, project) {
  const run = store.list().find((it) => it.project === project && it.released && it.artifacts?.length);
  if (!run) throw Object.assign(new Error(`${project} has no released file yet.`), { status: 404 });
  response.writeHead(302, { location: `/api/runs/${run.id}/artifacts/${encodeURIComponent(run.artifacts[0].name)}` });
  response.end();
}

async function serveStatic(response, pathname) {
  const file = path.join(appDir, 'public', pathname === '/' ? 'index.html' : path.normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(path.join(appDir, 'public'))) return sendJson(response, 404, { error: 'Not found.' });
  const body = await fs.readFile(file).catch(() => null);
  if (!body) return sendJson(response, 404, { error: 'Not found.' });
  response.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  response.end(body);
}

async function readJson(request) {
  let text = '';
  for await (const chunk of request) text += chunk;
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw Object.assign(new Error('The body is not JSON.'), { status: 400 });
  }
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}
