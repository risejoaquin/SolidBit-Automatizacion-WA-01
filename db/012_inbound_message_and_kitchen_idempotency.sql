-- Migration 012: Inbound WhatsApp Event Tracking, Message Idempotency (wamid) & Kitchen Signal Hardening
-- Purely additive, idempotent and backward-compatible migration for Meta WhatsApp -> Kapso -> Supabase -> Kitchen CRM.

begin;

-- 1. Create crm_inbound_events table for tracking all incoming provider messages (wamid)
create table if not exists public.crm_inbound_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.crm_businesses(id) on delete cascade,
  provider text not null default 'whatsapp',
  provider_message_id text not null,
  customer_phone text,
  conversation_id text,
  event_type text not null check (event_type in ('order_prepare', 'order_confirm', 'receipt_received', 'handoff', 'message_received')),
  status text not null default 'processed' check (status in ('received', 'processing', 'processed', 'failed')),
  resource_type text check (resource_type in ('draft', 'order', 'receipt', 'conversation', 'system')),
  resource_id text,
  payload jsonb not null default '{}'::jsonb,
  response_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  processed_at timestamptz not null default now(),
  unique (business_id, provider_message_id)
);

create index if not exists idx_crm_inbound_events_lookup
  on public.crm_inbound_events (business_id, provider_message_id);

create index if not exists idx_crm_inbound_events_resource
  on public.crm_inbound_events (business_id, resource_type, resource_id);

-- 2. Add provider_message_id to public.order_drafts and public.orders
alter table public.order_drafts
  add column if not exists provider_message_id text;

create index if not exists idx_order_drafts_provider_msg
  on public.order_drafts (provider_message_id)
  where provider_message_id is not null;

alter table public.orders
  add column if not exists provider_message_id text;

create unique index if not exists idx_orders_business_provider_msg
  on public.orders (business_id, provider_message_id)
  where provider_message_id is not null;

