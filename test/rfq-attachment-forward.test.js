'use strict';
// Luke 11/23 option B: isPositiveReply also passes a reply with an attachment or an RFQ / quote / proposal request mention.
// Existing rules stay; negatives never pass. Run: node --test test/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
const { stripTypeScriptTypes } = require('node:module');
const src = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'functions', 'cold-autopilot', 'index.ts'), 'utf8');
const a = src.indexOf('const QUOTE_SPLIT'), b = src.indexOf('export function replySentiment');
const code = stripTypeScriptTypes(src.slice(a, b).replace(/^export /gm, ''));
const isPositiveReply = new Function(code + ';return isPositiveReply')();

const chartiers = 'Please see the attached document(s). RFQ #2250853 - Chartiers Center.pdf We appreciate your business. Susan Coyle, RN, MPH Chief Executive Officer 437 Railroad Street | Bridgeville , PA 15017';
test('Chartiers Center RFQ (events 17068, 17070) now passes, by RFQ text, by subject, and by attachment', () => {
  assert.equal(isPositiveReply(chartiers), true);
  assert.equal(isPositiveReply('Please see the attached document(s).', { subject: 'RFQ #2250853 - Chartiers Center' }), true);
  assert.equal(isPositiveReply('Please see the attached document(s).', { hasAttachments: true }), true);
});
test('quote and proposal wording passes, case-insensitive, word-bounded', () => {
  for (const t of ['Please send a quote request.', 'We are requesting a quote for this.', 'REQUEST FOR QUOTATION attached', 'This is a request for quote', 'proposal request below', 'Please send RFQs']) assert.equal(isPositiveReply(t), true, t);
  for (const t of ['We are quoted at a premium already.', 'Thanks, noted.', 'Out of office until Monday.']) assert.equal(isPositiveReply(t), false, t);
});
test('no / not interested replies never pass, even with an attachment or RFQ word', () => {
  assert.equal(isPositiveReply('We are not interested. See attached.', { hasAttachments: true }), false);
  assert.equal(isPositiveReply('We are all set, no need for a quote.'), false);
  assert.equal(isPositiveReply('Please do not send RFQ emails.'), false);
});
test('existing rules unchanged', () => {
  assert.equal(isPositiveReply("I'm interested, happy to talk."), true);
  assert.equal(isPositiveReply('Thanks'), false);
  assert.equal(isPositiveReply('Thanks', { hasAttachments: false, subject: 'Re: Accounting role' }), false);
});

test('9641 Nadler phishing lure ("want a quote") must FAIL; plain quote alone never passes', () => {
  const nadler = "You've a New Document shared via OneDrive View Document This invitation is valid only for you and individuals who already have access. This is Paul Nadler's card. Their email is Paul@Nadlerinsurance.com. Need to a change or want a quote,";
  assert.equal(isPositiveReply(nadler, { subject: 'You have a new encrypted document received Paul@Nadlerinsurance.com' }), false);
  assert.equal(isPositiveReply('Thanks, see our quote below.'), false);
  assert.equal(isPositiveReply(nadler, { hasAttachments: true }), true); // attachments still pass (the Graph flag decides in production)
});
