'use strict';
// Console v1.3.4 Responses parity (Luke 11/11). index.html carries the shared Responses definitions block verbatim
// (// RESP:start to // RESP:end), the same block lib/responses.js holds in Operations (Claude-LS
// projects/autopilots-tracker), the FCP Hub (FCP-Internal-Lead-Gen) and FCLabz-BD. Those repos pin the whole file at
// sha256 624377e4...a3a2a; this pins the block itself, so an edit to the page's copy fails here until every copy and
// every checksum changes together. Run: node --test test/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').split('\r\n').join('\n');
const block = (s) => { const a = s.indexOf('// RESP:start'), b = s.indexOf('// RESP:end'); assert.ok(a >= 0 && b > a, 'RESP block missing'); return s.slice(a, b); };
// sha256 of the block (RESP:start up to RESP:end) in lib/responses.js at sha 624377e4...a3a2a
const RESP_BLOCK_SHA = '4097c1dda90ce64400f39d3cd4b02dfbb4f9274f40cc10593784638663f3c9a3';

test('index.html carries the shared Responses block verbatim', () => {
  const html = read('index.html');
  assert.strictEqual(html.split('// RESP:start').length, 2, 'exactly one RESP:start');
  assert.strictEqual(html.split('// RESP:end').length, 2, 'exactly one RESP:end');
  assert.strictEqual(crypto.createHash('sha256').update(block(html)).digest('hex'), RESP_BLOCK_SHA);
});

test('the block runs on its own and gives the shared chips', () => {
  const ctx = {}; vm.runInNewContext(block(read('index.html')) + '\nthis.C = RESP_CHIPS; this.D = RESP_DEFAULT; this.W = RESP_WINDOW_DAYS;', ctx);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.C.map(([k]) => k))), ['all', 'replies', 'pn', 'neg', 'opt', 'ooo', 'bounce']);
  assert.strictEqual(ctx.D, 'replies');
  assert.strictEqual(ctx.W, 30);
});
