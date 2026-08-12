import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { log } from './logger.js';
import { isSecretRef, applySecretsToConfig } from './secrets/resolve.js';

const DEFAULTS = {
  settings: {
    stateDir: './data',
    logLevel: 'info',
    // Refuse inline passwords / tokens in config.yaml (use file: or env:)
    allowPlaintextSecrets: false,
  },
};

/**
 * Resolve config path from CLI arg, env, or common filenames.
 */
export function resolveConfigPath(cliPath) {
  if (cliPath) return path.resolve(cliPath);
  if (process.env.MAILGOPHER_CONFIG) return path.resolve(process.env.MAILGOPHER_CONFIG);

  const candidates = ['config.yaml', 'config.yml', 'config.json'];
  for (const name of candidates) {
    const p = path.resolve(name);
    if (fs.existsSync(p)) return p;
  }
  return path.resolve('config.yaml');
}

function loadFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Config not found: ${filePath}\nCopy config.example.yaml to config.yaml and edit it.`,
    );
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  if (filePath.endsWith('.json')) {
    return JSON.parse(raw);
  }
  return YAML.parse(raw);
}

function applyEnvOverrides(config) {
  const accounts = config.gmailAccounts || {};
  for (const [key, account] of Object.entries(accounts)) {
    const envPrefix = `GMAIL_${key.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_`;
    if (process.env[`${envPrefix}EMAIL`]) {
      account.email = process.env[`${envPrefix}EMAIL`];
    }
  }
  return config;
}

function isSet(value) {
  return typeof value === 'string' && value.length > 0;
}

function validate(config) {
  if (!config.gmailAccounts || Object.keys(config.gmailAccounts).length === 0) {
    throw new Error('config.gmailAccounts must define at least one Gmail destination account');
  }
  if (!Array.isArray(config.jobs) || config.jobs.length === 0) {
    throw new Error('config.jobs must be a non-empty array');
  }

  for (const [key, acc] of Object.entries(config.gmailAccounts)) {
    if (!isSet(acc.clientId) && !isSecretRef(acc.clientId)) {
      throw new Error(`gmailAccounts.${key}: clientId is required`);
    }
    if (!isSet(acc.clientSecret) && !isSecretRef(acc.clientSecret)) {
      throw new Error(
        `gmailAccounts.${key}: clientSecret is required (e.g. "file:…/client-secret" or "env:…")`,
      );
    }
  }

  const accountKeys = new Set(Object.keys(config.gmailAccounts));
  const ids = new Set();

  for (const job of config.jobs) {
    if (!job.id) throw new Error('Each job needs an id');
    if (ids.has(job.id)) throw new Error(`Duplicate job id: ${job.id}`);
    ids.add(job.id);

    if (job.enabled === false) continue;

    const src = job.source;
    if (!src) throw new Error(`job ${job.id}: source is required`);
    const protocol = String(src.protocol || '').toLowerCase();
    if (protocol !== 'imap' && protocol !== 'pop3') {
      throw new Error(`job ${job.id}: source.protocol must be "imap" or "pop3"`);
    }
    if (!src.host || !src.user) {
      throw new Error(`job ${job.id}: source.host and source.user are required`);
    }
    if (!isSet(src.password) && !isSecretRef(src.password)) {
      throw new Error(
        `job ${job.id}: source.password is required (e.g. "file:…/password" or "env:…")`,
      );
    }

    const dest = job.destination;
    if (!dest?.gmailAccount) {
      throw new Error(`job ${job.id}: destination.gmailAccount is required`);
    }
    if (!accountKeys.has(dest.gmailAccount)) {
      throw new Error(
        `job ${job.id}: destination.gmailAccount "${dest.gmailAccount}" is not defined in gmailAccounts`,
      );
    }
  }

  return config;
}

function validateResolved(config) {
  for (const [key, acc] of Object.entries(config.gmailAccounts || {})) {
    if (!acc.clientSecret) {
      throw new Error(`gmailAccounts.${key}: clientSecret unresolved/empty`);
    }
  }
  for (const job of config.jobs || []) {
    if (job.enabled === false) continue;
    if (!job.source?.password) {
      throw new Error(`job ${job.id}: password unresolved/empty`);
    }
  }
}

export function loadConfigRaw(cliPath) {
  const filePath = resolveConfigPath(cliPath);
  let config = loadFile(filePath);
  config = {
    ...DEFAULTS,
    ...config,
    settings: { ...DEFAULTS.settings, ...(config.settings || {}) },
  };
  config = applyEnvOverrides(config);
  validate(config);
  config._path = filePath;
  return config;
}

/**
 * Load config and resolve file:/env: secret references.
 */
export function loadConfig(cliPath) {
  const filePath = resolveConfigPath(cliPath);
  log.info(`Loading config from ${filePath}`);
  let config = loadConfigRaw(cliPath);
  const { config: resolved } = applySecretsToConfig(config, {
    baseDir: path.dirname(filePath),
  });
  config = resolved;
  validateResolved(config);
  config._path = filePath;
  return config;
}