-- 3. Atomic helper to record inbound events
create or replace function public.crm_record_inbound_event(
  p_business_id uuid,
  p_provider_message_id text,
  p_event_type text,
  p_customer_phone text default null,
  p_conversation_id text default null,
  p_resource_type text default null,
  p_resource_id text default null,
  p_payload jsonb default '{}'::jsonb,
  p_response_data jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing record;
  v_new_id uuid;
begin
  if p_provider_message_id is null or trim(p_provider_message_id) = '' then
    return jsonb_build_object('recorded', false, 'duplicate', false, 'reason', 'no_provider_message_id');
  end if;

  perform pg_advisory_xact_lock(hashtext('inbound_event:' || p_business_id::text || ':' || trim(p_provider_message_id)));

  select * into v_existing
  from public.crm_inbound_events
  where business_id = p_business_id and provider_message_id = trim(p_provider_message_id)
  limit 1;

  if found then
    return jsonb_build_object(
      'recorded', false,
      'duplicate', true,
      'event_id', v_existing.id,
      'resource_type', v_existing.resource_type,
      'resource_id', v_existing.resource_id,
      'response_data', v_existing.response_data
    );
  end if;

  insert into public.crm_inbound_events (
    business_id, provider_message_id, customer_phone, conversation_id,
    event_type, status, resource_type, resource_id, payload, response_data
  ) values (
    p_business_id, trim(p_provider_message_id), p_customer_phone, p_conversation_id,
    p_event_type, 'processed', p_resource_type, p_resource_id, p_payload, p_response_data
  )
  returning id into v_new_id;

  return jsonb_build_object(
    'recorded', true,
    'duplicate', false,
    'event_id', v_new_id,
    'resource_type', p_resource_type,
    'resource_id', p_resource_id
  );
end;
$$;

-- 4. Overload prepare_qa_order with provider_message_id (wamid) tracking
create or replace function public.prepare_qa_order(
  p_payload jsonb,
  p_provider_message_id text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_clean_wamid text;
  v_business_id uuid;
begin
  v_clean_wamid := nullif(trim(coalesce(p_provider_message_id, '')), '');

  -- Serialize concurrent draft creation
  perform pg_advisory_xact_lock(hashtext('prepare_qa_order:' || coalesce(v_clean_wamid, p_payload::text, '')));

  -- Resolve default business ID
  select business_id into v_business_id
  from public.crm_order_sources
  where singleton = true
  limit 1;

  if v_business_id is null then
    select id into v_business_id
    from public.crm_businesses
    order by created_at asc
    limit 1;
  end if;

  -- 4a. If wamid is provided, check if an inbound event already registered this draft
  if v_clean_wamid is not null and v_business_id is not null then
    select resource_id::uuid into v_id
    from public.crm_inbound_events
    where business_id = v_business_id
      and provider_message_id = v_clean_wamid
      and event_type = 'order_prepare'
      and resource_type = 'draft'
    limit 1;

    if v_id is not null then
      return v_id;
    end if;

    -- Also check order_drafts table directly for this wamid
    select d.id into v_id
    from public.order_drafts d
    where d.provider_message_id = v_clean_wamid
    order by d.created_at desc
    limit 1;

    if v_id is not null then
      return v_id;
    end if;
  end if;

  -- 4b. Reuse existing unconfirmed draft with identical payload created within the last 10 minutes
  select d.id into v_id
  from public.order_drafts d
  where d.payload = p_payload
    and d.created_at >= (now() - interval '10 minutes')
    and not exists (
      select 1 from public.orders o where o.confirmation_key = d.id
    )
  order by d.created_at desc
  limit 1;

  if v_id is not null then
    -- Backfill provider_message_id if newly known
    if v_clean_wamid is not null then
      update public.order_drafts
      set provider_message_id = coalesce(provider_message_id, v_clean_wamid)
      where id = v_id;

      if v_business_id is not null then
        insert into public.crm_inbound_events (
          business_id, provider_message_id, event_type, status,
          resource_type, resource_id, payload
        ) values (
          v_business_id, v_clean_wamid, 'order_prepare', 'processed',
          'draft', v_id::text, p_payload
        ) on conflict (business_id, provider_message_id) do nothing;
      end if;
    end if;

    return v_id;
  end if;

  -- 4c. If an identical payload was just confirmed within the last 90 seconds (duplicate message retry burst),
  -- return that draft id so confirm_qa_order hits ON CONFLICT (confirmation_key) DO NOTHING idempotently.
  select d.id into v_id
  from public.order_drafts d
  where d.payload = p_payload
    and d.created_at >= (now() - interval '90 seconds')
    and exists (
      select 1 from public.orders o
      where o.confirmation_key = d.id
        and o.created_at >= (now() - interval '90 seconds')
    )
  order by d.created_at desc
  limit 1;

  if v_id is not null then
    return v_id;
  end if;

  -- 4d. Insert new draft with provider_message_id
  insert into public.order_drafts(payload, provider_message_id)
  values (p_payload, v_clean_wamid)
  returning id into v_id;

  -- Record event in crm_inbound_events
  if v_clean_wamid is not null and v_business_id is not null then
    insert into public.crm_inbound_events (
      business_id, provider_message_id, event_type, status,
      resource_type, resource_id, payload
    ) values (
      v_business_id, v_clean_wamid, 'order_prepare', 'processed',
      'draft', v_id::text, p_payload
    ) on conflict (business_id, provider_message_id) do nothing;
  end if;

  return v_id;
end;
$$;

-- 5. Overload confirm_qa_order_v2 with provider_message_id (wamid) tracking
create or replace function public.confirm_qa_order_v2(
  p_key uuid,
  p_conversation_id text default null,
  p_customer_phone text default null,
  p_provider_message_id text default null
)
returns table(
  order_id uuid,
  folio text,
  total_cents integer,
  order_status text,
  payment_status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_saved record;
  v_order public.orders%rowtype;
  v_clean_folio text;
  v_clean_wamid text;
  v_business_id uuid;
begin
  v_clean_wamid := nullif(trim(coalesce(p_provider_message_id, '')), '');

  -- Serialize concurrent confirmations on draft key and on wamid
  perform pg_advisory_xact_lock(hashtext('confirm_qa_order:' || coalesce(p_key::text, '')));
  if v_clean_wamid is not null then
    perform pg_advisory_xact_lock(hashtext('confirm_qa_wamid:' || v_clean_wamid));
  end if;

  -- 5a. If wamid is provided, check if an order was already created with this provider_message_id
  if v_clean_wamid is not null then
    select * into v_order
    from public.orders o
    where o.provider_message_id = v_clean_wamid
    limit 1;

    if found then
      v_clean_folio := '#' || ltrim(coalesce(v_order.folio, 'MB-' || upper(substr(replace(v_order.id::text, '-', ''), 1, 6))), '#');
      return query select
        v_order.id,
        v_clean_folio,
        v_order.total_cents,
        v_order.order_status,
        v_order.payment_status;
      return;
    end if;

    -- Also check crm_inbound_events for existing order confirmation
    select o.* into v_order
    from public.crm_inbound_events e
    join public.orders o on o.id::text = e.resource_id
    where e.provider_message_id = v_clean_wamid
      and e.event_type = 'order_confirm'
      and e.resource_type = 'order'
    limit 1;

    if found then
      v_clean_folio := '#' || ltrim(coalesce(v_order.folio, 'MB-' || upper(substr(replace(v_order.id::text, '-', ''), 1, 6))), '#');
      return query select
        v_order.id,
        v_clean_folio,
        v_order.total_cents,
        v_order.order_status,
        v_order.payment_status;
      return;
    end if;
  end if;

  -- 5b. Check if order was already confirmed for this draft key (idempotent retry)
  select * into v_order
  from public.orders o
  where o.confirmation_key = p_key
  limit 1;

  if not found then
    select * into strict v_saved
    from public.confirm_qa_order(p_key)
    limit 1;

    select * into strict v_order
    from public.orders o
    where o.id = v_saved.folio;
  end if;

  -- 5c. Link WhatsApp conversation_id, customer_ref, and provider_message_id if provided
  if (p_conversation_id is not null and trim(p_conversation_id) <> '' and v_order.conversation_id is null)
     or (p_customer_phone is not null and trim(p_customer_phone) <> '' and (v_order.customer_ref is null or v_order.customer_ref = 'qa-customer'))
     or (v_clean_wamid is not null and v_order.provider_message_id is null) then
    update public.orders o
    set
      conversation_id = coalesce(o.conversation_id, nullif(trim(p_conversation_id), '')),
      customer_ref = case
        when (o.customer_ref is null or o.customer_ref = 'qa-customer') and nullif(trim(p_customer_phone), '') is not null
        then trim(p_customer_phone)
        else o.customer_ref
      end,
      provider_message_id = coalesce(o.provider_message_id, v_clean_wamid)
    where o.id = v_order.id
    returning * into v_order;

    -- Keep draft payload p_customer synchronized
    update public.order_drafts
    set
      payload = jsonb_set(payload, '{p_customer}', to_jsonb(v_order.customer_ref), true),
      provider_message_id = coalesce(provider_message_id, v_clean_wamid)
    where id = p_key;
  end if;

  -- 5d. Record confirmation event in crm_inbound_events
  v_business_id := coalesce(
    v_order.business_id,
    (select business_id from public.crm_order_sources where singleton = true limit 1),
    (select id from public.crm_businesses order by created_at asc limit 1)
  );

  if v_clean_wamid is not null and v_business_id is not null then
    insert into public.crm_inbound_events (
      business_id, provider_message_id, customer_phone, conversation_id,
      event_type, status, resource_type, resource_id,
      payload, response_data
    ) values (
      v_business_id, v_clean_wamid, v_order.customer_ref, v_order.conversation_id,
      'order_confirm', 'processed', 'order', v_order.id::text,
      jsonb_build_object('draft_key', p_key, 'total_cents', v_order.total_cents),
      jsonb_build_object('order_id', v_order.id, 'folio', v_order.folio)
    )
    on conflict (business_id, provider_message_id) do nothing;
  end if;

  v_clean_folio := '#' || ltrim(coalesce(v_order.folio, 'MB-' || upper(substr(replace(v_order.id::text, '-', ''), 1, 6))), '#');

  return query select
    v_order.id,
    v_clean_folio,
    v_order.total_cents,
    v_order.order_status,
    v_order.payment_status;
end;
$$;

-- 6. Permissions and RLS
alter table public.crm_inbound_events enable row level security;

drop policy if exists crm_inbound_events_service_all on public.crm_inbound_events;
create policy crm_inbound_events_service_all on public.crm_inbound_events
  for all to service_role using (true) with check (true);

revoke all on public.crm_inbound_events from public, anon, authenticated;
grant all on public.crm_inbound_events to service_role;

revoke all on function public.crm_record_inbound_event(uuid, text, text, text, text, text, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.crm_record_inbound_event(uuid, text, text, text, text, text, text, jsonb, jsonb) to service_role;

revoke all on function public.prepare_qa_order(jsonb, text) from public, anon, authenticated;
grant execute on function public.prepare_qa_order(jsonb, text) to service_role;

revoke all on function public.confirm_qa_order_v2(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.confirm_qa_order_v2(uuid, text, text, text) to service_role;

commit;
