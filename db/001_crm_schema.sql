-- CRM Kapso: additive schema on an existing Supabase project.
-- Does NOT alter or grant access to orders, order_drafts, menu_products,
-- menu_modifiers. Run only after backup and local QA review.
begin;

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

commit;
