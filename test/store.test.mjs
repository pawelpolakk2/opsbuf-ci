import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Store } from '../lib/store.mjs';

test('saves of one run at the same time all land, and run.json keeps the last state', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opsbuf-ci-store-'));
  const store = new Store(root, 10);
  await store.init();
  const run = { id: 1, status: 'running', steps: [] };

  const saves = [];
  for (let index = 1; index <= 20; index++) {
    run.note = `save ${index}`;
    saves.push(store.save(run));
  }
  await Promise.all(saves);

  const saved = JSON.parse(fs.readFileSync(path.join(root, 'runs', '1', 'run.json'), 'utf8'));
  assert.equal(saved.note, 'save 20');
});
