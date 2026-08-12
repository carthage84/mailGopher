#!/usr/bin/env node
/**
 * One-time OAuth helper: open browser, capture refresh token, write to a secret file.
 *
 * Usage:
 *   node src/cli/auth.js --account personal
 *   node src/cli/auth.js --account personal --out /etc/mailgopher/personal.refresh
 */
import http from 'node:http';
import { URL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import open from 'open';
import YAML from 'yaml';
import { resolveConfigPath } from '../config.js';
import { createOAuthClient, SCOPES } from '../gmail/client.js';
import { log, setLogLevel } from '../logger.js';
import { isSecretRef, resolveSecretValue } from '../credentials/resolve.js';

const REDIRECT_PORT = 53682;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/oauth2callback`;

function parseArgs(argv) {
  const out = { account: null, config: null, out: null, write: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--account' || a === '-a') out.account = argv[++i];
    else if (a === '--config' || a === '-c') out.config = argv[++i];
    else if (a === '--out' || a === '-o') out.out = argv[++i];
    else if (a === '--no-write') out.write = false;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function usage() {
  console.log(`MailGopher Gmail OAuth

Usage:
  npm run auth -- --account <name>
  npm run auth -- --account personal --out /etc/mailgopher/personal.refresh

Prerequisites:
  1. Google Cloud project + Gmail API + OAuth client
     (Desktop, or Web with redirect ${REDIRECT_URI})
  2. clientSecret available via file: or env: in config.yaml
  3. After auth, point refreshToken at the written file:

       refreshToken: "file:./secrets/gmail.personal.refreshToken"

The token is written to a mode-0600 file (not into config.yaml).
`);
}

async function waitForCode() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const u = new URL(req.url, `http://127.0.0.1:${REDIRECT_PORT}`);
        if (u.pathname !== '/oauth2callback') {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        const err = u.searchParams.get('error');
        if (err) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`<h1>Auth failed</h1><p>${err}</p>`);
          server.close();
          reject(new Error(err));
          return;
        }
        const code = u.searchParams.get('code');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          '<h1>MailGopher authorized</h1><p>You can close this tab and return to the terminal.</p>',
        );
        server.close();
        resolve(code);
      } catch (e) {
        reject(e);
      }
    });
    server.listen(REDIRECT_PORT, '127.0.0.1', () => {
      log.info(`Listening for OAuth callback on ${REDIRECT_URI}`);
    });
    server.on('error', reject);
  });
}

function loadRawConfig(configPath) {
  const raw = fs.readFileSync(configPath, 'utf8');
  return configPath.endsWith('.json') ? JSON.parse(raw) : YAML.parse(raw);
}

function writeSecretFile(filePath, value) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, value, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* windows */
  }
}

function writeConfigRefreshTokenRef(configPath, accountKey, fileRef) {
  const raw = fs.readFileSync(configPath, 'utf8');
  const ref = JSON.stringify(fileRef); // quoted

  if (configPath.endsWith('.json')) {
    const data = JSON.parse(raw);
    if (!data.gmailAccounts?.[accountKey]) {
      throw new Error(`Account ${accountKey} not found in config`);
    }
    data.gmailAccounts[accountKey].refreshToken = fileRef;
    fs.writeFileSync(configPath, JSON.stringify(data, null, 2));
    return;
  }

  const keyRe = new RegExp(
    `(gmailAccounts:[\\s\\S]*?\\b${accountKey}:[\\s\\S]*?refreshToken:\\s*)(["'][^"']*["']|\\S*)`,
    'm',
  );
  if (keyRe.test(raw)) {
    fs.writeFileSync(configPath, raw.replace(keyRe, `$1${ref}`));
    return;
  }

  const data = YAML.parse(raw);
  if (!data.gmailAccounts?.[accountKey]) {
    throw new Error(`Account ${accountKey} not found in config`);
  }
  data.gmailAccounts[accountKey].refreshToken = fileRef;
  fs.writeFileSync(configPath, YAML.stringify(data));
}

async function main() {
  setLogLevel('info');
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.account) {
    usage();
    process.exit(args.help ? 0 : 1);
  }

  const configPath = resolveConfigPath(args.config);
  if (!fs.existsSync(configPath)) {
    console.error(`Config not found: ${configPath}`);
    process.exit(1);
  }

  const config = loadRawConfig(configPath);
  const account = config.gmailAccounts?.[args.account];
  if (!account) {
    console.error(
      `Unknown account "${args.account}". Defined: ${Object.keys(config.gmailAccounts || {}).join(', ') || '(none)'}`,
    );
    process.exit(1);
  }
  if (!account.clientId) {
    console.error(`gmailAccounts.${args.account} needs clientId`);
    process.exit(1);
  }

  const baseDir = path.dirname(configPath);
  let clientSecret = account.clientSecret;
  if (isSecretRef(clientSecret)) {
    clientSecret = resolveSecretValue(clientSecret, { baseDir });
  }
  if (!clientSecret) {
    console.error(`gmailAccounts.${args.account}.clientSecret is empty`);
    process.exit(1);
  }

  const oauth2 = createOAuthClient({
    ...account,
    clientSecret,
    redirectUri: REDIRECT_URI,
  });
  const authUrl = oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });

  log.info(`Authorize Gmail access for account "${args.account}" (${account.email || 'unknown'})`);
  log.info('Opening browser…');
  await open(authUrl);
  console.log('\nIf the browser did not open, visit:\n', authUrl, '\n');

  const code = await waitForCode();
  const { tokens } = await oauth2.getToken(code);
  if (!tokens.refresh_token) {
    console.error(
      'No refresh_token returned. Revoke prior grants at https://myaccount.google.com/permissions and try again.',
    );
    process.exit(1);
  }

  if (!args.write) {
    console.log('\n=== Refresh token (--no-write) ===\n');
    console.log(tokens.refresh_token);
    console.log('\nWrite it to a chmod 600 file and set refreshToken: "file:…"\n');
    return;
  }

  const stateDir = config.settings?.stateDir || './data';
  const defaultOut = path.resolve(baseDir, stateDir, 'secrets', `gmail.${args.account}.refreshToken`);
  const outPath = path.resolve(args.out || defaultOut);
  writeSecretFile(outPath, tokens.refresh_token);

  // Prefer path relative to config dir when possible
  let rel = path.relative(baseDir, outPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    rel = outPath;
  } else {
    rel = rel.split(path.sep).join('/'); // portable in yaml
  }
  const fileRef = `file:${rel.startsWith('/') || /^[A-Za-z]:/.test(rel) ? rel : `./${rel}`}`;

  writeConfigRefreshTokenRef(configPath, args.account, fileRef);
  log.info(`Wrote refresh token to ${outPath} (mode 0600)`);
  log.info(`Config refreshToken → ${fileRef}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
