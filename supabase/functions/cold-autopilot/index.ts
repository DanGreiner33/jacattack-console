import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// JacAttack COLD AUTOPILOT (built 2026-10-21). The only sender for Check Leads cold email.
// Fully separate from Check Clients (reeng-*), the Hub's BD engine and the old process-sends / inbox-watch.
// Actions (body.action), all gated by app_config worker_token:
//   send_tick     (cron, every minute)   sends the slots planned for the next minute, each at its own second (20+ s apart)
//   watch_tick    (cron, every 10 min)   reads the cold mailboxes, classifies, suppresses, forwards positive replies
//   refresh_leads (cron, every 3 min)    turns new scan batches into ready / skipped cold_leads (in slices of 125 hits)
//   test_mailbox, thread, forward        called by console-api for the Autopilot tab
// Mailboxes: send_mailboxes where lane = 'cold'. Ledger: contact_touches (source 'cold_autopilot').
// Graph: app-only (client credentials), the multitenant Entra app in COLD_MS_TENANT_ID / COLD_MS_CLIENT_ID /
// COLD_MS_CLIENT_SECRET; each mailbox's tenant is found from its domain.
// PACE (copied from the Hub's sender, which fixed the Oct 12 burst that got two mailboxes blocked): every mailbox
// sends at random times 8am-6pm Central, 5+ minutes apart, never two equal gaps in a row, never the same 30-second slot as another
// mailbox. v5 (10/22): with many mailboxes the day's capacity is shared out evenly so EVERY mailbox gets a schedule; slots are
// 30-second bins (about two sends a minute across the whole system, 960 a day for 48 mailboxes). v6 (10/22): each email is sent at
// its OWN planned second (the wake-up waits for each slot's time) instead of firing whatever was due at the top of the minute (which
// made every send land near :05 and :35). v7 (10/22): at least 20 s after the last email sent by ANY mailbox, checked in the ledger.
// SAFETY: a refusal that is about US (sign-in, permission, quota, "sender not recognized") pauses that mailbox.

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const J = { "Content-Type": "application/json" };
const out = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: J });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SOURCE = "cold_autopilot";
const CONSENT_REDIRECT = "https://dangreiner33.github.io/jacattack-console/";
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

type Cfg = Record<string, string>;
async function loadCfg(): Promise<Cfg> {
  const { data } = await sb.from("app_config").select("key,value");
  const k: Cfg = {};
  for (const r of data ?? []) k[r.key] = r.value;
  return k;
}
const setCfg = (key: string, value: string) => sb.from("app_config").upsert({ key, value }, { onConflict: "key" });

// ---------- time ----------
export function chicago(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short", hourCycle: "h23" }).formatToParts(d).map((x) => [x.type, x.value]));
  const dow = ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 } as Record<string, number>)[p.weekday];
  return { day: `${p.year}-${p.month}-${p.day}`, dow, minute: parseInt(p.hour, 10) * 60 + parseInt(p.minute, 10), sec: parseInt(p.second, 10) };
}
function chicagoDayStartMs(now = new Date()): number {
  const c = chicago(now);
  return now.getTime() - (c.minute * 60 + c.sec) * 1000 - now.getMilliseconds();
}

// ---------- slots (ported from the Hub's drawDay) ----------
function rhythm(minuteOfDay: number) {
  const h = minuteOfDay / 60;
  return h < 8.75 ? 0.55 : h < 11.75 ? 1.25 : h < 13 ? 0.5 : h < 16.5 ? 1.1 : 0.85;
}
const LAST_SEND_EARLIEST_MIN = 17 * 60 + 30;
// Two mailboxes never send within the same BIN_SEC seconds. With 60 the whole system could send at most about one email a minute
// (about 480 a day); with 30 about two a minute; v12 (11/4): 20 gives three a minute (810 slots in a 7am-12pm window), which is what
// 66 mailboxes at 12 a day (792) needs (with 30 the fair share was 8 each).
const BIN_SEC = 20;
export function drawDay(count: number, fromSec: number, endSec: number, taken: Set<number>, rand = Math.random, lastEarliestMin = LAST_SEND_EARLIEST_MIN): number[] {
  if (count <= 0 || endSec - fromSec < 300) return [];
  const blocks: { lo: number; hi: number; w: number }[] = [];
  for (let b = Math.floor(fromSec / 900) * 900; b < endSec; b += 900) {
    blocks.push({ lo: Math.max(b, fromSec), hi: Math.min(b + 900, endSec), w: rhythm(b / 60) * (0.6 + rand() * 0.8) });
  }
  const pick = (hiLimit: number) => {
    const ok = blocks.filter((x) => x.lo < hiLimit);
    if (!ok.length) return Math.floor(fromSec);
    const tot = ok.reduce((a, x) => a + x.w, 0);
    let r = rand() * tot;
    for (const x of ok) { if ((r -= x.w) <= 0) { const hi = Math.min(x.hi, hiLimit); return Math.floor(x.lo + rand() * (hi - x.lo)); } }
    return Math.floor(ok[ok.length - 1].lo);
  };
  const clash = (t: number, times: number[]) => taken.has(Math.floor(t / BIN_SEC)) || times.some((x) => Math.abs(x - t) < 300);
  const repeats = (ts: number[]) => { for (let i = 2; i < ts.length; i++) if (Math.round((ts[i] - ts[i - 1]) / 60) === Math.round((ts[i - 1] - ts[i - 2]) / 60)) return i; return 0; };
  for (let attempt = 0; attempt < 40; attempt++) {
    const lastLo = Math.max(fromSec, Math.min(lastEarliestMin * 60, endSec - 1200));
    let last = 0;
    for (let k = 0; k < 50 && !last; k++) { const t = Math.floor(lastLo + rand() * Math.max(1, endSec - 120 - lastLo)); if (!taken.has(Math.floor(t / BIN_SEC))) last = t; }
    if (!last) continue;
    const times = [last];
    for (let i = 1; i < count; i++) {
      for (let k = 0; k < 80; k++) { const t = pick(last - 300); if (t >= fromSec && !clash(t, times)) { times.push(t); break; } }
    }
    if (times.length < count) continue;
    times.sort((a, b) => a - b);
    for (let fix = 0, at: number; fix < 60 && (at = repeats(times)); fix++) {
      if (at === times.length - 1) at--;
      const rest = times.filter((_, j) => j !== at - 1);
      for (let k = 0; k < 80; k++) { const t = pick(last - 300); if (t >= fromSec && !clash(t, rest)) { rest.push(t); break; } }
      if (rest.length < times.length) break;
      times.splice(0, times.length, ...rest.sort((a, b) => a - b));
    }
    if (!repeats(times)) return times;
  }
  return count > 1 ? drawDay(count - 1, fromSec, endSec, taken, rand, lastEarliestMin) : [];
}
const catchUpGapMin = (lastId: number) => 7 + (Number(lastId) * 7919 % 13) + (Number(lastId) * 104729 % 60) / 60;
const MIN_GAP_MIN = 4;

