-- SOLIDBIT CRM KAPSO — STAGING QA SEED DATA
-- Fictitious, isolated dataset for staging environment verification
-- Safe, non-commercial, zero customer data

begin;

do $$
declare
  v_biz_id uuid := 'a0000000-0000-4000-8000-000000000001'::uuid;
  v_order1_id uuid := 'b0000000-0000-4000-8000-000000000001'::uuid;
  v_order2_id uuid := 'b0000000-0000-4000-8000-000000000002'::uuid;
  v_order3_id uuid := 'b0000000-0000-4000-8000-000000000003'::uuid;
  v_order4_id uuid := 'b0000000-0000-4000-8000-000000000004'::uuid;
  v_order5_id uuid := 'b0000000-0000-4000-8000-000000000005'::uuid;
begin

  -- 1. Create Staging Business
  insert into public.crm_businesses (id, name, slug)
  values (v_biz_id, 'Mr. Burger — Staging QA', 'mr-burger-staging-qa')
  on conflict (slug) do nothing;

  -- 2. Seed Staging Inventory
  insert into public.crm_inventory (business_id, sku, name, unit, stock_quantity, minimum_quantity, active)
  values
    (v_biz_id, 'SKU-BURGER-PATTY', 'Carne de Res Especial 150g', 'piece', 50, 15, true),
    (v_biz_id, 'SKU-BURGER-BUN', 'Pan Brioche Artesanal', 'piece', 60, 20, true),
    (v_biz_id, 'SKU-CHEESE-SLICES', 'Queso Americano Fundido', 'piece', 100, 25, true),
    (v_biz_id, 'SKU-BACON-KG', 'Tocino Ahumado Crujiente', 'kg', 12.5, 3.0, true),
    (v_biz_id, 'SKU-FRIES-KG', 'Papas Corte Francés', 'kg', 25.0, 5.0, true)
  on conflict (business_id, sku) do update set
    stock_quantity = excluded.stock_quantity,
    minimum_quantity = excluded.minimum_quantity;

  -- 3. Seed Fictitious QA Orders
  -- Order 1: Received, transfer pending, delivery
  insert into public.orders (
    id, folio, business_id, confirmation_key, customer_ref,
    items, subtotal_cents, shipping_cents, total_cents,
    fulfillment, address, delivery_references,
    payment_method, payment_status, order_status, created_at, updated_at
  ) values (
    v_order1_id, 'MB-STG001', v_biz_id, 'CONF-STG-001', 'Cliente QA 1 (+526220000001)',
    '[{"sku":"SKU-BURGER-CL","name":"Hamburguesa Clásica","quantity":1,"price_cents":14500},{"sku":"SKU-FRIES","name":"Papas Medianas","quantity":1,"price_cents":4000}]'::jsonb,
    18500, 0, 18500,
    'delivery', 'Av. Héroe de Nacozari #101, Col. Bellavista, Empalme', 'Casa blanca portón negro',
    'transfer', 'pending', 'received', now() - interval '45 minutes', now() - interval '45 minutes'
  ) on conflict (id) do nothing;

  -- Order 2: Confirmed, transfer pending, pickup
  insert into public.orders (
    id, folio, business_id, confirmation_key, customer_ref,
    items, subtotal_cents, shipping_cents, total_cents,
    fulfillment, address, delivery_references,
    payment_method, payment_status, order_status, created_at, updated_at
  ) values (
    v_order2_id, 'MB-STG002', v_biz_id, 'CONF-STG-002', 'Cliente QA 2 (+526220000002)',
    '[{"sku":"SKU-BURGER-DBL","name":"Hamburguesa Doble Queso Tocino","quantity":1,"price_cents":19000},{"sku":"SKU-DRINK","name":"Refresco 600ml","quantity":2,"price_cents":5000}]'::jsonb,
    24000, 0, 24000,
    'pickup', null, null,
    'transfer', 'pending', 'confirmed', now() - interval '30 minutes', now() - interval '30 minutes'
  ) on conflict (id) do nothing;

  -- Order 3: Preparing, cash on delivery
  insert into public.orders (
    id, folio, business_id, confirmation_key, customer_ref,
    items, subtotal_cents, shipping_cents, total_cents,
    fulfillment, address, delivery_references,
    payment_method, payment_status, order_status, created_at, updated_at
  ) values (
    v_order3_id, 'MB-STG003', v_biz_id, 'CONF-STG-003', 'Cliente QA 3 (+526220000003)',
    '[{"sku":"SKU-BURGER-BBQ","name":"Hamburguesa Western BBQ","quantity":2,"price_cents":26000},{"sku":"SKU-FRIES","name":"Aros de Cebolla","quantity":1,"price_cents":5000}]'::jsonb,
    31000, 0, 31000,
    'delivery', 'Calle 5ta #220, Col. Moderna, Empalme', 'Frente al parque',
    'cash', 'pending', 'preparing', now() - interval '20 minutes', now() - interval '20 minutes'
  ) on conflict (id) do nothing;

  -- Order 4: Ready, transfer validated, delivery
  insert into public.orders (
    id, folio, business_id, confirmation_key, customer_ref,
    items, subtotal_cents, shipping_cents, total_cents,
    fulfillment, address, delivery_references,
    payment_method, payment_status, order_status, created_at, updated_at
  ) values (
    v_order4_id, 'MB-STG004', v_biz_id, 'CONF-STG-004', 'Cliente QA 4 (+526220000004)',
    '[{"sku":"SKU-BURGER-SNGL","name":"Hamburguesa Sencilla","quantity":1,"price_cents":10500},{"sku":"SKU-DRINK","name":"Agua Fresca","quantity":1,"price_cents":3500}]'::jsonb,
    14000, 0, 14000,
    'delivery', 'Blvd. Las Américas #88, Col. Libertad, Empalme', 'Llamar al llegar',
    'transfer', 'validated', 'ready', now() - interval '10 minutes', now() - interval '10 minutes'
  ) on conflict (id) do nothing;

  -- Order 5: Delivered, cash, pickup (History)
  insert into public.orders (
    id, folio, business_id, confirmation_key, customer_ref,
    items, subtotal_cents, shipping_cents, total_cents,
    fulfillment, address, delivery_references,
    payment_method, payment_status, order_status, created_at, updated_at
  ) values (
    v_order5_id, 'MB-STG005', v_biz_id, 'CONF-STG-005', 'Cliente QA 5 (+526220000005)',
    '[{"sku":"SKU-COMBO-CL","name":"Combo Clásico Completo","quantity":1,"price_cents":19500}]'::jsonb,
    19500, 0, 19500,
    'pickup', null, null,
    'cash', 'validated', 'delivered', now() - interval '3 hours', now() - interval '2 hours'
  ) on conflict (id) do nothing;

  -- 4. Seed Fictitious QA Payment Receipt for Order 1
  insert into public.crm_payment_receipts (
    id, business_id, order_id, file_name, storage_path, mime_type, file_size_bytes,
    declared_amount_cents, bank_reference, validation_status, notes
  ) values (
    'c0000000-0000-4000-8000-000000000001'::uuid,
    v_biz_id, v_order1_id, 'comprobante_qa_stg001.png', 'staging/receipts/comprobante_qa_stg001.png', 'image/png', 245000,
    18500, 'SPEI-BBVA-QA-883921', 'pending', 'Comprobante QA enviado desde chat sandbox'
  ) on conflict (id) do nothing;

  -- 5. Seed Staging Notifications
  insert into public.crm_notifications (
    business_id, event_key, type, priority, title, message, resource_type, resource_id, state
  ) values
    (v_biz_id, 'stg:notif:transfer:order1', 'transfer_validation', 'high', 'Comprobante recibido: #MB-STG001', 'Se recibió comprobante por $185.00 MXN para el pedido #MB-STG001. Requiere validación bancaria.', 'order', v_order1_id::text, 'pending'),
    (v_biz_id, 'stg:notif:order:order2', 'order_confirmed', 'normal', 'Pedido confirmado: #MB-STG002', 'El pedido #MB-STG002 fue confirmado para recoger en sucursal.', 'order', v_order2_id::text, 'pending'),
    (v_biz_id, 'stg:notif:handoff:conv1', 'human_handoff', 'urgent', 'Atención humana: Cliente QA', 'El cliente solicitó comunicarse con un operador humano en el chat.', 'conversation', 'conv-stg-qa-991', 'pending')
  on conflict (business_id, event_key) do nothing;

end $$;

commit;
