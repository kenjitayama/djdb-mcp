import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

export const CONFIG_DIR_ENV = 'DJDB_CONFIG_DIR';
export const DB_PATH_ENV = 'DJDB_PATH';

function envValue(name) {
  const v = process.env[name];
  if (v == null) return undefined;
  const t = String(v).trim();
  if (!t || /^\$\{[A-Z0-9_]+\}$/.test(t)) return undefined;
  return t;
}

export function resolveConfigDir(opts = {}) {
  if (opts.configDir) return resolve(opts.configDir);
  const env = envValue(CONFIG_DIR_ENV);
  if (env) return resolve(env);
  const xdg = envValue('XDG_CONFIG_HOME');
  return join(xdg || join(homedir(), '.config'), 'djdb-mcp');
}

export function resolveDataDir(opts = {}) {
  if (opts.dataDir) return resolve(opts.dataDir);
  const xdg = envValue('XDG_DATA_HOME');
  return join(xdg || join(homedir(), '.local', 'share'), 'djdb-mcp');
}

/**
 * Single path resolver for the main DB.
 * DJDB_PATH → ~/.config/djdb-mcp/config.json dbPath → ${XDG_DATA_HOME:-~/.local/share}/djdb-mcp/djdb.sqlite
 */
export function resolveDbPath(opts = {}) {
  if (opts.dbPath) return resolve(opts.dbPath);
  const env = envValue(DB_PATH_ENV);
  if (env) return resolve(env);
  const cfgFile = join(resolveConfigDir(opts), 'config.json');
  if (existsSync(cfgFile)) {
    try {
      const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
      if (cfg?.dbPath) return resolve(cfg.dbPath);
    } catch {
      // ignore unreadable/invalid config; fall through to default
    }
  }
  return join(resolveDataDir(opts), 'djdb.sqlite');
}

export function tokenFilePath(opts = {}) {
  if (opts.tokenFile) return resolve(opts.tokenFile);
  return join(resolveConfigDir(opts), 'lb-token.json');
}

export function pathsFromDb(dbPath) {
  const abs = resolve(dbPath);
  const dir = dirname(abs);
  return {
    dbPath: abs,
    dbDir: dir,
    onlinePath: join(dir, 'djdb-online.sqlite'),
    snapsDir: join(dir, 'snapshots'),
    lockPath: join(dir, 'djdb.lock'),
    evalDir: join(dir, 'eval'),
  };
}

export function resolvePaths(opts = {}) {
  return { ...pathsFromDb(resolveDbPath(opts)), configDir: resolveConfigDir(opts), tokenFile: tokenFilePath(opts) };
}

/** snapshot.path is relative to snapshots/; the resolved path must stay under that directory. */
export function resolveSnapshotPath(snapsDir, rel) {
  if (typeof rel !== 'string' || rel.length === 0) throw new Error('snapshot path required');
  if (rel.startsWith('/') || rel.includes('..')) throw new Error('snapshot path escapes snapshots/');
  const base = resolve(snapsDir);
  const abs = resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + sep)) throw new Error('snapshot path escapes snapshots/');
  return abs;
}

export function ensureDir(p) {
  mkdirSync(p, { recursive: true });
  return p;
}
