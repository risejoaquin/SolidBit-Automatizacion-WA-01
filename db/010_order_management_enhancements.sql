-- Migration 010: Order Management Enhancements (DEV-KAPSO-026)
-- Purely additive and safe schema updates for orders, payment receipts and auditability.

begin;

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

commit;
