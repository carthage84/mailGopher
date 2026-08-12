import fs from 'node:fs';
import path from 'node:path';

const SENSITIVE_KEYS = new Set([
  'password',
  'clientsecret',
  'refreshtoken',
  'client_secret',
  'refresh_token',
]);

/**
 * Secret references — no crypto in-app. Use Linux tools for storage:
 *
 *   file:/run/credentials/mailgopher.service/yahoo   (systemd LoadCredential)
 *   file:./secrets/yahoo.password                    (chmod 600 file)
 *   env:YAHOO_IMAP_PASSWORD                          (from the environment)
 *
 * Paths may include $VAR or ${VAR} (e.g. ${CREDENTIALS_DIRECTORY}/yahoo).
 */

export function isSecretRef(value) {
  return typeof value === 'string' && (value.startsWith('file:') || value.startsWith('env:'));
}

/**
 * Expand $VAR and ${VAR} using process.env. Unknown vars become empty string.
 */
export function expandEnvInString(str) {
  return String(str).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, a, b) => {
    const name = a || b;
    return process.env[name] ?? '';
  });
}

/**
 * Resolve a single secret field value.
 * @param {string} value
 * @param {{ baseDir?: string }} [opts] - baseDir for relative file: paths (config dir)
 */
export function resolveSecretValue(value, opts = {}) {
  if (typeof value !== 'string') return value;

  if (value.startsWith('env:')) {
    const name = value.slice(4);
    if (!name) throw new Error('Empty env: secret reference');
    const v = process.env[name];
    if (v == null || v === '') {
      throw new Error(`Environment variable "${name}" is missing or empty (from env:${name})`);
    }
    return v;
  }

  if (value.startsWith('file:')) {
    let filePath = value.slice(5);
    if (!filePath) throw new Error('Empty file: secret reference');
    filePath = expandEnvInString(filePath);
    if (!path.isAbsolute(filePath)) {
      filePath = path.resolve(opts.baseDir || process.cwd(), filePath);
    }
    if (!fs.existsSync(filePath)) {
      throw new Error(`Secret file not found: ${filePath} (from file:…)`);
    }
    return fs.readFileSync(filePath, 'utf8').replace(/\r?\n$/, '');
  }

  return value;
}

/**
 * Deep-walk config; resolve file:/env: strings. Mutates nothing; returns new tree.
 */
export function resolveSecretRefs(config, opts = {}) {
  function walk(node) {
    if (typeof node === 'string') {
      if (isSecretRef(node)) return resolveSecretValue(node, opts);
      return node;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(node)) out[k] = walk(v);
      return out;
    }
    return node;
  }
  return walk(config);
}

/**
 * Paths of sensitive keys that are still inline plaintext (not file:/env:).
 */
export function findPlaintextSecretFields(config) {
  const hits = [];

  function walk(node, pathParts) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, pathParts.concat(String(i))));
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      const p = pathParts.concat(k);
      if (typeof v === 'string' && SENSITIVE_KEYS.has(k.toLowerCase())) {
        if (v.length > 0 && !isSecretRef(v)) hits.push(p.join('.'));
      } else if (v && typeof v === 'object') {
        walk(v, p);
      }
    }
  }

  walk(config, []);
  return hits;
}

/**
 * Apply secret resolution to a loaded config object.
 */
export function applySecretsToConfig(config, opts = {}) {
  const allowPlaintext = config.settings?.allowPlaintextSecrets === true;
  const plain = findPlaintextSecretFields(config);

  if (plain.length && !allowPlaintext) {
    throw new Error(
      `Plaintext secrets in config (use file: or env: refs):\n  - ${plain.join('\n  - ')}\n\n` +
        `Examples:\n` +
        `  password: "file:/etc/mailgopher/yahoo.password"\n` +
        `  password: "file:\${CREDENTIALS_DIRECTORY}/yahoo"\n` +
        `  password: "env:YAHOO_PASSWORD"\n\n` +
        `On Linux prefer systemd LoadCredential= or chmod 600 files.\n` +
        `Escape hatch: settings.allowPlaintextSecrets: true`,
    );
  }

  const baseDir = opts.baseDir || (config._path ? path.dirname(config._path) : process.cwd());
  const resolved = resolveSecretRefs(config, { baseDir });
  return { config: resolved };
}
