#!/usr/bin/env node
/**
 * MailGopher — personal multi-mailbox importer (MailPorter-style).
 *
 * Usage:
 *   node src/index.js                 # run scheduler (daemon)
 *   node src/index.js --once          # run all jobs once and exit
 *   node src/index.js --config path   # custom config path
 *   node src/index.js --job <id>      # only run specific job(s), comma-separated
 */
import { loadConfig } from './config.js';
import { createGmailClients } from './gmail/client.js';
import { runAllOnce, startScheduler } from './sync/scheduler.js';
import { log, setLogLevel } from './logger.js';

function parseArgs(argv) {
  const out = { once: false, config: null, job: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--once') out.once = true;
    else if (a === '--config' || a === '-c') out.config = argv[++i];
    else if (a === '--job' || a === '-j') out.job = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function usage() {
  console.log(`MailGopher — import email from POP3/IMAP into Gmail

Usage:
  npm start                      Start continuous sync
  npm run sync-once              Run all enabled jobs once
  npm run auth -- --account X    OAuth a Gmail destination account

Options:
  --once              Run enabled jobs once and exit
  --config <path>     Config file (default: ./config.yaml)
  --job <id[,id…]>    Only these job ids
  --help              Show help

Secrets (no built-in vault — use the OS):
  password: "file:/path/to/secret"     chmod 600 files, or systemd credentials
  password: "env:MY_PASSWORD"          inject via systemd Environment / EnvironmentFile

Setup:
  1. cp config.example.yaml config.yaml
  2. Put secrets in files (chmod 600) or env; reference with file: / env:
  3. npm run auth -- --account personal
  4. npm start
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    process.exit(0);
  }

  const config = loadConfig(args.config);
  setLogLevel(config.settings?.logLevel || 'info');

  if (args.job) {
    const want = new Set(
      args.job
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
    config.jobs = config.jobs.map((j) => ({
      ...j,
      enabled: want.has(j.id) ? true : false,
    }));
    const enabled = config.jobs.filter((j) => j.enabled);
    if (enabled.length === 0) {
      log.error(`No jobs matched --job ${args.job}`);
      process.exit(1);
    }
  }

  const gmailClients = createGmailClients(config.gmailAccounts);

  for (const job of config.jobs.filter((j) => j.enabled !== false)) {
    const key = job.destination.gmailAccount;
    const client = gmailClients.get(key);
    try {
      client.ensureConfigured();
    } catch (err) {
      log.error(err.message);
      process.exit(1);
    }
  }

  if (args.once) {
    const results = await runAllOnce(config, gmailClients);
    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      log.error(`${failed.length} job(s) failed`);
      process.exit(1);
    }
    log.info('All jobs completed');
    process.exit(0);
  }

  const scheduler = startScheduler(config, gmailClients);

  const shutdown = (sig) => {
    log.info(`Received ${sig}, shutting down…`);
    scheduler.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  log.info('MailGopher is running. Press Ctrl+C to stop.');
}

main().catch((err) => {
  log.error(err.stack || err.message || err);
  process.exit(1);
});
