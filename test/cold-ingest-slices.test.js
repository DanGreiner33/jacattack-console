'use strict';
// cold-autopilot refreshLeads: a scan batch goes into cold_ingest_hits in slices so no single call passes the 8 s statement limit.
// cold_ingest_hits writes cold_batches_seen on every call, so a failed slice must put the seen row back (or remove it) so the
// batch is retried; success writes the batch totals. Run: node --test test/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
const { stripTypeScriptTypes } = require('node:module');
const src = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'functions', 'cold-autopilot', 'index.ts'), 'utf8');
const block = src.match(/\/\/ INGEST_SLICED_START([\s\S]*?)\/\/ INGEST_SLICED_END/)[1];
const ingestSliced = new Function('INGEST_SLICE', stripTypeScriptTypes(block) + ';return ingestSliced')(125);

function fakeDb({ failAt = -1, prior = null, seenErr = null, restoreErr = null } = {}) {
  const db = { seen: prior ? { ...prior } : null, calls: [], log: [] };
  db.deps = {
    ingest: async (id, slice) => {
      const k = db.calls.length; db.calls.push(slice.length);
      if (k === failAt) return { data: null, error: { message: 'canceling statement due to statement timeout' } };
      // what cold_ingest_hits does: upsert the seen row with THIS call's counts and now()
      db.seen = { batch_id: id, processed_at: 'now-' + k, new_leads: slice.length, ready_leads: Math.floor(slice.length / 2) };
      return { data: { batch: id, new_leads: slice.length, ready: Math.floor(slice.length / 2) }, error: null };
    },
    readSeen: async () => seenErr ? { data: null, error: { message: seenErr } } : { data: db.seen ? { ...db.seen } : null, error: null },
    setTotals: async (id, n, ready) => { db.log.push('totals'); db.seen = { ...db.seen, new_leads: n, ready_leads: ready }; return { error: null }; },
    restoreSeen: async (id, p) => { db.log.push('restore'); if (restoreErr) return { error: { message: restoreErr } }; db.seen = p ? { ...p } : null; return { error: null }; },
  };
  return db;
}
const hits = (n) => Array.from({ length: n }, (_, i) => ({ i }));

test('746 hits go in 6 slices of at most 125, totals written once at the end', async () => {
  const db = fakeDb();
  const r = await ingestSliced(716, hits(746), db.deps);
  assert.deepEqual(db.calls, [125, 125, 125, 125, 125, 121]);
  assert.deepEqual(r, { batch: 716, new_leads: 746, ready: 62 * 5 + 60, slices: 6 });
  assert.equal(db.seen.new_leads, 746);
  assert.equal(db.seen.processed_at, 'now-5'); // processed_at stays the last call's now(), as a single call left it
  assert.deepEqual(db.log, ['totals']);
});

test('a small batch is one call and no extra write (same as before)', async () => {
  const db = fakeDb();
  const r = await ingestSliced(9, hits(40), db.deps);
  assert.deepEqual(db.calls, [40]);
  assert.deepEqual(r, { batch: 9, new_leads: 40, ready: 20, slices: 1 });
  assert.deepEqual(db.log, []);
});

test('an empty batch still makes one call so its seen row is written', async () => {
  const db = fakeDb();
  await ingestSliced(9, [], db.deps);
  assert.deepEqual(db.calls, [0]);
  assert.equal(db.seen.batch_id, 9);
});

test('a later slice failing puts the prior seen row back, so the batch is retried', async () => {
  const prior = { batch_id: 716, processed_at: '2026-11-16T05:48:03Z', new_leads: 25, ready_leads: 22 };
  const db = fakeDb({ failAt: 3, prior });
  const r = await ingestSliced(716, hits(746), db.deps);
  assert.equal(db.calls.length, 4);
  assert.match(r.error, /^slice 4\/6: canceling statement/);
  assert.equal(r.ingested, 375);
  assert.deepEqual(db.seen, prior);
  assert.deepEqual(db.log, ['restore']);
});

test('a later slice failing on a never-seen batch removes the row the earlier slices wrote', async () => {
  const db = fakeDb({ failAt: 1 });
  const r = await ingestSliced(800, hits(300), db.deps);
  assert.match(r.error, /^slice 2\/3/);
  assert.equal(db.seen, null);
});

test('the first slice failing needs no restore (nothing was written)', async () => {
  const db = fakeDb({ failAt: 0 });
  const r = await ingestSliced(800, hits(300), db.deps);
  assert.match(r.error, /^slice 1\/3/);
  assert.deepEqual(db.log, []);
});

test('a failed restore is reported, not swallowed', async () => {
  const db = fakeDb({ failAt: 2, restoreErr: 'boom' });
  const r = await ingestSliced(800, hits(300), db.deps);
  assert.equal(r.restore_error, 'boom');
});

test('if the seen row cannot be read, nothing is ingested', async () => {
  const db = fakeDb({ seenErr: 'nope' });
  const r = await ingestSliced(800, hits(300), db.deps);
  assert.deepEqual(db.calls, []);
  assert.match(r.error, /^seen read: nope/);
});
