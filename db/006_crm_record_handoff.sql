-- Migration 006: Atomic handoff recording and delegation reason
-- Preserves delegation reason and ensures crm_handoffs and crm_handoff_outbox
-- are recorded within a single atomic PostgreSQL transaction.
begin;

alter table public.crm_handoffs
  add column if not exists reason text not null default '';

create or replace function public.crm_record_handoff(
  p_business_id uuid,
  p_event_key text,
  p_conversation_id text,
  p_reason text default '',
  p_assigned_user_id text default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_existing record;
begin
  -- Validate business exists
  if not exists (select 1 from public.crm_businesses where id = p_business_id) then
    raise exception 'Business not found' using errcode = '22023';
  end if;

  -- Check existing handoff
  select provider_conversation_id into v_existing
  from public.crm_handoffs
  where business_id = p_business_id and event_key = p_event_key;

  if found then
    if v_existing.provider_conversation_id <> p_conversation_id then
      raise exception 'Idempotency key reused with different conversation' using errcode = '23505';
    end if;

    -- Ensure outbox row exists even if previously failed or duplicate retry
    insert into public.crm_handoff_outbox (business_id, event_key, state)
    values (p_business_id, p_event_key, 'pending')
    on conflict (business_id, event_key) do nothing;

    return jsonb_build_object('recorded', false, 'duplicate', true);
  end if;

  -- Insert handoff
  insert into public.crm_handoffs (
    business_id, event_key, provider_conversation_id, assigned_user_id, reason, state
  ) values (
    p_business_id, p_event_key, p_conversation_id, p_assigned_user_id, coalesce(p_reason, ''), 'pending'
  );

  -- Insert outbox atomically in the same transaction
  insert into public.crm_handoff_outbox (business_id, event_key, state)
  values (p_business_id, p_event_key, 'pending')
  on conflict (business_id, event_key) do nothing;

  return jsonb_build_object('recorded', true, 'duplicate', false);
end;
$$;

revoke all on function public.crm_record_handoff(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.crm_record_handoff(uuid, text, text, text, text) to service_role;

commit;
