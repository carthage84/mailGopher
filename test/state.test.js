import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobState, normalizeMessageId } from '../src/store/state.js';

describe('normalizeMessageId', () => {
  it('strips angle brackets and lowercases', () => {
    assert.equal(normalizeMessageId('<AbC@Example.COM>'), 'abc@example.com');
    assert.equal(normalizeMessageId('  x@y.z  '), 'x@y.z');
  });
});

describe('JobState', () => {
  it('persists seen message ids and pop3 uids', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailgopher-'));
    const a = new JobState(dir, 'job-1').load();
    assert.equal(a.hasSeenMessageId('<one@test>'), false);
    a.markSeenMessageId('<one@test>');
    a.markPop3Uid('uid-99');
    a.save();

    const b = new JobState(dir, 'job-1').load();
    assert.equal(b.hasSeenMessageId('<ONE@test>'), true);
    assert.equal(b.hasPop3Uid('uid-99'), true);
    assert.equal(b.hasPop3Uid('other'), false);
  });
});
