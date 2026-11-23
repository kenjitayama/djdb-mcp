import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { DjdbError } from './errors.mjs';

export function readTokenFile(path) {
  if (!existsSync(path)) return null;
  try {
    const o = JSON.parse(readFileSync(path, 'utf8'));
    if (!o || typeof o !== 'object') return null;
    return { token: typeof o.token === 'string' ? o.token : null };
  } catch {
    throw new DjdbError('token_unreadable', `could not read ListenBrainz token file`);
  }
}

export function writeTokenFile(path, { token }) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify({ token }, null, 2) + '\n', { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

export function resolveToken(opts = {}) {
  if (opts.token) return opts.token;
  const env = process.env.LISTENBRAINZ_TOKEN;
  if (env && env.trim() && !/^\$\{[A-Z0-9_]+\}$/.test(env.trim())) return env.trim();
  if (opts.tokenFile && existsSync(opts.tokenFile)) {
    const o = readTokenFile(opts.tokenFile);
    if (o?.token) return o.token;
  }
  return null;
}
