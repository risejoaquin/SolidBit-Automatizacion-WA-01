-- Migration 009: Notification Center and Order Management
-- Purely additive schema for notifications, payment receipts, order history, storage and transfer permissions.
-- Safe, idempotent, non-destructive.

begin;

-- 1. Add can_validate_transfers permission to memberships
alter table public.crm_memberships
  add column if not exists can_validate_transfers boolean not null default false;

-- 2. Notification Center tables
create table if not exists public.crm_notifications (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.crm_businesses(id) on delete cascade,
  event_key text not null,
  type text not null check (type in ('human_handoff', 'transfer_validation', 'order_confirmed', 'operational_incident')),
  priority text not null default 'high' check (priority in ('low', 'normal', 'high', 'urgent')),
  title text not null check (length(trim(title)) between 1 and 250),
  message text not null check (length(trim(message)) between 1 and 1000),
  resource_type text not null check (resource_type in ('conversation', 'order', 'payment', 'inventory', 'system')),
  resource_id text,
  recipient_role text not null default 'all' check (recipient_role in ('owner', 'worker', 'all')),
  recipient_user_id uuid references auth.users(id) on delete set null,
  state text not null default 'pending' check (state in ('pending', 'resolved', 'dismissed')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  unique (business_id, event_key)
);

create index if not exists idx_crm_notifications_lookup
  on public.crm_notifications (business_id, state, created_at desc);

create index if not exists idx_crm_notifications_recipient
  on public.crm_notifications (business_id, recipient_role, recipient_user_id);

-- Independent read states per user
create table if not exists public.crm_notification_reads (
  notification_id uuid not null references public.crm_notifications(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (notification_id, user_id)
);

create index if not exists idx_crm_notification_reads_user
  on public.crm_notification_reads (user_id);

-- 3. Payment Receipts (comprobantes de transferencias)
create table if not exists public.crm_payment_receipts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.crm_businesses(id) on delete cascade,
  order_id uuid references public.orders(id) on delete set null,
  storage_path text not null,
  file_name text not null,
  file_size integer not null default 0,
  mime_type text not null default 'image/jpeg',
  declared_amount_cents integer check (declared_amount_cents is null or declared_amount_cents >= 0),
  bank_reference text,
  status text not null default 'pending_validation' check (status in ('pending_association', 'pending_validation', 'validated', 'rejected')),
  validation_notes text,
  rejection_reason text,
  validated_by uuid references auth.users(id) on delete set null,
  validated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists idx_crm_payment_receipts_order
  on public.crm_payment_receipts (business_id, order_id);

create index if not exists idx_crm_payment_receipts_status
  on public.crm_payment_receipts (business_id, status);

-- 4. Order operational history / audit logs
create table if not exists public.crm_order_history (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.crm_businesses(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  actor_role text not null,
  actor_email text,
  action text not null,
  previous_status text,
  new_status text,
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists idx_crm_order_history_order
  on public.crm_order_history (order_id, created_at desc);

-- 5. Update constraints on public.orders to support dispatched and validated statuses seamlessly
alter table public.orders drop constraint if exists orders_order_status_check;
alter table public.orders add constraint orders_order_status_check
  check (order_status = any (array['received'::text, 'confirmed'::text, 'preparing'::text, 'ready'::text, 'assigned'::text, 'dispatched'::text, 'delivered'::text, 'cancelled'::text]));

alter table public.orders drop constraint if exists orders_payment_status_check;
alter table public.orders add constraint orders_payment_status_check
  check (payment_status = any (array['pending'::text, 'verified'::text, 'validated'::text, 'rejected'::text]));

-- 6. Storage bucket for transfer receipts (private)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'payment-receipts',
  'payment-receipts',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
on conflict (id) do nothing;

-- 7. Enable RLS
alter table public.crm_notifications enable row level security;
alter table public.crm_notification_reads enable row level security;
alter table public.crm_payment_receipts enable row level security;
alter table public.crm_order_history enable row level security;

-- Policies for service_role
drop policy if exists crm_notifications_service_all on public.crm_notifications;
create policy crm_notifications_service_all on public.crm_notifications
  for all to service_role using (true) with check (true);

drop policy if exists crm_notification_reads_service_all on public.crm_notification_reads;
create policy crm_notification_reads_service_all on public.crm_notification_reads
  for all to service_role using (true) with check (true);

drop policy if exists crm_payment_receipts_service_all on public.crm_payment_receipts;
create policy crm_payment_receipts_service_all on public.crm_payment_receipts
  for all to service_role using (true) with check (true);

drop policy if exists crm_order_history_service_all on public.crm_order_history;
create policy crm_order_history_service_all on public.crm_order_history
  for all to service_role using (true) with check (true);

-- 8. Helper RPC: Create or Deduplicate Notification
create or replace function public.crm_create_notification(
  p_business_id uuid,
  p_event_key text,
  p_type text,
  p_priority text,
  p_title text,
  p_message text,
  p_resource_type text,
  p_resource_id text default null,
  p_recipient_role text default 'all',
  p_recipient_user_id uuid default null,
  p_metadata jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_inserted boolean := false;
begin
  insert into public.crm_notifications (
    business_id, event_key, type, priority, title, message,
    resource_type, resource_id, recipient_role, recipient_user_id, metadata
  )
  values (
    p_business_id, p_event_key, p_type, p_priority, p_title, p_message,
    p_resource_type, p_resource_id, p_recipient_role, p_recipient_user_id, p_metadata
  )
  on conflict (business_id, event_key) do nothing
  returning id into v_id;

  if v_id is not null then
    v_inserted := true;
  else
    select id into v_id from public.crm_notifications
    where business_id = p_business_id and event_key = p_event_key;
  end if;

  return jsonb_build_object(
    'id', v_id,
    'inserted', v_inserted,
    'event_key', p_event_key
  );
end;
$$;

-- 9. Atomic handoff notification in crm_record_handoff
create or replace function public.crm_record_handoff(
  p_business_id uuid,
  p_event_key text,
  p_conversation_id text,
  p_reason text default ''::text,
  p_assigned_user_id text default null::text
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
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
    null,
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

  -- Insert human_handoff notification atomically in the same transaction
  perform public.crm_create_notification(
    p_business_id,
    'handoff:' || p_event_key,
    'human_handoff',
    'high',
    'Atención humana requerida',
    'Conversación requiere atención (' || coalesce(nullif(trim(p_reason), ''), 'solicitud de cliente') || ')',
    'conversation',
    p_conversation_id,
    'worker',
    null,
    jsonb_build_object(
      'conversation_id', p_conversation_id,
      'reason', coalesce(p_reason, ''),
      'assigned_user_id', p_assigned_user_id
    )
  );

  return jsonb_build_object('recorded', true, 'duplicate', false);
end;
$function$;

commit;
