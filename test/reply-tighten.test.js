'use strict';
// Luke 11/23: replies that are clearly not interested were still tagged positive_neutral. Fixtures are REAL replies (stored snippets) from the last 30 days of JacAttack and the Hub:
// bd_inbox_events / inbox_events; mark N = clearly not interested (must read negative), R = a real positive or neutral reply (must STAY positive_neutral).
// Run: node --test test/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
const { stripTypeScriptTypes } = require('node:module');
const src = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'functions', 'cold-autopilot', 'index.ts'), 'utf8');
const a = src.indexOf('const DECLINE = '), b = src.indexOf('export function classify');
const { replySentiment, isLinkOnlyNotice } = new Function("const domainOf=(e)=>String(e||'').split('@')[1]||'';" + stripTypeScriptTypes(src.slice(a, b).replace(/^export /gm, '')) + ';return {replySentiment,isLinkOnlyNotice}')();
const rows = [
 {
  "repo": "hub",
  "id": 1098,
  "mark": "R",
  "text": "Can you send me a resume please. We are looking for Jr engineers 5 yrs experience EIT, mid level 5-10 yrs licensed transportation engineers and senior level 15+ yrs experience with project manager level experience.",
  "from": "tmc@cardinal-engineering.com"
 },
 {
  "repo": "hub",
  "id": 1256,
  "mark": "R",
  "text": "Hi Lauren, What are your fees? Stacey Micka Principal | Director, Human Resources",
  "from": "smicka@acentech.com"
 },
 {
  "repo": "hub",
  "id": 1544,
  "mark": "R",
  "text": "Sure, send your agreement Bruce E. Loren, Esq. Board Certified by The Florida Bar in Construction Law",
  "from": "bloren@lorenkeanlaw.com"
 },
 {
  "repo": "hub",
  "id": 2172,
  "mark": "R",
  "text": "Hi Lauren, Please work through Chris Pienkowski, Chief Performance Officer. Thank you, Timothy R Lebens CEO",
  "from": "tim.lebens@kanyonmanufacturing.com"
 },
 {
  "repo": "hub",
  "id": 3598,
  "mark": "R",
  "text": "Hi Lauren, I am the Director of Talent here at CRR and work with John on hiring. You can send any tax senior or tax manager resumes to me. Thanks!",
  "from": "sarah.pratt@crradvisors.com"
 },
 {
  "repo": "hub",
  "id": 3606,
  "mark": "N",
  "text": "Thanks, Lauren. Not in the market at the moment. Steve Steven H. Eichler | Partner",
  "from": "seichler@margolisedelstein.com"
 },
 {
  "repo": "hub",
  "id": 3931,
  "mark": "N",
  "text": "You may have confused a listing by another company on the east coast. Wayne Gondeck, AIA",
  "from": "wayneg@drgarchitects.com"
 },
 {
  "repo": "hub",
  "id": 3961,
  "mark": "R",
  "text": "Hello, I would be interested in hearing more about your approach to this search for the role and fee, thanks! Shelby Friend Human Resources Director",
  "from": "saf@whitleylawfirm.com"
 },
 {
  "repo": "hub",
  "id": 4425,
  "mark": "N",
  "text": "Hello Lauren, Thanks for reaching out but we don't need any additional recruiting resources. Felicia Mudd (she/her) Talent Acquisition Manager",
  "from": "felicia@drbronner.com"
 },
 {
  "repo": "hub",
  "id": 4428,
  "mark": "R",
  "text": "Hi, Can you send me a link to the posting you speak of? Michael A. Lysakowski Marketing Manager",
  "from": "malysakowski@gwbcrane.com"
 },
 {
  "repo": "hub",
  "id": 4453,
  "mark": "R",
  "text": "Hi Lauren, Yes - open to creative solutions. What type of roles do you specialize in? We are a growing business so have a few positions to fill over the next 6-weeks.",
  "from": "kyle@proventilation.com"
 },
 {
  "repo": "hub",
  "id": 4473,
  "mark": "R",
  "text": "Hi Lauren, Thank you for approaching! We are hiring Sales Support Executive, Can you please provide some candidates?",
  "from": "sudarshan.kadariya@globalhitechfilms.com"
 },
 {
  "repo": "hub",
  "id": 4479,
  "mark": "R",
  "text": "Yes, we would. However, no more than 15% fees. If not acceptable we cannot work together. Please confirm.",
  "from": "dbaumwoll@ptgb-law.com"
 },
 {
  "repo": "hub",
  "id": 4488,
  "mark": "N",
  "text": "Lauren - we are not considering additional search resources at this time, Bruce Bechtel Get Outlook for iOS",
  "from": "bruceb@bristoltoolanddie.com"
 },
 {
  "repo": "hub",
  "id": 4769,
  "mark": "R",
  "text": "Hello Lauren, Thank you for your email and for reaching out. I'd like to connect with our HR Manager, Mari Bardavillias (cc'd) who is overseeing this. She would be able to give you a better status of things than I can. Many thanks, -Dan",
  "from": "dmamelak@custombiologics.com"
 },
 {
  "repo": "hub",
  "id": 4780,
  "mark": "N",
  "text": "Good morning Lauren, Thanks for reaching out. We actually have three different staffing agencies assisting us with this position along with our own recruiting. If we aren't seeing the candidates we need then I will have our internal recruit",
  "from": "dleggett@endeavor-re.com"
 },
 {
  "repo": "hub",
  "id": 4817,
  "mark": "R",
  "text": "Thanks. What are your rates? DANIEL KRAMER KRAMER TRIAL LAWYERS A.P.C.",
  "from": "dkramer@kramerlaw.com"
 },
 {
  "repo": "hub",
  "id": 6100,
  "mark": "R",
  "text": "Good morning, Lauren, I will share your email with our HR department that coordinates working with recruiting firms. Thank you, Scott Scott Giltner, Chief Lending Officer",
  "from": "sgiltner@westconsincu.org"
 },
 {
  "repo": "hub",
  "id": 6109,
  "mark": "R",
  "text": "Always interested in receiving good resumes. min 8 years fam law litigation experience. I also require a writing sample Debra R. Schoenberg, Esq.*",
  "from": "dschoenberg@sflg.com"
 },
 {
  "repo": "hub",
  "id": 6110,
  "mark": "N",
  "text": "Thanks Lauren, we are using a recruiter.",
  "from": "cindy@rockvilleredi.org"
 },
 {
  "repo": "hub",
  "id": 6146,
  "mark": "N",
  "text": "no Evan Y. Lin, JD, CPA, AEP® Attorney / Managing Member",
  "from": "elin@llattorneys.com"
 },
 {
  "repo": "jac",
  "id": 4686,
  "mark": "N",
  "text": "Good Morning Lauren: I do not currently have any open positions. Respectfully, Pamela Fulton Get Outlook for iOS",
  "from": "pfulton@thompsongrayinc.com"
 },
 {
  "repo": "jac",
  "id": 4774,
  "mark": "N",
  "text": "Hi – we currently do not have an open role in my team that requires an external recruiter. Thanks",
  "from": "jacob.botta@zirrus.com"
 },
 {
  "repo": "jac",
  "id": 4795,
  "mark": "N",
  "text": "Thank you for reaching out. At this time, we are actively interviewing a select group of applicants who have already applied for the position, so we do not anticipate needing external assistance. We appreciate your offer and will",
  "from": "grusso@monterey.org"
 },
 {
  "repo": "jac",
  "id": 4796,
  "mark": "N",
  "text": "Hi there, it is filled. Thanks. Best Regards, Gary Campbell President and Chief Executive Officer Johnson Health Center",
  "from": "gcampbell@jhcvirginia.org"
 },
 {
  "repo": "jac",
  "id": 4798,
  "mark": "N",
  "text": "Thanks for reaching out. We do not have any opening right now. We will contact you if we need any. Thank you. Chris Wen, Principal TAAD, LLP.",
  "from": "chris@taadllp.com"
 },
 {
  "repo": "jac",
  "id": 4824,
  "mark": "N",
  "text": "No, this is all handled through our HR department. Sent from my iPhone. Please excuse autocorrect malfunctions and brevity.",
  "from": "cbranson@cityofbeaufort.org"
 },
 {
  "repo": "jac",
  "id": 4837,
  "mark": "R",
  "text": "You may reach out to our HR Department. Thank you Lorie Sanchez Mannapov, LLC",
  "from": "lorie@mannapovllc.com"
 },
 {
  "repo": "jac",
  "id": 4851,
  "mark": "N",
  "text": "Hi Lauren, The application was closed a couple weeks ago, and we just completed interviews on Friday. Thanks for checking in, Joanne",
  "from": "jfabia@cityofnapa.org"
 },
 {
  "repo": "jac",
  "id": 5291,
  "mark": "N",
  "text": "Hi Lauren, Thanks for reaching out. No assistance is needed. Have a great day! Julie Wheeler Talent Acquisition Manager",
  "from": "jwheeler@broadmead.org"
 },
 {
  "repo": "jac",
  "id": 5297,
  "mark": "N",
  "text": "Hello Lauren, Thank you for reaching out. At this time we are not using outside sources for recruitment. I appreciate your time and I hope you have a wonderful rest of your week. Best, Bianca Guillen",
  "from": "biancag@pshhc.org"
 },
 {
  "repo": "jac",
  "id": 7960,
  "mark": "R",
  "text": "Hi Lauren, I’m interested in connecting with you. Please let me know when you have time to connect this week. Best, AW",
  "from": "ayan.warsame@codman.org"
 },
 {
  "repo": "jac",
  "id": 8060,
  "mark": "N",
  "text": "Thank you for reaching out. Unfortunately, we handle all of our recruiting efforts internally and are not utilizing outside recruiting services at this time. Best regards, Shirley",
  "from": "monroe_assistant@freedombehavioral.com"
 },
 {
  "repo": "jac",
  "id": 9093,
  "mark": "N",
  "text": "Hi Lauren, we have a process for evaluating all the great applicants that we get. Thanks for noticing our indeed post. But we've got this covered. Sent from my mobile phone.",
  "from": "kathy@budgetease.biz"
 },
 {
  "repo": "jac",
  "id": 9141,
  "mark": "R",
  "text": "Hi Lauren, can you share your updated resume Thank you, Sharif Sk Associate Director at Maxima Technologies,LLC",
  "from": "sharifsk@maximatek.com"
 },
 {
  "repo": "jac",
  "id": 9204,
  "mark": "R",
  "text": "What percentage do you charge? This is an in office position in HUNTSVILLE AL Sharon S. Heinz Enrolled Agent",
  "from": "sharon@profitwiseaccounting.biz"
 },
 {
  "repo": "jac",
  "id": 9742,
  "mark": "R",
  "text": "Any candidates must have direct merchant cash advance accounting experience.",
  "from": "adam@genuinefunding.com"
 },
 {
  "repo": "jac",
  "id": 11009,
  "mark": "N",
  "text": "Our internal recruiters handle ALL our openings and never use outside.",
  "from": "becky@pikemann.com"
 },
 {
  "repo": "jac",
  "id": 11036,
  "mark": "N",
  "text": "Hello Lauren, We do not have an Administrative Coordinator position open at the Lima, OH site. I'm not sure where you are seeing it, but it is not ours. Thank you for your inquiry. Nancy Wireman Advisor, HR Lima Nutrien",
  "from": "nancy.wireman@nutrien.com"
 },
 {
  "repo": "jac",
  "id": 12510,
  "mark": "R",
  "text": "Hi Lauren, Thanks for the email and inquiring... I would be interested in learning more and the cost associated with utilizing your services. Thanks again, Michael Michael Burk",
  "from": "mb@bridgeprosvcs.com"
 },
 {
  "repo": "jac",
  "id": 12623,
  "mark": "R",
  "text": "Hi Lauren, Thanks for reaching out. Does this mean you have experience with recruiting directly in the Philippines? Looking forward to your response! Best, Vanessa Vanessa Gooding",
  "from": "vanessa@intrinsicdigital.com"
 },
 {
  "repo": "jac",
  "id": 13810,
  "mark": "N",
  "text": "HI Lauren— I appreciate you reaching out. We actually have a recruiting/headhunting division so we handle all hiring through that department. Thank you! Sarah Pickering Artemis Solutions VP of Business Development",
  "from": "spickering@artemisvf.com"
 },
 {
  "repo": "jac",
  "id": 9636,
  "mark": "N",
  "text": "Good morning, As stated in our post, we are not seeking agency assistance in filling this position. Thank you, Danielle Socha Human Resources Manager",
  "from": "dsocha@sunpolymers.com"
 },
 {
  "repo": "jac",
  "id": 9668,
  "mark": "N",
  "text": "We are in receipt of your resume and cover letter; qualified applicants will be scheduled by our hiring team. Thanks!",
  "from": "jeff@moggcpa.tax"
 },
 {
  "repo": "jac",
  "id": 11487,
  "mark": "N",
  "text": "Hi Lauren, Thank you for reaching out - we have the search covered in-house and are not utilizing external partners at this time! Andrea Medved Talent Acquisition Specialist | HR",
  "from": "amedved@standardprocess.com"
 },
 {
  "repo": "jac",
  "id": 11503,
  "mark": "N",
  "text": "Good morning Lauren Thank you for your email. We are not utilizing agencies at this time but thank you for the offer of assistance. Brenda O'Connor Director of Human Resources",
  "from": "boconnor@imperialcleaning.com"
 },
 {
  "repo": "jac",
  "id": 12086,
  "mark": "N",
  "text": "Thanks for reaching out. We do our own recruiting. Have a good day. Tonja Tonja Hodgkinson Chief Financial and Administrative Officer",
  "from": "t.hodgkinson@helpinghandsreentry.org"
 },
 {
  "repo": "jac",
  "id": 12487,
  "mark": "N",
  "text": "Thanks for your email. We only hire w2 employees directly thru our website.. Bharat",
  "from": "bharat.mital@compuvis.com"
 },
 {
  "repo": "jac",
  "id": 12739,
  "mark": "N",
  "text": "Lauren, Sorry. We are in the final stages of interviewing a qualified candidate. Virginia",
  "from": "votis@centaurusfarms.com"
 },
 {
  "repo": "jac",
  "id": 13770,
  "mark": "N",
  "text": "Hello, We did fill our opening for an Accounting Manager in September. Thanks, Wendy",
  "from": "wblair@gpspca.org"
 },
 {
  "repo": "jac",
  "id": 13806,
  "mark": "N",
  "text": "Good afternoon Lauren, I think you are looking at the wrong Orion. We do not work in taxes or any kind of account. Ryland Reamy President / COO Orion Solutions, LLC",
  "from": "rpreamy@orionsolutionsllc.com"
 },
 {
  "repo": "jac",
  "id": 14779,
  "mark": "R",
  "text": "Tell me a little more on your company Chetan",
  "from": "cpatel@buckheadamerica.com"
 },
 {
  "repo": "jac",
  "id": 14807,
  "mark": "R",
  "text": "Hi Lauren, Do you have experience in ag lending recruiting? LB Laura Bustamante, SPHR, SHRM-SCP Chief People Officer",
  "from": "lbustamante@armlend.com"
 },
 {
  "repo": "jac",
  "id": 14809,
  "mark": "N",
  "text": "Hi Lauren, Thank you for the email. We are currently not considering non-local agencies at this time to assist us with filling this position. If anything were to change, I will reach out.",
  "from": "kylie.schrieber@liveonnebraska.org"
 },
 {
  "repo": "jac",
  "id": 15210,
  "mark": "N",
  "text": "Good morning Lauren, Thanks for reaching out. We actually have three different staffing agencies assisting us with this position along with our own recruiting.",
  "from": "dleggett@endeavor-re.com"
 },
 {
  "repo": "jac",
  "id": 15215,
  "mark": "N",
  "text": "Hi Lauren, We are a staffing firm. Stacy Stacy Leone Worton Managing Partner EMLIN GROUP, LLC",
  "from": "stacy@emlingroup.com"
 },
 {
  "repo": "jac",
  "id": 15513,
  "mark": "N",
  "text": "Thanks Lauren, no extra help needed. Kr Elena Secchi | Partner ARTEMIS Career Consulting",
  "from": "e.secchi@artemis-cc.com"
 },
 {
  "repo": "jac",
  "id": 17068,
  "mark": "R",
  "text": "Please see the attached document(s). RFQ #2250853 - Chartiers Center.pdf We appreciate your business. Susan Coyle, RN, MPH Chief Executive Officer",
  "from": "scoyle@chartierscenter.org"
 }
];
test('real not-interested replies read negative, real positives stay positive_neutral', () => {
  for (const r of rows) assert.strictEqual(replySentiment(r.text, r.from), r.mark === 'N' ? 'negative' : 'positive_neutral', r.repo + ' ' + r.id + ': ' + r.text.slice(0, 80));
});
test('yes outranks a no phrase; bare "No problem" is not a decline; curly apostrophes read; careers/hire domains are recruiters', () => {
  assert.strictEqual(replySentiment('No problem, happy to take a look at your terms.', 'a@b.com'), 'positive_neutral');
  assert.strictEqual(replySentiment('We\u2019re all set for now', 'a@b.com'), 'negative');
  assert.strictEqual(replySentiment('Please send details', 'x@acmecareers.com'), 'negative');
  assert.strictEqual(replySentiment('Please send details', 'x@fastrehire.com'), 'negative');
  assert.strictEqual(replySentiment("please don't send more email", 'a@b.com'), 'negative');
});
test('the auto-forward no longer uses the isPositiveReply gate', () => {
  const w = src.slice(src.indexOf('async function watchMailbox') > -1 ? src.indexOf('async function watchMailbox') : 0);
  assert.ok(/sentiment === "positive_neutral" && touch && !isLinkOnlyNotice\(own\)\) \{/.test(src), 'gate removed');
  assert.ok(!/sentiment === "positive_neutral" && touch && isPositiveReply/.test(src));
});

const PHISH = "You've a New Document shared via OneDrive View Document © This invitation is valid only for you and individuals who already have access. This is Paul Nadler's card. Their email is Paul@Nadlerinsurance.com. Need to a change or want a quote,";
test('link-only phishing notice (9641) is held; all R replies are not held; N replies read negative', () => {
  assert.strictEqual(isLinkOnlyNotice(PHISH), true);
  assert.strictEqual(isLinkOnlyNotice('You have a new encrypted message. View file'), true);
  assert.strictEqual(isLinkOnlyNotice('Please see the shared document and send resumes'), false);
  assert.strictEqual(isLinkOnlyNotice('Please see the attached document(s). RFQ #2250853 - Chartiers Center.pdf We appreciate your business.'), false);
  let rs = 0;
  for (const r of rows) { if (r.mark === 'R') { rs++; assert.strictEqual(isLinkOnlyNotice(r.text), false, 'R held: ' + r.id); assert.strictEqual(replySentiment(r.text, r.from), 'positive_neutral'); } if (r.mark === 'N') assert.strictEqual(replySentiment(r.text, r.from), 'negative'); }
  assert.strictEqual(rs, 24); // all R fixtures (the Master said 36; the stored marks hold 24 R, 34 N, 4 U)
});
