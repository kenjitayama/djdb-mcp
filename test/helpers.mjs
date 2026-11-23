import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb } from '../lib/init.mjs';
import { open } from '../lib/open.mjs';
import { writeTokenFile } from '../lib/token.mjs';

export function tmpRoot(prefix = 'djdb-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function mockClient({ user = 'tester', listens = [], feedback = [], similar = {}, popularity = [], tops = {}, fail } = {}) {
  return {
    similar,
    popularity,
    tops,
    similarAlgorithm: 'test-algo',
    async validateToken() {
      if (fail === 'token') throw new Error('token failed');
      return { valid: true, user };
    },
    iterCalls: [],
    lastIterOpts: null,
    async *iterListens(_user, opts = {}) {
      this.iterCalls.push(opts);
      this.lastIterOpts = opts;
      if (fail === 'listens') throw new Error('listens failed');
      const minTs = opts.minTs ?? opts.min_ts;
      const maxTs = opts.maxTs ?? opts.max_ts;
      const filtered = listens.filter((l) => {
        const ts = Number(l.listened_at);
        if (minTs != null && ts < Number(minTs)) return false;
        if (maxTs != null && ts > Number(maxTs)) return false;
        return true;
      });
      if (filtered.length) yield filtered;
    },
    async *iterFeedback() {
      if (fail === 'feedback') throw new Error('feedback failed');
      if (feedback.length) yield feedback;
    },
    async similarArtists(mbid) {
      if (fail === 'similar') throw Object.assign(new Error('similar failed'), { status: 503 });
      return similar[mbid] || [];
    },
    async artistPopularity(ids) {
      if (fail === 'popularity') throw Object.assign(new Error('popularity failed'), { status: 503 });
      const by = new Map((popularity || []).map((p) => [p.artist_mbid, p]));
      return ids.map((id) => by.get(id) || { artist_mbid: id, total_user_count: 50, total_listen_count: 500 });
    },
    async topRecordingsForArtist(mbid) {
      if (fail === 'tops') throw Object.assign(new Error('tops failed'), { status: 503 });
      return tops[mbid] || [];
    },
  };
}

export function listen({ at, msid, artist, title, album, mbid, mapped, via = 'lastfm', isrc, duration_ms }) {
  return {
    listened_at: at,
    recording_msid: msid,
    track_metadata: {
      artist_name: artist,
      track_name: title,
      release_name: album ?? null,
      additional_info: {
        recording_mbid: mbid ?? undefined,
        recording_msid: msid,
        music_service: via,
        isrc,
        duration_ms,
      },
      mbid_mapping: mapped ? { recording_mbid: mapped } : undefined,
    },
  };
}

export async function freshDb(opts = {}) {
  const root = tmpRoot();
  const dbPath = join(root, 'djdb.sqlite');
  const configDir = join(root, 'cfg');
  mkdirSync(configDir, { mode: 0o700 });
  const tokenFile = join(configDir, 'lb-token.json');
  const client = opts.client || mockClient({ user: opts.user || 'tester' });
  const info = await initDb(
    { dbPath, dbDir: root, onlinePath: join(root, 'djdb-online.sqlite'), lockPath: join(root, 'djdb.lock'), tokenFile, configDir },
    { client, skipTokenCheck: !opts.liveToken, token: opts.token || 'test-token', user: opts.user || 'tester' },
  );
  const handle = open({ dbPath, configDir, tokenFile });
  return { root, dbPath, configDir, tokenFile, handle, info, client, paths: handle.paths };
}
