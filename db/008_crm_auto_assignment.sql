-- Migration 008: Automatic handoff assignment tracking
-- Provides observability, idempotency, and state tracking for automatic
-- conversation assignment to Human Agents following handoff events.

begin;

-- 1. Add observability and tracking columns to crm_handoffs
alter table public.crm_handoffs
  add column if not exists expected_assignee_id text,
  add column if not exists effective_assignee_id text,
  add column if not exists assignment_state text not null default 'pending'
    check(assignment_state in ('pending','assigning','assigned','failed','skipped')),
  add column if not exists assignment_attempts integer not null default 0
    check(assignment_attempts >= 0),
  add column if not exists assignment_last_error text,
  add column if not exists assignment_confirmed_at timestamptz;

create index if not exists crm_handoffs_assignment_state_idx
  on public.crm_handoffs(business_id, assignment_state);

-- 2. Update crm_record_handoff to populate expected_assignee_id
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

  -- Insert handoff with pending assignment tracking
  insert into public.crm_handoffs (
    business_id,
    event_key,
    provider_conversation_id,
    assigned_user_id,
    expected_assignee_id,
    effective_assignee_id,
    reason,
    state,
    assignment_state,
    assignment_attempts
  ) values (
    p_business_id,
    p_event_key,
    p_conversation_id,
    null, -- Assigned only after real confirmation by Kapso
    p_assigned_user_id,
    null,
    coalesce(p_reason, ''),
    'pending',
    'pending',
    0
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

-- 3. Dedicated atomic function to record assignment outcome from Kapso
create or replace function public.crm_update_handoff_assignment(
  p_business_id uuid,
  p_event_key text,
  p_effective_assignee_id text,
  p_assignment_state text,
  p_error text default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_row record;
begin
  select * into v_row from public.crm_handoffs
  where business_id = p_business_id and event_key = p_event_key
  for update;

  if not found then
    raise exception 'Handoff record not found' using errcode = '22023';
  end if;

  update public.crm_handoffs
  set
    effective_assignee_id = coalesce(p_effective_assignee_id, effective_assignee_id),
    assigned_user_id = coalesce(p_effective_assignee_id, assigned_user_id),
    assignment_state = p_assignment_state,
    assignment_attempts = assignment_attempts + 1,
    assignment_last_error = p_error,
    assignment_confirmed_at = case
      when p_assignment_state = 'assigned' then now()
      else assignment_confirmed_at
    end,
    updated_at = now()
  where business_id = p_business_id and event_key = p_event_key;

  return jsonb_build_object(
    'updated', true,
    'assignment_state', p_assignment_state,
    'effective_assignee_id', p_effective_assignee_id
  );
end;
$$;

revoke all on function public.crm_update_handoff_assignment(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.crm_update_handoff_assignment(uuid, text, text, text, text) to service_role;

commit;