// ---------- Graph ----------
const GRAPH = "https://graph.microsoft.com/v1.0";
const IMMUTABLE = { Prefer: 'IdType="ImmutableId"' };
function env() {
  const tenant = Deno.env.get("COLD_MS_TENANT_ID"), clientId = Deno.env.get("COLD_MS_CLIENT_ID"), secret = Deno.env.get("COLD_MS_CLIENT_SECRET");
  return tenant && clientId && secret ? { tenant, clientId, secret } : null;
}
const tenantByDomain = new Map<string, string>();
async function tenantFor(mailbox: string): Promise<string> {
  const c = env();
  if (!c) throw new Error("Cold autopilot Graph app is not configured (COLD_MS_* secrets missing)");
  const dom = (mailbox.split("@")[1] || "").toLowerCase();
  if (!dom) return c.tenant;
  if (tenantByDomain.has(dom)) return tenantByDomain.get(dom)!;
  const r = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(dom)}/v2.0/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10000) });
  const j = await r.json().catch(() => ({}));
  const m = String(j.issuer || "").match(/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//i);
  if (!m) throw new Error(`no Microsoft 365 account found for ${dom}`);
  tenantByDomain.set(dom, m[1].toLowerCase());
  return m[1].toLowerCase();
}
const tokens = new Map<string, { t: string; exp: number }>();
async function token(tenant: string): Promise<string> {
  const c = env()!;
  const hit = tokens.get(tenant);
  if (hit && hit.exp > Date.now() + 60e3) return hit.t;
  const body = new URLSearchParams({ client_id: c.clientId, client_secret: c.secret, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" });
  const r = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, { method: "POST", body, signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    const code = String(j.error_description || "").match(/AADSTS\d+/)?.[0] || j.error || "HTTP " + r.status;
    throw Object.assign(new Error("Graph sign-in failed: " + code), { aad: code });
  }
  tokens.set(tenant, { t: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3000) * 1000 });
  return j.access_token;
}
async function gx(box: string, method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<any> {
  const tok = await token(await tenantFor(box));
  const url = path.startsWith("http") ? path : `${GRAPH}/users/${encodeURIComponent(box)}${path}`;
  const r = await fetch(url, { method, signal: AbortSignal.timeout(25000),
    headers: { Authorization: `Bearer ${tok}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...extra },
    body: body !== undefined ? JSON.stringify(body) : undefined });
  if (!r.ok) { const t = await r.text().catch(() => ""); throw Object.assign(new Error(`graph ${r.status}: ${t.slice(0, 300)}`), { status: r.status }); }
  if (r.status === 202 || r.status === 204) { await r.body?.cancel(); return null; }
  return r.json().catch(() => null);
}
const enc = encodeURIComponent;
async function sendNew(box: string, to: string, subject: string, html: string) {
  const d = await gx(box, "POST", "/messages", { subject, body: { contentType: "HTML", content: html }, toRecipients: [{ emailAddress: { address: to } }] }, IMMUTABLE);
  await gx(box, "POST", `/messages/${enc(d.id)}/send`);
  return { id: d.id as string, conversationId: (d.conversationId ?? null) as string | null, internetMessageId: (d.internetMessageId ?? null) as string | null };
}
async function sendReply(box: string, origId: string, html: string, to: string) {
  // createReply on a message in OUR Sent Items addresses the draft to its sender, i.e. our own mailbox. Always re-address it to the prospect (10/26 fix).
  if (!to || !/@/.test(to) || to.trim().toLowerCase() === box.trim().toLowerCase()) throw new Error("refusing to send a follow-up that is not addressed to the prospect");
  const d = await gx(box, "POST", `/messages/${enc(origId)}/createReply`, {}, IMMUTABLE);
  await gx(box, "PATCH", `/messages/${enc(d.id)}`, { body: { contentType: "HTML", content: html }, toRecipients: [{ emailAddress: { address: to } }], ccRecipients: [], bccRecipients: [] }, IMMUTABLE);
  await gx(box, "POST", `/messages/${enc(d.id)}/send`);
  return { id: d.id as string, conversationId: (d.conversationId ?? null) as string | null, internetMessageId: (d.internetMessageId ?? null) as string | null };
}
async function sendNotice(box: string, to: string, subject: string, html: string) {
  const list = to.split(/[,;\s]+/).map((a) => a.trim()).filter((a) => /@/.test(a));
  if (!list.length) throw new Error("no recipient");
  await gx(box, "POST", "/sendMail", { message: { subject, body: { contentType: "HTML", content: html }, toRecipients: list.map((address) => ({ emailAddress: { address } })) }, saveToSentItems: false });
}
const OUR_PROBLEM = /(ErrorSendAsDenied|SendAsDenied|ErrorAccessDenied|Authorization_RequestDenied|InvalidAuthenticationToken|MailboxNotEnabledForRESTAPI|ErrorQuotaExceeded|ErrorMessageSubmissionBlocked|sign-in failed|not configured|no Microsoft 365 account)/i;

async function pauseMailbox(email: string, why: string) {
  await sb.from("send_mailboxes").update({ active: false, paused_reason: why.slice(0, 300), last_error: why.slice(0, 500) }).ilike("email", email);
}

// ---------- email text ----------
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const toHtml = (text: string) => `<div style="font-family: Aptos, Calibri, Helvetica, sans-serif; font-size: 12pt;">${esc(text).replace(/\n/g, "<br>")}</div>`;
const initcap = (s: string) => (s || "").replace(/\b\w/g, (c) => c.toUpperCase());
function aAn(title: string): string {
  const t = (title || "").trim(), first = t.split(/[\s/-]+/)[0] ?? "";
  if (/^[A-Z&]{2,}$/.test(first.replace(/[^A-Z&]/g, "")) && first === first.toUpperCase() && /^[FHLMNRSX]/.test(first)) return "an";
  return /^[aeiou]/i.test(t) ? "an" : "a";
}
function cleanTitle(t: string): string {
  let s = (t || "").trim();
  s = s.replace(/^client opening\s*[-:–]\s*/i, "").replace(/\s*\([^)]*\)\s*$/g, "").replace(/\s*[-–]\s*opening\s*$/i, "");
  return s.replace(/\s+/g, " ").trim();
}
function cleanCompany(n: string): string {
  const raw = (n || "").trim();
  let s = raw.split("|")[0].trim();
  for (let i = 0; i < 3; i++) s = s.replace(/\s*[([][^()[\]]*[)\]]/g, "");
  s = s.replace(/\s*\([^)]*$/, "").replace(/\s+$/, "").replace(/[,\s]+(inc|incorporated|llc|l\.l\.c|llp|pllc|ltd|limited|corp|corporation|co|pc|p\.c|pa|p\.a|ps|p\.s|lp)\.?$/i, "");
  s = s.replace(/\s+/g, " ").replace(/[\s,;:–-]+$/, "").trim();
  return s || raw;
}
function fillTpl(tpl: string, v: { first: string; company: string; title: string }): string {
  return (tpl ?? "").replace(/\{first_name\}/g, v.first).replace(/\{company\}/g, v.company).replace(/\{a_an\}/g, aAn(v.title))
    .replace(/\{job_title\}/g, v.title).replace(/[ \t]*\{signature\}/g, "").replace(/\s+$/, "");
}
// body text + the HTML signature underneath (the signature is HTML, set on the Autopilot tab)
function bodyHtml(text: string, signatureHtml: string): string {
  return toHtml(text) + `<div style="font-family: Aptos, Calibri, Helvetica, sans-serif; font-size: 12pt; margin-top: 12px;">${signatureHtml}</div>`;
}
const FOREIGN_TLD = /[.](?!us$)[a-z]{2}$/i;
const domainOf = (e: string) => (e.split("@")[1] || "").toLowerCase();

// ---------- leads: pull new scan batches into cold_leads ----------
// 11/19: cold_ingest_hits on one 746-hit batch ran past the 8 s statement limit on every run (batch 716 retried forever).
// The batch now goes in slices of INGEST_SLICE hits, each its own statement. cold_ingest_hits writes cold_batches_seen at the
// end of every call, so: the row as it was before the batch is read first; if any slice fails, that row is put back (or removed
// when there was none) so the batch is picked up again next run; when every slice succeeds, the row gets the batch totals.
// Re-running a slice is safe (cold_leads insert is ON CONFLICT DO NOTHING).
const INGEST_SLICE = 125;
// INGEST_SLICED_START
type SeenRow = { batch_id: number; processed_at: string; new_leads: number; ready_leads: number };
type IngestDeps = {
  ingest: (id: number, slice: unknown[]) => Promise<{ data: unknown; error: { message: string } | null }>;
  readSeen: (id: number) => Promise<{ data: SeenRow | null; error: { message: string } | null }>;
  setTotals: (id: number, n: number, ready: number) => Promise<{ error: { message: string } | null }>;
  restoreSeen: (id: number, prior: SeenRow | null) => Promise<{ error: { message: string } | null }>;
};
async function ingestSliced(id: number, hits: unknown[], deps: IngestDeps, size = INGEST_SLICE) {
  const prior = await deps.readSeen(id);
  if (prior.error) return { batch: id, error: "seen read: " + prior.error.message.slice(0, 100) };
  const slices: unknown[][] = [];
  for (let i = 0; i < hits.length; i += size) slices.push(hits.slice(i, i + size));
  if (!slices.length) slices.push([]); // an empty batch still gets its seen row, as before
  let n = 0, ready = 0;
  for (let k = 0; k < slices.length; k++) {
    const { data, error } = await deps.ingest(id, slices[k]);
    if (error) {
      const r = k > 0 ? await deps.restoreSeen(id, prior.data) : { error: null };
      return { batch: id, error: `slice ${k + 1}/${slices.length}: ` + error.message.slice(0, 100), ingested: n,
        ...(r.error ? { restore_error: r.error.message.slice(0, 100) } : {}) };
    }
    const d = (data ?? {}) as { new_leads?: number; ready?: number };
    n += Number(d.new_leads) || 0; ready += Number(d.ready) || 0;
  }
  if (slices.length > 1) {
    const t = await deps.setTotals(id, n, ready);
    if (t.error) return { batch: id, new_leads: n, ready, slices: slices.length, totals_error: t.error.message.slice(0, 100) };
  }
  return { batch: id, new_leads: n, ready, slices: slices.length };
}
// INGEST_SLICED_END
const coldIngestDeps: IngestDeps = {
  ingest: async (id, slice) => await sb.rpc("cold_ingest_hits", { p_batch_id: id, p_hits: slice }),
  readSeen: async (id) => await sb.from("cold_batches_seen").select("batch_id, processed_at, new_leads, ready_leads").eq("batch_id", id).maybeSingle(),
  setTotals: async (id, n, ready) => await sb.from("cold_batches_seen").update({ new_leads: n, ready_leads: ready }).eq("batch_id", id),
  restoreSeen: async (id, prior) => prior
    ? await sb.from("cold_batches_seen").update({ processed_at: prior.processed_at, new_leads: prior.new_leads, ready_leads: prior.ready_leads }).eq("batch_id", id)
    : await sb.from("cold_batches_seen").delete().eq("batch_id", id),
};

async function refreshLeads(cfg: Cfg) {
  const started = Date.now();
  const hours = Math.max(24, parseInt(cfg.cold_batch_window_hours || "96", 10) || 96);
  const expired = (await sb.rpc("cold_housekeeping")).data ?? 0;
  const { data: todo } = await sb.rpc("cold_batches_todo", { p_hours: hours });
  const done: unknown[] = [];
  for (const id of (todo ?? []) as number[]) {
    if (Date.now() - started > 90e3) break;
    // two statements so each gets its own time limit: the scan's hit query, then our filters on its result
    const { data: hits, error: e1 } = await sb.rpc("batch_hits_internal", { p_batch_id: id });
    if (e1) { done.push({ batch: id, error: "hits: " + e1.message.slice(0, 100) }); continue; }
    done.push(await ingestSliced(id, (hits ?? []) as unknown[], coldIngestDeps));
  }
  return { expired_claims: expired, batches: done, remaining: ((todo ?? []) as number[]).length - done.length };
}

// ---------- the sender ----------
async function activeBoxes() {
  const { data } = await sb.from("send_mailboxes").select("email, daily_cap, display_name").eq("lane", "cold").eq("active", true);
  return (data ?? []) as { email: string; daily_cap: number; display_name: string | null }[];
}

async function planSlots(boxes: { email: string; daily_cap: number }[], s: { h0: number; h1: number }, dry: boolean) {
  const now = chicago();
  const dayStart = chicagoDayStartMs();
  const nowSec = now.minute * 60 + now.sec;
  const fromSec = Math.max(s.h0 * 3600, nowSec + 60), endSec = s.h1 * 3600;
  const plan: Record<string, string[]> = {};
  const shuffled = [...boxes].sort(() => Math.random() - 0.5);
  // The whole system can send about two emails a minute (BIN_SEC slots, no two mailboxes in the same slot). To give EVERY
  // mailbox a day (not just the first ones planned), the day's capacity is shared out evenly: each mailbox gets at most
  // 90% of the window's slots divided by the number of mailboxes, or its daily cap if that is lower (48 mailboxes: 20 each).
  // The "last send of the day lands late" rule (the Hub's, for 20 mailboxes) needs one distinct slot per mailbox in the last
  // stretch of the window, so that stretch grows with the number of mailboxes (30 minutes for up to 20 mailboxes, 72 for 48, 99 for 66).
  const nBoxes = Math.max(1, boxes.length);
  const fairShare = Math.floor(0.9 * ((endSec - fromSec) / BIN_SEC) / nBoxes);
  const lastEarliestMin = s.h1 * 60 - Math.max(30, Math.ceil(nBoxes * 1.5));
  const { data: slotsToday } = await sb.from("cold_send_slots").select("mailbox, slot_at").eq("day", now.day);
  const takenByBox = (except: string) => new Set((slotsToday ?? []).filter((x) => x.mailbox !== except).map((x) => Math.floor((new Date(x.slot_at).getTime() - dayStart) / (BIN_SEC * 1000))));
  const taken = new Set<number>((slotsToday ?? []).map((x) => Math.floor((new Date(x.slot_at).getTime() - dayStart) / (BIN_SEC * 1000))));
  for (const b of shuffled) {
    if ((slotsToday ?? []).some((x) => x.mailbox === b.email)) continue;
    const { count: sent } = await sb.from("contact_touches").select("id", { count: "exact", head: true }).eq("mailbox", b.email).eq("source", SOURCE).eq("status", "sent").gte("sent_at", new Date(dayStart).toISOString());
    const target = Math.min(b.daily_cap, Math.max(1, fairShare));
    const count = Math.min(Math.max(0, target - (sent ?? 0)), Math.floor((endSec - fromSec) / 480));
    if (count <= 0) continue;
    const mins = takenByBox(b.email);
    for (const m of taken) mins.add(m);
    const secs = drawDay(count, fromSec, endSec, mins, Math.random, lastEarliestMin);
    if (!secs.length) continue;
    for (const t of secs) taken.add(Math.floor(t / BIN_SEC));
    const rows = secs.map((t) => ({ mailbox: b.email, day: now.day, slot_at: new Date(dayStart + t * 1000).toISOString() }));
    plan[b.email] = rows.map((r) => r.slot_at);
    if (!dry) await sb.from("cold_send_slots").upsert(rows, { onConflict: "mailbox,slot_at", ignoreDuplicates: true });
  }
  return plan;
}

async function suppressed(email: string) {
  const { count } = await sb.from("email_suppression").select("email", { count: "exact", head: true }).eq("email", email.toLowerCase());
  return (count ?? 0) > 0;
}

// Follow-up 1 goes in the same thread cold_followup_after_days (3) after the first email; follow-up 2 goes cold_followup_2_after_days (4)
// after follow-up 1. Each is sent only if its message has been written, nobody at the company has replied, and nothing is suppressed.
// Follow-up 2 is looked for first so a backlog of follow-up 1s never starves it.
async function nextFollowup(box: string, cfg: Cfg): Promise<any | null> {
  if (cfg.cold_followups_enabled !== "true") return null;
  for (const fromStep of [2, 1]) {
    const body = fromStep === 1 ? cfg.cold_followup_body : cfg.cold_followup_2_body;
    if (!(body || "").trim()) continue;
    const days = Math.max(1, parseInt((fromStep === 1 ? cfg.cold_followup_after_days : cfg.cold_followup_2_after_days) || (fromStep === 1 ? "3" : "4"), 10) || (fromStep === 1 ? 3 : 4));
    const cutoff = new Date(Date.now() - days * 86400e3).toISOString();
    const oldest = new Date(Date.now() - (days + 7) * 86400e3).toISOString();
    const { data } = await sb.from("contact_touches").select("*").eq("mailbox", box).eq("source", SOURCE).eq("step", fromStep).eq("status", "sent")
      .not("graph_message_id", "is", null).is("replied_at", null).is("stopped_at", null).lte("sent_at", cutoff).gte("sent_at", oldest)
      .order("sent_at", { ascending: true }).limit(25);
    for (const t of data ?? []) {
      const em = String(t.contact_email).toLowerCase();
      if (FOREIGN_TLD.test(domainOf(em)) || await suppressed(em)) {
        await sb.from("contact_touches").update({ stopped_at: new Date().toISOString(), stop_reason: "suppressed_before_followup" }).eq("id", t.id);
        continue;
      }
      const { count: hasNext } = await sb.from("contact_touches").select("id", { count: "exact", head: true }).eq("source", SOURCE).eq("lead_id", t.lead_id).eq("step", fromStep + 1);
      if ((hasNext ?? 0) > 0) continue;
      // nothing on this lead (the first email or an earlier follow-up) was replied to or stopped
      const { count: ended } = await sb.from("contact_touches").select("id", { count: "exact", head: true }).eq("source", SOURCE).eq("lead_id", t.lead_id).or("replied_at.not.is.null,stopped_at.not.is.null");
      if ((ended ?? 0) > 0) continue;
      if (t.company_id != null) {
        const { count: rep } = await sb.from("contact_touches").select("id", { count: "exact", head: true }).eq("company_id", t.company_id).not("replied_at", "is", null);
        if ((rep ?? 0) > 0) continue;
      }
      return t;
    }
  }
  return null;
}

async function sendFirst(cfg: Cfg, box: string, slot: any, lead: any) {
  const title = cleanTitle(lead.job_title || "") || (lead.job_title || "").trim();
  if (!title) {
    await sb.from("cold_leads").update({ status: "skipped", skip_reason: "no_job_title", decided_at: new Date().toISOString() }).eq("id", lead.id);
    return { skipped: "no_job_title" };
  }
  const first = initcap((lead.poc_name || "").trim().split(/\s+/)[0] || "there");
  const tplSubject = cfg.cold_email_subject_template || cfg.email_subject_template || "{job_title} - Opening";
  const tplBody = cfg.cold_email_template_body || cfg.email_template_body || "";
  const subject = tplSubject.replace(/\{job_title\}/g, title);
  const text = fillTpl(tplBody, { first, company: cleanCompany(lead.company_name || ""), title });
  const html = bodyHtml(text, cfg.cold_signature_html);
  // take the slot first: two overlapping ticks can never both use it
  const { data: got } = await sb.from("cold_send_slots").update({ used_at: new Date().toISOString() }).eq("id", slot.id).is("used_at", null).select("id");
  if (!got?.length) {
    await sb.from("cold_leads").update({ status: "ready", decided_at: null }).eq("id", lead.id);
    return { skipped: "slot_taken" };
  }
  try {
    const m = await sendNew(box, lead.email, subject, html);
    const { data: t } = await sb.from("contact_touches").insert({
      contact_id: lead.contact_id, company_id: lead.company_id, contact_email: lead.email, mailbox: box, batch_id: lead.batch_id, subject,
      status: "sent", source: SOURCE, step: 1, lead_id: lead.id, graph_message_id: m.id, conversation_id: m.conversationId,
      internet_message_id: m.internetMessageId, slot_id: slot.id }).select("id").single();
    await sb.from("cold_leads").update({ status: "sent", touch_id: t?.id ?? null, decided_at: new Date().toISOString() }).eq("id", lead.id);
    await sb.from("cold_send_slots").update({ touch_id: t?.id ?? null }).eq("id", slot.id);
    return { sent: "first", to: lead.email, company: lead.company_name };
  } catch (e: any) {
    const msg = String(e.message || e);
    await sb.from("contact_touches").insert({ contact_id: lead.contact_id, company_id: lead.company_id, contact_email: lead.email, mailbox: box, batch_id: lead.batch_id,
      subject, status: "failed:" + (e.status || "error"), source: SOURCE, step: 1, lead_id: lead.id, slot_id: slot.id, error: msg.slice(0, 500) });
    if (OUR_PROBLEM.test(msg) || e.status === 401 || e.status === 403) {
      await sb.from("cold_leads").update({ status: "ready", decided_at: null }).eq("id", lead.id);   // not the lead's fault
      await sb.from("cold_send_slots").update({ used_at: null }).eq("id", slot.id);
      await pauseMailbox(box, msg);
      return { error: msg, paused: box };
    }
    await sb.from("cold_leads").update({ status: "skipped", skip_reason: "send_failed:" + (e.status || "error"), decided_at: new Date().toISOString() }).eq("id", lead.id);
    return { error: msg };
  }
}

async function sendFollowupFor(cfg: Cfg, box: string, slot: any, t: any) {
  const { data: lead } = await sb.from("cold_leads").select("*").eq("id", t.lead_id).maybeSingle();
  const title = cleanTitle(lead?.job_title || "") || String(t.subject || "").replace(/^(re:\s*)+/i, "").replace(/\s*-\s*opening\s*$/i, "");
  const first = initcap((lead?.poc_name || "").trim().split(/\s+/)[0] || "there");
  const nextStep = Number(t.step) + 1;
  const text = fillTpl(nextStep === 2 ? cfg.cold_followup_body : cfg.cold_followup_2_body, { first, company: cleanCompany(lead?.company_name || ""), title });
  const html = bodyHtml(text, cfg.cold_signature_html);
  const { data: got } = await sb.from("cold_send_slots").update({ used_at: new Date().toISOString() }).eq("id", slot.id).is("used_at", null).select("id");
  if (!got?.length) return { skipped: "slot_taken" };
  const subject = "RE: " + String(t.subject || "").replace(/^(re:\s*)+/i, "");
  try {
    const m = await sendReply(box, t.graph_message_id, html, t.contact_email);
    const { data: nt } = await sb.from("contact_touches").insert({
      contact_id: t.contact_id, company_id: t.company_id, contact_email: t.contact_email, mailbox: box, batch_id: t.batch_id, subject,
      status: "sent", source: SOURCE, step: nextStep, lead_id: t.lead_id, graph_message_id: m.id, conversation_id: m.conversationId || t.conversation_id,
      internet_message_id: m.internetMessageId, slot_id: slot.id }).select("id").single();
    await sb.from("cold_send_slots").update({ touch_id: nt?.id ?? null }).eq("id", slot.id);
    return { sent: "followup", to: t.contact_email };
  } catch (e: any) {
    const msg = String(e.message || e);
    await sb.from("contact_touches").insert({ contact_id: t.contact_id, company_id: t.company_id, contact_email: t.contact_email, mailbox: box,
      subject, status: "failed:" + (e.status || "error"), source: SOURCE, step: nextStep, lead_id: t.lead_id, slot_id: slot.id, error: msg.slice(0, 500) });
    if (OUR_PROBLEM.test(msg) || e.status === 401 || e.status === 403) {
      await sb.from("cold_send_slots").update({ used_at: null }).eq("id", slot.id);
      await pauseMailbox(box, msg);
      return { error: msg, paused: box };
    }
    await sb.from("contact_touches").update({ stopped_at: new Date().toISOString(), stop_reason: "followup_failed" }).eq("id", t.id);
    return { error: msg };
  }
}

async function sendTick(cfg: Cfg, dry: boolean) {
  const started = Date.now();
  const h0 = parseInt(cfg.cold_send_hour_start || "8", 10), h1 = parseInt(cfg.cold_send_hour_end || "18", 10);
  const boxes = await activeBoxes();
  const sigSet = !!(cfg.cold_signature_html || "").trim();
  if (dry) {
    const plan = await planSlots(boxes, { h0, h1 }, true);
    const { count: ready } = await sb.from("cold_leads").select("id", { count: "exact", head: true }).eq("status", "ready");
    return { dry_run: true, would_send_today: Object.fromEntries(Object.entries(plan).map(([k, v]) => [k, v.length])), planned_times_ct: Object.fromEntries(Object.entries(plan).map(([k, v]) =>
      [k, v.map((t) => new Date(t).toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit", second: "2-digit" }))])),
      ready_leads: ready ?? 0, active_mailboxes: boxes.length, signature_set: sigSet, send_enabled: cfg.cold_send_enabled === "true", note: "dry run: nothing was sent, claimed or saved" };
  }
  if (cfg.cold_send_enabled !== "true") return { skipped: "cold_send_enabled off" };
  if (!env()) return { skipped: "Graph app not configured" };
  if (!sigSet) return { skipped: "no signature set" };
  const now = chicago();
  if (now.dow === 0 || now.dow === 6 || now.minute < h0 * 60 || now.minute >= h1 * 60) return { skipped: "outside 8am-6pm CT weekdays" };
  if (!boxes.length) return { skipped: "no active cold mailboxes" };
  await planSlots(boxes, { h0, h1 }, false);
  const outreachDays = String(cfg.cold_outreach_days || "1,2,3").split(",").map((s) => parseInt(s, 10)).filter((n) => n >= 0);
  const outreachFirst = outreachDays.includes(now.dow);
  const results: unknown[] = [];
  // v19 (Luke 11/10): a slot more than SLOT_EXPIRY_MIN minutes past its time is EXPIRED, never sent. On 11/10 the ready pool ran dry at about 9:40 and
  // the overdue slots then sent in bursts at each 15-minute lead refresh, up to 154 minutes late (and past 12:00 while the end hour was 14).
  // Expired slots keep their row (they still count as planned for the day) and get expired_at set, so the tracker's used_at is untouched.
  const expiryMin = Math.max(5, parseInt(cfg.cold_slot_expiry_min || "20", 10) || 20);
  const expiredNow = await sb.from("cold_send_slots").update({ expired_at: new Date().toISOString() }).eq("day", now.day).is("used_at", null).is("expired_at", null)
    .lt("slot_at", new Date(Date.now() - expiryMin * 60e3).toISOString()).select("id");
  if (expiredNow.error) console.error("cold-autopilot expire", expiredNow.error.message);
  if ((expiredNow.data?.length ?? 0) > 0) results.push({ expired_slots: expiredNow.data!.length, older_than_min: expiryMin });
  // Each email goes out at ITS OWN planned second, not at the top of the minute: this wake-up takes the slots planned for the next
  // minute and waits for each one's time (plus 0-3 s). (Firing whatever was due at the wake-up made every send land near :05 and :35
  // of the minute, a regular rhythm.)
  const boxByEmail = new Map(boxes.map((b) => [b.email, b]));
  const { data: due } = await sb.from("cold_send_slots").select("*").eq("day", now.day).is("used_at", null).is("expired_at", null)
    .lte("slot_at", new Date(Date.now() + 58e3).toISOString()).order("slot_at", { ascending: true }).limit(10);
  for (const slot of due ?? []) {
    if (Date.now() - started > 110e3) break;
    const b = boxByEmail.get(slot.mailbox);
    if (!b) continue;   // paused or removed since the plan was drawn
    const { data: lastRows } = await sb.from("contact_touches").select("id, sent_at").eq("mailbox", b.email).eq("source", SOURCE).order("sent_at", { ascending: false }).limit(1);
    const last = lastRows?.[0];
    const slotMs = new Date(slot.slot_at).getTime();
    const overdue = Date.now() - slotMs > 3 * 60e3;
    const gapMin = last ? (overdue ? catchUpGapMin(last.id) : MIN_GAP_MIN) : 0;
    if (last && Date.now() - new Date(last.sent_at).getTime() < gapMin * 60e3) continue;
    // wait for this slot's own second, and until at least 20 s after the last email sent by ANY mailbox (checked against the ledger,
    // so it also holds across wake-ups: adjacent slots can fall in different wake-ups)
    const slotJitter = Math.random() * 3000, gapJitter = Math.random() * 3000;   // v12: was 10 s of gap jitter; with 20 s bins the system sends every 20-23 s
    for (let i = 0; i < 3; i++) {
      const { data: la } = await sb.from("contact_touches").select("sent_at").eq("source", SOURCE).eq("status", "sent").order("sent_at", { ascending: false }).limit(1);
      const lastAnyMs = la?.[0] ? new Date(la[0].sent_at).getTime() : 0;
      const wait = Math.max(slotMs + slotJitter, lastAnyMs + 20000 + gapJitter) - Date.now();
      if (wait <= 0) break;
      await sleep(Math.min(wait, 45000));
    }
    const first = async () => {
      const { data } = await sb.rpc("cold_pick_lead", { p_mailbox: b.email });
      return data && (data as any).id != null ? data : null;
    };
    const follow = () => nextFollowup(b.email, cfg);
    let kind: "first" | "followup" | null = null, item: any = null;
    if (outreachFirst) { item = await first(); kind = item ? "first" : null; if (!item) { item = await follow(); kind = item ? "followup" : null; } }
    else { item = await follow(); kind = item ? "followup" : null; if (!item) { item = await first(); kind = item ? "first" : null; } }
    if (!item) continue;   // the slot stays open for the next contact
    const r = kind === "first" ? await sendFirst(cfg, b.email, slot, item) : await sendFollowupFor(cfg, b.email, slot, item);
    results.push({ mailbox: b.email, ...r });
  }
  return results.length ? { sends: results } : {};
}

// ---------- reply watcher ----------
const NDR_FROM = /(mailer-daemon|postmaster|microsoftexchange[0-9a-f]{20,}|^bounce|mail delivery (sub)?system)/i;
const NDR_SUBJ = /^(undeliverable|undelivered|non[- ]?delivery|delivery (status notification \(failure\)|has failed|failure|failed)|mail delivery failed|returned mail|failure notice|message not delivered|could not be delivered|address not found)/i;
const SENDER_BLOCKED = /(not recognized as a valid sender|bad outbound sender|5\.1\.8|5\.7\.708|5\.7\.705|5\.7\.750|restricted from sending|no longer allowed to send|suspected of sending spam)/i;
const DELAY_SUBJ = /(delivery (status notification \(delay\)|delayed)|delay(ed)? notification|will retry|still trying)/i;
const OOO_SUBJ = /^(automatic reply|auto(matic)?[- ]?(reply|response)|auto:|autoreply|out of (the )?office|ooo\b|away from (the )?office|on vacation|r[ée]ponse automatique|abwesenheit)/i;
const OOO_BODY = /(out of (the )?office|i am (currently )?(away|out|on (vacation|leave|pto))|i('| a)m (currently )?(away|out of)|limited access to (my )?e-?mail|will (be )?(return|back)|returning (on|to the office)|(maternity|paternity|medical|annual) leave|away from my desk)/i;
const LEFT_BODY = /(no longer (with|employed|at|works? (at|for|with)|part of)|has (left|retired from) (the|our)|is no longer (with|at|employed)|has departed|left the (company|firm|organization)|this (e-?mail|mailbox|address) is no longer (monitored|active|in use))/i;
const OPT_OUT = /(remove (me|us|my (e-?mail|name|address)|our (e-?mail|name|address))|take (me|us) off|unsubscribe|opt(ed)?[- ]?out|do not (contact|e-?mail|reach out|solicit)|don'?t (contact|e-?mail|reach out) (me|us|again|anymore)|stop (contacting|e-?mailing|messaging) (me|us)|never (contact|e-?mail)|no (further|more) (contact|e-?mails?|solicitations?)|cease (all )?(contact|communication)|(off|from) your (mailing |e-?mail |distribution )?list)/i;
const DECLINE = /(not interested|no,? thanks?\b|no thank you|not at this time|not right now|not looking (for|to)|(we('| a)re|we are|are) not (currently )?hiring|no (current )?(openings|need)\b|not in need|(position|role|job|opening|req(uisition)?|search) (has been|was|is|been|has) (already )?(filled|closed|cancel+ed|put on hold|on hold)|already (filled|hired|found|been filled)|filled (it|the (role|position|job))|(we|they) (have |'ve )?filled|hired (someone|internally)|internal(ly)? (hire|candidate|filled)|we('| a)re (all )?set|all set\b|(don'?t|do not|never) (work|use|partner) with (outside |third[- ]party |external )?(recruiters|agencies|firms|staffing)|not (currently )?(working|work|partner(ing)?) with (outside |third[- ]party |external )?(recruiters|agencies|firms|staffing)|no longer (hiring|looking|need|recruiting)|(we('| wi)ll|going to) pass\b|pass(ing)? on (this|your)|(must|have to|will) (respectfully )?decline|not a (good )?fit|we have (it|this) covered|not something we need)/i;
const DECLINE_MORE = new RegExp([
  "(should|we('| a)re|we are|we('ll| will)) (be )?(all )?set(?!\\s+up)( for now| at this time| on (this|that|it))?\\b",
  "found (a few |some |several |a couple( of)? |our |the right |a |an? )?(new |good |great )?(hires?|candidates?|people|someone|person|replacements?)\\b",
  "(made|extended) (an |the )?(offer|hire)\\b|offer (was |has been )?accepted|(we|i) (have |'ve )?(already )?hired\\b",
  "already (have|got|working with|engaged|partnered with|partnering with|using|use) (an? |other |several |multiple |some |our |a few |two |three )?(other )?(agenc(y|ies)|recruit(ers?|ing (firms?|partners?))|search firms?|staffing( firms?| agenc(y|ies))?|vendors?)",
  "(agenc(y|ies)|recruiters?|search firms?) (already )?working on (it|this|same|that|the (role|position|search|opening))",
  "(we('| a)re|we are|i('| a)m|i am) covered\\b",
  "misfired|wrong (person|contact|company|email|address)\\b",
  "(do not|don'?t|won'?t|will not|no) need (for )?(a |an |any |your |outside |external |third[- ]party )?(recruit|agenc|help|assistance|services|staffing|partner|support)",
  "unsolicited|(do not|don'?t) accept (unsolicited |agency |third[- ]party )?(resumes|submissions|candidates)",
  "(don'?t|do not|won'?t|will not|not) (pay|paying) (agency |recruit(er|ing) |placement |search )?fees?|no budget\\b|hiring freeze",
  "(position|role|job|opening|req(uisition)?) (is |has been |was )?(no longer|not) (available|open|active)",
  "(cancel+ed|eliminated|paused|closed) (the |this |that )?(position|role|search|req(uisition)?|opening)",
].join("|"), "i");
const YES = /((happy|glad|open|willing) to (take a look|look|review|engage|talk|chat|discuss|connect|consider|work|see)|send (me |over |us )?(the |your )?(agreement|contract|terms|fee|rates?)|(attach(ed|ing)|here is|here's) (a copy of )?(the |our )?(job description|jd)|(set up|schedule|hop on|jump on) (a )?(call|time|meeting)|(please|feel free to|go ahead and) send (me |us |over )?(any |your )?(candidates|resumes|profiles)|what (are|is) your (fee|terms|rates?))/i;
const RECRUITER_DOMAIN_RE = /(staffing|recruit|(?<!re)search|talent|workforce|personnel|placement|headhunt|careers|(?<!s)hire)/i;
const EMAIL_RE = /[A-Z0-9._%+'-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const QUOTE_SPLIT = /\n?(From:|-----Original Message|On .{0,80} wrote:)/i;
// DEFANG_START
// Luke 11/23: links inside a forwarded reply or thread are made INERT (the Chartiers RFQ link to an unrelated domain was quarantined, and any lure we
// forward could be clicked). Our own header links (Role URL) are not touched. Same code as the Hub's lib/defang.js; keep the two in step.
const URL_RE = /\b(?:https?|ftp):\/\/[^\s<>"'()\]]+|\bwww\.[^\s<>"'()\]]+/gi;
function defangText(s: unknown): string {
  return String(s == null ? "" : s).replace(URL_RE, (u: string) => {
    const m = u.match(/^((?:[a-z]+):\/\/)?([^\/?#]*)([\s\S]*)$/i)!;
    const scheme = (m[1] || "").replace(/^http/i, "hxxp").replace(/^ftp/i, "fxp");
    return scheme + m[2].replace(/\./g, "[.]") + m[3];
  });
}
function defangHtml(html: unknown): string {
  let h = String(html == null ? "" : html);
  h = h.replace(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi, (all: string, a: string, b: string, c: string, inner: string) => {
    const href = String(a != null ? a : b != null ? b : c || "").replace(/&amp;/g, "&").trim();
    if (!/^(?:https?:|ftp:|\/\/|www\.)/i.test(href)) return all;
    const shown = inner.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();
    const d = defangText(href.replace(/^\/\//, "https://"));
    return defangText(inner) + (defangText(shown) === d ? "" : " (" + d.replace(/&/g, "&amp;").replace(/</g, "&lt;") + ")");
  });
  h = h.replace(/<img\b[^>]*\bsrc\s*=\s*["']?(?:https?:)?\/\/[^>]*>/gi, "[remote image removed]");
  return defangText(h);
}
// DEFANG_END

// v15 (Luke 11/5): only a reply that asks to talk, asks about fees or information, or points to the right person is forwarded.
const POS_STRONG = /(fee structure|your fees?\b|(what|how) (are|is) your (fee|terms|rates?|pricing)|let me know (your|the) (fees?|rates?|terms|pricing)|(?<!not )(?<!n't )(?<!un)\binterested (in|to)\b|\bi'?m interested|we'?re interested|(would|'d) (like|love) to (talk|connect|chat|discuss|learn|hear|meet|speak)|happy to (talk|chat|connect|discuss|take a look|review|meet|speak)|open to (a |an )?(call|chat|talk|discuss|connecting|conversation)|(set up|schedule|hop on|jump on|book|arrange) (a |an )?(call|time|meeting|chat|intro)|give (me|us) a call|call me\b|let'?s (talk|chat|connect|discuss|set up|schedule)|(please |kindly )?send (me |us |over )?(more )?(info|information|details|candidates|resumes|profiles|your (agreement|contract|terms|fee))|can you (send|share)|share (your|an?) (updated )?(resume|profile|info)|(when|what time) (are you|can we) (free|available|talk|connect))/i;
const POS_REFERRAL = /(you (may|can|should|could) (reach out|contact|speak|talk|email|call)|(please |kindly )?(contact|reach out to|email|call|speak (to|with)) (our|my|the) [a-z &-]{0,30}(hr|human resources|recruit|talent|hiring|department|team|manager|director|vp|president)|forwarded (this|your)|i('| ha)ve (forwarded|passed)|looping in|cc'?ing|copying (you|him|her|them|us|our [a-z]+|my [a-z]+|the [a-z]+|[\w.+-]+@[\w.-]+))/i;
const POS_NEG = /(not (currently |at this time |right now )?(interested|hiring|looking)|no (need|longer|openings?|assistance)|don'?t (need|have a need)|do not (need|have a need)|we'?re (all )?set|we have (it|this) covered|filled)/i;
// 11/6 (Luke, "copying fix"): the sender's legal disclaimer is not part of the reply. The text is cut at the first disclaimer marker, and
// "copying" only counts when a person follows it (copying you / him / our HR / name@address), not "...the information it contains, copying ...".
const DISC_I = /(confidentiality notice|privileged and[/]or confidential|this (e-?mail|message|communication)[^.]{0,60}(privileged|confidential)|if you (have )?(received|are not the intended recipient of) this (e-?mail|message|communication)( in error)?|the information (contained )?in this (e-?mail|message)|this (e-?mail|message) (and any attachments? )?(is|are) intended)/i;
const DISC_CAPS = /\b(CONFIDENTIAL|CONFIDENTIALITY NOTICE|DISCLAIMER)\b/;
// 11/6 (Luke): fee and price questions, and "send me your agreement / contract / terms", count as positive (not after "not" / "don't" / "no").
const POS_PRICE = /(what percentage|percentage (do|would) you charge|what (do|would) you charge|what are you charging|how much (do|would|will|is|are)|how much\b[^.?!]{0,40}\?|what('s| is| are) (your|the) (fees?|rates?|pricing|price|cost|percentage|commission)|(your|the) (fees?|rates?|pricing|commission) (is|are|would be)\b)/i;
const POS_AGREE = /(?<!not )(?<!n't )(?<!no )\bsend (it |that |this )?(to (me|us) )?(me |us |over )?(your |the |an? )?(one[- ]page )?(agreement|contract|terms)\b/i;
const NEG_SEND = /(don'?t|do not|never|no need to|please don'?t) (send|email|e-mail)\b/i;
function replyBody(text: string): string {
  let t = String(text || "").replace(/\s+/g, " ").split(QUOTE_SPLIT)[0];
  const cut = [t.search(DISC_I), t.search(DISC_CAPS)].filter((i) => i >= 0);
  if (cut.length) t = t.slice(0, Math.min(...cut));
  return t.slice(0, 1500);
}
// 11/23 (Luke, option B for now): a reply with an attachment, or one that mentions an RFQ / request for quote or quotation / quote /
// proposal request, is also forwarded (Chartiers Center RFQ #2250853 was held back as "not a yes"). Not after a "no" (NEG_SEND, POS_NEG).
// Tightened (Luke via Master 11/23, after a phishing lure with "want a quote" passed): a plain "quote" alone does NOT pass. It counts only in
// the same sentence as request / requesting / RFQ.
const POS_RFQ_STRONG = /\b(rfqs?|requests? for (a )?quot(e|es|ation|ations)|proposal requests?|requests? for (a )?proposals?)\b/i;
const POS_QUOTE = /\bquot(e|es|ation|ations)\b/i;
const POS_REQ = /\b(request(s|ed|ing)?|rfqs?)\b/i;
const POS_RFQ = { test: (s: string) => POS_RFQ_STRONG.test(s) || String(s).split(/[.!?\n]+/).some((x) => POS_QUOTE.test(x) && POS_REQ.test(x)) };
export function isPositiveReply(own: string, opts?: { hasAttachments?: boolean; subject?: string }): boolean {
  const t = replyBody(own);
  if (NEG_SEND.test(t)) return false;
  if (POS_STRONG.test(t) || POS_PRICE.test(t) || POS_AGREE.test(t)) return true;
  if (POS_REFERRAL.test(t) && !POS_NEG.test(t)) return true;
  return !POS_NEG.test(t) && (!!opts?.hasAttachments || POS_RFQ.test(t) || POS_RFQ.test(String(opts?.subject || "")));
}

// 11/23 (Luke: "a ton of responses that are clearly not interested still get tagged positive/neutral"): more ways people say no, from real
// replies (Hub bd_inbox_events 3606 4425 4488 6110 6146 3931 4780; JacAttack inbox_events 4686 4774 4795 4796 4798 4824 4851 5291 5297 8060 9093 11009 11036 13810).
// Identical in the Hub (lib/bd-sender.js) and JacAttack (cold-autopilot). A YES phrase still outranks all of them.
const DECLINE_V2 = new RegExp([
  "not in the market",
  "(application|applications|posting|search|position|role) (was |were |has been |have been )?closed",
  "not (currently )?(using|utili[sz]ing) (any )?(outside|external) (sources|resources|vendors)",
  "(we'?ve|we have|we) got (this|it) covered|we'?ve got this",
  "handle (all |most )?(of )?(our |the )?(hiring|recruiting) (efforts )?(through|in[- ]house|internally)",
  "in receipt of your resume|qualified applicants will be (scheduled|contacted)",
  "(only )?hire (w-?2 )?(employees )?direct(ly)?|only hire",
  "final stages of interviewing|actively interviewing",
  "(don'?t|do not) need (any )?(additional|more|extra)",
  "(do not|don'?t|doesn'?t) (currently |presently )?(have|need) (any |an? )?(open(ings?)?|positions?|roles?|vacanc(y|ies)|need)\\b",
  "(do not|don'?t) (anticipate|expect|foresee) (needing|a need)",
  "not (currently )?(utili[sz]ing|using|considering|seeking|accepting|engaging|working with) (any |additional |outside |non-local |external |third[- ]party )*(agenc(y|ies)|recruit(ers?|ing)|search (resources|firms?)|vendors?|resources|partners|assistance|help|services)",
  "(no|not|don'?t need) (any )?(additional |extra |outside |external )(recruiting |search )?(help|assistance|resources|support)\\b|no (extra |additional |outside )?(help|assistance) (is |was )?(needed|necessary)",
  "(do|handle|manage|run|conduct)(es)? (all |most )?(of )?(our|my) (own )?(recruiting|hiring|openings)|(recruit(ing|ers?)|hiring|openings?)[^.]{0,40}(internally|in[- ]house)|(our own|own) recruit(ing|ers?)|(never|don'?t|do not) use outside|covered in[- ]house|handled (in[- ]house|internally|through our hr)",
  "(we|i) (are|am|'re) (currently )?(using|working with) (a|an|our) (recruiter|agency|search firm|staffing)|using a recruiter",
  "(position|role|job|opening|it|this) (is|has been|was|'s) filled\\b|(did|have|has) fill(ed)? (our|the|this) (opening|position|role)",
  "(that|this|it) (is|'s) not (ours|our (job|posting|listing|opening|position|role|company))|(wrong|different) (orion|company|listing|job|posting)|confused (a |this )?(listing|posting|job|company)|looking at the wrong|listing by another company",
  "(have|having|got) (three|two|four|several|multiple|many|a few) (different )?(other )?(staffing )?(agenc(y|ies)|recruiters)",
  "(we|you) (are|'re) a (staffing|recruiting) firm",
].join("|"), "i");
const DECLINE_BARE_NO = /^\s*(no|nope|nah)\b(?!\s*(problem|worries|rush|issue))/i;
// 11/23 (Luke): a reply whose own text is essentially only a shared-document / encrypted-message / view-file notice (a phishing lure) is HELD:
// not auto-forwarded, still shown with "Forward now". Narrow on purpose: any recruiting wording or a longer message is not held.
const LINK_ONLY_LURE = /(new (encrypted )?document|encrypted (message|document|file)|shared (a |the )?(document|file)|shared via (onedrive|sharepoint|dropbox|google drive|docusign)|view (the )?(document|file|message)|invitation is valid only for you)/i;
const LINK_ONLY_BUSINESS = /(resume|candidate|\bfees?\b|agreement|position|opening|interested|hiring|\brole\b|\bjobs?\b|search|recruit)/i;
const LINK_ONLY_FIRST_PERSON = /\b(i|we|i've|we've|i have|we have)\b[^.?!]{0,25}\bshared\b/i;
export function isLinkOnlyNotice(own: string): boolean {
  const t = String(own || "").replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();
  return t.length <= 450 && !LINK_ONLY_FIRST_PERSON.test(t) && LINK_ONLY_LURE.test(t) && !LINK_ONLY_BUSINESS.test(t);
}
export function replySentiment(own: string, fromEmail: string): "positive_neutral" | "negative" {
  // curly apostrophes (Outlook on phones) read as straight ones, as in the Hub (10/26)
  const t = String(own || "").replace(/[‘’]/g, "'").replace(/\s+/g, " ");
  if (RECRUITER_DOMAIN_RE.test(domainOf(fromEmail))) return "negative";
  if ((DECLINE.test(t) || DECLINE_MORE.test(t) || DECLINE_V2.test(t) || DECLINE_BARE_NO.test(t) || NEG_SEND.test(t)) && !YES.test(t)) return "negative";
  return "positive_neutral";
}
export function classify(m: any, ourBoxes: Set<string>): { kind: string; why: string } {
  const from = String(m.from?.emailAddress?.address ?? "").toLowerCase(), fromName = String(m.from?.emailAddress?.name ?? "");
  const subj = String(m.subject ?? ""), prev = String(m.bodyPreview ?? "");
  const hdr: Record<string, string> = {};
  for (const h of (m.internetMessageHeaders ?? [])) hdr[String(h.name).toLowerCase()] = String(h.value);
  const autoSub = (hdr["auto-submitted"] ?? "").toLowerCase();
  const isAuto = (autoSub && autoSub !== "no") || !!hdr["x-autoreply"] || !!hdr["x-autorespond"] || /auto_reply|auto-reply/i.test(hdr["precedence"] ?? "");
  if (DELAY_SUBJ.test(subj)) return { kind: "other", why: "delivery_delay" };
  const isNdr = NDR_SUBJ.test(subj) || NDR_FROM.test(from) || NDR_FROM.test(fromName);
  if (isNdr && SENDER_BLOCKED.test(prev)) return { kind: "sender_blocked", why: "our mailbox is blocked from sending" };
  if (isNdr) return { kind: "bounce", why: "ndr" };
  if (ourBoxes.has(from)) return { kind: "other", why: "own_mailbox" };
  const oooSubj = OOO_SUBJ.test(subj);
  if ((oooSubj || isAuto) && LEFT_BODY.test(prev)) return { kind: "left", why: "auto_left_company" };
  if (oooSubj || (isAuto && OOO_BODY.test(prev))) return { kind: "ooo", why: "auto_reply" };
  if (isAuto) return { kind: "other", why: "auto_generated" };
  return { kind: "reply", why: "human" };
}

async function messageText(box: string, id: string, field: "uniqueBody" | "body" = "uniqueBody"): Promise<string> {
  const j = await gx(box, "GET", `/messages/${enc(id)}?$select=${field}`, undefined, { Prefer: 'outlook.body-content-type="text"' });
  return String(j?.[field]?.content ?? "");
}

// FORWARD_HEADER_START
// Luke 11/23: a forward opens with Hiring Company / Recruiting Company / Role URL, recorded data only.
// JacAttack records the hiring company (cold_leads.company_name) and the posting URL (cold_leads.job_url) but NOT which
// recruiting firm posted it (its leads come from job boards, not recruiter ads), so Recruiting Company is "not recorded".
function forwardHeader(lead: any, fallbackCompany: string | null, escf: (x: unknown) => string) {
  const clean = (x: unknown) => String(x ?? "").replace(/\s+/g, " ").trim();
  const hiring = clean(lead?.company_name || fallbackCompany) || "not recorded";
  const rec = clean(lead?.recruiting_company) || "not recorded";
  const url = clean(lead?.job_url);
  const safe = /^https?:\/\/\S+$/i.test(url) ? url : "";
  const row = (l: string, v: string) => `<p style="margin:0 0 3px"><b>${l}:</b> ${v}</p>`;
  const link = safe ? `<a href="${escf(safe).replace(/"/g, "&quot;")}">${escf(safe)}</a>` : escf(url || "not recorded");
  return `<div style="margin:0 0 16px;padding:0 0 10px;border-bottom:1px solid #ccc">${row("Hiring Company", escf(hiring))}${row("Recruiting Company", escf(rec))}${row("Role URL", link)}</div>`;
}
// FORWARD_HEADER_END

// v15 (Luke 11/5, approved example): a positive reply goes to lsmith@ and ghalsey@ (cold_reply_alert_to) as info@fclabz.com through the
// n8n mailer: one note line, THEIR REPLY on top, then the rest of the conversation most recent first down to our first outreach.
// Our own internal forwards (mail from the box to lsmith@ or ghalsey@) are left out of the thread. Sent once: callers mark alerted_at.
async function alertReply(cfg: Cfg, box: string, ev: any, touch: any, company: string | null, text: string, lead?: any): Promise<boolean> {
  const to = String(cfg.cold_reply_alert_to || "").trim();
  if (!/@/.test(to) || !cfg.health_mail_url || !cfg.health_mail_token) return false;
  const role = String(touch?.subject ?? ev.subject ?? "").replace(/^(re:\s*)+/i, "").replace(/\s*-\s*opening\s*$/i, "");
  const when = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/Chicago", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " CT";
  const note = `Company: ${company || "unknown"} | Contact: ${ev.from_name ? ev.from_name + " <" + ev.from_email + ">" : ev.from_email} | Replied: ${when(ev.received_at)} | Came in on ${box}`;
  const stamp = (m: any) => String(m.sentDateTime || m.receivedDateTime);
  const internal = (m: any) => (m?.toRecipients ?? []).some((x: any) => /^(lsmith|ghalsey)@fcplacements\.com$/i.test(String(x?.emailAddress?.address || "")));
  let msgs: any[] = [];
  try {
    if (ev.conversation_id) {
      const j = await gx(box, "GET", `/messages?$filter=${enc(`conversationId eq '${String(ev.conversation_id).replace(/'/g, "''")}'`)}&$top=50&$select=id,from,toRecipients,sentDateTime,receivedDateTime,subject,body`, undefined, IMMUTABLE);
      msgs = (j?.value ?? []).filter((m: any) => !internal(m)).sort((a: any, b: any) => stamp(a).localeCompare(stamp(b)));
    }
  } catch { /* the saved snippet will do */ }
  const block = (m: any, label?: string) => {
    const ours = String(m?.from?.emailAddress?.address || "").toLowerCase() === box.toLowerCase();
    let b = String(m?.body?.content || "").replace(/<script[\s\S]*?<\/script>/gi, "");
    if (m?.body?.contentType === "html") b = defangHtml(b);
    if (m?.body?.contentType !== "html") b = `<pre style="white-space:pre-wrap;font:inherit">${esc(defangText(b))}</pre>`;
    return `<div style="margin:0 0 14px"><p style="margin:0 0 4px;font-size:12px;color:#555"><b>${label || (ours ? "OUR EMAIL" : "THEIR MESSAGE")}</b> &middot; ${esc(m?.from?.emailAddress?.name || "")} &lt;${esc(m?.from?.emailAddress?.address || "")}&gt; &middot; ${esc(when(stamp(m)))}</p><div style="border-left:3px solid ${ours ? "#9ca3af" : "#0a7f5f"};padding:4px 12px">${b}</div></div>`;
  };
  const reply = msgs.find((m: any) => m.id === ev.graph_id) ?? msgs.filter((m: any) => String(m?.from?.emailAddress?.address || "").toLowerCase() !== box.toLowerCase()).pop();
  const rest = msgs.filter((m: any) => m !== reply).reverse();
  const top = reply ? block(reply, "THEIR REPLY") : `<div style="margin:0 0 14px"><p style="margin:0 0 4px;font-size:12px;color:#555"><b>THEIR REPLY</b></p><div style="border-left:3px solid #0a7f5f;padding:4px 12px;white-space:pre-wrap">${esc(defangText(String(text || ev.snippet || "").trim().slice(0, 4000)))}</div></div>`;
  const html = `<div style="font-family:Aptos,Calibri,Helvetica,sans-serif;font-size:14px;color:#111;max-width:760px">${forwardHeader(lead, company, esc)}<p style="margin:0 0 14px"><b>${esc(note)}</b></p>${top}${rest.length ? `<p style="margin:6px 0 10px;color:#555;font-size:12px">Below: the rest of the conversation, most recent first, down to our first outreach.</p>${rest.map((m: any) => block(m)).join("")}` : ""}</div>`;
  try {
    const r = await fetch(cfg.health_mail_url, { method: "POST", signal: AbortSignal.timeout(30000),
      headers: { "Content-Type": "application/json", "x-health-token": cfg.health_mail_token },
      body: JSON.stringify({ to, subject: `JacAttack positive reply: ${company || ev.from_email}${role ? " — " + role : ""}`.slice(0, 250), html }) });
    return r.ok;
  } catch { return false; }
}

async function watchMailbox(cfg: Cfg, box: string, ourBoxes: Set<string>) {
  const stat: any = { read: 0, new: 0, by_kind: {} };
  const { data: lastEv } = await sb.from("inbox_events").select("received_at").eq("mailbox", box).order("received_at", { ascending: false }).limit(1);
  const { data: firstT } = await sb.from("contact_touches").select("sent_at").eq("mailbox", box).eq("source", SOURCE).order("sent_at", { ascending: true }).limit(1);
  if (!firstT?.length && !lastEv?.length) return stat;   // nothing sent from this mailbox yet
  const since = new Date(lastEv?.[0] ? new Date(lastEv[0].received_at).getTime() - 3600e3 : new Date(firstT![0].sent_at).getTime()).toISOString();
  const { data: knownRows } = await sb.from("inbox_events").select("graph_id").eq("mailbox", box).gte("received_at", since).limit(5000);
  const known = new Set((knownRows ?? []).map((r) => r.graph_id));
  const sel = "id,conversationId,receivedDateTime,from,subject,bodyPreview,hasAttachments,internetMessageHeaders";
  let url: string | null = `/mailFolders/inbox/messages?$filter=${enc(`receivedDateTime ge ${since}`)}&$orderby=receivedDateTime asc&$top=50&$select=${sel}`;
  const started = Date.now();
  while (url && stat.read < 1500 && Date.now() - started < 90e3) {
    const page = await gx(box, "GET", url);
    url = page?.["@odata.nextLink"] ?? null;
    for (const m of page?.value ?? []) {
      stat.read++;
      if (known.has(m.id)) continue;
      stat.new++;
      let { kind, why } = classify(m, ourBoxes);
      const from = String(m.from?.emailAddress?.address ?? "").toLowerCase();
      let touch: any = null, method: string | null = null;
      if (m.conversationId) {
        const { data } = await sb.from("contact_touches").select("*").eq("conversation_id", m.conversationId).eq("source", SOURCE).eq("status", "sent").order("sent_at", { ascending: false }).limit(1);
        if (data?.length) { touch = data[0]; method = "conversation"; }
      }
      if (!touch && from) {
        const { data } = await sb.from("contact_touches").select("*").ilike("contact_email", from).eq("source", SOURCE).eq("status", "sent").order("sent_at", { ascending: false }).limit(1);
        if (data?.length) { touch = data[0]; method = "sender"; }
      }
      if (!touch && (kind === "bounce" || kind === "left")) {
        let text = String(m.bodyPreview ?? "");
        try { text += "\n" + await messageText(box, m.id, "body"); } catch { /* preview only */ }
        for (const a of (text.match(EMAIL_RE) ?? []).map((x) => x.toLowerCase())) {
          const { data } = await sb.from("contact_touches").select("*").ilike("contact_email", a).eq("mailbox", box).eq("source", SOURCE).eq("status", "sent").order("sent_at", { ascending: false }).limit(1);
          if (data?.length) { touch = data[0]; method = "body_address"; break; }
        }
      }
      if (kind === "reply" && !touch) { kind = "other"; why = "no_matching_email"; }
      if (kind === "reply" && touch && String(touch.contact_email).toLowerCase() !== from) kind = "colleague_reply";
      let own = "";
      if ((kind === "reply" || kind === "colleague_reply") && touch) {
        try { own = await messageText(box, m.id); } catch { own = String(m.bodyPreview ?? "").split(QUOTE_SPLIT)[0]; }
        own = own.split(QUOTE_SPLIT)[0];
        if (OPT_OUT.test(own)) { kind = "opt_out"; why = "asked_not_to_be_contacted"; }
      }
      const sentiment = (kind === "reply" || kind === "colleague_reply") ? replySentiment(own, from) : null;
      if ((kind === "ooo" || kind === "left" || kind === "bounce") && !touch) { why = "unmatched_" + kind; kind = "other"; }
      let action = "none";
      if (touch && ["bounce", "left", "opt_out"].includes(kind)) action = "suppressed";
      if (touch && (kind === "reply" || kind === "colleague_reply")) action = "stopped_followup";
      if (kind === "sender_blocked") action = "paused_mailbox";
      stat.by_kind[kind] = (stat.by_kind[kind] || 0) + 1;
      const ev = { mailbox: box, graph_id: m.id, conversation_id: m.conversationId ?? null, received_at: m.receivedDateTime, from_email: from || null,
        from_name: m.from?.emailAddress?.name ?? null, subject: String(m.subject ?? "").slice(0, 300),
        snippet: String(m.bodyPreview ?? "").replace(/\s+/g, " ").slice(0, 240), kind, why, sentiment,
        matched_email: touch ? String(touch.contact_email).toLowerCase() : null, matched_touch_id: touch?.id ?? null, match_method: method, action };
      const { data: ins, error } = await sb.from("inbox_events").insert(ev).select("id").single();
      if (error || !ins) continue;
      const now = new Date().toISOString();
      if (kind === "sender_blocked") { await pauseMailbox(box, "Microsoft says this mailbox is blocked from sending: " + ev.snippet.slice(0, 120)); continue; }
      if (action === "suppressed") {
        const addrs = kind === "opt_out" ? [...new Set([from, String(touch.contact_email).toLowerCase()].filter(Boolean))] : [String(touch.contact_email).toLowerCase()];
        for (const a of addrs) {
          await sb.from("email_suppression").upsert({ email: a, reason: kind === "opt_out" ? "opt_out" : kind === "left" ? "left_company" : "bounce", inbox_event_id: ins.id }, { onConflict: "email", ignoreDuplicates: true });
          await sb.from("contact_touches").update({ stopped_at: now, stop_reason: kind }).ilike("contact_email", a).is("stopped_at", null);
        }
        if (kind !== "opt_out") await sb.from("contacts").update({ email_status: kind === "bounce" ? "bounced" : "left_company" }).ilike("email", String(touch.contact_email));
      }
      if (action === "stopped_followup" || kind === "opt_out") {
        await sb.from("contact_touches").update({ replied_at: m.receivedDateTime, reply_checked_at: now }).eq("id", touch.id).is("replied_at", null);
        if (touch.company_id != null) await sb.from("contact_touches").update({ stopped_at: now, stop_reason: "company_replied" }).eq("company_id", touch.company_id).eq("source", SOURCE).is("stopped_at", null).is("replied_at", null);
      }
      // 11/23 (Luke): every positive_neutral reply forwards, as in the Hub; the sentiment read (DECLINE_V2 etc.) is the only gate. isPositiveReply is no longer used here.
      if (sentiment === "positive_neutral" && touch && !isLinkOnlyNotice(own)) {
        const { data: lead } = touch.lead_id ? await sb.from("cold_leads").select("company_name,job_url").eq("id", touch.lead_id).maybeSingle() : { data: null };
        if (await alertReply(cfg, box, { ...ev, kind }, touch, lead?.company_name ?? null, own, lead)) await sb.from("inbox_events").update({ alerted_at: new Date().toISOString() }).eq("id", ins.id);
      }
    }
  }
  return stat;
}

async function watchTick(cfg: Cfg) {
  if (cfg.cold_inbox_watch_enabled !== "true") return { skipped: "cold_inbox_watch_enabled off" };
  if (!env()) return { skipped: "Graph app not configured" };
  const { data: boxes } = await sb.from("send_mailboxes").select("email").eq("lane", "cold").not("connected_at", "is", null);
  const ourBoxes = new Set((boxes ?? []).map((b) => b.email.toLowerCase()));
  const report: Record<string, unknown> = {};
  for (const b of boxes ?? []) {
    try { report[b.email] = await watchMailbox(cfg, b.email.toLowerCase(), ourBoxes); }
    catch (e) {
      report[b.email] = { error: String(e).slice(0, 200) };
      const msg = String(e);
      if (OUR_PROBLEM.test(msg)) await sb.from("send_mailboxes").update({ last_error: msg.slice(0, 500) }).ilike("email", b.email);
    }
  }
  await setCfg("cold_inbox_watch_last_run", new Date().toISOString());
  return report;
}

// ---------- console actions ----------
function plainError(e: any, domain: string): string {
  const aad = String(e.aad || ""), msg = String(e.message || e);
  if (/AADSTS700016|AADSTS65001|unauthorized_client|AADSTS7000229/i.test(aad + msg)) return `The Microsoft 365 account for ${domain} has not approved the app yet. A Global Admin of that account needs to open the consent link below once.`;
  if (/AADSTS90002|AADSTS900023|no Microsoft 365 account/i.test(aad + msg)) return `No Microsoft 365 account was found for ${domain}. Check the address, or the domain is not on Microsoft 365.`;
  if (/AADSTS7000215|invalid_client|AADSTS7000222/i.test(aad + msg)) return "The app's client secret is wrong or expired. Re-create the secret in Entra and update COLD_MS_CLIENT_SECRET.";
  if (/ErrorAccessDenied|Authorization_RequestDenied|\b403\b/i.test(msg)) return "The app is approved but has no permission on this mailbox. It needs the Application permissions Mail.Send and Mail.ReadWrite, with admin consent granted in that account (and no application access policy blocking this mailbox).";
  if (/MailboxNotFound|ResourceNotFound|ErrorInvalidUser|\b404\b/i.test(msg)) return "That mailbox was not found in the Microsoft 365 account. Check the address and that it has a mailbox license.";
  return "Could not connect: " + msg.slice(0, 200);
}
async function testMailbox(emailRaw: string) {
  const email = String(emailRaw || "").toLowerCase().trim();
  const domain = domainOf(email);
  const c = env();
  const consent = c && domain ? `https://login.microsoftonline.com/${domain}/adminconsent?client_id=${c.clientId}&redirect_uri=${encodeURIComponent(CONSENT_REDIRECT)}` : null;
  const { data: row } = await sb.from("send_mailboxes").select("id").eq("lane", "cold").ilike("email", email).maybeSingle();
  if (!row) return { ok: false, message: "That mailbox is not in the list. Add it first." };
  if (!c) return { ok: false, message: "The cold autopilot Graph app is not configured on the server (COLD_MS_* secrets missing)." };
  try {
    const tenant = await tenantFor(email);
    await token(tenant);
    await gx(email, "GET", "/mailFolders/inbox?$select=id");                     // read works
    const d = await gx(email, "POST", "/messages", { subject: "JacAttack connection test (draft, never sent)" }, IMMUTABLE);   // write works
    if (d?.id) await gx(email, "DELETE", `/messages/${enc(d.id)}`);
    await sb.from("send_mailboxes").update({ tenant_id: tenant, connected_at: new Date().toISOString(), last_error: null,
      paused_reason: "connected: press Activate when ready" }).eq("id", row.id);
    return { ok: true, message: "Connected. The app can read and write this mailbox. Press Activate to include it in sending.", consent_url: consent };
  } catch (e: any) {
    const message = plainError(e, domain);
    await sb.from("send_mailboxes").update({ last_error: message.slice(0, 500) }).eq("id", row.id);
    return { ok: false, message, consent_url: consent };
  }
}
async function threadFor(kind: string, id: number) {
  const { data: r } = kind === "touch"
    ? await sb.from("contact_touches").select("mailbox, conversation_id, graph_message_id").eq("id", id).maybeSingle()
    : await sb.from("inbox_events").select("mailbox, conversation_id, graph_id").eq("id", id).maybeSingle();
  if (!r) throw Object.assign(new Error("That email is not in the records"), { status: 404 });
  const box = String(r.mailbox).toLowerCase();
  const msgId = (r as any).graph_message_id ?? (r as any).graph_id;
  let list: any[] = [];
  if (r.conversation_id) {
    const j = await gx(box, "GET", `/messages?$filter=${enc(`conversationId eq '${String(r.conversation_id).replace(/'/g, "''")}'`)}&$top=30&$select=id,from,toRecipients,receivedDateTime,sentDateTime,bodyPreview,subject`, undefined, { Prefer: 'outlook.body-content-type="text"' });
    list = j?.value ?? [];
  }
  if (!list.length && msgId) { const one = await gx(box, "GET", `/messages/${enc(msgId)}?$select=id,from,toRecipients,receivedDateTime,sentDateTime,bodyPreview,subject`); if (one) list = [one]; }
  const messages = [];
  for (const m of list.sort((a, b) => String(a.receivedDateTime || a.sentDateTime).localeCompare(String(b.receivedDateTime || b.sentDateTime)))) {
    let text = String(m.bodyPreview || "");
    try { text = (await messageText(box, m.id)) || text; } catch { /* preview */ }
    messages.push({ id: m.id, subject: m.subject, date: m.receivedDateTime || m.sentDateTime, from: m.from?.emailAddress ?? null,
      to: (m.toRecipients ?? []).map((x: any) => x.emailAddress?.address), text: text.trim().slice(0, 4000), ours: String(m.from?.emailAddress?.address || "").toLowerCase() === box });
  }
  return { mailbox: box, messages };
}
async function forwardEvent(cfg: Cfg, id: number) {
  const { data: e } = await sb.from("inbox_events").select("*").eq("id", id).maybeSingle();
  if (!e) throw new Error("That reply is not in the records");
  const { data: touch } = e.matched_touch_id ? await sb.from("contact_touches").select("*").eq("id", e.matched_touch_id).maybeSingle() : { data: null };
  const { data: lead } = touch?.lead_id ? await sb.from("cold_leads").select("company_name,job_url").eq("id", touch.lead_id).maybeSingle() : { data: null };
  let text = e.snippet || "";
  try { text = (await messageText(e.mailbox, e.graph_id)).split(QUOTE_SPLIT)[0] || text; } catch { /* snippet will do */ }
  const ok = await alertReply(cfg, e.mailbox, e, touch, lead?.company_name ?? null, text, lead);
  if (!ok) throw new Error("The forward did not send. Check the forward-to addresses in Settings and that " + e.mailbox + " is connected.");
  await sb.from("inbox_events").update({ alerted_at: new Date().toISOString() }).eq("id", id);
  return { ok: true, to: cfg.cold_reply_alert_to };
}

// ---------- entry ----------
Deno.serve(async (req) => {
  try {
    const body = await req.json().catch(() => ({}));
    const cfg = await loadCfg();
    if (!body.worker_token || body.worker_token !== cfg.worker_token) return out({ error: "unauthorized" }, 401);
    const action = String(body.action || "");
    const log = (r: unknown) => console.log("cold-autopilot", action, JSON.stringify(r).slice(0, 1500));
    // cron actions answer at once (pg_net waits on the slowest call in a batch) and work in the background
    if (["send_tick", "watch_tick", "refresh_leads"].includes(action) && !body.wait && !body.dry_run) {
      EdgeRuntime.waitUntil((async () => {
        try {
          const r = action === "send_tick" ? await sendTick(cfg, false) : action === "watch_tick" ? await watchTick(cfg) : await refreshLeads(cfg);
          log(r);
          if (action === "refresh_leads") await setCfg("cold_leads_last_refresh", new Date().toISOString());
        } catch (e) { console.error("cold-autopilot error", action, String(e)); }
      })());
      return out({ started: true, action }, 202);
    }
    switch (action) {
      case "send_tick": return out(await sendTick(cfg, body.dry_run === true));
      case "watch_tick": return out(await watchTick(cfg));
      case "refresh_leads": return out(await refreshLeads(cfg));
      case "test_mailbox": return out(await testMailbox(body.email));
      case "test_followup": { const to = String(body.to || ""), box = String(body.mailbox || ""); if (!to || !box) return out({ error: "mailbox and to required" }, 400);
        const a = await sendNew(box, to, "TEST first email (follow-up fix)", bodyHtml("This is a test first email.", cfg.cold_signature_html));
        await new Promise((r) => setTimeout(r, 4000));
        const b = await sendReply(box, a.id, bodyHtml("This is the test follow-up. It should be addressed to you and threaded under the first email.", cfg.cold_signature_html), to);
        return out({ ok: true, first: a.id, followup: b.id }); }
      case "thread": return out(await threadFor(String(body.kind), Number(body.id)));
      case "forward": return out(await forwardEvent(cfg, Number(body.id)));
      default: return out({ error: "unknown action" }, 400);
    }
  } catch (e: any) {
    return out({ error: String(e.message || e) }, e.status && e.status >= 400 && e.status < 600 ? e.status : 500);
  }
});
