import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb } from '../lib/init.mjs';
import { open } from '../lib/open.mjs';
import { writeTokenFile } from '../lib/token.mjs';
import { fakeClient } from './lb-fake.mjs';

export function tmpRoot(prefix = 'djdb-') {
  return mkdtempSync(join(tmpdir(), prefix));
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
  const client = opts.client || fakeClient({ user: opts.user || 'tester' });
  const info = await initDb(
    { dbPath, dbDir: root, onlinePath: join(root, 'djdb-online.sqlite'), lockPath: join(root, 'djdb.lock'), tokenFile, configDir },
    { client, skipTokenCheck: !opts.liveToken, token: opts.token || 'test-token', user: opts.user || 'tester' },
  );
  const handle = open({ dbPath, configDir, tokenFile });
  return { root, dbPath, configDir, tokenFile, handle, info, client, paths: handle.paths };
}
