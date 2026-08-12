import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { log } from '../logger.js';

/**
 * Fetch new messages from an IMAP mailbox.
 *
 * Strategy:
 *  - Prefer UID-based fetch using stored uidValidity / last uid
 *  - Fall back to UNSEEN or recent messages if no cursor
 *  - Returns raw RFC822 buffers + metadata; does not talk to Gmail
 *
 * @param {object} source - job.source config
 * @param {import('../store/state.js').JobState} state
 * @param {object} options
 * @returns {Promise<{messages: Array, updateState: Function, client: ImapFlow|null}>}
 */
export async function fetchImapMessages(source, state, options = {}) {
  const folder = source.folder || 'INBOX';
  const max = options.maxMessagesPerRun ?? 100;

  const client = new ImapFlow({
    host: source.host,
    port: source.port || (source.secure === false ? 143 : 993),
    secure: source.secure !== false,
    auth: {
      user: source.user,
      pass: source.password,
    },
    logger: false,
    tls: {
      rejectUnauthorized: source.rejectUnauthorized !== false,
    },
  });

  // STARTTLS on non-secure port is handled by imapflow when secure:false
  // (it upgrades automatically on most servers). Explicit flag kept for docs.

  await client.connect();
  log.debug(`[imap] Connected to ${source.host} as ${source.user}`);

  const lock = await client.getMailboxLock(folder);
  try {
    const mailbox = client.mailbox;
    const uidValidity = Number(mailbox.uidValidity);
    let sinceUid = 0;

    if (
      state.data.imapUidValidity &&
      Number(state.data.imapUidValidity) === uidValidity &&
      state.data.imapUidNext
    ) {
      // uidNext is the next UID that will be assigned; fetch UIDs >= previous uidNext
      // After last run we stored the highest processed+1 conceptually as uidNext snapshot
      sinceUid = Number(state.data.imapLastUid || 0);
    } else if (state.data.imapUidValidity && Number(state.data.imapUidValidity) !== uidValidity) {
      log.warn(
        `[imap:${source.user}] UIDVALIDITY changed (${state.data.imapUidValidity} → ${uidValidity}); re-scanning recent mail`,
      );
      sinceUid = 0;
    }

    const messages = [];
    let highestUid = sinceUid;

    // If mailbox empty, just record cursor
    if (mailbox.exists === 0) {
      return {
        messages: [],
        updateState: () => {
          state.data.imapUidValidity = uidValidity;
          state.data.imapUidNext = mailbox.uidNext;
          state.data.imapLastUid = highestUid;
        },
        client,
        lock,
        folder,
      };
    }

    // UID range when we have a cursor; sequence range on first run (last N messages)
    let range;
    let useUidQuery = false;
    if (sinceUid > 0) {
      range = `${sinceUid + 1}:*`;
      useUidQuery = true;
    } else {
      const exists = mailbox.exists || 0;
      const start = Math.max(1, exists - max + 1);
      range = `${start}:*`;
      log.info(
        `[imap] First run (or no cursor) for ${folder}: fetching up to last ${max} of ${exists} messages`,
      );
    }

    for await (const msg of client.fetch(
      range,
      { uid: true, source: true, envelope: true, flags: true },
      useUidQuery ? { uid: true } : {},
    )) {
      if (!msg.source) continue;
      const uid = msg.uid;
      if (uid <= sinceUid) continue;

      highestUid = Math.max(highestUid, uid);
      const raw = Buffer.isBuffer(msg.source) ? msg.source : Buffer.from(msg.source);

      let messageId = msg.envelope?.messageId || null;
      if (!messageId) {
        try {
          const parsed = await simpleParser(raw);
          messageId = parsed.messageId || null;
        } catch {
          /* ignore */
        }
      }

      messages.push({
        uid,
        raw,
        messageId,
        subject: msg.envelope?.subject || null,
        date: msg.envelope?.date || null,
        flags: msg.flags || new Set(),
      });

      if (messages.length >= max) {
        log.info(`[imap] Hit maxMessagesPerRun=${max}; remaining mail will sync next run`);
        break;
      }
    }

    // Sort by UID ascending for stable import order
    messages.sort((a, b) => a.uid - b.uid);

    return {
      messages,
      updateState: () => {
        state.data.imapUidValidity = uidValidity;
        state.data.imapUidNext = mailbox.uidNext;
        state.data.imapLastUid = highestUid || state.data.imapLastUid || 0;
      },
      /**
       * Post-import actions on the source message.
       */
      async afterImport(msg, opts) {
        if (opts.markAsRead) {
          await client.messageFlagsAdd({ uid: msg.uid }, ['\\Seen'], { uid: true });
        }
        if (opts.deleteAfterImport) {
          await client.messageDelete({ uid: msg.uid }, { uid: true });
        }
      },
      client,
      lock,
      folder,
    };
  } catch (err) {
    lock.release();
    try {
      await client.logout();
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/**
 * Release IMAP lock and disconnect.
 */
export async function closeImapSession(session) {
  if (!session) return;
  try {
    session.lock?.release();
  } catch {
    /* ignore */
  }
  try {
    if (session.client?.usable) {
      await session.client.logout();
    }
  } catch {
    /* ignore */
  }
}

/**
 * Run IMAP IDLE until abort, calling onNotify when new mail may be available.
 */
export async function runImapIdle(source, onNotify, abortSignal) {
  const folder = source.folder || 'INBOX';
  const client = new ImapFlow({
    host: source.host,
    port: source.port || 993,
    secure: source.secure !== false,
    auth: { user: source.user, pass: source.password },
    logger: false,
  });

  await client.connect();
  const lock = await client.getMailboxLock(folder);

  const onExists = async () => {
    try {
      await onNotify();
    } catch (err) {
      log.error(`[imap-idle] notify handler error:`, err.message);
    }
  };

  client.on('exists', onExists);

  log.info(`[imap-idle] Watching ${source.host}/${folder} for ${source.user}`);

  const cleanup = async () => {
    client.off('exists', onExists);
    try {
      lock.release();
    } catch {
      /* ignore */
    }
    try {
      await client.logout();
    } catch {
      /* ignore */
    }
  };

  if (abortSignal?.aborted) {
    await cleanup();
    return;
  }

  await new Promise((resolve) => {
    const onAbort = () => {
      abortSignal?.removeEventListener('abort', onAbort);
      resolve();
    };
    abortSignal?.addEventListener('abort', onAbort);

    // Keep connection alive; imapflow handles IDLE internally while mailbox is locked
    // and no other commands are running. We idle by waiting on abort.
  });

  await cleanup();
}
