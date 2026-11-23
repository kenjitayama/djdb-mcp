import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from '../lib/cli.mjs';
import { mockClient, freshDb, listen } from './helpers.mjs';
import { createCore } from '../lib/mcp-core.mjs';

const root = dirname(fileURLToPath(import.meta.url)) + '/..';

test('CLI help does not mention a bare unscoped bin invocation', async () => {
  const chunks = [];
  const code = await runCli(['help'], { out: (o) => chunks.push(o) });
  assert.equal(code, 0);
  const text = JSON.stringify(chunks);
  assert.equal(/npx djdb/.test(text), false);
  assert.match(text, /bin\/djdb/);
  assert.match(text, /npm exec --prefix/);
});

test('CLI init, status, refresh, unlock --force --yes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'djdb-cli-'));
  const dbPath = join(dir, 'djdb.sqlite');
  const client = mockClient({
    user: 'tester',
    listens: [listen({ at: 2000, msid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', artist: 'A', title: 'T', via: 'lastfm' })],
  });
  const cfg = join(dir, 'cfg');
  const logs = [];
  const out = (o) => logs.push(typeof o === 'string' ? o : JSON.stringify(o));
  const common = { out, client, skipTokenCheck: true, token: 'test-token', dbPath, configDir: cfg, tokenFile: join(cfg, 'lb-token.json') };
  assert.equal(await runCli(['init', '--user', 'tester'], common), 0);
  assert.equal(existsSync(dbPath), true);
  assert.equal(await runCli(['status', '--json'], common), 1); // no snapshot yet
  assert.equal(await runCli(['refresh', '--listens-full-history'], common), 0);
  assert.equal(await runCli(['status', '--json'], common), 0);
  assert.equal(await runCli(['unlock', '--force', '--yes'], common), 0);
  assert.equal(await runCli(['online-reset', '--yes'], common), 0);
});

test('MCP stdio: initialize, tools/list, tools/call(status) against the real server binary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'djdb-smoke-'));
  const dbPath = join(dir, 'djdb.sqlite');
  const child = spawn(join(root, 'bin', 'djdb-mcp-server'), [], {
    cwd: root,
    env: { ...process.env, DJDB_PATH: dbPath, DJDB_CONFIG_DIR: join(dir, 'cfg') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const responses = new Map();
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) {
        const m = JSON.parse(line);
        if (m.id !== undefined) responses.set(m.id, m);
      }
    }
  });
  const err = [];
  child.stderr.on('data', (d) => err.push(d.toString()));
  const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
  const wait = (id) => new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (responses.has(id)) { clearInterval(iv); res(responses.get(id)); }
      else if (Date.now() - t0 > 5000) { clearInterval(iv); rej(new Error('timeout ' + id + ' stderr=' + err.join(''))); }
    }, 10);
  });

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } });
  const init = await wait(1);
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'djdb-mcp');
  assert.ok(init.result.capabilities.tools);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = (await wait(2)).result.tools.map((t) => t.name);
  assert.deepEqual(names, ['status', 'recommend', 'explain', 'library_stats']);

  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'status', arguments: {} } });
  const st = await wait(3);
  assert.equal(st.result.isError, false);
  const body = JSON.parse(st.result.content[0].text);
  assert.equal(body.ok, false);
  assert.match(body.reason, /no database/);

  send({ jsonrpc: '2.0', id: 4, method: 'bogus/method' });
  assert.equal((await wait(4)).error.code, -32601);

  child.stdin.end();
  await new Promise((r) => child.on('exit', r));
});

test('createCore status on a missing DB does not throw', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'djdb-core-'));
  const core = createCore({ dbPath: join(dir, 'djdb.sqlite'), configDir: join(dir, 'cfg') });
  const s = await core.callTool('status', {});
  assert.equal(s.ok, false);
  assert.match(s.reason, /no database/);
});

test('docs never mention a bare unscoped registry invocation of the CLI', async () => {
  const { readFileSync } = await import('node:fs');
  for (const f of ['README.md', 'VERIFY.md', 'skills/djdb/SKILL.md', 'package.json']) {
    const t = readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    assert.equal(/npx djdb/.test(t), false, f);
  }
});
