// The public surface and the version strings that must move together.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as api from '../lib/index.mjs';
import { USER_AGENT } from '../lib/listenbrainz.mjs';

const json = (f) => JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'));

test('the library exports only what dj-mcp uses', () => {
  assert.deepEqual(Object.keys(api).sort(), [
    'API_VERSION', 'NODE_RANGE', 'explain', 'nodeSupported', 'openReader', 'recommend',
    'recordEvent', 'recordExternalIds', 'resolveDbPath', 'status',
  ]);
});

test('package.json, plugin.json, the User-Agent and the CHANGELOG agree on the version', () => {
  const v = json('package.json').version;
  assert.equal(json('plugin.json').version, v);
  assert.match(USER_AGENT, new RegExp(`^djdb-mcp/${v.replaceAll('.', '\\.')} `));
  assert.match(readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8'), new RegExp(`^## ${v.replaceAll('.', '\\.')}\\b`, 'm'));
});
