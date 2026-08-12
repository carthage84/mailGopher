import { google } from 'googleapis';
import { log } from '../logger.js';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.insert',
  'https://www.googleapis.com/auth/gmail.labels',
];

export { SCOPES };

export function createOAuthClient(account) {
  const oauth2 = new google.auth.OAuth2(
    account.clientId,
    account.clientSecret,
    account.redirectUri || 'http://127.0.0.1:53682/oauth2callback',
  );
  if (account.refreshToken) {
    oauth2.setCredentials({ refresh_token: account.refreshToken });
  }
  return oauth2;
}

export class GmailDestination {
  /**
   * @param {string} accountKey
   * @param {object} accountConfig
   */
  constructor(accountKey, accountConfig) {
    this.accountKey = accountKey;
    this.accountConfig = accountConfig;
    this.auth = createOAuthClient(accountConfig);
    this.gmail = google.gmail({ version: 'v1', auth: this.auth });
    this.labelCache = new Map(); // name -> id
  }

  ensureConfigured() {
    if (!this.accountConfig.refreshToken) {
      throw new Error(
        `Gmail account "${this.accountKey}" has no refreshToken. Run: npm run auth -- --account ${this.accountKey}`,
      );
    }
  }

  /**
   * Ensure labels exist (create missing ones) and return label IDs.
   * Supports nested-looking names like "Imported/Yahoo" as a single label name.
   */
  async resolveLabelIds(labelNames = []) {
    if (!labelNames.length) return [];

    if (this.labelCache.size === 0) {
      await this.refreshLabelCache();
    }

    const ids = [];
    for (const name of labelNames) {
      const key = name.trim();
      if (!key) continue;
      if (this.labelCache.has(key)) {
        ids.push(this.labelCache.get(key));
        continue;
      }
      const created = await this.createLabel(key);
      ids.push(created);
    }
    return ids;
  }

  async refreshLabelCache() {
    const res = await this.gmail.users.labels.list({ userId: 'me' });
    this.labelCache.clear();
    for (const label of res.data.labels || []) {
      if (label.name && label.id) {
        this.labelCache.set(label.name, label.id);
      }
    }
  }

  async createLabel(name) {
    log.info(`[gmail:${this.accountKey}] Creating label "${name}"`);
    const res = await this.gmail.users.labels.create({
      userId: 'me',
      requestBody: {
        name,
        labelListVisibility: 'labelShow',
        messageListVisibility: 'show',
      },
    });
    const id = res.data.id;
    this.labelCache.set(name, id);
    return id;
  }

  /**
   * Insert a raw RFC822 message into Gmail.
   * @param {Buffer|string} rawMessage - full MIME message
   * @param {string[]} labelNames
   * @returns {Promise<{id: string, threadId: string}>}
   */
  async insertRaw(rawMessage, labelNames = []) {
    this.ensureConfigured();
    const labelIds = await this.resolveLabelIds(labelNames);
    const raw = Buffer.isBuffer(rawMessage)
      ? rawMessage.toString('base64url')
      : Buffer.from(rawMessage, 'utf8').toString('base64url');

    const res = await this.gmail.users.messages.insert({
      userId: 'me',
      requestBody: {
        raw,
        labelIds: labelIds.length ? labelIds : undefined,
      },
      internalDateSource: 'dateHeader',
    });

    return { id: res.data.id, threadId: res.data.threadId };
  }
}

/**
 * Build a map of accountKey -> GmailDestination
 */
export function createGmailClients(gmailAccounts) {
  const map = new Map();
  for (const [key, cfg] of Object.entries(gmailAccounts || {})) {
    map.set(key, new GmailDestination(key, cfg));
  }
  return map;
}
