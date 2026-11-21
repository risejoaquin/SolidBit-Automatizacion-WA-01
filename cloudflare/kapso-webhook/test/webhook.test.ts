import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { handleRequest } from "../src/handler.ts";
import { verifyKapsoSignature } from "../src/crypto.ts";
import { parseKapsoHandoff } from "../src/parse.ts";
import type { Env } from "../src/types.ts";

const TEST_SECRET = "test-webhook-secret-with-minimum-length-32";
const TEST_PROJECT_ID = "test-project-123";
const TEST_BUSINESS_ID = "1c2238f8-863a-4e33-8b5b-5b5e4683e190";
const TEST_SUPABASE_URL = "https://gplewdvxxldfvmeintvu.supabase.co";
const TEST_SERVICE_KEY = "test-service-role-key-length-greater-than-twenty";

const validEnv: Env = {
  KAPSO_WEBHOOK_SECRET: TEST_SECRET,
  KAPSO_PROJECT_ID: TEST_PROJECT_ID,
  SUPABASE_URL: TEST_SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: TEST_SERVICE_KEY,
  CRM_BUSINESS_ID: TEST_BUSINESS_ID,
  WORKER_VERSION: "1.0.0",
  ENVIRONMENT: "test"
};

function signPayload(body: string | Uint8Array, secret: string = TEST_SECRET): string {
  const buf = typeof body === "string" ? Buffer.from(body, "utf-8") : Buffer.from(body);
  return createHmac("sha256", secret).update(buf).digest("hex");
}

function makeValidPayload(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    event: "workflow.execution.handoff",
    occurred_at: "2026-11-18T22:00:00Z",
    project_id: TEST_PROJECT_ID,
    workflow_execution_id: "exec-101",
    channel: "whatsapp",
    whatsapp_conversation_id: "conv-202",
    handoff: {
      reason: "Customer wants human support",
      source: "agent_tool"
    },
    ...overrides
  });
}

test("1. Endpoint de salud (GET /health) responde correctamente sin secretos", async () => {
  const req = new Request("https://worker.local/health", { method: "GET" });
  const res = await handleRequest(req, validEnv);
  assert.equal(res.status, 200);
  const data = (await res.json()) as Record<string, unknown>;
  assert.equal(data.status, "healthy");
  assert.equal(data.service, "crm-kapso-webhook");
  assert.equal(data.version, "1.0.0");
  assert.equal(data.environment, "test");
  assert.ok(data.deployed_at);
  // Verify no secrets leaked
  const text = JSON.stringify(data);
  assert.ok(!text.includes(TEST_SECRET));
  assert.ok(!text.includes(TEST_SERVICE_KEY));
});

test("2. Endpoint de salud rechaza métodos distintos a GET", async () => {
  const req = new Request("https://worker.local/health", { method: "POST" });
  const res = await handleRequest(req, validEnv);
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("Allow"), "GET");
});

test("3. Webhook rechaza métodos distintos a POST", async () => {
  const req = new Request("https://worker.local/webhooks/kapso/handoff", { method: "GET" });
  const res = await handleRequest(req, validEnv);
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("Allow"), "POST");
});

test("4. Webhook rechaza Content-Type no JSON", async () => {
  const req = new Request("https://worker.local/webhooks/kapso/handoff", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "hello"
  });
  const res = await handleRequest(req, validEnv);
  assert.equal(res.status, 415);
});

test("5. Webhook rechaza solicitudes mayores a 100KB", async () => {
  const hugeBody = "x".repeat(100_001);
  const req = new Request("https://worker.local/webhooks/kapso/handoff", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": "100001",
      "X-Webhook-Signature": "0".repeat(64),
      "X-Idempotency-Key": "idemp-huge"
    },
    body: hugeBody
  });
  const res = await handleRequest(req, validEnv);
  assert.equal(res.status, 413);
});

test("6. Firma HMAC ausente o malformada es rechazada (401)", async () => {
  const body = makeValidPayload();
  // Missing signature
  const reqMissing = new Request("https://worker.local/webhooks/kapso/handoff", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Idempotency-Key": "idemp-1" },
    body
  });
  const resMissing = await handleRequest(reqMissing, validEnv);
  assert.equal(resMissing.status, 401);

  // Malformed signature (not 64 hex chars)
  const reqMalformed = new Request("https://worker.local/webhooks/kapso/handoff", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Idempotency-Key": "idemp-1",
      "X-Webhook-Signature": "invalid-hex-short"
    },
    body
  });
  const resMalformed = await handleRequest(reqMalformed, validEnv);
  assert.equal(resMalformed.status, 401);
});

