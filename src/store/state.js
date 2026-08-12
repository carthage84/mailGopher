import fs from 'node:fs';
import path from 'node:path';
import { log } from '../logger.js';

/**
 * Persistent per-job state for Message-ID dedupe and protocol cursors.
 * Stored as JSON under stateDir/jobs/<jobId>.json
 */
export class JobState {
  constructor(stateDir, jobId) {
    this.jobId = jobId;
    this.dir = path.join(stateDir, 'jobs');
    this.file = path.join(this.dir, `${sanitize(jobId)}.json`);
    this.data = {
      jobId,
      seenMessageIds: {},
      // IMAP: last processed UID (per folder)
      imapUidNext: null,
      imapUidValidity: null,
      // POP3: last known UIDL set / watermark
      pop3SeenUids: {},
      lastRunAt: null,
      lastSuccessAt: null,
      lastError: null,
      stats: { imported: 0, skipped: 0, errors: 0 },
    };
  }

  load() {
    fs.mkdirSync(this.dir, { recursive: true });
    if (fs.existsSync(this.file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.data = { ...this.data, ...parsed, jobId: this.jobId };
      } catch (err) {
        log.warn(`Could not parse state for ${this.jobId}, starting fresh:`, err.message);
      }
    }
    return this;
  }

  save() {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  hasSeenMessageId(messageId) {
    if (!messageId) return false;
    return Boolean(this.data.seenMessageIds[normalizeMessageId(messageId)]);
  }

  markSeenMessageId(messageId) {
    if (!messageId) return;
    this.data.seenMessageIds[normalizeMessageId(messageId)] = Date.now();
    this.pruneSeen();
  }

  /**
   * Keep only the newest N message IDs so the file does not grow forever.
   */
  pruneSeen(max = 50000) {
    const entries = Object.entries(this.data.seenMessageIds);
    if (entries.length <= max) return;
    entries.sort((a, b) => a[1] - b[1]);
    const drop = entries.length - max;
    for (let i = 0; i < drop; i++) {
      delete this.data.seenMessageIds[entries[i][0]];
    }
  }

  hasPop3Uid(uid) {
    return Boolean(this.data.pop3SeenUids[String(uid)]);
  }

  markPop3Uid(uid) {
    this.data.pop3SeenUids[String(uid)] = Date.now();
    const entries = Object.entries(this.data.pop3SeenUids);
    if (entries.length > 20000) {
      entries.sort((a, b) => a[1] - b[1]);
      for (let i = 0; i < entries.length - 20000; i++) {
        delete this.data.pop3SeenUids[entries[i][0]];
      }
    }
  }
}

function sanitize(id) {
  return String(id).replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function normalizeMessageId(id) {
  return String(id).trim().replace(/^<|>$/g, '').toLowerCase();
}
