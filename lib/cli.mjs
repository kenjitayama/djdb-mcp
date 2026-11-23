import { resolve } from 'node:path';
import { errorPayload, DjdbError } from './errors.mjs';
import { resolvePaths } from './paths.mjs';
import { open, openReader } from './open.mjs';
import { status as statusOf } from './status.mjs';
import { initDb } from './init.mjs';
import { refresh } from './refresh.mjs';
import { restore } from './restore.mjs';
import { accountRename } from './account.mjs';
import { onlineReset } from './online.mjs';
import { unlock, lockStatus, withLockAsync } from './lock.mjs';
import { snapshotOk } from './snapshot.mjs';
import { isInitialized } from './db.mjs';

export const COMMANDS = [
  'init',
  'refresh',
  'status',
  'account-rename',
  'unlock',
  'snapshot-pin',
  'restore',
  'online-reset',
];

export function usage() {
  return {
    usage: 'node <path-to-@kenjitayama/djdb-mcp>/bin/djdb <command> [args]',
    commands: {
      init: 'djdb init [--user NAME]   (token from LISTENBRAINZ_TOKEN or the token file)',
      refresh: 'djdb refresh [--export <file>] [--listens-full-history]',
      status: 'djdb status [--json]',
      'account-rename': 'djdb account-rename <new-username>   (the token must belong to that user)',
      unlock: 'djdb unlock   (removes djdb.lock only if its pid is gone)',
      'snapshot-pin': 'djdb snapshot-pin <id> <label>',
      restore: 'djdb restore <file>',
      'online-reset': 'djdb online-reset --yes   (empties the recommendation log and Spotify ID cache)',
    },
    notes: [
      'Do not invoke this CLI via a bare unscoped bin name from a public registry.',
      'When installed under dj-mcp: node <dj-mcp>/node_modules/@kenjitayama/djdb-mcp/bin/djdb <command>',
      'or: npm exec --prefix <dj-mcp> --no -- djdb <command>',
    ],
  };
}

function parseFlags(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') flags.json = true;
    else if (a === '--yes' || a === '-y') flags.yes = true;
    else if (a === '--user') flags.user = argv[++i];
    else if (a === '--db') flags.dbPath = argv[++i];
    else if (a === '--export') flags.export = argv[++i];
    else if (a === '--listens-full-history') flags.listens_full_history = true;
    else if (a.startsWith('-')) throw new DjdbError('unknown_flag', `unknown flag: ${a}`, 'See djdb help. The token comes from LISTENBRAINZ_TOKEN or the token file, never from argv.');
    else flags._.push(a);
  }
  return flags;
}

function envExportPath() {
  const v = process.env.LISTENBRAINZ_EXPORT;
  if (!v || !v.trim() || /^\$\{[A-Z0-9_]+\}$/.test(v.trim())) return undefined;
  return v.trim();
}

function refreshOpts(flags, opts) {
  return {
    token: opts.token,
    client: opts.client,
    fetch: opts.fetch,
    skipTokenCheck: opts.skipTokenCheck,
    exportFile: flags.export || opts.exportFile || envExportPath(),
    listensFullHistory: !!(flags.listens_full_history || opts.listensFullHistory),
  };
}