test("7. Firma HMAC inválida (adulteración de cuerpo) es rechazada (401)", async () => {
  const body = makeValidPayload();
  const signature = signPayload(body);
  const tamperedBody = body + " "; // Alter 1 byte

  const req = new Request("https://worker.local/webhooks/kapso/handoff", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Idempotency-Key": "idemp-1",
      "X-Webhook-Signature": signature
    },
    body: tamperedBody
  });
  const res = await handleRequest(req, validEnv);
  assert.equal(res.status, 401);
});

test("8. Idempotency Key ausente o inválida es rechazada (400)", async () => {
  const body = makeValidPayload();
  const signature = signPayload(body);

  const req = new Request("https://worker.local/webhooks/kapso/handoff", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Webhook-Signature": signature
    },
    body
  });
  const res = await handleRequest(req, validEnv);
  assert.equal(res.status, 400);
  const data = (await res.json()) as any;
  assert.equal(data.error.code, "INVALID_IDEMPOTENCY_KEY");
});

test("9. JSON inválido es rechazado (400)", async () => {
  const invalidJson = "{ invalid json payload";
  const signature = signPayload(invalidJson);

  const req = new Request("https://worker.local/webhooks/kapso/handoff", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Idempotency-Key": "idemp-1",
      "X-Webhook-Signature": signature
    },
    body: invalidJson
  });
  const res = await handleRequest(req, validEnv);
  assert.equal(res.status, 400);
  const data = (await res.json()) as any;
  assert.equal(data.error.code, "INVALID_JSON");
});

test("10. Evento no autorizado es rechazado (422)", async () => {
  const body = makeValidPayload({ event: "whatsapp.message.received" });
  const signature = signPayload(body);

  const req = new Request("https://worker.local/webhooks/kapso/handoff", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Idempotency-Key": "idemp-1",
      "X-Webhook-Signature": signature
    },
    body
  });
  const res = await handleRequest(req, validEnv);
  assert.equal(res.status, 422);
  const data = (await res.json()) as any;
  assert.equal(data.error.code, "UNSUPPORTED_EVENT");
});

test("11. Canal no autorizado es rechazado (422)", async () => {
  const body = makeValidPayload({ channel: "telegram" });
  const signature = signPayload(body);

  const req = new Request("https://worker.local/webhooks/kapso/handoff", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Idempotency-Key": "idemp-1",
      "X-Webhook-Signature": signature
    },
    body
  });
  const res = await handleRequest(req, validEnv);
  assert.equal(res.status, 422);
  const data = (await res.json()) as any;
  assert.equal(data.error.code, "UNSUPPORTED_CHANNEL");
});

test("12. Proyecto incorrecto es rechazado (403)", async () => {
  const body = makeValidPayload({ project_id: "unauthorized-project-id" });
  const signature = signPayload(body);

  const req = new Request("https://worker.local/webhooks/kapso/handoff", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Idempotency-Key": "idemp-1",
      "X-Webhook-Signature": signature
    },
    body
  });
  const res = await handleRequest(req, validEnv);
  assert.equal(res.status, 403);
  const data = (await res.json()) as any;
  assert.equal(data.error.code, "FORBIDDEN_PROJECT");
});

test("13. Identificadores faltantes en payload son rechazados (400)", async () => {
  const body = makeValidPayload({ whatsapp_conversation_id: "" });
  const signature = signPayload(body);

  const req = new Request("https://worker.local/webhooks/kapso/handoff", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Idempotency-Key": "idemp-1",
      "X-Webhook-Signature": signature
    },
    body
  });
  const res = await handleRequest(req, validEnv);
  assert.equal(res.status, 400);
  const data = (await res.json()) as any;
  assert.equal(data.error.code, "INVALID_PAYLOAD_IDS");
});

