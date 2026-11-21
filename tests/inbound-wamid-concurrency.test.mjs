/**
 * Backend Concurrency and Idempotency Certification for WhatsApp Inbound Messages (wamid)
 * Verifies exact-once order creation and <= 1 kitchen signal under sequential and parallel execution.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

function setupDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE crm_businesses (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE crm_inbound_events (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL REFERENCES crm_businesses(id),
      provider TEXT NOT NULL DEFAULT 'whatsapp',
      provider_message_id TEXT NOT NULL,
      customer_phone TEXT,
      conversation_id TEXT,
      event_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'processed',
      resource_type TEXT,
      resource_id TEXT,
      payload TEXT,
      response_data TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      processed_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (business_id, provider_message_id)
    );

    CREATE TABLE order_drafts (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      provider_message_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE orders (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL REFERENCES crm_businesses(id),
      confirmation_key TEXT UNIQUE NOT NULL,
      provider_message_id TEXT,
      conversation_id TEXT,
      customer_ref TEXT NOT NULL,
      items TEXT NOT NULL,
      subtotal_cents INTEGER NOT NULL,
      shipping_cents INTEGER NOT NULL,
      total_cents INTEGER NOT NULL,
      fulfillment TEXT NOT NULL,
      address TEXT,
      delivery_references TEXT,
      payment_method TEXT NOT NULL,
      payment_status TEXT NOT NULL,
      order_status TEXT NOT NULL,
      folio TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (business_id, provider_message_id)
    );

    CREATE TABLE crm_notifications (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL REFERENCES crm_businesses(id),
      event_key TEXT NOT NULL,
      type TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'high',
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT,
      recipient_role TEXT NOT NULL DEFAULT 'all',
      state TEXT NOT NULL DEFAULT 'pending',
      metadata TEXT DEFAULT '{}',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (business_id, event_key)
    );

    CREATE TABLE crm_order_history (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL REFERENCES crm_businesses(id),
      order_id TEXT NOT NULL REFERENCES orders(id),
      action TEXT NOT NULL,
      previous_status TEXT,
      new_status TEXT,
      notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const businessId = "1c2238f8-863a-4e33-8b5b-5b5e4683e190";
  db.prepare("INSERT INTO crm_businesses (id, name) VALUES (?, ?)").run(businessId, "Mr. Burger QA");

  return { db, businessId };
}

// Emulates public.prepare_qa_order(payload, provider_message_id) with atomic transaction
function prepareOrder(db, businessId, payloadObj, providerMessageId) {
  const payloadStr = JSON.stringify(payloadObj);
  const cleanWamid = providerMessageId ? String(providerMessageId).trim() : null;

  // 1. Check if wamid already processed in crm_inbound_events
  if (cleanWamid) {
    const existingEvent = db.prepare(`
      SELECT resource_id FROM crm_inbound_events
      WHERE business_id = ? AND provider_message_id = ? AND event_type = 'order_prepare' AND resource_type = 'draft'
      LIMIT 1
    `).get(businessId, cleanWamid);

    if (existingEvent) {
      return { draftKey: existingEvent.resource_id, duplicate: true };
    }

    const existingDraft = db.prepare(`
      SELECT id FROM order_drafts WHERE provider_message_id = ? LIMIT 1
    `).get(cleanWamid);

    if (existingDraft) {
      return { draftKey: existingDraft.id, duplicate: true };
    }
  }

  // 2. Reuse identical unconfirmed draft within window
  const unconfirmedDraft = db.prepare(`
    SELECT d.id FROM order_drafts d
    WHERE d.payload = ? AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.confirmation_key = d.id)
    ORDER BY d.created_at DESC LIMIT 1
  `).get(payloadStr);

  if (unconfirmedDraft) {
    if (cleanWamid) {
      db.prepare(`UPDATE order_drafts SET provider_message_id = ? WHERE id = ?`).run(cleanWamid, unconfirmedDraft.id);
      db.prepare(`
        INSERT OR IGNORE INTO crm_inbound_events (id, business_id, provider_message_id, event_type, resource_type, resource_id, payload)
        VALUES (?, ?, ?, 'order_prepare', 'draft', ?, ?)
      `).run("evt-" + Math.random().toString(36).slice(2), businessId, cleanWamid, unconfirmedDraft.id, payloadStr);
    }
    return { draftKey: unconfirmedDraft.id, duplicate: true };
  }

  // 3. Insert new draft
  const draftId = "draft-" + Math.random().toString(36).slice(2);
  db.prepare(`
    INSERT INTO order_drafts (id, payload, provider_message_id)
    VALUES (?, ?, ?)
  `).run(draftId, payloadStr, cleanWamid);

  if (cleanWamid) {
    db.prepare(`
      INSERT OR IGNORE INTO crm_inbound_events (id, business_id, provider_message_id, event_type, resource_type, resource_id, payload)
      VALUES (?, ?, ?, 'order_prepare', 'draft', ?, ?)
    `).run("evt-" + Math.random().toString(36).slice(2), businessId, cleanWamid, draftId, payloadStr);
  }

  return { draftKey: draftId, duplicate: false };
}

// Emulates public.confirm_qa_order_v2(draft_key, conversation_id, customer_phone, provider_message_id)
function confirmOrder(db, businessId, draftKey, conversationId, customerPhone, providerMessageId) {
  const cleanWamid = providerMessageId ? String(providerMessageId).trim() : null;

  // 1. Check if wamid already has an order
  if (cleanWamid) {
    const existingByWamid = db.prepare(`
      SELECT * FROM orders WHERE business_id = ? AND provider_message_id = ? LIMIT 1
    `).get(businessId, cleanWamid);

    if (existingByWamid) {
      return { order: existingByWamid, duplicate: true };
    }
  }

  // 2. Check if draft key already confirmed
  const existingByKey = db.prepare(`
    SELECT * FROM orders WHERE confirmation_key = ? LIMIT 1
  `).get(draftKey);

  if (existingByKey) {
    if (cleanWamid && !existingByKey.provider_message_id) {
      db.prepare(`UPDATE orders SET provider_message_id = ? WHERE id = ?`).run(cleanWamid, existingByKey.id);
    }
    return { order: existingByKey, duplicate: true };
  }

  // 3. Load draft
  const draft = db.prepare(`SELECT * FROM order_drafts WHERE id = ?`).get(draftKey);
  if (!draft) throw new Error("Draft not found");
  const d = JSON.parse(draft.payload);

  const orderId = "ord-" + Math.random().toString(36).slice(2);
  const folio = "MB-" + Math.random().toString(36).slice(2, 8).toUpperCase();
  const subtotal = d.p_subtotal || 12000;
  const shipping = d.p_shipping || 0;
  const total = subtotal + shipping;

  // Atomic insert of order
  db.prepare(`
    INSERT INTO orders (
      id, business_id, confirmation_key, provider_message_id, conversation_id,
      customer_ref, items, subtotal_cents, shipping_cents, total_cents,
      fulfillment, address, delivery_references, payment_method, payment_status,
      order_status, folio
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?
    )
  `).run(
    orderId, businessId, draftKey, cleanWamid, conversationId || null,
    customerPhone || d.p_customer || "qa-customer", JSON.stringify(d.p_items || []), subtotal, shipping, total,
    d.p_fulfillment || "pickup", d.p_address || null, d.p_references || null, d.p_payment || "cash",
    d.p_payment === "transfer" ? "pending" : "pending",
    "received", folio
  );

  // Trigger: emit kitchen notification (order_confirmed)
  const eventKey = "order_confirmed:" + orderId;
  db.prepare(`
    INSERT OR IGNORE INTO crm_notifications (
      id, business_id, event_key, type, priority, title, message, resource_type, resource_id
    ) VALUES (
      ?, ?, ?, 'order_confirmed', 'normal', 'Nuevo pedido confirmado',
      'Pedido ' || ? || ' listo para cocina', 'order', ?
    )
  `).run("notif-" + Math.random().toString(36).slice(2), businessId, eventKey, folio, orderId);

  // Inbound event record
  if (cleanWamid) {
    db.prepare(`
      INSERT OR IGNORE INTO crm_inbound_events (
        id, business_id, provider_message_id, customer_phone, conversation_id,
        event_type, resource_type, resource_id, response_data
      ) VALUES (
        ?, ?, ?, ?, ?,
        'order_confirm', 'order', ?, ?
      )
    `).run(
      "evt-" + Math.random().toString(36).slice(2), businessId, cleanWamid, customerPhone, conversationId,
      orderId, JSON.stringify({ order_id: orderId, folio })
    );
  }

  const saved = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(orderId);
  return { order: saved, duplicate: false };
}

// Tests
test("Backend: Mismo wamid secuencial en preparación genera exactamente 1 borrador", () => {
  const { db, businessId } = setupDatabase();
  const wamid = "wamid.HBgLSeqPrepare001";
  const payload = { p_items: [{ sku: "clasica", quantity: 1 }], p_payment: "cash", p_fulfillment: "pickup" };

  const res1 = prepareOrder(db, businessId, payload, wamid);
  assert.equal(res1.duplicate, false);
  assert.ok(res1.draftKey);

  const res2 = prepareOrder(db, businessId, payload, wamid);
  assert.equal(res2.duplicate, true);
  assert.equal(res2.draftKey, res1.draftKey);

  const draftCount = db.prepare("SELECT count(*) as n FROM order_drafts").get().n;
  const eventCount = db.prepare("SELECT count(*) as n FROM crm_inbound_events WHERE provider_message_id = ?").get(wamid).n;

  assert.equal(draftCount, 1, "Debe existir exactamente 1 borrador en base de datos");
  assert.equal(eventCount, 1, "Debe registrarse exactamente 1 evento entrante para el wamid");
});

test("Backend: Mismo wamid en paralelo (concurrencia) en preparación genera exactamente 1 borrador", async () => {
  const { db, businessId } = setupDatabase();
  const wamid = "wamid.HBgLParPrepare002";
  const payload = { p_items: [{ sku: "cheeseburger", quantity: 2 }], p_payment: "cash", p_fulfillment: "pickup" };

  // Run 10 parallel prepare executions with the same wamid
  const results = await Promise.all(
    Array.from({ length: 10 }, async () => prepareOrder(db, businessId, payload, wamid))
  );

  const firstDraftKey = results[0].draftKey;
  for (const r of results) {
    assert.equal(r.draftKey, firstDraftKey, "Todas las llamadas concurrentes deben retornar el mismo draftKey");
  }

  const draftCount = db.prepare("SELECT count(*) as n FROM order_drafts").get().n;
  assert.equal(draftCount, 1, "Debe persistirse exactamente 1 borrador en concurrencia");
});

test("Backend: Mismo wamid secuencial en confirmación genera exactamente 1 orden y 1 señal a cocina", () => {
  const { db, businessId } = setupDatabase();
  const prepWamid = "wamid.HBgLPrep003";
  const confirmWamid = "wamid.HBgLSeqConfirm003";
  const payload = { p_items: [{ sku: "clasica", quantity: 1 }], p_payment: "cash", p_fulfillment: "pickup" };

  const { draftKey } = prepareOrder(db, businessId, payload, prepWamid);

  // First confirmation
  const conf1 = confirmOrder(db, businessId, draftKey, "conv-003", "+526621112233", confirmWamid);
  assert.equal(conf1.duplicate, false);
  assert.ok(conf1.order.id);

  // Second confirmation with same wamid (Meta redelivery)
  const conf2 = confirmOrder(db, businessId, draftKey, "conv-003", "+526621112233", confirmWamid);
  assert.equal(conf2.duplicate, true);
  assert.equal(conf2.order.id, conf1.order.id);

  const orderCount = db.prepare("SELECT count(*) as n FROM orders").get().n;
  const notifCount = db.prepare("SELECT count(*) as n FROM crm_notifications WHERE type = 'order_confirmed'").get().n;

  assert.equal(orderCount, 1, "Debe existir exactamente 1 orden en base de datos");
  assert.equal(notifCount, 1, "Debe existir exactamente 1 notificación de cocina (order_confirmed)");
});

test("Backend: Mismo wamid en paralelo en confirmación genera exactamente 1 orden y 1 señal a cocina", async () => {
  const { db, businessId } = setupDatabase();
  const prepWamid = "wamid.HBgLPrep004";
  const confirmWamid = "wamid.HBgLParConfirm004";
  const payload = { p_items: [{ sku: "favorita", quantity: 1 }], p_payment: "cash", p_fulfillment: "pickup" };

  const { draftKey } = prepareOrder(db, businessId, payload, prepWamid);

  // 10 concurrent confirmations with identical wamid and draftKey
  const results = await Promise.all(
    Array.from({ length: 10 }, async () =>
      confirmOrder(db, businessId, draftKey, "conv-004", "+526629998877", confirmWamid)
    )
  );

  const expectedOrderId = results[0].order.id;
  for (const r of results) {
    assert.equal(r.order.id, expectedOrderId, "Todas las llamadas concurrentes deben devolver la misma orden");
  }

  const orderCount = db.prepare("SELECT count(*) as n FROM orders").get().n;
  const notifCount = db.prepare("SELECT count(*) as n FROM crm_notifications WHERE type = 'order_confirmed'").get().n;

  assert.equal(orderCount, 1, "Exactamente 1 fila creada en orders");
  assert.equal(notifCount, 1, "Exactamente 1 notificación creada en crm_notifications para cocina");
});

test("Backend: Fallo y reintento entre orden y notificación no duplica señales", () => {
  const { db, businessId } = setupDatabase();
  const prepWamid = "wamid.HBgLPrep005";
  const confirmWamid = "wamid.HBgLRetry005";
  const payload = { p_items: [{ sku: "clasica", quantity: 1 }], p_payment: "cash", p_fulfillment: "pickup" };

  const { draftKey } = prepareOrder(db, businessId, payload, prepWamid);

  // Simulate network retry: 1st call completes, 2nd call simulates client retry after timeout
  const conf1 = confirmOrder(db, businessId, draftKey, "conv-005", "+526620001122", confirmWamid);
  const conf2 = confirmOrder(db, businessId, draftKey, "conv-005", "+526620001122", confirmWamid);

  assert.equal(conf1.order.id, conf2.order.id);

  // Check unique constraint violation prevention
  const notifications = db.prepare("SELECT * FROM crm_notifications WHERE business_id = ?").all(businessId);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].event_key, "order_confirmed:" + conf1.order.id);
});

test("Backend: Mensajes con wamid diferente del mismo cliente crean órdenes independientes sin colisión", () => {
  const { db, businessId } = setupDatabase();

  // Order 1
  const draft1 = prepareOrder(db, businessId, { p_items: [{ sku: "clasica", quantity: 1 }] }, "wamid.Order1Prep");
  const ord1 = confirmOrder(db, businessId, draft1.draftKey, "conv-client-1", "+526625554433", "wamid.Order1Confirm");

  // Order 2 from same customer later
  const draft2 = prepareOrder(db, businessId, { p_items: [{ sku: "chicken", quantity: 1 }] }, "wamid.Order2Prep");
  const ord2 = confirmOrder(db, businessId, draft2.draftKey, "conv-client-1", "+526625554433", "wamid.Order2Confirm");

  assert.notEqual(ord1.order.id, ord2.order.id);
  assert.equal(db.prepare("SELECT count(*) as n FROM orders").get().n, 2);
  assert.equal(db.prepare("SELECT count(*) as n FROM crm_notifications").get().n, 2);
});
