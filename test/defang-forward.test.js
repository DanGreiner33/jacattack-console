'use strict';
// Luke 11/23: links in a forwarded reply/thread are inert; our own header link (Role URL) stays live. Run: node --test test/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
const { stripTypeScriptTypes } = require('node:module');
const src = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'functions', 'cold-autopilot', 'index.ts'), 'utf8');
const dBlock = src.match(/\/\/ DEFANG_START([\s\S]*?)\/\/ DEFANG_END/)[1];
const hBlock = src.match(/\/\/ FORWARD_HEADER_START([\s\S]*?)\/\/ FORWARD_HEADER_END/)[1];
const { defangText, defangHtml } = new Function(stripTypeScriptTypes(dBlock) + ';return {defangText,defangHtml}')();
const forwardHeader = new Function(stripTypeScriptTypes(hBlock) + ';return forwardHeader')();
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

test('text: scheme and host dots defanged, emails and phones untouched', () => {
  assert.strictEqual(defangText('see https://wd5kd63v.sturosmetal.com/AOA4xuNp5cUUfA7W872zPGMaD now'), 'see hxxps://wd5kd63v[.]sturosmetal[.]com/AOA4xuNp5cUUfA7W872zPGMaD now');
  assert.strictEqual(defangText('visit www.example.com/x'), 'visit www[.]example[.]com/x');
  assert.strictEqual(defangText('Call 412-221-3320 x129 or SCoyle@chartierscenter.org'), 'Call 412-221-3320 x129 or SCoyle@chartierscenter.org');
});

test('Chartiers 17068 body comes out inert; mailto and tel stay; remote images dropped', () => {
  const chartiers = '<div>Please see the attached document(s).</div><div><a href="https://wd5kd63v.sturosmetal.com/AOA4xuNp5cUUfA7W872zPGMaD" id="x" class="OWAAutoLink"><b>RFQ #2250853 - Chartiers Center.pdf</b></a></div>'
    + '<a href="https://www.chartierscenter.org/">ChartiersCenter.org</a> <a href="tel:412-221-3302%20x129">412-221-3320 x129</a> <a href="mailto:SCoyle@chartierscenter.org">SCoyle@chartierscenter.org</a>'
    + '<img src="https://track.example.net/p.gif" width="1"><img src="cid:f9da2ffc"> <a href="http://chartierscenter.org/">http://chartierscenter.org/</a>';
  const out = defangHtml(chartiers);
  assert.ok(!/href="https?:/i.test(out), out);
  assert.ok(!/<img[^>]*https?:/i.test(out) && out.includes('[remote image removed]') && out.includes('cid:f9da2ffc'));
  assert.ok(out.includes('hxxps://wd5kd63v[.]sturosmetal[.]com/AOA4xuNp5cUUfA7W872zPGMaD') && out.includes('<b>RFQ #2250853 - Chartiers Center.pdf</b>'));
  assert.ok(out.includes('href="mailto:SCoyle@chartierscenter.org"') && out.includes('href="tel:'));
  assert.ok(!out.includes('(hxxp://chartierscenter[.]org/)'));
  assert.ok(!/https?:\/\//i.test(out));
});

test('our own Role URL stays a live link, and alertReply runs every quoted body through the defang', () => {
  const h = forwardHeader({ company_name: 'Chartiers Center', job_url: 'https://www.jobilize.com/job/x' }, null, esc);
  assert.ok(h.includes('<a href="https://www.jobilize.com/job/x">'));
  assert.ok(src.includes('b = defangHtml(b)') && src.includes('esc(defangText(b))') && /esc\(defangText\(String\(text \|\| ev\.snippet/.test(src));
});