test("14. Handoff válido se registra correctamente en Supabase (200, recorded: true)", async () => {
  const body = makeValidPayload();
  const signature = signPayload(body);

  let capturedUrl = "";
  let capturedBody: any = null;
  const mockFetch: typeof fetch = async (url, opts) => {
    capturedUrl = String(url);
    capturedBody = JSON.parse(String(opts?.body));
    return new Response(JSON.stringify({ recorded: true, duplicate: false }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  const req = new Request("https://worker.local/webhooks/kapso/handoff", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Idempotency-Key": "idemp-success-1",
      "X-Webhook-Signature": signature
    },
    body
  });

  const res = await handleRequest(req, validEnv, mockFetch);
  assert.equal(res.status, 200);
  const data = (await res.json()) as any;
  assert.equal(data.recorded, true);
  assert.equal(data.duplicate, false);

  assert.ok(capturedUrl.includes("/rpc/crm_record_handoff"));
  assert.equal(capturedBody.p_business_id, TEST_BUSINESS_ID);
  assert.equal(capturedBody.p_event_key, "idemp-success-1");
  assert.equal(capturedBody.p_conversation_id, "conv-202");
  assert.equal(capturedBody.p_reason, "Customer wants human support");
});

test("15. Evento repetido con misma idempotency key devuelve duplicate: true", async () => {
  const body = makeValidPayload();
  const signature = signPayload(body);

  const mockFetch: typeof fetch = async () => {
    return new Response(JSON.stringify({ recorded: false, duplicate: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  const req = new Request("https://worker.local/webhooks/kapso/handoff", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Idempotency-Key": "idemp-success-1",
      "X-Webhook-Signature": signature
    },
    body
  });

  const res = await handleRequest(req, validEnv, mockFetch);
  assert.equal(res.status, 200);
  const data = (await res.json()) as any;
  assert.equal(data.recorded, false);
  assert.equal(data.duplicate, true);
});

test("16. Reutilización conflictiva de idempotency key genera 409 Conflict", async () => {
  const body = makeValidPayload();
  const signature = signPayload(body);

  const mockFetch: typeof fetch = async () => {
    return new Response(JSON.stringify({ message: "Idempotency key reused with different conversation" }), {
      status: 409,
      headers: { "Content-Type": "application/json" }
    });
  };

  const req = new Request("https://worker.local/webhooks/kapso/handoff", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Idempotency-Key": "idemp-conflict-1",
      "X-Webhook-Signature": signature
    },
    body
  });

  const res = await handleRequest(req, validEnv, mockFetch);
  assert.equal(res.status, 409);
  const data = (await res.json()) as any;
  assert.equal(data.error.code, "IDEMPOTENCY_CONFLICT");
});

test("17. Error temporal de Supabase devuelve 502", async () => {
  const body = makeValidPayload();
  const signature = signPayload(body);

  const mockFetch: typeof fetch = async () => {
    throw new Error("Connection timeout to Supabase");
  };

  const req = new Request("https://worker.local/webhooks/kapso/handoff", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Idempotency-Key": "idemp-fail-1",
      "X-Webhook-Signature": signature
    },
    body
  });

  const res = await handleRequest(req, validEnv, mockFetch);
  assert.equal(res.status, 502);
  const data = (await res.json()) as any;
  assert.equal(data.error.code, "SUPABASE_UNAVAILABLE");
});

test("18. Secretos faltantes provocan falla controlada (503) sin revelar variables", async () => {
  const incompleteEnv: Env = {
    ...validEnv,
    KAPSO_WEBHOOK_SECRET: undefined
  };

  const body = makeValidPayload();
  const signature = signPayload(body);

  const req = new Request("https://worker.local/webhooks/kapso/handoff", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Idempotency-Key": "idemp-1",
      "X-Webhook-Signature": signature
    },
    body
  });

  const res = await handleRequest(req, incompleteEnv);
  assert.equal(res.status, 503);
  const data = (await res.json()) as any;
  assert.equal(data.error.code, "CONFIG_INCOMPLETE");
});

test("19. Respuestas y errores nunca exponen secretos o payloads confidenciales", async () => {
  const body = makeValidPayload();
  const signature = signPayload(body);

  const mockFetch: typeof fetch = async () => {
    return new Response(JSON.stringify({ error: "DB Error details" }), { status: 500 });
  };

  const req = new Request("https://worker.local/webhooks/kapso/handoff", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Idempotency-Key": "idemp-1",
      "X-Webhook-Signature": signature
    },
    body
  });

  const res = await handleRequest(req, validEnv, mockFetch);
  assert.equal(res.status, 502);
  const text = await res.text();
  assert.ok(!text.includes(TEST_SECRET));
  assert.ok(!text.includes(TEST_SERVICE_KEY));
});