export async function runCli(argv, opts = {}) {

  const out = opts.out || ((o) => process.stdout.write((typeof o === 'string' ? o : JSON.stringify(o, null, 2)) + '\n'));
  const cmd = argv[0];
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    out(usage());
    return 0;
  }
  const token = opts.token;

  try {
    const flags = parseFlags(argv.slice(1));
    const yes = !!flags.yes;
    const paths = resolvePaths({ dbPath: flags.dbPath || opts.dbPath, configDir: opts.configDir, tokenFile: opts.tokenFile });
    switch (cmd) {
      case 'init': {
        const r = await initDb(paths, { token, user: flags.user, client: opts.client, skipTokenCheck: opts.skipTokenCheck });
        out(flags.json ? r : `initialized ${r.dbPath} for ListenBrainz user ${r.lb_user}`);
        return 0;
      }
      case 'status': {
        if (!isInitialized(paths.dbPath)) {
          const s = { ok: false, reason: 'no database: run djdb init', db_path: paths.dbPath, lock: lockStatus(paths.lockPath) };
          out(flags.json ? s : formatStatus(s));
          return 1;
        }
        const h = openReader({ dbPath: paths.dbPath, configDir: paths.configDir, online: 'read' });
        try {
          const s = statusOf(h);
          out(flags.json ? s : formatStatus(s));
          return s.ok ? 0 : 1;
        } finally { h.close(); }
      }
      case 'refresh': {
        const h = open({ dbPath: paths.dbPath, configDir: paths.configDir, tokenFile: paths.tokenFile });
        try {
          const r = await refresh(h, refreshOpts(flags, opts));
          out(flags.json ? r : formatRefresh(r));
          return r.ok ? 0 : 1;
        } finally { h.close(); }
      }
      case 'account-rename': {
        const name = flags._[0];
        const h = open({ dbPath: paths.dbPath, configDir: paths.configDir, tokenFile: paths.tokenFile });
        try {
          const r = await accountRename(h, name, { token, client: opts.client });
          out(r);
          return 0;
        } finally { h.close(); }
      }
      case 'unlock': {
        const r = unlock(paths.lockPath);
        out(flags.json ? { result: r } : r);
        return 0;
      }
      case 'snapshot-pin': {
        const id = Number(flags._[0]);
        const label = flags._.slice(1).join(' ');
        if (!id || !label) throw new DjdbError('invalid_argument', 'usage: djdb snapshot-pin <id> <label>');
        const h = open({ dbPath: paths.dbPath, configDir: paths.configDir });
        try {
          const locked = await withLockAsync(paths.lockPath, 'snapshot-pin', () => {
            const r = h.main.prepare(`SELECT id, path, sha256, pinned FROM snapshot WHERE id=?`).get(id);
            if (!r || !snapshotOk(paths.snapsDir, r)) return 'refused: snapshot missing or corrupt';
            h.main.prepare(`UPDATE snapshot SET pinned=1, label=? WHERE id=?`).run(label, id);
            return 'pinned';
          });
          if (locked.locked) throw new DjdbError('locked', 'another djdb command holds djdb.lock');
          out(flags.json ? { result: locked.result } : locked.result);
          return locked.result === 'pinned' ? 0 : 1;
        } finally { h.close(); }
      }
      case 'restore': {
        const file = flags._[0] ? resolve(flags._[0]) : null;
        if (!file) throw new DjdbError('invalid_argument', 'usage: djdb restore <file>');
        const h = open({ dbPath: paths.dbPath, configDir: paths.configDir });
        try {
          const r = await restore(h, file, { skipRefresh: true, token, client: opts.client });
          // refresh after the lock is released
          h.close();
          const h2 = open({ dbPath: paths.dbPath, configDir: paths.configDir, tokenFile: paths.tokenFile });
          try {
            const pub = await refresh(h2, refreshOpts(flags, opts));
            r.refresh = pub;
            out(flags.json ? r : r);
            return r.ok && pub.ok ? 0 : 1;
          } finally { h2.close(); }
        } catch (e) {
          try { h.close(); } catch {}
          throw e;
        }
      }
      case 'online-reset': {
        if (!yes) {
          throw new DjdbError('confirm_required', 'online-reset empties the online DB (recommendation log and Spotify ID cache)', 'Run djdb online-reset --yes.');
        }
        const h = open({ dbPath: paths.dbPath, configDir: paths.configDir });
        try {
          const r = onlineReset(h.online, h.main);
          out(flags.json ? r : r.message);
          return 0;
        } finally { h.close(); }
      }
      default:
        throw new DjdbError('invalid_argument', `unknown command: ${cmd}`, 'See djdb help.');
    }
  } catch (e) {
    out(errorPayload(e));
    return 1;
  }
}

function formatStatus(s) {
  const lines = [];
  lines.push(`djdb status: ${s.ok ? 'ok' : s.reason}`);
  if (s.db_path) lines.push(`  db: ${s.db_path}`);
  if (s.lb_user) lines.push(`  lb_user: ${s.lb_user}`);
  if (s.lock) lines.push(`  lock: ${s.lock}`);
  if (s.dirty) lines.push('  dirty: yes (run djdb refresh)');
  if (s.snapshot) lines.push(`  latest snapshot: id ${s.snapshot.id}${s.snapshot.pinned ? ' (pinned: ' + s.snapshot.label + ')' : ''}`);
  if (s.provisional) lines.push(`  ${s.provisional_note}`);
  if (s.bad_pinned_note) lines.push(`  ${s.bad_pinned_note}`);
  if (s.recommend_disabled) lines.push(`  recommend disabled: ${s.online?.reason || s.reason}${s.hint ? ' — ' + s.hint : ''}`);
  if (s.counts) lines.push(`  plays ${s.counts.plays_canonical}/${s.counts.plays}  artists ${s.counts.artists}  tracks ${s.counts.tracks}  edges ${s.counts.edges}  feedback ${s.counts.feedback}  snapshots ${s.counts.snapshots}`);
  return lines.join('\n');
}

function formatRefresh(r) {
  const lines = [`djdb refresh: ${r.note || (r.ok ? 'ok' : 'failed')}`];
  if (r.provisional) lines.push('  暫定 snapshot was taken after a stage failed.');
  if (r.results) for (const s of r.results) lines.push(`  ${s.name}: ${s.ok ? 'ok' : 'FAILED'} ${s.error || ''}`.trim());
  if (r.path) lines.push(`  published ${r.path}`);
  return lines.join('\n');
}
