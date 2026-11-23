// /listens paging and request pacing against the fake LB server (real min_ts/max_ts semantics).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as H from './helpers.mjs';
import { fakeClient } from './lb-fake.mjs';

const listensAt = (seconds, tag = 'x') => seconds.map((at, i) => H.listen({ at, msid: `${tag}${i}`, artist: 'A', title: `T${i}` }));
const range = (from, n) => Array.from({ length: n }, (_, i) => from + i);
const listenCalls = (client) => client.fetch.calls.filter((c) => c.path.endsWith('/listens')).map((c) => c.params);

async function drain(client, opts) {
  const warnings = [];
  const seen = new Set();
  for await (const page of client.iterListens('tester', { ...opts, onWarn: (w) => warnings.push(w) })) {
    for (const l of page) seen.add(l.recording_msid);
  }
  return { seen, warnings };
}

test('forward paging: the next min_ts is the page newest second - 1', async () => {
  const client = fakeClient({ listens: listensAt(range(20_000, 2500)) });
  const { seen, warnings } = await drain(client, { minTs: 6400 });
  assert.equal(seen.size, 2500);
  assert.deepEqual(warnings, []);
  assert.deepEqual(listenCalls(client).map((p) => [p.min_ts, p.max_ts]), [['6400', undefined], ['20998', undefined], ['21997', undefined]]);
});

test('backward paging: the next max_ts is the page oldest second + 1', async () => {
  const client = fakeClient({ listens: listensAt(range(20_000, 2500)) });
  const { seen, warnings } = await drain(client, {});
  assert.equal(seen.size, 2500);
  assert.deepEqual(warnings, []);
  assert.deepEqual(listenCalls(client).map((p) => [p.min_ts, p.max_ts]), [[undefined, undefined], [undefined, '21501'], [undefined, '20502']]);
});

for (const [label, opts] of [['forward', { minTs: 100 }], ['backward', {}]]) {
  test(`${label} paging stops and warns when more than 1,000 listens share one second`, async () => {
    const crowd = listensAt(Array(1001).fill(30_000), 'c');
    const around = listensAt([29_000, 31_000], 'o');
    const client = fakeClient({ listens: [...crowd, ...around] });
    const { seen, warnings } = await drain(client, opts);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].code, 'lb_same_second');
    assert.equal(warnings[0].second, 30_000);
    assert.ok(seen.has('o0') && seen.has('o1'), 'listens on both sides of the crowded second are fetched');
    assert.ok(listenCalls(client).length <= 5);
  });
}

test('requests are at least one second apart, and wait out X-RateLimit-Reset-In at 0 remaining', async () => {
  let clock = 0;
  const sleeps = [];
  const timing = { now: () => clock, sleep: async (ms) => { sleeps.push(ms); clock += ms; } };
  const client = fakeClient({ listens: listensAt(range(20_000, 2500)) }, timing);
  await drain(client, { minTs: 6400 });
  assert.deepEqual(sleeps, [1000, 1000]);

  sleeps.length = 0;
  const limited = fakeClient({ listens: listensAt(range(20_000, 1500)), rateLimit: { remaining: 0, resetIn: 7 } }, timing);
  await drain(limited, { minTs: 6400 });
  assert.deepEqual(sleeps, [7000]);
});
