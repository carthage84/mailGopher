import net from 'node:net';
import tls from 'node:tls';
import { simpleParser } from 'mailparser';
import { log } from '../logger.js';

/**
 * Minimal promise-based POP3 client (TLS or plain).
 * Avoids third-party POP3 deps with outdated transitive packages.
 */
class Pop3Client {
  constructor() {
    this.socket = null;
    this.buffer = '';
    this.pending = null;
    this.closed = false;
  }

  connect({ host, port, secure = true, rejectUnauthorized = true, timeoutMs = 60_000 }) {
    return new Promise((resolve, reject) => {
      const onConnect = () => {
        /* wait for +OK greeting via readResponse */
      };

      const sock = secure
        ? tls.connect({ host, port, rejectUnauthorized, servername: host }, onConnect)
        : net.connect({ host, port }, onConnect);

      this.socket = sock;
      sock.setEncoding('utf8');
      sock.setTimeout(timeoutMs);

      sock.on('data', (chunk) => this.#onData(chunk));
      sock.on('error', (err) => {
        if (this.pending) {
          const p = this.pending;
          this.pending = null;
          p.reject(err);
        } else {
          reject(err);
        }
      });
      sock.on('timeout', () => {
        sock.destroy(new Error('POP3 socket timeout'));
      });
      sock.on('close', () => {
        this.closed = true;
        if (this.pending) {
          const p = this.pending;
          this.pending = null;
          p.reject(new Error('POP3 connection closed'));
        }
      });

      this.#readLineResponse()
        .then((greeting) => {
          if (!greeting.ok) reject(new Error(`POP3 greeting failed: ${greeting.text}`));
          else resolve(greeting);
        })
        .catch(reject);
    });
  }

  async login(user, pass) {
    await this.command(`USER ${user}`);
    await this.command(`PASS ${pass}`);
  }

  /**
   * @returns {Promise<Array<{num: number, uid: string}>>}
   */
  async uidl() {
    const res = await this.command('UIDL', { multiline: true });
    const items = [];
    for (const line of res.lines) {
      const m = /^(\d+)\s+(\S+)/.exec(line.trim());
      if (m) items.push({ num: Number(m[1]), uid: m[2] });
    }
    return items;
  }

  /**
   * @returns {Promise<Buffer>}
   */
  async retr(num) {
    const res = await this.command(`RETR ${num}`, { multiline: true });
    // POP3 dot-stuffing: lines starting with ".." become "."
    const unstuffed = res.lines.map((l) => (l.startsWith('..') ? l.slice(1) : l));
    return Buffer.from(unstuffed.join('\r\n'), 'utf8');
  }

  async dele(num) {
    await this.command(`DELE ${num}`);
  }

  async quit() {
    try {
      if (!this.closed && this.socket) {
        await this.command('QUIT');
      }
    } catch {
      /* ignore */
    }
    this.#destroy();
  }

  /**
   * @param {string} cmd
   * @param {{multiline?: boolean}} opts
   */
  command(cmd, opts = {}) {
    if (!this.socket || this.closed) {
      return Promise.reject(new Error('POP3 not connected'));
    }
    if (this.pending) {
      return Promise.reject(new Error('POP3 command already in flight'));
    }

    return new Promise((resolve, reject) => {
      this.pending = {
        multiline: Boolean(opts.multiline),
        lines: [],
        resolve,
        reject,
        mode: 'status',
      };
      this.socket.write(`${cmd}\r\n`);
    });
  }

  #onData(chunk) {
    this.buffer += chunk;
    this.#pump();
  }

  #pump() {
    if (!this.pending) return;

    if (this.pending.mode === 'status') {
      const idx = this.buffer.indexOf('\n');
      if (idx === -1) return;
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      const ok = line.startsWith('+OK');
      const text = line.replace(/^\+OK\s?/, '').replace(/^-ERR\s?/, '');
      if (!ok) {
        const p = this.pending;
        this.pending = null;
        p.reject(new Error(text || line));
        return;
      }
      if (!this.pending.multiline) {
        const p = this.pending;
        this.pending = null;
        p.resolve({ ok: true, text, lines: [] });
        return;
      }
      this.pending.mode = 'body';
      this.#pump();
      return;
    }

    // multiline body until lone "."
    while (this.pending) {
      const idx = this.buffer.indexOf('\n');
      if (idx === -1) return;
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      if (line === '.') {
        const p = this.pending;
        this.pending = null;
        p.resolve({ ok: true, text: '', lines: p.lines });
        return;
      }
      this.pending.lines.push(line);
    }
  }

  #readLineResponse() {
    return new Promise((resolve, reject) => {
      this.pending = {
        multiline: false,
        lines: [],
        mode: 'status',
        resolve,
        reject,
      };
      // greeting already arriving via data events
      this.#pump();
    });
  }

  #destroy() {
    try {
      this.socket?.destroy();
    } catch {
      /* ignore */
    }
    this.closed = true;
  }
}

/**
 * Fetch new POP3 messages (deduped by UIDL at job layer + Message-ID).
 */
export async function fetchPop3Messages(source, state, options = {}) {
  const max = options.maxMessagesPerRun ?? 100;
  const port = source.port || (source.secure === false ? 110 : 995);
  const secure = source.secure !== false;

  const client = new Pop3Client();
  await client.connect({
    host: source.host,
    port,
    secure,
    rejectUnauthorized: source.rejectUnauthorized !== false,
  });

  try {
    await client.login(source.user, source.password);
    log.debug(`[pop3] Logged in to ${source.host} as ${source.user}`);

    let items = [];
    try {
      items = await client.uidl();
    } catch (err) {
      log.warn(`[pop3] UIDL failed (${err.message}); cannot safely resume — skipping run`);
      return {
        messages: [],
        updateState: () => {},
        async afterImport() {},
        async close() {
          await client.quit();
        },
        client,
      };
    }

    items.sort((a, b) => a.num - b.num);
    const pending = items.filter((e) => !state.hasPop3Uid(e.uid));
    const toFetch = pending.length > max ? pending.slice(-max) : pending;

    if (pending.length > max) {
      log.info(`[pop3] ${pending.length} new messages; processing newest ${max} this run`);
    }

    const messages = [];
    for (const item of toFetch) {
      try {
        const raw = await client.retr(item.num);
        let messageId = null;
        let subject = null;
        try {
          const parsed = await simpleParser(raw);
          messageId = parsed.messageId || null;
          subject = parsed.subject || null;
        } catch {
          /* ignore parse errors */
        }
        messages.push({
          uid: item.uid,
          msgNumber: item.num,
          raw,
          messageId,
          subject,
        });
      } catch (err) {
        log.warn(`[pop3] Failed to RETR ${item.num}: ${err.message}`);
      }
    }

    return {
      messages,
      updateState: () => {},
      async afterImport(msg, opts) {
        state.markPop3Uid(msg.uid);
        if (opts.deleteAfterImport) {
          await client.dele(msg.msgNumber);
        }
      },
      async close() {
        await client.quit();
      },
      client,
    };
  } catch (err) {
    try {
      await client.quit();
    } catch {
      /* ignore */
    }
    throw err;
  }
}
