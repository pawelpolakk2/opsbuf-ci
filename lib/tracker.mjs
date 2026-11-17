// Notes on the tracker's tickets, written as author ci. Without "tracker" in config.json the CI writes none.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export class Tracker {
  constructor({ url, tokenFile }) {
    this.url = url;
    this.tokenFile = tokenFile;
  }

  static fromConfig(config) {
    if (!config.tracker) return null;
    return new Tracker({ url: config.tracker.url, tokenFile: expandHome(config.tracker.tokenFile) });
  }

  async addNote(issueId, text) {
    const token = (await fs.readFile(this.tokenFile, 'utf8')).trim();
    const response = await fetch(`${this.url}/api/issues/${issueId}/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ author: 'ci', text }),
    });
    if (!response.ok) throw new Error(`The tracker refused the note on #${issueId}: ${response.status} ${await response.text()}`);
  }
}

const expandHome = (file) => (file.startsWith('~/') ? path.join(os.homedir(), file.slice(2)) : file);
