import { errorPayload, DjdbError } from './errors.mjs';
import { resolvePaths } from './paths.mjs';
import { openReader } from './open.mjs';
import { status as statusOf } from './status.mjs';
import { recommend } from './recommend.mjs';
import { explain } from './online.mjs';
import { isInitialized } from './db.mjs';
import { lockStatus } from './lock.mjs';

export function createCore(opts = {}) {
  const paths = resolvePaths(opts);

  async function withHandle(fn) {
    const h = openReader({ dbPath: paths.dbPath, configDir: paths.configDir, online: 'read' });
    try {
      return await fn(h);
    } finally {
      h.close();
    }
  }

  const tools = [
    {
      name: 'status',
      description: 'Report djdb status: lock, last refresh and whether it was incomplete (暫定), online DB binding, and library counts. Never reveals tokens.',
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
      description: 'Preview recommendations from the library. Returns recording MBIDs and ISRCs only (no Spotify IDs). Writes nothing. mode: discover | rediscover.',
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
      description: 'Explain a recorded recommendation run (written by dj-mcp): its parameters and items. The standalone server never records runs.',
      inputSchema: {
        type: 'object',
        properties: { run_id: { type: 'integer' } },
        required: ['run_id'],
        additionalProperties: false,
      },
      handler: async (args) => withHandle((h) => explain(h.online, args.run_id)),
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
