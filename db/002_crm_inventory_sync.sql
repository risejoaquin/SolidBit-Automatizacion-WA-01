-- CRM Kapso: additive integration with the existing orders table.
-- Keep all existing Kapso tables and columns unchanged.
begin;
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

commit;
