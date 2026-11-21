-- SOLIDBIT CRM KAPSO — UNIFIED STAGING SCHEMA BUNDLE (001 - 010)
-- Generated for independent Staging deployment

-- ==========================================
-- MIGRATION 001: 001_crm_schema.sql
-- ==========================================

-- CRM Kapso: additive schema on an existing Supabase project.
-- Does NOT alter or grant access to orders, order_drafts, menu_products,
-- menu_modifiers. Run only after backup and local QA review.
-- begin;

create table if not exists public.crm_businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 160),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,79}$'),
  created_at timestamptz not null default now()
);

create table if not exists public.crm_memberships (
  business_id uuid not null references public.crm_businesses(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','worker')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (business_id,user_id)
);
create index if not exists crm_memberships_user_idx on public.crm_memberships(user_id);

create table if not exists public.crm_inventory (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.crm_businesses(id) on delete cascade,
  sku text not null check (length(trim(sku)) between 1 and 80),
  name text not null check (length(trim(name)) between 1 and 200),
  unit text not null default 'piece' check (unit in ('piece','kg','g','l','ml')),
  stock_quantity numeric(16,3) not null default 0 check(stock_quantity>=0),
  minimum_quantity numeric(16,3) not null default 0 check(minimum_quantity>=0),
  active boolean not null default true,
  updated_at timestamptz not null default now(),
  unique (business_id,sku),
  unique (business_id,id)
);
create index if not exists crm_inventory_low_idx on public.crm_inventory(business_id,active);

create table if not exists public.crm_stock_movements (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  inventory_id uuid not null,
  delta numeric(16,3) not null check(delta<>0),
  reason text not null check (length(trim(reason)) between 1 and 200),
  event_key text,
  created_at timestamptz not null default now(),
  foreign key (business_id,inventory_id) references public.crm_inventory(business_id,id),
  unique (business_id,event_key)
);
create index if not exists crm_stock_movements_time_idx on public.crm_stock_movements(business_id,created_at desc);

create table if not exists public.crm_order_effects (
  business_id uuid not null references public.crm_businesses(id),
  order_id uuid not null references public.orders(id),
  state text not null check(state in ('applied','reversed')),
  applied_at timestamptz not null default now(),
  reversed_at timestamptz,
  primary key(business_id,order_id)
);

create table if not exists public.crm_alerts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  inventory_id uuid not null,
  kind text not null default 'low_stock' check(kind in ('low_stock','sync_error','handoff')),
  message text not null default '',
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key(business_id,inventory_id) references public.crm_inventory(business_id,id)
);
create unique index if not exists crm_active_low_stock_idx on public.crm_alerts(business_id,inventory_id,kind) where resolved_at is null;

