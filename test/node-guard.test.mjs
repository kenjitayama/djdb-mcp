// The bin scripts must reach the Node version check on any Node, so before it they import only
// builtins and lib/node-range.mjs (lib/ imports node:sqlite, which Node 20 cannot even load).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nodeSupported, assertNode, NODE_HINT } from '../lib/node-range.mjs';

for (const bin of ['djdb', 'djdb-mcp-server']) {
  test(`bin/${bin} imports nothing that needs node:sqlite before the version check`, () => {
    const src = readFileSync(new URL(`../bin/${bin}`, import.meta.url), 'utf8');
    const statics = [...src.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
    assert.ok(statics.includes('../lib/node-range.mjs'));
    for (const s of statics) assert.ok(s.startsWith('node:') || s === '../lib/node-range.mjs', `static import ${s}`);
    assert.ok(src.indexOf('assertNode()') < src.indexOf('await import('), 'the check runs before lib/ is loaded');
  });
}

test('the supported range and the guidance', () => {
  for (const v of ['20.20.2', '22.23.4', '24.14.1', '25.0.0', '27.0.0']) assert.equal(nodeSupported(v), false, v);
  for (const v of ['24.15.0', '24.22.3', '26.0.0', '26.13.1']) assert.equal(nodeSupported(v), true, v);
  assert.throws(() => assertNode('22.23.4'), { code: 'unsupported_node' });
  assert.match(NODE_HINT, /Node 24 \(24\.15 or later\) or Node 26/);
});
