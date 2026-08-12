import { fetchImapMessages, closeImapSession } from '../fetchers/imap.js';
import { fetchPop3Messages } from '../fetchers/pop3.js';
import { JobState, normalizeMessageId } from '../store/state.js';
import { log } from '../logger.js';

/**
 * Run a single sync job once: fetch from source → insert into Gmail.
 */
export async function runJobOnce(job, gmailClients, stateDir) {
  const opts = {
    intervalMinutes: 30,
    leaveOnServer: true,
    markAsRead: false,
    deleteAfterImport: false,
    maxMessagesPerRun: 100,
    ...(job.options || {}),
  };

  // deleteAfterImport implies not leaving on server
  if (opts.deleteAfterImport) {
    opts.leaveOnServer = false;
  }

  const state = new JobState(stateDir, job.id).load();
  state.data.lastRunAt = new Date().toISOString();
  state.data.lastError = null;

  const destKey = job.destination.gmailAccount;
  const gmail = gmailClients.get(destKey);
  if (!gmail) {
    throw new Error(`No Gmail client for account "${destKey}"`);
  }
  gmail.ensureConfigured();

  const labels = job.destination.labels || (job.destination.label ? [job.destination.label] : []);
  const protocol = String(job.source.protocol).toLowerCase();

  log.info(`[job:${job.id}] Starting ${protocol.toUpperCase()} → gmail:${destKey}`);

  let session;
  let imported = 0;
  let skipped = 0;
  let errors = 0;

  try {
    if (protocol === 'imap') {
      session = await fetchImapMessages(job.source, state, opts);
    } else if (protocol === 'pop3') {
      session = await fetchPop3Messages(job.source, state, opts);
    } else {
      throw new Error(`Unsupported protocol: ${protocol}`);
    }

    const { messages, afterImport, updateState } = session;
    log.info(`[job:${job.id}] Fetched ${messages.length} candidate message(s)`);

    for (const msg of messages) {
      const mid = msg.messageId ? normalizeMessageId(msg.messageId) : null;
      if (mid && state.hasSeenMessageId(mid)) {
        skipped++;
        // Still advance POP3 UIDL so we don't re-download
        if (protocol === 'pop3') state.markPop3Uid(msg.uid);
        continue;
      }

      try {
        await gmail.insertRaw(msg.raw, labels);
        if (mid) state.markSeenMessageId(mid);
        if (protocol === 'pop3') state.markPop3Uid(msg.uid);

        if (afterImport) {
          await afterImport(msg, {
            markAsRead: opts.markAsRead,
            deleteAfterImport: opts.deleteAfterImport,
          });
        }

        imported++;
        log.info(
          `[job:${job.id}] Imported${msg.subject ? `: ${truncate(msg.subject, 80)}` : ''} (${mid || 'no-message-id'})`,
        );
      } catch (err) {
        errors++;
        log.error(`[job:${job.id}] Failed to import message: ${err.message}`);
      }
    }

    if (updateState) updateState();

    state.data.lastSuccessAt = new Date().toISOString();
    state.data.stats.imported += imported;
    state.data.stats.skipped += skipped;
    state.data.stats.errors += errors;
    state.save();

    log.info(
      `[job:${job.id}] Done — imported=${imported} skipped=${skipped} errors=${errors}`,
    );

    return { imported, skipped, errors };
  } catch (err) {
    state.data.lastError = err.message;
    state.save();
    throw err;
  } finally {
    if (protocol === 'imap') {
      await closeImapSession(session);
    } else if (session?.close) {
      await session.close();
    }
  }
}

function truncate(s, n) {
  const t = String(s);
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
