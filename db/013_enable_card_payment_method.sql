-- Migration 013: Enable 'card' payment method on public.orders
-- Forward-only, safe, idempotent migration.
-- Updates CHECK constraints on orders.payment_method to allow ('cash', 'transfer', 'card').
-- Does NOT modify existing data, preserves all existing constraints and indexes.

do $$
declare
  r record;
begin
  -- 1. Drop existing CHECK constraint on payment_method if exists
  for r in (
    select conname
    from pg_constraint c
    join pg_class t on c.conrelid = t.oid
    join pg_namespace n on t.relnamespace = n.oid
    where n.nspname = 'public'
      and t.relname = 'orders'
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%payment_method%'
  ) loop
    execute format('alter table public.orders drop constraint if exists %I', r.conname);
  end loop;

  -- 2. Add updated CHECK constraint including 'card'
  alter table public.orders
    add constraint orders_payment_method_check
    check (payment_method in ('cash', 'transfer', 'card'));
end $$;
