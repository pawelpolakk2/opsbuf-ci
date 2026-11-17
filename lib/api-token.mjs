// Starting or cancelling a job runs code on the mini, so the API takes a token: the content of "apiTokenFile".
import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Accepts "Bearer <token>"; throws a 401 otherwise, and always when no token file is configured or readable. */
export async function requireToken(authorization, tokenFile) {
  const expected = await readToken(tokenFile);
  const given = /^Bearer (.+)$/.exec(authorization ?? '')?.[1]?.trim() ?? '';
  if (!expected) throw unauthorized('The CI has no token (apiTokenFile in config.json), so it starts and cancels nothing from the API.');
  if (!isSameText(given, expected)) throw unauthorized('This needs the CI token: Authorization: Bearer <token>.');
}

async function readToken(tokenFile) {
  if (!tokenFile) return '';
  const file = tokenFile.startsWith('~/') ? path.join(os.homedir(), tokenFile.slice(2)) : tokenFile;
  return (await fs.readFile(file, 'utf8').catch(() => '')).trim();
}

function isSameText(given, expected) {
  const left = Buffer.from(given);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

const unauthorized = (message) => Object.assign(new Error(message), { status: 401 });
