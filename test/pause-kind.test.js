'use strict';
// Console v1.3.6: a red banner only for what needs a look. apPauseKind classifies a mailbox's paused_reason:
// moved (switched to another engine on purpose: no banner, grey MOVED pill), rest (a planned pause by a person: amber note),
// hold (the health check: red, returns by itself), other (anything else: red). Run: node --test test/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const kind = new Function(html.match(/const apPauseKind = .*;/)[0] + ';return apPauseKind')();

test('apPauseKind classifies the pause reasons the console meets', () => {
  assert.equal(kind('moved to FCP Hub 2026-11-16'), 'moved');
  assert.equal(kind('moved from FC Labz BD 2026-11-16: press Activate'), 'moved');
  assert.equal(kind('warmforge: placement 0% (2026-11-17)'), 'hold');
  assert.equal(kind('held: something (2026-11-17)'), 'hold');
  assert.equal(kind('paused Nov 4 2026 by Dan: Microsoft restricted this mailbox'), 'rest');
  assert.equal(kind('switched off'), 'other');
  assert.equal(kind('paused: blocked by Microsoft 5.1.8'), 'other');
  assert.equal(kind('paused after bounce by rule'), 'other');
  assert.equal(kind('  moved to FCP Hub 2026-11-16'), 'moved');
  assert.equal(kind(null), 'other');
});
test('moved boxes raise no banner, a hold or other pause stays red, a rest is amber', () => {
  const loop = html.slice(html.indexOf('boxes.filter((m) => !m.active && m.connected_at && m.paused_reason'), html.indexOf('$("ap-banners").innerHTML = b;'));
  assert.match(loop, /if \(k === "moved"\) return;/);
  assert.match(loop, /"note"\)/);
  assert.match(loop, /health check and returns by itself/);
  assert.match(html, /\.ap-banner\.note \{/);
  assert.match(html, /<div id="ver" class="mono">v1\.3\.6<\/div>/);
});
