import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { fetchPop3Messages } from '../src/fetchers/pop3.js';
import { JobState } from '../src/store/state.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Tiny fake POP3 server for unit testing the client.
 */
function startFakePop3({ messages }) {
  // messages: [{ uid, raw }]
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let buf = '';
      let authed = false;
      socket.write('+OK fake pop3 ready\r\n');
      socket.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\r\n')) !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const [cmd, ...rest] = line.split(' ');
          const upper = cmd.toUpperCase();
          if (upper === 'USER') {
            socket.write('+OK user\r\n');
          } else if (upper === 'PASS') {
            authed = true;
            socket.write('+OK logged in\r\n');
          } else if (upper === 'UIDL' && authed) {
            socket.write(`+OK ${messages.length} messages\r\n`);
            messages.forEach((m, i) => socket.write(`${i + 1} ${m.uid}\r\n`));
            socket.write('.\r\n');
          } else if (upper === 'RETR' && authed) {
            const n = Number(rest[0]);
            const m = messages[n - 1];
            if (!m) {
              socket.write('-ERR no such message\r\n');
            } else {
              socket.write('+OK message follows\r\n');
              for (const l of m.raw.replace(/\r\n/g, '\n').split('\n')) {
                socket.write((l.startsWith('.') ? `.${l}` : l) + '\r\n');
              }
              socket.write('.\r\n');
            }
          } else if (upper === 'DELE' && authed) {
            socket.write('+OK deleted\r\n');
          } else if (upper === 'QUIT') {
            socket.write('+OK bye\r\n');
            socket.end();
          } else {
            socket.write('-ERR unknown\r\n');
          }
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

describe('fetchPop3Messages', () => {
  let server;
  let port;
  let stateDir;

  before(async () => {
    const raw = [
      'From: a@example.com',
      'To: b@example.com',
      'Subject: Hello',
      'Message-ID: <msg-1@example.com>',
      'Date: Mon, 1 Jan 2024 00:00:00 +0000',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Hi there',
    ].join('\r\n');

    ({ server, port } = await startFakePop3({
      messages: [{ uid: 'uid-abc', raw }],
    }));
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-pop3-'));
  });

  after(() => {
    server.close();
  });

  it('logs in, lists UIDL, retrieves new mail', async () => {
    const state = new JobState(stateDir, 'pop3-test').load();
    const session = await fetchPop3Messages(
      {
        host: '127.0.0.1',
        port,
        secure: false,
        user: 'u',
        password: 'p',
      },
      state,
      { maxMessagesPerRun: 10 },
    );

    assert.equal(session.messages.length, 1);
    assert.equal(session.messages[0].uid, 'uid-abc');
    assert.match(session.messages[0].messageId || '', /msg-1@example.com/i);

    await session.afterImport(session.messages[0], { deleteAfterImport: false });
    await session.close();

    assert.equal(state.hasPop3Uid('uid-abc'), true);

    // Second run should see nothing new
    const state2 = new JobState(stateDir, 'pop3-test').load();
    // mark was only in memory of first state — persist
    state.save();
    const state3 = new JobState(stateDir, 'pop3-test').load();
    // pop3 uids need to be saved — JobState.save saves whole data including pop3SeenUids
    const session2 = await fetchPop3Messages(
      {
        host: '127.0.0.1',
        port,
        secure: false,
        user: 'u',
        password: 'p',
      },
      state3,
      { maxMessagesPerRun: 10 },
    );
    // Without save after mark, state3 may not have it — we saved state after mark
    assert.equal(session2.messages.length, 0);
    await session2.close();
  });
});