test("20. Concurrencia de solicitudes sobre el mismo evento", async () => {
  const body = makeValidPayload();
  const signature = signPayload(body);

  let calls = 0;
  const mockFetch: typeof fetch = async () => {
    calls++;
    if (calls === 1) {
      return new Response(JSON.stringify({ recorded: true, duplicate: false }), { status: 200 });
    }
    return new Response(JSON.stringify({ recorded: false, duplicate: true }), { status: 200 });
  };

  const req1 = new Request("https://worker.local/webhooks/kapso/handoff", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Idempotency-Key": "idemp-concurrent",
      "X-Webhook-Signature": signature
    },
    body
  });
  const req2 = new Request("https://worker.local/webhooks/kapso/handoff", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Idempotency-Key": "idemp-concurrent",
      "X-Webhook-Signature": signature
    },
    body
  });

  const [res1, res2] = await Promise.all([
    handleRequest(req1, validEnv, mockFetch),
    handleRequest(req2, validEnv, mockFetch)
  ]);

  assert.equal(res1.status, 200);
  assert.equal(res2.status, 200);
  const data1 = (await res1.json()) as any;
  const data2 = (await res2.json()) as any;
  assert.ok(data1.recorded || data2.recorded);
  assert.ok(data1.duplicate || data2.duplicate);
});

test("21. E2E-07 Webhook Media Receipt: descarga comprobante de WhatsApp/Kapso, sube a Storage privado y asocia al pedido pendiente", async () => {
  const payload = JSON.stringify({
    event: "whatsapp.message.received",
    channel: "whatsapp",
    project_id: TEST_PROJECT_ID,
    whatsapp_conversation_id: "conv-receipt-1",
    customer_phone: "qa-customer",
    provider_message_id: "wamid.receipt.001",
    media: {
      url: "https://api.kapso.ai/media/receipt-001.jpg",
      file_name: "spei.jpg",
      mime_type: "image/jpeg",
      file_size: 12
    },
    declared_amount_cents: 27000,
    bank_reference: "SPEI-001"
  });
  const signature = signPayload(payload);

  let uploadedStoragePath = "";
  let createdNotification = false;

  const mockFetch: typeof fetch = async (url, init) => {
    const u = String(url);
    const method = init?.method || "GET";
    if (u.includes("/rest/v1/crm_payment_receipts") && method === "GET") {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (u === "https://api.kapso.ai/media/receipt-001.jpg") {
      return new Response(new Uint8Array([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1]), {
        status: 200,
        headers: { "Content-Type": "image/jpeg" }
      });
    }
    if (u.includes("/storage/v1/object/payment-receipts/") && method === "POST") {
      uploadedStoragePath = u;
      return new Response(JSON.stringify({ Key: "ok" }), { status: 200 });
    }
    if (u.includes("/rest/v1/orders") && method === "GET") {
      return new Response(
        JSON.stringify([
          {
            id: "84aa45e1-5b85-4a83-81df-12ae18606494",
            folio: "MB-84AA45",
            customer_ref: "qa-customer",
            conversation_id: "conv-receipt-1",
            payment_method: "transfer",
            payment_status: "pending",
            total_cents: 27000
          }
        ]),
        { status: 200 }
      );
    }
    if (u.includes("/rest/v1/crm_payment_receipts") && method === "POST") {
      return new Response(JSON.stringify([{ id: "rec-001" }]), { status: 201 });
    }
    if (u.includes("/rest/v1/rpc/crm_create_notification")) {
      createdNotification = true;
      return new Response(JSON.stringify("notif-001"), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  };

  const req = new Request("https://worker.local/webhooks/kapso/receipt", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Idempotency-Key": "idemp-receipt-1",
      "X-Webhook-Signature": signature
    },
    body: payload
  });

  const res = await handleRequest(req, validEnv, mockFetch);
  assert.equal(res.status, 201);
  const data = (await res.json()) as any;
  assert.equal(data.recorded, true);
  assert.equal(data.duplicate, false);
  assert.equal(data.association_state, "pending_validation");
  assert.equal(data.order_id, "84aa45e1-5b85-4a83-81df-12ae18606494");
  assert.ok(uploadedStoragePath.includes("/storage/v1/object/payment-receipts/"));
  assert.equal(createdNotification, true);
});

test("22. E2E-07 Webhook Media Receipt Idempotencia: comprobante repetido con mismo provider_message_id no re-descarga ni duplica", async () => {
  const payload = JSON.stringify({
    event: "whatsapp.message.received",
    channel: "whatsapp",
    project_id: TEST_PROJECT_ID,
    whatsapp_conversation_id: "conv-receipt-1",
    provider_message_id: "wamid.receipt.dup",
    media: {
      url: "https://api.kapso.ai/media/receipt-dup.jpg",
      file_name: "spei.jpg",
      mime_type: "image/jpeg"
    }
  });
  const signature = signPayload(payload);

  let downloadCalled = false;
  const mockFetch: typeof fetch = async (url, init) => {
    const u = String(url);
    const method = init?.method || "GET";
    if (u.includes("/rest/v1/crm_payment_receipts") && method === "GET") {
      return new Response(
        JSON.stringify([
          {
            id: "rec-existing",
            order_id: "84aa45e1-5b85-4a83-81df-12ae18606494",
            storage_path: "1c2238f8-863a-4e33-8b5b-5b5e4683e190/receipts/2026-11-20/wamid_spei.jpg",
            status: "pending_validation"
          }
        ]),
        { status: 200 }
      );
    }
    if (u.startsWith("https://api.kapso.ai/media/")) {
      downloadCalled = true;
    }
    return new Response("Not found", { status: 404 });
  };

  const req = new Request("https://worker.local/webhooks/kapso/receipt", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Idempotency-Key": "idemp-receipt-dup",
      "X-Webhook-Signature": signature
    },
    body: payload
  });

  const res = await handleRequest(req, validEnv, mockFetch);
  assert.equal(res.status, 200);
  const data = (await res.json()) as any;
  assert.equal(data.duplicate, true);
  assert.equal(data.recorded, false);
  assert.equal(downloadCalled, false);
});