create table if not exists public.crm_handoffs (
  business_id uuid not null references public.crm_businesses(id),
  event_key text not null,
  provider_conversation_id text not null,
  assigned_user_id text,
  state text not null default 'pending' check(state in ('pending','accepted','resolved')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(business_id,event_key)
);
create index if not exists crm_handoffs_state_idx on public.crm_handoffs(business_id,state);

-- One legacy orders table is mapped to ONE CRM business. No mapping is
-- inserted automatically, so existing Kapso orders continue unchanged.
create table if not exists public.crm_order_sources (
  singleton boolean primary key default true check(singleton),
  business_id uuid not null unique references public.crm_businesses(id),
  enabled boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.crm_order_queue (
  order_id uuid primary key references public.orders(id) on delete cascade,
  business_id uuid not null references public.crm_businesses(id),
  requested_at timestamptz not null default now(),
  processed_at timestamptz,
  attempts integer not null default 0 check(attempts>=0),
  last_error text
);

-- RLS is enabled on every newly exposed table; no policies are added
-- that expose unrelated businesses' records.
alter table public.crm_businesses enable row level security;
alter table public.crm_memberships enable row level security;
alter table public.crm_inventory enable row level security;
alter table public.crm_stock_movements enable row level security;
alter table public.crm_order_effects enable row level security;
alter table public.crm_alerts enable row level security;
alter table public.crm_handoffs enable row level security;
alter table public.crm_order_sources enable row level security;
alter table public.crm_order_queue enable row level security;

-- Members can look up only their own memberships; role never comes from user_metadata.
create policy crm_member_self_read on public.crm_memberships for select to authenticated
using (user_id=(select auth.uid()) and active);

create policy crm_business_member_read on public.crm_businesses for select to authenticated
using (exists (select 1 from public.crm_memberships m where m.business_id=id and m.user_id=(select auth.uid()) and m.active));

create policy crm_inventory_owner_read on public.crm_inventory for select to authenticated
using (exists (select 1 from public.crm_memberships m where m.business_id=crm_inventory.business_id and m.user_id=(select auth.uid()) and m.active and m.role='owner'));

create policy crm_inventory_owner_insert on public.crm_inventory for insert to authenticated
with check (exists (select 1 from public.crm_memberships m where m.business_id=crm_inventory.business_id and m.user_id=(select auth.uid()) and m.active and m.role='owner') and stock_quantity=0);

-- Direct UPDATE of quantity is blocked by column-level grants below.
create policy crm_inventory_owner_update on public.crm_inventory for update to authenticated
using (exists (select 1 from public.crm_memberships m where m.business_id=crm_inventory.business_id and m.user_id=(select auth.uid()) and m.active and m.role='owner'))
with check (exists (select 1 from public.crm_memberships m where m.business_id=crm_inventory.business_id and m.user_id=(select auth.uid()) and m.active and m.role='owner'));

create policy crm_stock_movements_owner_read on public.crm_stock_movements for select to authenticated
using (exists (select 1 from public.crm_memberships m where m.business_id=crm_stock_movements.business_id and m.user_id=(select auth.uid()) and m.active and m.role='owner'));
create policy crm_alerts_owner_read on public.crm_alerts for select to authenticated
using (exists (select 1 from public.crm_memberships m where m.business_id=crm_alerts.business_id and m.user_id=(select auth.uid()) and m.active and m.role='owner'));
create policy crm_effects_owner_read on public.crm_order_effects for select to authenticated
using (exists (select 1 from public.crm_memberships m where m.business_id=crm_order_effects.business_id and m.user_id=(select auth.uid()) and m.active and m.role='owner'));
create policy crm_handoffs_read on public.crm_handoffs for select to authenticated
using (exists (select 1 from public.crm_memberships m where m.business_id=crm_handoffs.business_id and m.user_id=(select auth.uid()) and m.active));

-- Explicit API grants; RLS remains a second, independent boundary.
revoke all on public.crm_businesses,public.crm_memberships,public.crm_inventory,
  public.crm_stock_movements,public.crm_order_effects,public.crm_alerts,
  public.crm_handoffs,public.crm_order_sources,public.crm_order_queue from anon,authenticated;
grant select on public.crm_businesses,public.crm_memberships,public.crm_inventory,
  public.crm_stock_movements,public.crm_order_effects,public.crm_alerts,public.crm_handoffs to authenticated;
grant insert on public.crm_inventory to authenticated;
grant update(name,unit,minimum_quantity,active) on public.crm_inventory to authenticated;

-- commit;


-- ==========================================
-- MIGRATION 002: 002_crm_inventory_sync.sql
-- ==========================================

-- CRM Kapso: additive integration with the existing orders table.
-- Keep all existing Kapso tables and columns unchanged.
-- begin;
create schema if not exists crm_private;
revoke all on schema crm_private from public,anon,authenticated;

alter table public.crm_order_effects add column if not exists items_fingerprint text;

-- Keep alert state synchronized with new and manually adjusted stock.
create or replace function crm_private.refresh_stock_alert()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.active and new.stock_quantity <= new.minimum_quantity then
    insert into public.crm_alerts(business_id,inventory_id,kind,message)
    values(new.business_id,new.id,'low_stock','Existencias en mínimo o por debajo')
    on conflict(business_id,inventory_id,kind) where resolved_at is null do nothing;
  else
    update public.crm_alerts set resolved_at=now()
     where business_id=new.business_id and inventory_id=new.id
       and kind='low_stock' and resolved_at is null;
  end if;
  return new;
end $$;
drop trigger if exists crm_stock_alert_refresh on public.crm_inventory;
create trigger crm_stock_alert_refresh after insert or update of stock_quantity,minimum_quantity,active
on public.crm_inventory for each row execute function crm_private.refresh_stock_alert();

-- Explicit owner-only RPC for adjustments, preserving a movement audit.
create or replace function public.crm_adjust_stock(
 p_business_id uuid, p_inventory_id uuid, p_delta numeric, p_reason text
) returns numeric language plpgsql security definer set search_path=''
as $$
declare v_new numeric;
begin
 if (select auth.uid()) is null or not exists (
  select 1 from public.crm_memberships m
  where m.business_id=p_business_id and m.user_id=auth.uid()
    and m.role='owner' and m.active
 ) then raise exception 'Not authorized' using errcode='42501'; end if;
 if p_delta is null or p_delta=0 or abs(p_delta)>1000000
    or length(trim(coalesce(p_reason,''))) not between 1 and 200 then
   raise exception 'Invalid adjustment';
 end if;
 update public.crm_inventory set stock_quantity=stock_quantity+p_delta, updated_at=now()
  where id=p_inventory_id and business_id=p_business_id and stock_quantity+p_delta>=0
  returning stock_quantity into v_new;
 if not found then raise exception 'Insufficient stock or unknown product'; end if;
 insert into public.crm_stock_movements(business_id,inventory_id,delta,reason)
 values(p_business_id,p_inventory_id,p_delta,p_reason);
 return v_new;
end $$;
revoke all on function public.crm_adjust_stock(uuid,uuid,numeric,text) from public,anon;
grant execute on function public.crm_adjust_stock(uuid,uuid,numeric,text) to authenticated;

-- Single-source binding: no existing Kapso order is touched until mapping enabled.
create or replace function crm_private.enqueue_legacy_order()
returns trigger language plpgsql security definer set search_path=''
as $$
declare v_business uuid;
begin
 select business_id into v_business from public.crm_order_sources
 where singleton=true and enabled=true;
 if v_business is not null then
   insert into public.crm_order_queue(order_id,business_id,requested_at,processed_at,last_error)
   values(new.id,v_business,now(),null,null)
   on conflict(order_id) do update set
     requested_at=excluded.requested_at,processed_at=null,last_error=null;
 end if;
 return new;
end $$;
drop trigger if exists crm_queue_on_order_insert on public.orders;
create trigger crm_queue_on_order_insert after insert on public.orders for each row
execute function crm_private.enqueue_legacy_order();
drop trigger if exists crm_queue_on_order_update on public.orders;
create trigger crm_queue_on_order_update after update of order_status,payment_status,items on public.orders
for each row when (
  old.order_status is distinct from new.order_status or
  old.payment_status is distinct from new.payment_status or
  old.items is distinct from new.items
) execute function crm_private.enqueue_legacy_order();

-- Single-order reconciler. Executed ONLY by a trusted backend service_role;
-- not called by browser users. Transactions provide atomicity and row locks.
create or replace function public.crm_reconcile_order(p_order_id uuid)
returns text language plpgsql security definer set search_path=''
as $$
declare
 v_business uuid;
 v_order public.orders%rowtype;
 v_state text;
 v_fingerprint text;
 v_line record;
 v_inventory_id uuid;
 v_qty numeric;
 v_count int:=0;
begin
 select business_id into v_business from public.crm_order_sources where singleton=true and enabled=true;
 if v_business is null then raise exception 'CRM source not enabled'; end if;
 select * into v_order from public.orders where id=p_order_id for update;
 if not found then raise exception 'Unknown order'; end if;
 select state into v_state from public.crm_order_effects
 where business_id=v_business and order_id=p_order_id for update;

 if v_order.order_status='cancelled' then
   if v_state='applied' then
     for v_line in select inventory_id,delta,reason from public.crm_stock_movements
       where business_id=v_business and event_key like ('sale:'||p_order_id::text||':%')
     loop
       update public.crm_inventory set stock_quantity=stock_quantity-v_line.delta,updated_at=now()
       where id=v_line.inventory_id and business_id=v_business;
       insert into public.crm_stock_movements(business_id,inventory_id,delta,reason,event_key)
       values(v_business,v_line.inventory_id,-v_line.delta,'cancelled_order','reversal:'||p_order_id::text||':'||v_line.inventory_id::text)
       on conflict (business_id,event_key) do nothing;
     end loop;
     update public.crm_order_effects set state='reversed',reversed_at=now()
       where business_id=v_business and order_id=p_order_id;
   end if;
   update public.crm_order_queue set processed_at=now(),last_error=null where order_id=p_order_id;
   return 'reversed_or_skipped';
 end if;

 if v_order.order_status not in ('confirmed','preparing','ready','assigned','delivered')
   or (v_order.payment_method='transfer' and v_order.payment_status<>'verified')
   or v_order.payment_method not in ('cash','transfer') then
   update public.crm_order_queue set processed_at=now(),last_error=null where order_id=p_order_id;
   return 'not_confirmed';
 end if;

 v_fingerprint=md5(v_order.items::text);
 if v_state='reversed' then raise exception 'Previously reversed order requires manual review'; end if;
 if v_state='applied' then
   if exists(select 1 from public.crm_order_effects
     where business_id=v_business and order_id=p_order_id and items_fingerprint<>v_fingerprint)
     then raise exception 'Confirmed order contents changed; manual review required'; end if;
   update public.crm_order_queue set processed_at=now(),last_error=null where order_id=p_order_id;
   return 'duplicate';
 end if;

 -- Lock inventory rows and validate every SKU before deducting anything.
 for v_line in
   select sku,sum(quantity) as qty
   from jsonb_to_recordset(v_order.items) as x(sku text,quantity numeric)
   group by sku order by sku
 loop
   if v_line.sku is null or length(trim(v_line.sku))=0 or
      v_line.qty is null or v_line.qty<=0 or v_line.qty>1000000 then
      raise exception 'Invalid confirmed order item';
   end if;
   select id,stock_quantity into v_inventory_id,v_qty
   from public.crm_inventory
   where business_id=v_business and sku=v_line.sku and active=true for update;
   if v_inventory_id is null then raise exception 'SKU not mapped to CRM inventory'; end if;
   if v_qty < v_line.qty then raise exception 'Not enough inventory'; end if;
   v_count=v_count+1;
 end loop;
 if v_count=0 then raise exception 'Confirmed order has no lines'; end if;
 insert into public.crm_order_effects(business_id,order_id,state,items_fingerprint)
 values(v_business,p_order_id,'applied',v_fingerprint);

 for v_line in
   select sku,sum(quantity) as qty
   from jsonb_to_recordset(v_order.items) as x(sku text,quantity numeric)
   group by sku order by sku
 loop
   select id into v_inventory_id from public.crm_inventory
   where business_id=v_business and sku=v_line.sku;
   update public.crm_inventory set stock_quantity=stock_quantity-v_line.qty,updated_at=now()
     where business_id=v_business and id=v_inventory_id and stock_quantity>=v_line.qty;
   if not found then raise exception 'Concurrent stock change'; end if;
   insert into public.crm_stock_movements(business_id,inventory_id,delta,reason,event_key)
   values(v_business,v_inventory_id,-v_line.qty,'confirmed_order','sale:'||p_order_id::text||':'||v_inventory_id::text);
 end loop;
 update public.crm_order_queue set processed_at=now(),last_error=null where order_id=p_order_id;
 return 'applied';
end $$;

-- SECURITY DEFINER exposed RPC: absolutely no access to anon/authenticated.
revoke all on function public.crm_reconcile_order(uuid) from public,anon,authenticated;
grant execute on function public.crm_reconcile_order(uuid) to service_role;

-- commit;


-- ==========================================
-- MIGRATION 003: 003_crm_access_hardening.sql
-- ==========================================

-- Add a per-worker Kapso assignment reference. Tokens remain in server-side env,
-- never stored in these tables. Worker can only see their own delegated handoffs.
-- begin;
alter table public.crm_memberships add column if not exists kapso_assignee_id text;
create unique index if not exists crm_assignee_per_business_idx
on public.crm_memberships (business_id,kapso_assignee_id)
where kapso_assignee_id is not null;

drop policy if exists crm_handoffs_read on public.crm_handoffs;
create policy crm_handoffs_read on public.crm_handoffs
for select to authenticated using (
 exists (
   select 1 from public.crm_memberships m
   where m.business_id=crm_handoffs.business_id
     and m.user_id=(select auth.uid()) and m.active
     and (m.role='owner' or (m.role='worker' and m.kapso_assignee_id=crm_handoffs.assigned_user_id))
 )
);

-- Alert only if a meaningful minimum is configured; suppress empty-item spam.
create or replace function crm_private.refresh_stock_alert()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.active and new.minimum_quantity>0 and new.stock_quantity<=new.minimum_quantity then
    insert into public.crm_alerts(business_id,inventory_id,kind,message)
    values(new.business_id,new.id,'low_stock','Existencias en mínimo o por debajo')
    on conflict(business_id,inventory_id,kind) where resolved_at is null do nothing;
  else
    update public.crm_alerts set resolved_at=now()
      where business_id=new.business_id and inventory_id=new.id
       and kind='low_stock' and resolved_at is null;
  end if;
  return new;
end $$;

-- Only service_role can map the existing single-business legacy order source.
revoke all on public.crm_order_sources,public.crm_order_queue from anon,authenticated;
-- commit;


-- ==========================================
-- MIGRATION 004: 004_crm_handoff_outbox.sql
-- ==========================================

-- Durable outbox for Kapso handoff notifications in the SAME Supabase project.
-- No direct browser access; used by authenticated backend with service_role.
-- begin;
create table if not exists public.crm_handoff_outbox(
  business_id uuid not null,
  event_key text not null,
  state text not null default 'pending' check(state in ('pending','sending','sent','failed')),
  attempts integer not null default 0 check(attempts>=0),
  provider_message_id text,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(business_id,event_key),
  foreign key(business_id,event_key) references public.crm_handoffs(business_id,event_key) on delete cascade
);
create index if not exists crm_handoff_pending_idx on public.crm_handoff_outbox(business_id,state,updated_at);
alter table public.crm_handoff_outbox enable row level security;
revoke all on public.crm_handoff_outbox from public,anon,authenticated;
-- commit;


-- ==========================================
-- MIGRATION 005: 005_handoff_atomic_claim.sql
-- ==========================================

-- Atomic handoff notification claiming prevents two workers sending the
-- same queued item concurrently. A stale 'sending' row retries after 5 minutes.
-- Delivery remains at-least-once after uncertain network outcomes.
-- begin;
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
-- commit;


-- ==========================================
-- MIGRATION 006: 006_crm_record_handoff.sql
-- ==========================================

-- Migration 006: Atomic handoff recording and delegation reason
-- Preserves delegation reason and ensures crm_handoffs and crm_handoff_outbox
-- are recorded within a single atomic PostgreSQL transaction.
-- begin;

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

-- commit;


-- ==========================================
-- MIGRATION 007: 007_crm_sessions_and_rate_limits.sql
-- ==========================================

-- 007_crm_sessions_and_rate_limits.sql
-- Server-side opaque sessions and distributed rate limits for Cloudflare Workers CRM

-- 1. crm_sessions table
CREATE TABLE IF NOT EXISTS public.crm_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES public.crm_businesses(id) ON DELETE CASCADE,
  access_token text NOT NULL,
  refresh_token text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'worker')),
  kapso_assignee_id text,
  email text NOT NULL,
  expires_at timestamptz NOT NULL,
  ttl timestamptz NOT NULL,
  revoked_at timestamptz DEFAULT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- RLS: Only service_role can access crm_sessions
