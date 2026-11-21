-- Add a per-worker Kapso assignment reference. Tokens remain in server-side env,
-- never stored in these tables. Worker can only see their own delegated handoffs.
begin;
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
commit;
