-- Atomic handoff notification claiming prevents two workers sending the
-- same queued item concurrently. A stale 'sending' row retries after 5 minutes.
-- Delivery remains at-least-once after uncertain network outcomes.
begin;
create or replace function public.crm_claim_handoff_notifications(
  p_business_id uuid,p_limit integer default 10
) returns table(event_key text,attempts integer)
language sql security definer set search_path=''
as $$
 with candidates as (
   select h.business_id,h.event_key
   from public.crm_handoff_outbox h
   where h.business_id=p_business_id and h.attempts<5 and
     (h.state='pending' or (h.state='sending' and h.updated_at<now()-interval '5 minutes'))
   order by h.created_at,h.event_key
   for update skip locked
   limit least(greatest(coalesce(p_limit,10),1),50)
 ), claimed as (
   update public.crm_handoff_outbox q
   set state='sending',attempts=q.attempts+1,updated_at=now(),last_error_code=null
   from candidates c
   where q.business_id=c.business_id and q.event_key=c.event_key
   returning q.event_key,q.attempts
 )
 select claimed.event_key,claimed.attempts from claimed;
$$;
revoke all on function public.crm_claim_handoff_notifications(uuid,integer)
 from public,anon,authenticated;
grant execute on function public.crm_claim_handoff_notifications(uuid,integer) to service_role;
commit;
