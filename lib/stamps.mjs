// A job's prepare step runs only when its inputs changed: a hash of the input files of the commit under test, kept as a
// stamp in the CI's data once the step passed.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** sha256 over the path and content of every file under the inputs; a missing input counts too. */
export async function hashInputs(workspace, inputs) {
  const hash = createHash('sha256');
  for (const input of [...inputs].sort()) {
    const files = await listFiles(path.join(workspace, input));
    if (!files.length) hash.update(`missing ${input}\0`);
    for (const file of files) {
      hash.update(`${path.relative(workspace, file)}\0`);
      hash.update(await fs.readFile(file));
      hash.update('\0');
    }
  }
  return hash.digest('hex');
}

export async function findStamp(file) {
  return (await fs.readFile(file, 'utf8').catch(() => '')).trim() || undefined;
}

export async function writeStamp(file, hash) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${hash}\n`);
}

async function listFiles(target) {
  const stat = await fs.stat(target).catch(() => null);
  if (!stat) return [];
  if (stat.isFile()) return [target];
  const entries = await fs.readdir(target, { recursive: true, withFileTypes: true });
  return entries.filter((it) => it.isFile()).map((it) => path.join(it.parentPath, it.name)).sort();
}
