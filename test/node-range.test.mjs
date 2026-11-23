import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeSupported, NODE_RANGE, assertNode } from '../lib/node-range.mjs';

const cases = {
  '20.18.0': false,
  '22.13.0': false,
  '24.14.9': false,
  '24.15.0': true,
  '24.22.1': true,
  '25.7.0': false,
  '26.0.0': true,
  '26.13.1': true,
  '27.0.0': false,
};

test('nodeSupported matches engines range', () => {
  for (const [v, want] of Object.entries(cases)) {
    assert.equal(nodeSupported(v), want, v);
  }
  assert.equal(nodeSupported(), true);
  assert.match(NODE_RANGE, /24\.15\.0/);
  assert.doesNotThrow(() => assertNode());
  assert.throws(() => assertNode('20.0.0'), /requires Node/);
});