test("23. E2E-07 Formato nativo Kapso v2 (message.kapso.media_data + conversation.id) descarga PDF a Storage privado", async () => {
  const payload = JSON.stringify({
    message: {
      id: "wamid.native.v2.pdf",
      type: "document",
      kapso: {
        direction: "inbound",
        has_media: true,
        media_url: "https://api.kapso.ai/meta/whatsapp/media_download?token=signed_qa_token",
        media_data: {
          url: "https://api.kapso.ai/meta/whatsapp/media_download?token=signed_qa_token",
          filename: "comprobante-qa-sin-valor.pdf",
          content_type: "application/pdf",
          byte_size: 732
        }
      }
    },
    conversation: {
      id: "51134d34-02c7-4a44-a896-572b3c543343",
      phone_number: "+526623357058",
      phone_number_id: "597907523413541"
    },
    phone_number_id: "597907523413541"
  });
  const signature = signPayload(payload);

  const mockFetch: typeof fetch = async (url, init) => {
    const u = String(url);
    const method = init?.method || "GET";
    if (u.includes("/rest/v1/crm_payment_receipts") && method === "GET") {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (u.startsWith("https://api.kapso.ai/meta/whatsapp/media_download")) {
      return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
        status: 200,
        headers: { "Content-Type": "application/pdf" }
      });
    }
    if (u.includes("/storage/v1/object/payment-receipts/") && method === "POST") {
      return new Response(JSON.stringify({ Key: "ok" }), { status: 200 });
    }
    if (u.includes("/rest/v1/orders") && method === "GET") {
      return new Response(
        JSON.stringify([
          {
            id: "a32019c8-1a8b-4e24-864d-35aaa91bd803",
            folio: "MB-A32019",
            customer_ref: "+526623357058",
            conversation_id: "51134d34-02c7-4a44-a896-572b3c543343",
            payment_method: "transfer",
            payment_status: "pending",
            total_cents: 13500
          }
        ]),
        { status: 200 }
      );
    }
    if (u.includes("/rest/v1/crm_payment_receipts") && method === "POST") {
      return new Response(JSON.stringify([{ id: "81fc5e61-ac4f-4bee-b480-7012df094a35" }]), { status: 201 });
    }
    if (u.includes("/rest/v1/rpc/crm_create_notification")) {
      return new Response(JSON.stringify("notif-001"), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  };

  const req = new Request("https://worker.local/webhooks/kapso/receipt", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Idempotency-Key": "idemp-native-v2",
      "X-Webhook-Signature": signature
    },
    body: payload
  });

  const res = await handleRequest(req, validEnv, mockFetch);
  assert.equal(res.status, 201);
  const data = (await res.json()) as any;
  assert.equal(data.recorded, true);
  assert.equal(data.association_state, "pending_validation");
  assert.equal(data.order_id, "a32019c8-1a8b-4e24-864d-35aaa91bd803");
});
