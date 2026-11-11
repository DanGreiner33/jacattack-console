-- JacAttack console v1.3.4: Responses parity with Operations Performance and the FCP Hub (Luke 11/11: "its two tables are
-- showing different numbers when they should be the same").
-- NOT APPLIED. Apply in the JacAttack Supabase project (ewyhiutafnoqlcsyrpvb) with the console change in the same PR.
-- The only changes to the live function (read back 11/11 with pg_get_functiondef):
--   responses: kinds reply, colleague_reply, opt_out PLUS ooo, bounce, left; last 30 days; limit 300 -> 2000; id tiebreak
--   new key responses_window_days = 30 (the console switches to the shared chips only when it sees this key)
-- Rollback: re-run the same function with the old responses where clause and without responses_window_days.
CREATE OR REPLACE FUNCTION public.cold_autopilot_page(p_passcode text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare
  v_day timestamptz := date_trunc('day', now() at time zone 'America/Chicago') at time zone 'America/Chicago';
  v_week timestamptz := date_trunc('week', now() at time zone 'America/Chicago') at time zone 'America/Chicago';
  cfg json; res json;
begin
  if not public.check_passcode(p_passcode) then raise exception 'unauthorized'; end if;
  select json_object_agg(key, case when key = 'cold_signature_html' then (case when value <> '' then 'set' else '' end) else value end)
    into cfg from app_config where key like 'cold\_%' escape '\';
  select json_build_object(
    'config', cfg,
    'signature_html', (select value from app_config where key='cold_signature_html'),
    'followup_body', (select value from app_config where key='cold_followup_body'),
    'sent', (select json_build_object('total', count(*), 'leads', count(distinct lead_id), 'firsts', count(*) filter (where step=1),
               'followups', count(*) filter (where step>1), 'today', count(*) filter (where sent_at >= v_day), 'week', count(*) filter (where sent_at >= v_week))
             from contact_touches where source='cold_autopilot' and status='sent'),
    'failed_7d', (select count(*) from contact_touches where source='cold_autopilot' and status like 'failed%' and sent_at >= now() - interval '7 days'),
    'bounced', (select count(distinct lower(matched_email)) from inbox_events e where e.kind in ('bounce','left') and e.mailbox in (select email from send_mailboxes where lane='cold')),
    'replies', (select json_build_object('total', count(*) filter (where kind in ('reply','colleague_reply','opt_out')),
                 'positive_neutral', count(*) filter (where sentiment='positive_neutral'),
                 'negative', count(*) filter (where kind in ('reply','colleague_reply') and sentiment='negative'),
                 'opted_out', count(*) filter (where kind='opt_out'),
                 'forwarded', count(*) filter (where sentiment='positive_neutral' and alerted_at is not null))
                from inbox_events where mailbox in (select email from send_mailboxes where lane='cold')),
    'responses', coalesce((select json_agg(x) from (
        select e.id, e.received_at, e.kind, e.mailbox, e.from_email, e.from_name, e.subject, left(e.snippet,300) snippet, e.sentiment, e.alerted_at,
               l.company_name company, l.poc_name, l.job_title
          from inbox_events e left join contact_touches t on t.id = e.matched_touch_id left join cold_leads l on l.id = t.lead_id and t.source='cold_autopilot'
         -- 2026-11-11 Responses parity (Hub 1.35.120, Operations v1.18.2): every response kind, last 30 days
         where e.kind in ('reply','colleague_reply','opt_out','ooo','bounce','left') and e.received_at > now() - interval '30 days'
           and e.mailbox in (select email from send_mailboxes where lane='cold')
         order by e.received_at desc, e.id desc limit 2000) x), '[]'::json),
    'responses_window_days', 30,
    'feed_sent', coalesce((select json_agg(x) from (
        select t.id, t.sent_at, t.mailbox, t.contact_email email, t.subject, t.step, l.company_name company, l.poc_name, l.job_title
          from contact_touches t left join cold_leads l on l.id = t.lead_id
         where t.source='cold_autopilot' and t.status='sent' order by t.sent_at desc limit 100) x), '[]'::json),
    'feed_inbox', coalesce((select json_agg(x) from (
        select e.id, e.received_at, e.kind, e.mailbox, e.from_email, e.from_name, e.subject, left(e.snippet,300) snippet, e.sentiment, e.alerted_at,
               l.company_name company, l.poc_name, l.job_title
          from inbox_events e left join contact_touches t on t.id = e.matched_touch_id left join cold_leads l on l.id = t.lead_id and t.source='cold_autopilot'
         where e.kind <> 'other' and e.mailbox in (select email from send_mailboxes where lane='cold')
         order by e.received_at desc limit 100) x), '[]'::json),
    'leads', coalesce((select json_agg(x) from (
        select l.id, l.created_at, l.company_name company, l.poc_name, l.poc_title, l.email, l.job_title, l.job_url, l.posted_at, l.status, l.skip_reason,
               t.id touch_id, t.sent_at, t.mailbox
          from cold_leads l left join lateral (select y.id, y.sent_at, y.mailbox from contact_touches y where y.lead_id = l.id and y.source='cold_autopilot' and y.step=1 and y.status='sent' order by y.sent_at limit 1) t on true
         order by (l.status='ready') desc, l.created_at desc limit 300) x), '[]'::json),
    'lead_counts', (select json_build_object('ready', count(*) filter (where status='ready'), 'made_today', count(*) filter (where created_at >= v_day),
                      'sent_today', count(*) filter (where status='sent' and decided_at >= v_day), 'skipped_today', count(*) filter (where status='skipped' and decided_at >= v_day)) from cold_leads),
    'skip_reasons', coalesce((select json_agg(x) from (select skip_reason reason, count(*) n from cold_leads where status='skipped' and decided_at >= now() - interval '7 days' group by 1 order by 2 desc limit 12) x), '[]'::json),
    'mailboxes', coalesce((select json_agg(x) from (
        select m.email, m.display_name, m.daily_cap, m.active, m.paused_reason, m.last_error, m.connected_at,
               (select count(*) from contact_touches t where t.mailbox=m.email and t.source='cold_autopilot' and t.status='sent') total,
               (select count(*) from contact_touches t where t.mailbox=m.email and t.source='cold_autopilot' and t.status='sent' and t.sent_at >= v_day) today,
               (select count(*) from contact_touches t where t.mailbox=m.email and t.source='cold_autopilot' and t.status='sent' and t.sent_at >= v_week) week,
               (select count(distinct lower(e.matched_email)) from inbox_events e where e.mailbox=m.email and e.kind in ('bounce','left')) bounced,
               (select min(s.slot_at) from cold_send_slots s where s.mailbox=m.email and s.used_at is null and s.slot_at > now() and s.day = (now() at time zone 'America/Chicago')::date) next_slot
          from send_mailboxes m where m.lane='cold' order by m.created_at, m.email) x), '[]'::json),
    'weekly', coalesce((select json_agg(x) from (
        select to_char(date_trunc('week', sent_at at time zone 'America/Chicago'),'YYYY-MM-DD') week,
               count(*) filter (where step=1 and status='sent') first_touches, count(*) filter (where step>1 and status='sent') follow_ups,
               count(distinct lower(contact_email)) filter (where replied_at is not null) replied_contacts, count(*) filter (where status like 'failed%') failed
          from contact_touches where source='cold_autopilot' group by 1 order by 1 desc limit 8) x), '[]'::json)
  ) into res;
  return res;
end $function$;
