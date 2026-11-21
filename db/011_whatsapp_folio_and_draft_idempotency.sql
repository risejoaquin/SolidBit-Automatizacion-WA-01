-- Migration 011: WhatsApp Readable Folios (#MB-XXXXXX), Auto Business Scope, Draft/Confirm Idempotency & Order Notifications
-- Purely additive and idempotent migration for WhatsApp Sandbox -> Supabase -> CRM integration.

begin;

-- 1. Enhance crm_generate_order_folio trigger function to auto-assign folio AND business_id
create or replace function public.crm_generate_order_folio()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_business_id uuid;
begin
  if new.folio is null or trim(new.folio) = '' then
    new.folio := 'MB-' || upper(substr(replace(new.id::text, '-', ''), 1, 6));
  end if;

  if new.business_id is null then
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

    new.business_id := v_business_id;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

-- 2. Trigger to automatically emit CRM Notification Center alerts on newly inserted orders
create or replace function public.crm_notify_new_order()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_clean_folio text;
begin
  if new.business_id is null then
    return new;
  end if;

  v_clean_folio := ltrim(coalesce(new.folio, 'MB-' || upper(substr(replace(new.id::text, '-', ''), 1, 6))), '#');

  if new.payment_method = 'transfer' and new.payment_status = 'pending' then
    perform public.crm_create_notification(
      new.business_id,
      'order_transfer_pending:' || new.id::text,
      'transfer_validation',
      'high',
      'Pedido por transferencia pendiente (#' || v_clean_folio || ')',
      'Pedido #' || v_clean_folio || ' ($' || trim(to_char(new.total_cents / 100.0, '999990.00')) || ') pendiente de comprobante y validación bancaria manual.',
      'order',
      new.id::text,
      'all',
      null,
      jsonb_build_object(
        'order_id', new.id,
        'folio', '#' || v_clean_folio,
        'total_cents', new.total_cents,
        'payment_method', new.payment_method,
        'payment_status', new.payment_status
      )
    );
  elsif new.order_status in ('received', 'confirmed') then
    perform public.crm_create_notification(
      new.business_id,
      'order_confirmed:' || new.id::text,
      'order_confirmed',
      'normal',
      'Nuevo pedido confirmado (#' || v_clean_folio || ')',
      'Pedido #' || v_clean_folio || ' (' || case when new.fulfillment = 'delivery' then 'Domicilio' else 'Recoger en sucursal' end || ') confirmado por $' || trim(to_char(new.total_cents / 100.0, '999990.00')) || '.',
      'order',
      new.id::text,
      'all',
      null,
      jsonb_build_object(
        'order_id', new.id,
        'folio', '#' || v_clean_folio,
        'total_cents', new.total_cents,
        'fulfillment', new.fulfillment
      )
    );
  end if;

  return new;
end;
$$;

drop trigger if exists trg_orders_notify_crm on public.orders;
create trigger trg_orders_notify_crm
  after insert on public.orders
  for each row
  execute function public.crm_notify_new_order();

-- 3. Make prepare_qa_order idempotent and concurrency-safe against duplicate inbound messages
create or replace function public.prepare_qa_order(p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  -- Serialize concurrent draft creation for identical payload within the transaction
  perform pg_advisory_xact_lock(hashtext('prepare_qa_order:' || coalesce(p_payload::text, '')));

  -- 3a. Reuse existing unconfirmed draft with identical payload created within the last 10 minutes
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
    return v_id;
  end if;

  -- 3b. If an identical payload was just confirmed within the last 90 seconds (duplicate message retry burst),
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

  insert into public.order_drafts(payload)
  values (p_payload)
  returning id into v_id;

  return v_id;
end;
$$;

-- 4. Harden confirm_qa_order with transaction advisory lock for concurrent confirm retries
create or replace function public.confirm_qa_order(p_key uuid)
returns table(folio uuid, total_cents integer, order_status text, payment_status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  d jsonb;
begin
  perform pg_advisory_xact_lock(hashtext('confirm_qa_order:' || coalesce(p_key::text, '')));
  select payload into strict d from public.order_drafts where id = p_key;
  return query select * from public.save_order(
    p_key,
    d->>'p_customer',
    d->'p_items',
    (d->>'p_subtotal')::integer,
    (d->>'p_shipping')::integer,
    d->>'p_fulfillment',
    d->>'p_payment',
    d->>'p_address',
    d->>'p_references'
  );
end;
$$;

-- 5. Add confirm_qa_order_v2 returning human-readable #MB-XXXXXX folio and linking WhatsApp conversation/phone
create or replace function public.confirm_qa_order_v2(
  p_key uuid,
  p_conversation_id text default null,
  p_customer_phone text default null
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
begin
  perform pg_advisory_xact_lock(hashtext('confirm_qa_order:' || coalesce(p_key::text, '')));

  -- Check if order was already confirmed for this draft key (idempotent retry)
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

  -- Link WhatsApp conversation_id and customer_ref phone if provided
  if (p_conversation_id is not null and trim(p_conversation_id) <> '' and v_order.conversation_id is null)
     or (p_customer_phone is not null and trim(p_customer_phone) <> '' and (v_order.customer_ref is null or v_order.customer_ref = 'qa-customer')) then
    update public.orders o
    set
      conversation_id = coalesce(o.conversation_id, nullif(trim(p_conversation_id), '')),
      customer_ref = case
        when (o.customer_ref is null or o.customer_ref = 'qa-customer') and nullif(trim(p_customer_phone), '') is not null
        then trim(p_customer_phone)
        else o.customer_ref
      end
    where o.id = v_order.id
    returning * into v_order;

    -- Keep draft payload p_customer synchronized so legacy confirm_qa_order never sees a customer_ref mismatch
    update public.order_drafts
    set payload = jsonb_set(payload, '{p_customer}', to_jsonb(v_order.customer_ref), true)
    where id = p_key;
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

revoke all on function public.confirm_qa_order_v2(uuid, text, text) from public, anon, authenticated;
grant execute on function public.confirm_qa_order_v2(uuid, text, text) to service_role;

revoke all on function public.prepare_qa_order(jsonb) from public, anon, authenticated;
grant execute on function public.prepare_qa_order(jsonb) to service_role;

revoke all on function public.confirm_qa_order(uuid) from public, anon, authenticated;
grant execute on function public.confirm_qa_order(uuid) to service_role;

-- 6. Backfill any existing orders missing business_id or folio
update public.orders
set
  business_id = coalesce(
    business_id,
    (select business_id from public.crm_order_sources where singleton = true limit 1),
    (select id from public.crm_businesses order by created_at asc limit 1)
  ),
  folio = coalesce(nullif(trim(folio), ''), 'MB-' || upper(substr(replace(id::text, '-', ''), 1, 6)))
where business_id is null or folio is null or trim(folio) = '';

-- 7. Backfill notifications for any confirmed or pending-transfer orders that did not have a notification yet
do $$
declare
  r record;
  v_clean_folio text;
begin
  for r in
    select * from public.orders
    where business_id is not null
      and created_at >= now() - interval '24 hours'
  loop
    v_clean_folio := ltrim(coalesce(r.folio, 'MB-' || upper(substr(replace(r.id::text, '-', ''), 1, 6))), '#');
    if r.payment_method = 'transfer' and r.payment_status = 'pending' then
      perform public.crm_create_notification(
        r.business_id,
        'order_transfer_pending:' || r.id::text,
        'transfer_validation',
        'high',
        'Pedido por transferencia pendiente (#' || v_clean_folio || ')',
        'Pedido #' || v_clean_folio || ' ($' || trim(to_char(r.total_cents / 100.0, '999990.00')) || ') pendiente de comprobante y validación bancaria manual.',
        'order',
        r.id::text,
        'all',
        null,
        jsonb_build_object(
          'order_id', r.id,
          'folio', '#' || v_clean_folio,
          'total_cents', r.total_cents,
          'payment_method', r.payment_method,
          'payment_status', r.payment_status
        )
      );
    elsif r.order_status in ('received', 'confirmed') then
      perform public.crm_create_notification(
        r.business_id,
        'order_confirmed:' || r.id::text,
        'order_confirmed',
        'normal',
        'Nuevo pedido confirmado (#' || v_clean_folio || ')',
        'Pedido #' || v_clean_folio || ' (' || case when r.fulfillment = 'delivery' then 'Domicilio' else 'Recoger en sucursal' end || ') confirmado por $' || trim(to_char(r.total_cents / 100.0, '999990.00')) || '.',
        'order',
        r.id::text,
        'all',
        null,
        jsonb_build_object(
          'order_id', r.id,
          'folio', '#' || v_clean_folio,
          'total_cents', r.total_cents,
          'fulfillment', r.fulfillment
        )
      );
    end if;
  end loop;
end;
$$;

commit;
