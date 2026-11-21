import test from "node:test";
import assert from "node:assert/strict";
import type { NotifierEnv, ClaimedTask } from "../src/types.ts";
import { drainOutbox, buildTemplateMessage } from "../src/drain.ts";
import worker from "../src/index.ts";

const mockServiceKey = ["mock", "service", "key", "twenty"].join("-");
const mockApiKey = ["mock", "kapso", "api", "key", "sixtyfour"].join("-");
const TEST_BUSINESS_ID = "1c2238f8-863a-4e33-8b5b-5b5e4683e190";

const baseEnv: NotifierEnv = {
  SUPABASE_URL: "https://gplewdvxxldfvmeintvu.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: mockServiceKey,
  CRM_BUSINESS_ID: TEST_BUSINESS_ID,
  KAPSO_API_KEY: mockApiKey,
  KAPSO_PHONE_NUMBER_ID: "597907523413541",
  KAPSO_WORKER_PHONE: "5216441234567",
  KAPSO_HANDOFF_TEMPLATE: "crm_handoff_alert",
  KAPSO_HANDOFF_TEMPLATE_LANGUAGE: "es_MX",
  ENABLE_KAPSO_HANDOFF_NOTICES: "false",
  WORKER_VERSION: "1.0.0",
  ENVIRONMENT: "test"
};

test("1. drainOutbox se desactiva limpiamente cuando el flag es false", async () => {
  let called = false;
  const mockFetch: typeof fetch = async () => {
    called = true;
    return new Response("OK", { status: 200 });
  };

  const res = await drainOutbox(baseEnv, mockFetch);
  assert.equal(res.status, "disabled");
  assert.equal(res.processed, 0);
  assert.equal(called, false);
});

test("2. buildTemplateMessage genera el payload de WhatsApp UTILITY oficial", () => {
  const req = buildTemplateMessage("597907523413541", "5216441234567", "crm_handoff_alert", "es_MX");
  assert.equal(req.url, "https://api.kapso.ai/meta/whatsapp/v24.0/597907523413541/messages");
  assert.equal(req.payload.messaging_product, "whatsapp");
  assert.equal(req.payload.type, "template");
  assert.equal(req.payload.template.name, "crm_handoff_alert");
  assert.equal(req.payload.template.language.code, "es_MX");
  assert.equal(req.payload.to, "5216441234567");
});

test("3. drainOutbox responde idle cuando no hay elementos pendientes", async () => {
  const env: NotifierEnv = { ...baseEnv, ENABLE_KAPSO_HANDOFF_NOTICES: "true" };
  const mockFetch: typeof fetch = async (url) => {
    if (String(url).includes("/rpc/crm_claim_handoff_notifications")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  };

  const res = await drainOutbox(env, mockFetch);
  assert.equal(res.status, "idle");
  assert.equal(res.processed, 0);
});

test("4. drainOutbox procesa elementos pendientes y actualiza a sent con message ID", async () => {
  const env: NotifierEnv = { ...baseEnv, ENABLE_KAPSO_HANDOFF_NOTICES: "true" };
  const claimed: ClaimedTask[] = [{ event_key: "evt_101", attempts: 1 }];

  let patchedState = "";
  let providerMsgId = "";

  const mockFetch: typeof fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("/rpc/crm_claim_handoff_notifications")) {
      return new Response(JSON.stringify(claimed), { status: 200 });
    }
    if (u.includes("api.kapso.ai/meta/whatsapp")) {
      return new Response(
        JSON.stringify({ messages: [{ id: "wamid_mock_test_12345" }] }),
        { status: 200 }
      );
    }
    if (u.includes("/rest/v1/crm_handoff_outbox")) {
      const body = JSON.parse(String(opts?.body || "{}"));
      patchedState = body.state;
      providerMsgId = body.provider_message_id;
      return new Response(JSON.stringify({}), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  };

  const res = await drainOutbox(env, mockFetch);
  assert.equal(res.status, "completed");
  assert.equal(res.processed, 1);
  assert.equal(res.accepted, 1);
  assert.equal(res.failed, 0);
  assert.equal(patchedState, "sent");
  assert.equal(providerMsgId, "wamid_mock_test_12345");
});

test("5. drainOutbox maneja fallo de envío con reintento (state pending)", async () => {
  const env: NotifierEnv = { ...baseEnv, ENABLE_KAPSO_HANDOFF_NOTICES: "true" };
  const claimed: ClaimedTask[] = [{ event_key: "evt_102", attempts: 2 }];

  let patchedState = "";
  let lastErrorCode = "";

  const mockFetch: typeof fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("/rpc/crm_claim_handoff_notifications")) {
      return new Response(JSON.stringify(claimed), { status: 200 });
    }
    if (u.includes("api.kapso.ai/meta/whatsapp")) {
      return new Response(JSON.stringify({ error: "Network timeout" }), { status: 500 });
    }
    if (u.includes("/rest/v1/crm_handoff_outbox")) {
      const body = JSON.parse(String(opts?.body || "{}"));
      patchedState = body.state;
      lastErrorCode = body.last_error_code;
      return new Response(JSON.stringify({}), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  };

  const res = await drainOutbox(env, mockFetch);
  assert.equal(res.status, "completed");
  assert.equal(res.processed, 1);
  assert.equal(res.accepted, 0);
  assert.equal(res.failed, 1);
  assert.equal(patchedState, "pending");
  assert.equal(lastErrorCode, "DELIVERY_UNCERTAIN");
});

test("6. drainOutbox marca failed cuando se alcanza el límite de 5 intentos", async () => {
  const env: NotifierEnv = { ...baseEnv, ENABLE_KAPSO_HANDOFF_NOTICES: "true" };
  const claimed: ClaimedTask[] = [{ event_key: "evt_103", attempts: 5 }];

  let patchedState = "";

  const mockFetch: typeof fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("/rpc/crm_claim_handoff_notifications")) {
      return new Response(JSON.stringify(claimed), { status: 200 });
    }
    if (u.includes("api.kapso.ai/meta/whatsapp")) {
      return new Response(JSON.stringify({ error: "Fatal error" }), { status: 400 });
    }
    if (u.includes("/rest/v1/crm_handoff_outbox")) {
      const body = JSON.parse(String(opts?.body || "{}"));
      patchedState = body.state;
      return new Response(JSON.stringify({}), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  };

  const res = await drainOutbox(env, mockFetch);
  assert.equal(res.status, "completed");
  assert.equal(res.processed, 1);
  assert.equal(res.failed, 1);
  assert.equal(patchedState, "failed");
});

test("7. GET /health del Worker Notifier responde 200 sin secretos", async () => {
  const req = new Request("https://notifier.local/health", { method: "GET" });
  const res = await worker.fetch(req, baseEnv);
  assert.equal(res.status, 200);
  const data = (await res.json()) as any;
  assert.equal(data.status, "healthy");
  assert.equal(data.service, "crm-kapso-notifier");
  assert.equal(data.notices_enabled, false);
  assert.ok(!JSON.stringify(data).includes(mockServiceKey));
  assert.ok(!JSON.stringify(data).includes(mockApiKey));
});
