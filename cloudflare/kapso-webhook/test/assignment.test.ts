import test from "node:test";
import assert from "node:assert/strict";
import { assignConversationToWorker } from "../src/assigner.ts";
import type { Env, ParsedHandoff } from "../src/types.ts";

const HUMAN_AGENT_ID = "6ef337c0-c724-4cd4-85ae-0c6068495840";
const OWNER_ID = "e5d724a2-8961-458c-a95d-03222b17cd03";
const PHONE_NUMBER_ID = "597907523413541";
const BUSINESS_ID = "1c2238f8-863a-4e33-8b5b-5b5e4683e190";

const TEST_MOCK_KAPSO_KEY = "mock-kapso-key-for-unit-test";
const TEST_MOCK_SUPABASE_KEY = "mock-service-role-key-for-unit-test";

const baseEnv: Env = {
  KAPSO_API_KEY: TEST_MOCK_KAPSO_KEY,
  KAPSO_PROJECT_ID: "7edf4d72-e0af-4b96-939f-08a44014bb88",
  KAPSO_WORKER_ASSIGNEE_ID: HUMAN_AGENT_ID,
  KAPSO_PHONE_NUMBER_ID: PHONE_NUMBER_ID,
  CRM_BUSINESS_ID: BUSINESS_ID,
  SUPABASE_URL: "https://gplewdvxxldfvmeintvu.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: TEST_MOCK_SUPABASE_KEY
};

const baseHandoff: ParsedHandoff = {
  idempotencyKey: "test-event-key-101",
  projectId: "7edf4d72-e0af-4b96-939f-08a44014bb88",
  executionId: "exec-test-01",
  conversationId: "conv-uuid-101",
  reason: "customer_request"
};

