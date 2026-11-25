-- Migration 013: Align public.orders.confirmation_key and provider_message_id
-- Safe, idempotent forward migration.
-- Does NOT drop data: converts existing UUIDs to TEXT safely if confirmation_key is still UUID.

-- 1. Convert confirmation_key from UUID to TEXT if currently UUID
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'orders'
      and column_name = 'confirmation_key'
      and data_type = 'uuid'
  ) then
    alter table public.orders
      alter column confirmation_key type text using confirmation_key::text;
  end if;
end $$;

-- 2. Add provider_message_id to public.orders if not exists
alter table public.orders
  add column if not exists provider_message_id text;

-- 3. Ensure index on (business_id, confirmation_key)
create index if not exists idx_orders_business_confirmation_key
  on public.orders (business_id, confirmation_key);

-- 4. Ensure index on (business_id, provider_message_id)
create index if not exists idx_orders_business_provider_message_id
  on public.orders (business_id, provider_message_id)
  where provider_message_id is not null;
