import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const e = process.env;
const hasLiveSupabase = Boolean(
  e.SUPABASE_URL &&
  e.SUPABASE_SERVICE_ROLE_KEY &&
  e.CRM_BUSINESS_ID
);

test("Integración Real Supabase QA: Verificación de Contrato de Esquema Vivo", { skip: !hasLiveSupabase }, async () => {
  const base = e.SUPABASE_URL;
  const key = e.SUPABASE_SERVICE_ROLE_KEY;

  const res = await fetch(base + "/rest/v1/", {
    headers: {
      apikey: key,
      Authorization: "Bearer " + key,
      Accept: "application/openapi+json"
    }
  });
  assert.equal(res.status, 200, "Supabase OpenAPI debe responder 200");
  const spec = await res.json();

  // 1. orders
  const ordersDef = spec.definitions?.orders;
  assert.ok(ordersDef, "Tabla public.orders debe existir");
  const ordersProps = ordersDef.properties || {};
  assert.equal(ordersProps.confirmation_key?.type, "string");
  assert.equal(ordersProps.confirmation_key?.format, "uuid");
  assert.equal(
    "provider_message_id" in ordersProps,
    false,
    "provider_message_id NO debe existir en orders (esquema vivo)"
  );
  assert.ok("address" in ordersProps, "address debe existir en orders");
  assert.ok("delivery_references" in ordersProps, "delivery_references debe existir en orders");
  assert.ok("subtotal_cents" in ordersProps, "subtotal_cents debe existir en orders");
  assert.ok("shipping_cents" in ordersProps, "shipping_cents debe existir en orders");
  assert.ok("total_cents" in ordersProps, "total_cents debe existir en orders");

  // 2. crm_payment_receipts
  const receiptsDef = spec.definitions?.crm_payment_receipts;
  assert.ok(receiptsDef, "Tabla public.crm_payment_receipts debe existir");
  const receiptsProps = receiptsDef.properties || {};
  assert.ok("provider_message_id" in receiptsProps, "provider_message_id DEBE existir en crm_payment_receipts");
  assert.ok("conversation_id" in receiptsProps, "conversation_id DEBE existir en crm_payment_receipts");

  // 3. crm_notifications
  const notifsDef = spec.definitions?.crm_notifications;
  assert.ok(notifsDef, "Tabla public.crm_notifications debe existir");
});