// 1. Happy path: assign conversation successfully
test("ASG-01 / ASG-03: Handoff recibido asigna correctamente al Human Agent configurado", async () => {
  let assignCalled = false;
  let supabaseUpdated = false;

  const mockFetch: typeof fetch = async (url, options) => {
    const urlStr = String(url);
    if (urlStr.includes("/whatsapp/conversations/conv-uuid-101") && options?.method === "GET") {
      if (urlStr.includes("/assignments")) {
        return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        data: { id: "conv-uuid-101", phone_number_id: PHONE_NUMBER_ID, status: "active" }
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (urlStr.includes("/whatsapp/conversations/conv-uuid-101/assignments") && options?.method === "POST") {
      assignCalled = true;
      const body = JSON.parse(String(options?.body));
      assert.equal(body.assignment.user_id, HUMAN_AGENT_ID);
      return new Response(JSON.stringify({
        data: { id: "assign-uuid-1", active: true, user_id: HUMAN_AGENT_ID }
      }), { status: 201, headers: { "Content-Type": "application/json" } });
    }
    if (urlStr.includes("/whatsapp/conversations/conv-uuid-101") && options?.method === "PATCH") {
      return new Response(JSON.stringify({
        data: { id: "conv-uuid-101", status: "active" }
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (urlStr.includes("/rpc/crm_update_handoff_assignment")) {
      supabaseUpdated = true;
      const body = JSON.parse(String(options?.body));
      assert.equal(body.p_assignment_state, "assigned");
      assert.equal(body.p_effective_assignee_id, HUMAN_AGENT_ID);
      return new Response(JSON.stringify({ updated: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("Not found", { status: 404 });
  };

  const result = await assignConversationToWorker(baseEnv, baseHandoff, mockFetch);
  assert.equal(result.success, true);
  assert.equal(result.status, "assigned");
  assert.equal(result.assigneeId, HUMAN_AGENT_ID);
  assert.equal(assignCalled, true);
  assert.equal(supabaseUpdated, true);
});

// 2. Idempotency: conversation already assigned to worker
test("ASG-09: Idempotencia - conversacion ya asignada al Worker no reasigna innecesariamente", async () => {
  let assignCalled = false;

  const mockFetch: typeof fetch = async (url, options) => {
    const urlStr = String(url);
    if (urlStr.includes("/whatsapp/conversations/conv-uuid-101") && options?.method === "GET") {
      if (urlStr.includes("/assignments")) {
        return new Response(JSON.stringify({
          data: [{ id: "assign-1", active: true, user_id: HUMAN_AGENT_ID }]
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        data: { id: "conv-uuid-101", phone_number_id: PHONE_NUMBER_ID, status: "active" }
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (urlStr.includes("/assignments") && options?.method === "POST") {
      assignCalled = true;
      return new Response("{}", { status: 200 });
    }
    if (urlStr.includes("/rpc/crm_update_handoff_assignment")) {
      return new Response(JSON.stringify({ updated: true }), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  };

  const result = await assignConversationToWorker(baseEnv, baseHandoff, mockFetch);
  assert.equal(result.success, true);
  assert.equal(result.status, "already_assigned");
  assert.equal(assignCalled, false, "POST assignments must not be called when already assigned");
});

// 3. Security guard: Owner ID rejected as fallback
test("ASG-08: Seguridad - rechaza asignar al propietario si se configurara por error", async () => {
  const envWithOwner: Env = {
    ...baseEnv,
    KAPSO_WORKER_ASSIGNEE_ID: OWNER_ID
  };

  let recordedState: string | null = null;
  const mockFetch: typeof fetch = async (url, options) => {
    if (String(url).includes("/rpc/crm_update_handoff_assignment")) {
      const body = JSON.parse(String(options?.body));
      recordedState = body.p_assignment_state;
      return new Response(JSON.stringify({ updated: true }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  };

  const result = await assignConversationToWorker(envWithOwner, baseHandoff, mockFetch);
  assert.equal(result.success, false);
  assert.equal(result.status, "failed");
  assert.ok(result.error?.includes("Owner user ID cannot be used"));
  assert.equal(recordedState, "failed");
});

// 4. Security guard: Other phone number rejected
test("ASG-04: Seguridad - rechaza conversacion de otro phone_number_id no autorizado", async () => {
  let patchCalled = false;
  let recordedState: string | null = null;

  const mockFetch: typeof fetch = async (url, options) => {
    const urlStr = String(url);
    if (urlStr.includes("/whatsapp/conversations/conv-uuid-101") && options?.method === "GET") {
      return new Response(JSON.stringify({
        data: { id: "conv-uuid-101", phone_number_id: "other-phone-9999", status: "active" }
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (options?.method === "PATCH") {
      patchCalled = true;
      return new Response("{}", { status: 200 });
    }
    if (urlStr.includes("/rpc/crm_update_handoff_assignment")) {
      const body = JSON.parse(String(options?.body));
      recordedState = body.p_assignment_state;
      return new Response(JSON.stringify({ updated: true }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  };

  const result = await assignConversationToWorker(baseEnv, baseHandoff, mockFetch);
  assert.equal(result.success, false);
  assert.equal(result.status, "skipped_existing_assignee");
  assert.equal(patchCalled, false);
  assert.equal(recordedState, "skipped");
});

// 5. Recovery: Rate limit HTTP 429 retries
test("Recuperación: Kapso devuelve HTTP 429 y reintenta con backoff controlado", async () => {
  let attempts = 0;

  const mockFetch: typeof fetch = async (url, options) => {
    const urlStr = String(url);
    if (urlStr.includes("/whatsapp/conversations/conv-uuid-101") && options?.method === "GET") {
      if (urlStr.includes("/assignments")) {
        return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        data: { id: "conv-uuid-101", phone_number_id: PHONE_NUMBER_ID, status: "active" }
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (urlStr.includes("/assignments") && options?.method === "POST") {
      attempts++;
      if (attempts < 2) {
        return new Response(JSON.stringify({ error: "Rate limit exceeded" }), { status: 429 });
      }
      return new Response(JSON.stringify({ data: { id: "assign-uuid-1", status: "active" } }), { status: 201 });
    }
    if (options?.method === "PATCH") {
      return new Response(JSON.stringify({ data: { id: "conv-uuid-101", status: "active" } }), { status: 200 });
    }
    if (urlStr.includes("/rpc/crm_update_handoff_assignment")) {
      return new Response(JSON.stringify({ updated: true }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  };

  const result = await assignConversationToWorker(baseEnv, baseHandoff, mockFetch);
  assert.equal(result.success, true);
  assert.equal(result.status, "assigned");
  assert.equal(attempts, 2);
});

// 6. Recovery: HTTP 500 error persistence and failure state
test("ASG-10: Recuperación - Kapso devuelve HTTP 500 persistiendo estado failed sin secretos", async () => {
  let recordedError: string | null = null;
  let recordedState: string | null = null;

  const mockFetch: typeof fetch = async (url, options) => {
    const urlStr = String(url);
    if (urlStr.includes("/whatsapp/conversations/conv-uuid-101") && options?.method === "GET") {
      if (urlStr.includes("/assignments")) {
        return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        data: { id: "conv-uuid-101", phone_number_id: PHONE_NUMBER_ID, status: "active" }
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (urlStr.includes("/assignments") && options?.method === "POST") {
      return new Response("Internal Server Error", { status: 500 });
    }
    if (urlStr.includes("/rpc/crm_update_handoff_assignment")) {
      const body = JSON.parse(String(options?.body));
      recordedState = body.p_assignment_state;
      recordedError = body.p_error;
      return new Response(JSON.stringify({ updated: true }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  };

  const result = await assignConversationToWorker(baseEnv, baseHandoff, mockFetch);
  assert.equal(result.success, false);
  assert.equal(result.status, "failed");
  assert.equal(result.retryable, true);
  assert.equal(recordedState, "failed");
  assert.ok(recordedError?.includes("Kapso HTTP 500"));
  assert.ok(!recordedError?.includes(baseEnv.KAPSO_API_KEY!), "No secrets in error");
});
