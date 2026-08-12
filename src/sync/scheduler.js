import { runJobOnce } from './job.js';
import { runImapIdle } from '../fetchers/imap.js';
import { log } from '../logger.js';

/**
 * Schedule enabled jobs. IMAP jobs with idle:true get a dedicated IDLE loop
 * plus an initial sync; others poll on intervalMinutes.
 */
export function startScheduler(config, gmailClients) {
  const stateDir = config.settings.stateDir || './data';
  const jobs = (config.jobs || []).filter((j) => j.enabled !== false);
  const controllers = [];
  const timers = [];

  if (jobs.length === 0) {
    log.warn('No enabled jobs in config');
    return { stop: () => {} };
  }

  log.info(`Starting scheduler with ${jobs.length} job(s)`);

  for (const job of jobs) {
    const intervalMs = Math.max(1, Number(job.options?.intervalMinutes || 30)) * 60 * 1000;
    const protocol = String(job.source.protocol).toLowerCase();
    const useIdle = protocol === 'imap' && job.source.idle === true;

    // Always run once at startup
    queueMicrotask(() => {
      runSafe(job, gmailClients, stateDir);
    });

    if (useIdle) {
      const ac = new AbortController();
      controllers.push(ac);
      // Debounce IDLE notifications so a burst of EXISTS doesn't thrash
      let debounce = null;
      const onNotify = () =>
        new Promise((resolve) => {
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(async () => {
            await runSafe(job, gmailClients, stateDir);
            resolve();
          }, 2000);
        });

      (async () => {
        while (!ac.signal.aborted) {
          try {
            await runImapIdle(job.source, onNotify, ac.signal);
          } catch (err) {
            if (ac.signal.aborted) break;
            log.error(`[job:${job.id}] IDLE error: ${err.message}; retrying in 30s`);
            await sleep(30_000, ac.signal);
          }
        }
      })();

      // Backup poll in case IDLE drops events
      const t = setInterval(() => runSafe(job, gmailClients, stateDir), intervalMs);
      timers.push(t);
      log.info(`[job:${job.id}] IMAP IDLE + backup poll every ${intervalMs / 60000}m`);
    } else {
      const t = setInterval(() => runSafe(job, gmailClients, stateDir), intervalMs);
      timers.push(t);
      log.info(`[job:${job.id}] Polling every ${intervalMs / 60000}m`);
    }
  }

  return {
    stop() {
      for (const t of timers) clearInterval(t);
      for (const c of controllers) c.abort();
      log.info('Scheduler stopped');
    },
  };
}

/**
 * Run all enabled jobs once (for --once mode).
 */
export async function runAllOnce(config, gmailClients) {
  const stateDir = config.settings.stateDir || './data';
  const jobs = (config.jobs || []).filter((j) => j.enabled !== false);
  const results = [];
  for (const job of jobs) {
    try {
      const r = await runJobOnce(job, gmailClients, stateDir);
      results.push({ id: job.id, ok: true, ...r });
    } catch (err) {
      log.error(`[job:${job.id}] ${err.message}`);
      results.push({ id: job.id, ok: false, error: err.message });
    }
  }
  return results;
}

async function runSafe(job, gmailClients, stateDir) {
  try {
    await runJobOnce(job, gmailClients, stateDir);
  } catch (err) {
    log.error(`[job:${job.id}] ${err.message}`);
  }
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}
