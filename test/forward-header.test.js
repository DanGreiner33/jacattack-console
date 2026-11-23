'use strict';
// Luke 11/23: forwards open with Hiring Company / Recruiting Company / Role URL, recorded data only. Run: node --test test/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
const { stripTypeScriptTypes } = require('node:module');
const src = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'functions', 'cold-autopilot', 'index.ts'), 'utf8');
const block = src.match(/\/\/ FORWARD_HEADER_START([\s\S]*?)\/\/ FORWARD_HEADER_END/)[1];
const forwardHeader = new Function(stripTypeScriptTypes(block) + ';return forwardHeader')();
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

test('three lines in order, link only for http(s), missing reads not recorded', () => {
  const h = forwardHeader({ company_name: 'Acme CPA', job_url: 'https://www.indeed.com/viewjob?jk=1' }, null, esc);
  assert.ok(h.indexOf('Hiring Company') < h.indexOf('Recruiting Company') && h.indexOf('Recruiting Company') < h.indexOf('Role URL'));
  assert.ok(h.includes('<b>Recruiting Company:</b> not recorded'));
  assert.ok(h.includes('<a href="https://www.indeed.com/viewjob?jk=1">'));
  const m = forwardHeader(null, null, esc);
  assert.ok(m.includes('Hiring Company:</b> not recorded') && m.includes('Role URL:</b> not recorded'));
  assert.ok(forwardHeader(null, 'Fallback Co', esc).includes('Fallback Co'));
});
test('markup is escaped and bad links are not clickable', () => {
  const x = forwardHeader({ company_name: '<b>x</b>&y', job_url: 'javascript:alert(1)' }, null, esc);
  assert.ok(!x.includes('<b>x') && !x.includes('<a ') && x.includes('&lt;b&gt;x&lt;/b&gt;&amp;y'));
  const q = forwardHeader({ company_name: 'A', job_url: 'https://x.com/a"onmouseover="1' }, null, esc);
  assert.ok(!/href="[^"]*"onmouseover/.test(q));
});
