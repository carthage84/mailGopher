const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

let currentLevel = LEVELS.info;

export function setLogLevel(name) {
  const key = String(name || 'info').toLowerCase();
  currentLevel = LEVELS[key] ?? LEVELS.info;
}

function emit(level, args) {
  if ((LEVELS[level] ?? 99) < currentLevel) return;
  const ts = new Date().toISOString();
  const prefix = `[${ts}] ${level.toUpperCase()}`;
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(prefix, ...args);
}

export const log = {
  debug: (...a) => emit('debug', a),
  info: (...a) => emit('info', a),
  warn: (...a) => emit('warn', a),
  error: (...a) => emit('error', a),
};
