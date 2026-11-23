import { errorPayload, DjdbError } from './errors.mjs';
import { resolvePaths } from './paths.mjs';
import { open } from './open.mjs';
import { status as statusOf } from './status.mjs';
import { recommend } from './recommend.mjs';
import { explain } from './online.mjs';
import { isInitialized } from './db.mjs';
import { lockStatus } from './lock.mjs';

export function createCore(opts = {}) {
  const paths = resolvePaths(opts);

  async function withHandle(fn, { onlineReadOnly = true } = {}) {
    if (!isInitialized(paths.dbPath)) {
      throw new DjdbError('no_database', `database not found: ${paths.dbPath}`, 'Run djdb init, then djdb refresh.');
    }
    const h = open({ dbPath: paths.dbPath, configDir: paths.configDir, onlineReadOnly, allowMissing: false });
    try {
      return await fn(h);
    } finally {
      h.close();
    }
  }

  const tools = [
    {
      name: 'status',
      description: 'Report djdb status: lock, dirty flag, latest snapshot, provisional snapshots, and library counts. Never reveals tokens.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => {
        if (!isInitialized(paths.dbPath)) {
          return { ok: false, reason: 'no database: run djdb init', db_path: paths.dbPath, lock: lockStatus(paths.lockPath) };
        }
        return withHandle((h) => statusOf(h));
      },
    },
    {
      name: 'recommend',
      description: 'Preview recommendations from the latest valid snapshot. Returns recording MBIDs and ISRCs only (no Spotify IDs). Does not write the online DB. mode: discover | rediscover.',
      inputSchema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['discover', 'rediscover'] },
          n: { type: 'integer', minimum: 1, maximum: 100 },
          seeds: { type: 'array', items: { type: 'object' } },
        },
        additionalProperties: false,
      },
      handler: async (args) => withHandle((h) => recommend(h, {
        mode: args.mode,
        n: args.n,
        seeds: args.seeds,
        record: false,
      })),
    },
    {
      name: 'explain',
      description: 'Explain a recorded recommendation run (written by dj-mcp). Returns "deleted" if the snapshot was cleaned up. The standalone server never records runs.',
      inputSchema: {
        type: 'object',
        properties: { run_id: { type: 'integer' } },
        required: ['run_id'],
        additionalProperties: false,
      },
      handler: async (args) => withHandle((h) => explain(h.online, h.main, args.run_id)),
    },
  ];

  async function callTool(name, args = {}) {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new DjdbError('unknown_tool', `unknown tool: ${name}`);
    return t.handler(args || {});
  }

  return { tools, callTool, paths };
}

export { errorPayload };