test("Integración Real Supabase QA: Flujo completo de pedido a domicilio (Tocino + Dedos de queso), folio, total_cents generado, idempotencia y limpieza", { skip: !hasLiveSupabase }, async () => {
  const base = e.SUPABASE_URL;
  const key = e.SUPABASE_SERVICE_ROLE_KEY;
  const bid = e.CRM_BUSINESS_ID;

  // UUID determinista de prueba para idempotencia
  const testKeyUuid = crypto.randomUUID();
  const phone = "+5216623357058";
  const convId = "conv_qa_live_e2e_" + Date.now();

  let insertedOrderId = null;
  let insertedReceiptId = null;

  try {
    // 1. Inserción de pedido en Supabase
    // Subtotal: Tocino ($135) + Dedos de queso ($95) = $230 (23000 centavos)
    // Envío: $40 (4000 centavos)
    // total_cents es columna GENERADA en Postgres; NO debe enviarse en el payload
    const orderBody = {
      business_id: bid,
      confirmation_key: testKeyUuid,
      customer_ref: phone,
      conversation_id: convId,
      items: [
        { sku: "tocino", name: "Tocino", quantity: 1, unit_price_cents: 13500, total_price_cents: 13500 },
        { sku: "dedos-queso", name: "Dedos de queso", quantity: 1, unit_price_cents: 9500, total_price_cents: 9500 }
      ],
      subtotal_cents: 23000,
      shipping_cents: 4000,
      fulfillment: "delivery",
      address: "GPS: 27.9654, -110.8172 (Col. Moderna, Empalme)",
      delivery_references: "Casa blanca con portón negro",
      payment_method: "transfer",
      payment_status: "pending",
      order_status: "received"
    };

    const resInsert = await fetch(base + "/rest/v1/orders", {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify(orderBody)
    });

    assert.equal(resInsert.status, 201, "El pedido debe insertarse exitosamente con HTTP 201");
    const data = await resInsert.json();
    assert.ok(Array.isArray(data) && data.length > 0, "Debe retornar la fila insertada");
    const order = data[0];
    insertedOrderId = order.id;

    // Verificaciones de valores reales en Postgres
    assert.ok(order.id, "Debe tener un UUID id generado");
    assert.equal(order.business_id, bid);
    assert.equal(order.confirmation_key, testKeyUuid);
    assert.equal(order.customer_ref, phone);
    assert.equal(order.conversation_id, convId);
    assert.equal(order.fulfillment, "delivery");
    assert.equal(order.payment_method, "transfer");
    assert.equal(order.payment_status, "pending");
    assert.equal(order.order_status, "received");
    assert.equal(order.subtotal_cents, 23000);
    assert.equal(order.shipping_cents, 4000);
    // Postgres calculó total_cents = subtotal_cents + shipping_cents
    assert.equal(order.total_cents, 27000);
    // Folio asignado por trigger de base de datos
    assert.ok(order.folio, "Debe tener folio asignado");
    assert.ok(order.folio.includes("MB-"), "Folio debe tener prefijo MB-");

    // 2. Lectura inmediata de la fila por business_id y confirmation_key
    const resRead = await fetch(base + `/rest/v1/orders?business_id=eq.${bid}&confirmation_key=eq.${testKeyUuid}&select=*`, {
      headers: { apikey: key, Authorization: "Bearer " + key }
    });
    assert.equal(resRead.status, 200);
    const readRows = await resRead.json();
    assert.equal(readRows.length, 1);
    assert.equal(readRows[0].id, order.id);

    // 3. Prueba de Idempotencia: reintentar la misma inserción con la misma confirmation_key
    // Postgres debe rechazar con 409 Conflict (violación de clave única)
    const resDup = await fetch(base + "/rest/v1/orders", {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify(orderBody)
    });
    assert.equal(resDup.status, 409, "Reintento de clave única debe retornar 409 en Supabase");
    const dupErr = await resDup.json();
    assert.equal(dupErr.code, "23505", "Código Postgres debe ser 23505 (unique_violation)");

    // 4. Ingesta de comprobante ficticio de transferencia vinculado al pedido
    const receiptBody = {
      business_id: bid,
      order_id: order.id,
      conversation_id: convId,
      provider_message_id: "wamid_live_test_" + Date.now(),
      storage_path: "qa/test_comprobante.jpg",
      file_name: "test_comprobante.jpg",
      file_size: 1024,
      mime_type: "image/jpeg",
      status: "pending_validation",
      metadata: {
        note: "Comprobante ficticio de prueba QA",
        qa: true
      }
    };
    const resReceipt = await fetch(base + "/rest/v1/crm_payment_receipts", {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify(receiptBody)
    });
    assert.equal(resReceipt.status, 201, "Comprobante debe guardarse con 201");
    const receiptData = await resReceipt.json();
    insertedReceiptId = receiptData[0]?.id;
    assert.equal(receiptData[0]?.status, "pending_validation");
    assert.equal(receiptData[0]?.order_id, order.id);

  } finally {
    // 5. Limpieza absoluta en Supabase (dejar la base de datos limpia)
    if (insertedReceiptId) {
      await fetch(base + `/rest/v1/crm_payment_receipts?id=eq.${insertedReceiptId}`, {
        method: "DELETE",
        headers: { apikey: key, Authorization: "Bearer " + key }
      });
    }
    if (insertedOrderId) {
      await fetch(base + `/rest/v1/orders?id=eq.${insertedOrderId}`, {
        method: "DELETE",
        headers: { apikey: key, Authorization: "Bearer " + key }
      });
    }
  }
});