ALTER TABLE public.crm_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS crm_sessions_service_role ON public.crm_sessions;
CREATE POLICY crm_sessions_service_role ON public.crm_sessions
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_crm_sessions_lookup ON public.crm_sessions (id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_sessions_user ON public.crm_sessions (user_id);

-- 2. crm_rate_limits table
CREATE TABLE IF NOT EXISTS public.crm_rate_limits (
  key text PRIMARY KEY,
  attempts integer NOT NULL DEFAULT 1,
  locked_until timestamptz DEFAULT NULL,
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE public.crm_rate_limits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS crm_rate_limits_service_role ON public.crm_rate_limits;
CREATE POLICY crm_rate_limits_service_role ON public.crm_rate_limits
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Atomic function to check and increment rate limit
CREATE OR REPLACE FUNCTION public.crm_check_rate_limit(
  p_key text,
  p_max_attempts integer DEFAULT 5,
  p_window_seconds integer DEFAULT 600,
  p_lockout_seconds integer DEFAULT 600
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_rec record;
  v_now timestamptz := clock_timestamp();
  v_attempts integer := 1;
BEGIN
  SELECT attempts, locked_until, updated_at
    INTO v_rec
    FROM public.crm_rate_limits
   WHERE key = p_key
     FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.crm_rate_limits (key, attempts, locked_until, updated_at)
    VALUES (p_key, 1, NULL, v_now);
    RETURN jsonb_build_object('allowed', true, 'attempts', 1, 'remaining', p_max_attempts - 1);
  END IF;

  -- If currently locked out
  IF v_rec.locked_until IS NOT NULL AND v_rec.locked_until > v_now THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'locked', true,
      'attempts', v_rec.attempts,
      'retry_after', EXTRACT(EPOCH FROM (v_rec.locked_until - v_now))::integer
    );
  END IF;

  -- If window expired, reset attempts
  IF v_rec.updated_at < (v_now - (p_window_seconds || ' seconds')::interval) THEN
    UPDATE public.crm_rate_limits
       SET attempts = 1,
           locked_until = NULL,
           updated_at = v_now
     WHERE key = p_key;
    RETURN jsonb_build_object('allowed', true, 'attempts', 1, 'remaining', p_max_attempts - 1);
  END IF;

  -- Otherwise increment
  v_attempts := v_rec.attempts + 1;
  IF v_attempts >= p_max_attempts THEN
    UPDATE public.crm_rate_limits
       SET attempts = v_attempts,
           locked_until = v_now + (p_lockout_seconds || ' seconds')::interval,
           updated_at = v_now
     WHERE key = p_key;
    RETURN jsonb_build_object(
      'allowed', false,
      'locked', true,
      'attempts', v_attempts,
      'retry_after', p_lockout_seconds
    );
  ELSE
    UPDATE public.crm_rate_limits
       SET attempts = v_attempts,
           updated_at = v_now
     WHERE key = p_key;
    RETURN jsonb_build_object('allowed', true, 'attempts', v_attempts, 'remaining', p_max_attempts - v_attempts);
  END IF;
END;
$$;

-- Reset rate limit on successful login
CREATE OR REPLACE FUNCTION public.crm_reset_rate_limit(p_key text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  DELETE FROM public.crm_rate_limits WHERE key = p_key;
END;
$$;


-- ==========================================
-- MIGRATION 008: 008_crm_auto_assignment.sql
-- ==========================================

-- Migration 008: Automatic handoff assignment tracking
-- Provides observability, idempotency, and state tracking for automatic
-- conversation assignment to Human Agents following handoff events.

-- begin;

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

-- commit;


-- ==========================================
-- MIGRATION 009: 009_notifications_and_order_management.sql
-- ==========================================

-- Migration 009: Notification Center and Order Management
-- Purely additive schema for notifications, payment receipts, order history, storage and transfer permissions.
-- Safe, idempotent, non-destructive.

-- begin;

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

-- commit;


-- ==========================================
-- MIGRATION 010: 010_order_management_enhancements.sql
-- ==========================================

-- Migration 010: Order Management Enhancements (DEV-KAPSO-026)
-- Purely additive and safe schema updates for orders, payment receipts and auditability.

-- begin;

-- 1. Add business_id, conversation_id, folio and updated_at to public.orders
alter table public.orders
  add column if not exists business_id uuid references public.crm_businesses(id) on delete set null,
  add column if not exists conversation_id text,
  add column if not exists folio text,
  add column if not exists updated_at timestamptz not null default now();

create index if not exists idx_orders_business_lookup
  on public.orders (business_id, order_status, created_at desc);

create index if not exists idx_orders_conversation
  on public.orders (conversation_id);

create index if not exists idx_orders_customer_ref
  on public.orders (customer_ref, created_at desc);

create index if not exists idx_orders_folio
  on public.orders (folio);

-- 2. Add provider_message_id and conversation_id to crm_payment_receipts
alter table public.crm_payment_receipts
  add column if not exists provider_message_id text,
  add column if not exists conversation_id text;

create unique index if not exists idx_payment_receipts_provider_msg
  on public.crm_payment_receipts (business_id, provider_message_id)
  where provider_message_id is not null;

create index if not exists idx_payment_receipts_conversation
  on public.crm_payment_receipts (business_id, conversation_id);

-- 3. Function to generate or backfill human-friendly folio
create or replace function public.crm_generate_order_folio()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.folio is null or trim(new.folio) = '' then
    new.folio := 'MB-' || upper(substr(replace(new.id::text, '-', ''), 1, 6));
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_orders_folio_updated_at on public.orders;
create trigger trg_orders_folio_updated_at
  before insert or update on public.orders
  for each row
  execute function public.crm_generate_order_folio();

-- Backfill folio for any existing orders without a folio
update public.orders
set folio = 'MB-' || upper(substr(replace(id::text, '-', ''), 1, 6))
where folio is null;

-- Backfill business_id for any existing orders using the primary business
update public.orders
set business_id = (select id from public.crm_businesses limit 1)
where business_id is null;

-- commit;


