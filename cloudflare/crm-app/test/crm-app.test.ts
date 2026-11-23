import test from "node:test";
import assert from "node:assert/strict";
import type { Env, DbSessionRow } from "../src/types.ts";
import { handleRequest } from "../src/handler.ts";
import { createSessionCookieValue } from "../src/session.ts";
import { getOrders, getOrderDetails, updateOrderStatus } from "../src/supabase.ts";

const mockSecret = ["mock", "secret", "32", "bytes", "length"].join("-");
const mockServiceKey = ["mock", "service", "key", "length", "twenty"].join("-");
const mockPubKey = ["mock", "pub", "key"].join("-");
const TEST_BUSINESS_ID = "1c2238f8-863a-4e33-8b5b-5b5e4683e190";
const TEST_SUPABASE_URL = "https://gplewdvxxldfvmeintvu.supabase.co";

const testEnv: Env = {
  SUPABASE_URL: TEST_SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY: mockPubKey,
  SUPABASE_SERVICE_ROLE_KEY: mockServiceKey,
  CRM_BUSINESS_ID: TEST_BUSINESS_ID,
  SESSION_SECRET: mockSecret,
  KAPSO_OWNER_EMBED_URL: "https://inbox.kapso.ai/embed/owner-mock-token",
  KAPSO_WORKER_EMBED_URL: "https://inbox.kapso.ai/embed/worker-mock-token",
  KAPSO_WORKER_EMBED_APPROVED: "false",
  KAPSO_WORKER_ASSIGNEE_ID: "assignee-worker-1",
  KAPSO_API_KEY: "mock-kapso-api-key",
  KAPSO_PHONE_NUMBER_ID: "1462335776957834",
  WORKER_VERSION: "1.1.0",
  ENVIRONMENT: "test"
};

const inMemorySessions = new Map<string, DbSessionRow>();

function makeDbSession(
  role: "owner" | "worker",
  opts: { email?: string; expiredTtl?: boolean; revoked?: boolean } = {}
): { sessionId: string; session: DbSessionRow } {
  const sessionId = "sess-" + Math.random().toString(36).slice(2) + "-" + role;
  const now = Date.now();
  const session: DbSessionRow = {
    id: sessionId,
    user_id: "user-" + role + "-id",
    business_id: TEST_BUSINESS_ID,
    access_token: "tok",
    refresh_token: "ref",
    role,
    kapso_assignee_id: role === "worker" ? "assignee-worker-1" : null,
    email: opts.email || `${role}@test.com`,
    expires_at: new Date(now + 3600_000).toISOString(),
    ttl: opts.expiredTtl ? new Date(now - 10_000).toISOString() : new Date(now + 8 * 3600_000).toISOString(),
    revoked_at: opts.revoked ? new Date(now - 5_000).toISOString() : null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  inMemorySessions.set(sessionId, session);
  return { sessionId, session };
}

async function makeCookie(
  role: "owner" | "worker",
  opts: { email?: string; expiredTtl?: boolean; revoked?: boolean } = {}
): Promise<string> {
  const { sessionId } = makeDbSession(role, opts);
  const cookieVal = await createSessionCookieValue(sessionId, mockSecret);
  return `crm_remote_session=${cookieVal}`;
}

test("1. GET /health responde 200 con metadata pública y sin secretos", async () => {
  const req = new Request("https://crm.local/health", { method: "GET" });
  const res = await handleRequest(req, testEnv);
  assert.equal(res.status, 200);
  const data = (await res.json()) as any;
  assert.equal(data.status, "healthy");
  assert.equal(data.service, "crm-kapso-app");
  assert.equal(data.version, "1.1.0");
  assert.ok(data.commit_sha);
  assert.ok(!JSON.stringify(data).includes(mockSecret));
  assert.ok(!JSON.stringify(data).includes(mockServiceKey));
});

test("2. GET /health rechaza métodos no permitidos (405)", async () => {
  const req = new Request("https://crm.local/health", { method: "POST" });
  const res = await handleRequest(req, testEnv);
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("Allow"), "GET");
});

test("3. Sirve assets estáticos correctamente con encabezados de seguridad", async () => {
  const reqRoot = new Request("https://crm.local/", { method: "GET" });
  const resRoot = await handleRequest(reqRoot, testEnv);
  assert.equal(resRoot.status, 200);
  assert.ok(resRoot.headers.get("Content-Type")?.includes("text/html"));
  assert.equal(resRoot.headers.get("X-Frame-Options"), "DENY");

  const reqJs = new Request("https://crm.local/remote-app.js", { method: "GET" });
  const resJs = await handleRequest(reqJs, testEnv);
  assert.equal(resJs.status, 200);
  assert.ok(resJs.headers.get("Content-Type")?.includes("javascript"));
});

test("4. Rechaza solicitudes mutantes desde orígenes no autorizados (403)", async () => {
  const req = new Request("https://crm.local/api/login", {
    method: "POST",
    headers: {
      "Origin": "https://malicious-site.com",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ email: "test@qa.com", password: "pwd" })
  });
  const res = await handleRequest(req, testEnv);
  assert.equal(res.status, 403);
  const data = (await res.json()) as any;
  assert.equal(data.error, "Origen no autorizado");
});

test("5. Login valida credenciales, crea sesión opaca en DB y emite cookie firmada", async () => {
  const mockFetch: typeof fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("/rest/v1/rpc/crm_check_rate_limit")) {
      return new Response(JSON.stringify({ allowed: true, attempts: 1 }), { status: 200 });
    }
    if (u.includes("/rest/v1/rpc/crm_reset_rate_limit")) {
      return new Response(JSON.stringify({}), { status: 200 });
    }
    if (u.includes("/auth/v1/token")) {
      return new Response(
        JSON.stringify({
          access_token: "tok",
          refresh_token: "ref",
          expires_in: 3600,
          user: { id: "user-owner-123", email: "owner@test.com" }
        }),
        { status: 200 }
      );
    }
    if (u.includes("/rest/v1/crm_memberships")) {
      return new Response(
        JSON.stringify([
          { business_id: TEST_BUSINESS_ID, role: "owner", active: true, kapso_assignee_id: null }
        ]),
        { status: 200 }
      );
    }
    if (u.includes("/rest/v1/crm_sessions")) {
      const body = JSON.parse(String(opts?.body || "{}"));
      const newSession: DbSessionRow = {
        id: "db-sess-12345",
        ...body,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      inMemorySessions.set(newSession.id, newSession);
      return new Response(JSON.stringify([newSession]), { status: 201 });
    }
    return new Response("Not found", { status: 404 });
  };

  const reqLogin = new Request("https://crm.local/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "owner@test.com", password: "pwd" })
  });
  const resLogin = await handleRequest(reqLogin, testEnv, mockFetch);
  assert.equal(resLogin.status, 200);
  const data = (await resLogin.json()) as any;
  assert.equal(data.email, "owner@test.com");
  assert.equal(data.role, "owner");

  const setCookie = resLogin.headers.get("Set-Cookie");
  assert.ok(setCookie);
  assert.ok(setCookie.includes("crm_remote_session="));
  assert.ok(setCookie.includes("HttpOnly"));
  assert.ok(setCookie.includes("SameSite=Lax"));
  // Ensure tokens are NOT in cookie
  assert.ok(!setCookie.includes("mock-tok"));
  assert.ok(!setCookie.includes("mock-ref"));
});

test("6. Rate limit rechaza con 429 tras exceso de intentos fallidos", async () => {
  const mockFetch: typeof fetch = async (url) => {
    if (String(url).includes("/rest/v1/rpc/crm_check_rate_limit")) {
      return new Response(
        JSON.stringify({ allowed: false, locked: true, attempts: 5, retry_after: 600 }),
        { status: 200 }
      );
    }
    return new Response("Not found", { status: 404 });
  };

  const req = new Request("https://crm.local/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "spammer@test.com", password: "pwd" })
  });
  const res = await handleRequest(req, testEnv, mockFetch);
  assert.equal(res.status, 429);
  const data = (await res.json()) as any;
  assert.equal(data.error, "Demasiados intentos; vuelve más tarde");
});

test("7. Rutas protegidas exigen sesión válida (401 si falta o adulterada)", async () => {
  // Missing cookie
  const reqNoAuth = new Request("https://crm.local/api/me", { method: "GET" });
  const resNoAuth = await handleRequest(reqNoAuth, testEnv);
  assert.equal(resNoAuth.status, 401);

  // Tampered cookie
  const validCookie = await makeCookie("owner");
  const tampered = validCookie + "tampered";
  const reqTampered = new Request("https://crm.local/api/me", {
    method: "GET",
    headers: { Cookie: tampered }
  });
  const resTampered = await handleRequest(reqTampered, testEnv);
  assert.equal(resTampered.status, 401);
});

test("8. Sesión expirada por TTL es rechazada (401)", async () => {
  const cookie = await makeCookie("owner", { expiredTtl: true });
  const mockFetch: typeof fetch = async (url) => {
    const u = String(url);
    if (u.includes("/rest/v1/crm_sessions")) {
      const match = u.match(/id=eq\.([^&]+)/);
      const sess = match ? inMemorySessions.get(match[1]) : null;
      return new Response(JSON.stringify(sess ? [sess] : []), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  };

  const req = new Request("https://crm.local/api/me", {
    method: "GET",
    headers: { Cookie: cookie }
  });
  const res = await handleRequest(req, testEnv, mockFetch);
  assert.equal(res.status, 401);
});

test("9. Logout revoca sesión en DB de forma inmediata y efectiva", async () => {
  const { sessionId } = makeDbSession("owner");
  const cookieVal = await createSessionCookieValue(sessionId, mockSecret);
  const cookie = `crm_remote_session=${cookieVal}`;

  let sessionRevoked = false;
  const mockFetch: typeof fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("/rest/v1/crm_sessions")) {
      if (opts?.method === "PATCH") {
        sessionRevoked = true;
        const sess = inMemorySessions.get(sessionId);
        if (sess) sess.revoked_at = new Date().toISOString();
        return new Response(JSON.stringify({}), { status: 200 });
      }
      const sess = inMemorySessions.get(sessionId);
      if (sess && !sess.revoked_at) {
        return new Response(JSON.stringify([sess]), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (u.includes("/rest/v1/crm_memberships")) {
      return new Response(
        JSON.stringify([{ business_id: TEST_BUSINESS_ID, role: "owner", active: true }]),
        { status: 200 }
      );
    }
    return new Response("Not found", { status: 404 });
  };

  // Perform logout
  const reqLogout = new Request("https://crm.local/api/logout", {
    method: "POST",
    headers: { Cookie: cookie }
  });
  const resLogout = await handleRequest(reqLogout, testEnv, mockFetch);
  assert.equal(resLogout.status, 200);
  assert.equal(sessionRevoked, true);
  assert.ok(resLogout.headers.get("Set-Cookie")?.includes("Max-Age=0"));

  // Subsequent request with the same cookie is now rejected with 401
  const reqAfter = new Request("https://crm.local/api/me", {
    method: "GET",
    headers: { Cookie: cookie }
  });
  const resAfter = await handleRequest(reqAfter, testEnv, mockFetch);
  assert.equal(resAfter.status, 401);
});

test("10. Desactivación de membresía en Supabase revoca acceso inmediatamente", async () => {
  const cookie = await makeCookie("owner");
  const mockFetch: typeof fetch = async (url) => {
    const u = String(url);
    if (u.includes("/rest/v1/crm_sessions")) {
      const match = u.match(/id=eq\.([^&]+)/);
      const sess = match ? inMemorySessions.get(match[1]) : null;
      return new Response(JSON.stringify(sess ? [sess] : []), { status: 200 });
    }
    if (u.includes("/rest/v1/crm_memberships")) {
      // Membership marked inactive
      return new Response(
        JSON.stringify([{ business_id: TEST_BUSINESS_ID, role: "owner", active: false }]),
        { status: 200 }
      );
    }
    return new Response("Not found", { status: 404 });
  };

  const req = new Request("https://crm.local/api/me", {
    method: "GET",
    headers: { Cookie: cookie }
  });
  const res = await handleRequest(req, testEnv, mockFetch);
  assert.equal(res.status, 401);
});

test("11. Restricción por rol: Worker recibe 403 en endpoints owner", async () => {
  const cookie = await makeCookie("worker", { email: "worker@company.com" });
  const mockFetch: typeof fetch = async (url) => {
    const u = String(url);
    if (u.includes("/rest/v1/crm_sessions")) {
      const match = u.match(/id=eq\.([^&]+)/);
      const sess = match ? inMemorySessions.get(match[1]) : null;
      return new Response(JSON.stringify(sess ? [sess] : []), { status: 200 });
    }
    if (u.includes("/rest/v1/crm_memberships")) {
      return new Response(
        JSON.stringify([
          { business_id: TEST_BUSINESS_ID, role: "worker", active: true, kapso_assignee_id: "assignee-worker-1" }
        ]),
        { status: 200 }
      );
    }
    return new Response("Not found", { status: 404 });
  };

  const checkForbidden = async (path: string) => {
    const req = new Request("https://crm.local" + path, { method: "GET", headers: { Cookie: cookie } });
    const res = await handleRequest(req, testEnv, mockFetch);
    assert.equal(res.status, 403);
  };

  await checkForbidden("/api/inventory");
  await checkForbidden("/api/movements");
  await checkForbidden("/api/alerts");
  await checkForbidden("/api/drafts");
  await checkForbidden("/api/menu");
});

test("12. Separación estricta de Inbox: Owner recibe embed owner, Worker nunca recibe embed owner", async () => {
  const mockFetch: typeof fetch = async (url) => {
    const u = String(url);
    if (u.includes("/rest/v1/crm_sessions")) {
      const match = u.match(/id=eq\.([^&]+)/);
      const sess = match ? inMemorySessions.get(match[1]) : null;
      return new Response(JSON.stringify(sess ? [sess] : []), { status: 200 });
    }
    if (u.includes("/rest/v1/crm_memberships")) {
      const isWorker = u.includes("worker");
      return new Response(
        JSON.stringify([
          {
            business_id: TEST_BUSINESS_ID,
            role: isWorker ? "worker" : "owner",
            active: true,
            kapso_assignee_id: isWorker ? "assignee-worker-1" : null
          }
        ]),
        { status: 200 }
      );
    }
    return new Response("Not found", { status: 404 });
  };

  // 1. Owner request
  const ownerCookie = await makeCookie("owner");
  const reqOwner = new Request("https://crm.local/api/handoff", {
    method: "GET",
    headers: { Cookie: ownerCookie }
  });
  const resOwner = await handleRequest(reqOwner, testEnv, mockFetch);
  assert.equal(resOwner.status, 200);
  const dataOwner = (await resOwner.json()) as any;
  assert.equal(dataOwner.status, "ready");
  assert.equal(dataOwner.embed_url, "https://inbox.kapso.ai/embed/owner-mock-token");

  // 2. Worker request (approval pending)
  const workerCookie = await makeCookie("worker");
  const reqWorker = new Request("https://crm.local/api/handoff", {
    method: "GET",
    headers: { Cookie: workerCookie }
  });
  const resWorker = await handleRequest(reqWorker, testEnv, mockFetch);
  assert.equal(resWorker.status, 200);
  const dataWorker = (await resWorker.json()) as any;
  assert.equal(dataWorker.status, "pending_integration");
  assert.ok(!JSON.stringify(dataWorker).includes("owner-mock-token"));
});

test("13. Owner consulta GET /api/alerts: consulta public.crm_alerts con filtro de business_id y resolved_at", async () => {
  let capturedAlertsUrl = "";
  let capturedToken = "";
  const mockFetch: typeof fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/rest/v1/crm_sessions")) {
      const match = u.match(/id=eq\.([^&]+)/);
      const sess = match ? inMemorySessions.get(match[1]) : null;
      return new Response(JSON.stringify(sess ? [sess] : []), { status: 200 });
    }
    if (u.includes("/rest/v1/crm_memberships")) {
      return new Response(
        JSON.stringify([{ business_id: TEST_BUSINESS_ID, role: "owner", active: true, kapso_assignee_id: null }]),
        { status: 200 }
      );
    }
    if (u.includes("/rest/v1/crm_alerts")) {
      capturedAlertsUrl = u;
      capturedToken = (init?.headers as any)?.Authorization || "";
      return new Response(
        JSON.stringify([
          {
            id: "alert-uuid-1",
            business_id: TEST_BUSINESS_ID,
            inventory_id: "inv-uuid-1",
            kind: "low_stock",
            message: "Stock crítico de pan",
            resolved_at: null,
            created_at: new Date().toISOString()
          }
        ]),
        { status: 200 }
      );
    }
    return new Response("Not found", { status: 404 });
  };

  const ownerCookie = await makeCookie("owner");
  const req = new Request("https://crm.local/api/alerts", {
    method: "GET",
    headers: { Cookie: ownerCookie }
  });
  const res = await handleRequest(req, testEnv, mockFetch);
  assert.equal(res.status, 200);
  const data = (await res.json()) as any;
  assert.equal(data.alerts.length, 1);
  assert.equal(data.alerts[0].message, "Stock crítico de pan");
  assert.ok(capturedAlertsUrl.includes("/rest/v1/crm_alerts"));
  assert.ok(capturedAlertsUrl.includes("business_id=eq." + TEST_BUSINESS_ID));
  assert.ok(capturedAlertsUrl.includes("resolved_at=is.null"));
  assert.ok(!capturedAlertsUrl.includes("crm_stock_alerts"));
});

test("14. Owner consulta GET /api/menu: consulta menu_products y menu_modifiers con privileged=true y columnas reales", async () => {
  let capturedProductHeaders: Record<string, string> = {};
  let capturedModifierHeaders: Record<string, string> = {};
  let capturedProductUrl = "";
  let capturedModifierUrl = "";

  const mockFetch: typeof fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/rest/v1/crm_sessions")) {
      const match = u.match(/id=eq\.([^&]+)/);
      const sess = match ? inMemorySessions.get(match[1]) : null;
      return new Response(JSON.stringify(sess ? [sess] : []), { status: 200 });
    }
    if (u.includes("/rest/v1/crm_memberships")) {
      return new Response(
        JSON.stringify([{ business_id: TEST_BUSINESS_ID, role: "owner", active: true, kapso_assignee_id: null }]),
        { status: 200 }
      );
    }
    if (u.includes("/rest/v1/menu_products")) {
      capturedProductUrl = u;
      capturedProductHeaders = (init?.headers as any) || {};
      return new Response(
        JSON.stringify([
          { sku: "BURGER-01", category: "Hamburguesas", name: "Clásica", price_cents: 12000, description: "Deliciosa", active: true }
        ]),
        { status: 200 }
      );
    }
    if (u.includes("/rest/v1/menu_modifiers")) {
      capturedModifierUrl = u;
      capturedModifierHeaders = (init?.headers as any) || {};
      return new Response(
        JSON.stringify([
          { sku: "EXTRA-QUESO", name: "Extra Queso", price_cents: 2000, category: "Toppings", requires_review: false }
        ]),
        { status: 200 }
      );
    }
    return new Response("Not found", { status: 404 });
  };

  const ownerCookie = await makeCookie("owner");
  const req = new Request("https://crm.local/api/menu", {
    method: "GET",
    headers: { Cookie: ownerCookie }
  });
  const res = await handleRequest(req, testEnv, mockFetch);
  assert.equal(res.status, 200);
  const data = (await res.json()) as any;
  assert.equal(data.products.length, 1);
  assert.equal(data.products[0].sku, "BURGER-01");
  assert.equal(data.modifiers.length, 1);
  assert.equal(data.modifiers[0].sku, "EXTRA-QUESO");

  // Verify privileged service role header used
  assert.equal(capturedProductHeaders.apikey, testEnv.SUPABASE_SERVICE_ROLE_KEY);
  assert.equal(capturedModifierHeaders.apikey, testEnv.SUPABASE_SERVICE_ROLE_KEY);

  // Verify real columns requested (no 'id' column)
  const decodedProductUrl = decodeURIComponent(capturedProductUrl);
  const decodedModifierUrl = decodeURIComponent(capturedModifierUrl);
  assert.ok(decodedProductUrl.includes("sku,category,name,price_cents,description,active"));
  assert.ok(!decodedProductUrl.includes("select=id"));
  assert.ok(decodedModifierUrl.includes("sku,name,price_cents,category,requires_review"));
  assert.ok(!decodedModifierUrl.includes("select=id"));
});

test("15. Owner consulta GET /api/orders: consulta orders con privileged=true", async () => {
  let capturedOrdersHeaders: Record<string, string> = {};
  const mockFetch: typeof fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/rest/v1/crm_sessions")) {
      const match = u.match(/id=eq\.([^&]+)/);
      const sess = match ? inMemorySessions.get(match[1]) : null;
      return new Response(JSON.stringify(sess ? [sess] : []), { status: 200 });
    }
    if (u.includes("/rest/v1/crm_memberships")) {
      return new Response(
        JSON.stringify([{ business_id: TEST_BUSINESS_ID, role: "owner", active: true, kapso_assignee_id: null }]),
        { status: 200 }
      );
    }
    if (u.includes("/rest/v1/orders")) {
      capturedOrdersHeaders = (init?.headers as any) || {};
      return new Response(
        JSON.stringify([
          {
            id: "ord-1",
            confirmation_key: "KEY1",
            customer_ref: "5512345678",
            items: [],
            subtotal_cents: 10000,
            shipping_cents: 0,
            total_cents: 10000,
            fulfillment: "pickup",
            address: null,
            delivery_references: null,
            payment_method: "cash",
            payment_status: "pending",
            order_status: "confirmed",
            created_at: new Date().toISOString()
          }
        ]),
        { status: 200 }
      );
    }
    return new Response("Not found", { status: 404 });
  };

  const ownerCookie = await makeCookie("owner");
  const req = new Request("https://crm.local/api/orders", {
    method: "GET",
    headers: { Cookie: ownerCookie }
  });
  const res = await handleRequest(req, testEnv, mockFetch);
  assert.equal(res.status, 200);
  const data = (await res.json()) as any;
  assert.equal(data.orders.length, 1);
  assert.equal(data.orders[0].id, "ord-1");
  assert.equal(capturedOrdersHeaders.apikey, testEnv.SUPABASE_SERVICE_ROLE_KEY);
});

test("16. Worker con aprobación habilitada recibe URL worker con filtros handoff=1&status=active, nunca token owner", async () => {
  const approvedEnv: Env = {
    ...testEnv,
    KAPSO_WORKER_EMBED_APPROVED: "true"
  };

  const mockFetch: typeof fetch = async (url) => {
    const u = String(url);
    if (u.includes("/rest/v1/crm_sessions")) {
      const match = u.match(/id=eq\.([^&]+)/);
      const sess = match ? inMemorySessions.get(match[1]) : null;
      return new Response(JSON.stringify(sess ? [sess] : []), { status: 200 });
    }
    if (u.includes("/rest/v1/crm_memberships")) {
      return new Response(
        JSON.stringify([
          {
            business_id: TEST_BUSINESS_ID,
            role: "worker",
            active: true,
            kapso_assignee_id: "assignee-worker-1"
          }
        ]),
        { status: 200 }
      );
    }
    return new Response("Not found", { status: 404 });
  };

  const workerCookie = await makeCookie("worker");
  const req = new Request("https://crm.local/api/handoff", {
    method: "GET",
    headers: { Cookie: workerCookie }
  });
  const res = await handleRequest(req, approvedEnv, mockFetch);
  assert.equal(res.status, 200);
  const data = (await res.json()) as any;
  assert.equal(data.status, "ready");
  assert.ok(data.embed_url.includes("https://inbox.kapso.ai/embed/worker-mock-token"));
  assert.ok(data.embed_url.includes("handoff=1"));
  assert.ok(data.embed_url.includes("status=active"));
  assert.ok(!data.embed_url.includes("owner-mock-token"));
});

test("17. Worker y Owner consultan GET /api/notifications con aislamiento y lectura", async () => {
  const workerCookie = await makeCookie("worker", { email: "worker1@test.com" });
  const mockNotifications = [
    {
      id: "notif-1",
      business_id: TEST_BUSINESS_ID,
      event_key: "handoff:1",
      type: "human_handoff",
      priority: "high",
      title: "Handoff Worker",
      message: "Atender cliente",
      resource_type: "conversation",
      resource_id: "conv-1",
      recipient_role: "worker",
      recipient_user_id: null,
      state: "pending",
      created_at: new Date().toISOString()
    },
    {
      id: "notif-2",
      business_id: TEST_BUSINESS_ID,
      event_key: "transfer:1",
      type: "transfer_validation",
      priority: "high",
      title: "Comprobante por validar",
      message: "Validar pago",
      resource_type: "order",
      resource_id: "ord-1",
      recipient_role: "all",
      recipient_user_id: null,
      state: "pending",
      created_at: new Date().toISOString()
    }
  ];

  const mockFetch: typeof fetch = async (url) => {
    const u = String(url);
    if (u.includes("/rest/v1/crm_sessions")) {
      const match = u.match(/id=eq\.([^&]+)/);
      const sess = match ? inMemorySessions.get(match[1]) : null;
      return new Response(JSON.stringify(sess ? [sess] : []), { status: 200 });
    }
    if (u.includes("/rest/v1/crm_memberships")) {
      return new Response(
        JSON.stringify([
          { business_id: TEST_BUSINESS_ID, role: "worker", active: true, can_validate_transfers: false }
        ]),
        { status: 200 }
      );
    }
    if (u.includes("/rest/v1/crm_notifications")) {
      return new Response(JSON.stringify(mockNotifications), { status: 200 });
    }
    if (u.includes("/rest/v1/crm_notification_reads")) {
      return new Response(JSON.stringify([{ notification_id: "notif-1" }]), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  };

  const req = new Request("https://crm.local/api/notifications", {
    method: "GET",
    headers: { Cookie: workerCookie }
  });
  const res = await handleRequest(req, testEnv, mockFetch);
  assert.equal(res.status, 200);
  const data = (await res.json()) as any;
  // Worker without can_validate_transfers filtered out notif-2 (transfer_validation)
  assert.equal(data.notifications.length, 1);
  assert.equal(data.notifications[0].id, "notif-1");
  assert.equal(data.notifications[0].read, true);
});

test("18. Marcar notificaciones como leídas y resolución", async () => {
  const ownerCookie = await makeCookie("owner");
  let readInserted = false;
  let resolvedPatched = false;

  const mockFetch: typeof fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("/rest/v1/crm_sessions")) {
      const match = u.match(/id=eq\.([^&]+)/);
      const sess = match ? inMemorySessions.get(match[1]) : null;
      return new Response(JSON.stringify(sess ? [sess] : []), { status: 200 });
    }
    if (u.includes("/rest/v1/crm_memberships")) {
      return new Response(
        JSON.stringify([{ business_id: TEST_BUSINESS_ID, role: "owner", active: true }]),
        { status: 200 }
      );
    }
    if (u.includes("/rest/v1/crm_notification_reads") && opts?.method === "POST") {
      readInserted = true;
      return new Response(JSON.stringify([]), { status: 201 });
    }
    if (u.includes("/rest/v1/crm_notifications") && opts?.method === "PATCH") {
      resolvedPatched = true;
      return new Response(JSON.stringify([]), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  };

  // Mark read
  const reqRead = new Request("https://crm.local/api/notifications/notif-abc/read", {
    method: "POST",
    headers: { Cookie: ownerCookie }
  });
  const resRead = await handleRequest(reqRead, testEnv, mockFetch);
  assert.equal(resRead.status, 200);
  assert.equal(readInserted, true);

  // Resolve
  const reqResolve = new Request("https://crm.local/api/notifications/notif-abc/resolve", {
    method: "POST",
    headers: { Cookie: ownerCookie }
  });
  const resResolve = await handleRequest(reqResolve, testEnv, mockFetch);
  assert.equal(resResolve.status, 200);
  assert.equal(resolvedPatched, true);
});

test("19. Worker consulta GET /api/orders y actualiza estado operativo (PATCH /api/orders/:id/status)", async () => {
  const workerCookie = await makeCookie("worker");
  let statusUpdated = false;
  let historyInserted = false;

  const mockOrder = {
    id: "33333333-3333-4333-8333-333333333333",
    confirmation_key: "44444444-4444-4444-8444-444444444444",
    customer_ref: "+526221234567",
    items: [{ sku: "BURGER-1", name: "Hamburguesa Clásica", qty: 2 }],
    subtotal_cents: 18000,
    shipping_cents: 0,
    total_cents: 18000,
    fulfillment: "pickup",
    payment_method: "cash",
    payment_status: "pending",
    order_status: "received",
    created_at: new Date().toISOString()
  };

  const mockFetch: typeof fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("/rest/v1/crm_sessions")) {
      const match = u.match(/id=eq\.([^&]+)/);
      const sess = match ? inMemorySessions.get(match[1]) : null;
      return new Response(JSON.stringify(sess ? [sess] : []), { status: 200 });
    }
    if (u.includes("/rest/v1/crm_memberships")) {
      return new Response(
        JSON.stringify([{ business_id: TEST_BUSINESS_ID, role: "worker", active: true }]),
        { status: 200 }
      );
    }
    if (u.includes("/rest/v1/orders")) {
      if (opts?.method === "PATCH") {
        statusUpdated = true;
        return new Response(JSON.stringify([{ ...mockOrder, order_status: "confirmed" }]), { status: 200 });
      }
      return new Response(JSON.stringify([mockOrder]), { status: 200 });
    }
    if (u.includes("/rest/v1/crm_payment_receipts")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (u.includes("/rest/v1/crm_order_history")) {
      if (opts?.method === "POST") historyInserted = true;
      return new Response(JSON.stringify([]), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  };

  // GET /api/orders
  const reqGet = new Request("https://crm.local/api/orders", {
    method: "GET",
    headers: { Cookie: workerCookie }
  });
  const resGet = await handleRequest(reqGet, testEnv, mockFetch);
  assert.equal(resGet.status, 200);
  const dataGet = (await resGet.json()) as any;
  assert.equal(dataGet.orders.length, 1);
  assert.equal(dataGet.orders[0].id, mockOrder.id);

  // PATCH /api/orders/:id/status
  const reqPatch = new Request(`https://crm.local/api/orders/${mockOrder.id}/status`, {
    method: "PATCH",
    headers: { Cookie: workerCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ order_status: "confirmed", notes: "Confirmado por trabajador" })
  });
  const resPatch = await handleRequest(reqPatch, testEnv, mockFetch);
  assert.equal(resPatch.status, 200);
  assert.equal(statusUpdated, true);
  assert.equal(historyInserted, true);
});

test("20. Transición de pedido a confirmed emite notificación order_confirmed", async () => {
  const ownerCookie = await makeCookie("owner");
  let notificationCreated = false;

  const mockOrder = {
    id: "55555555-5555-4555-8555-555555555555",
    confirmation_key: "66666666-6666-4666-8666-666666666666",
    customer_ref: "+526221234567",
    items: [],
    subtotal_cents: 10000,
    shipping_cents: 0,
    total_cents: 10000,
    fulfillment: "pickup",
    payment_method: "transfer",
    payment_status: "validated",
    order_status: "received",
    created_at: new Date().toISOString()
  };

  const mockFetch: typeof fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("/rest/v1/crm_sessions")) {
      const match = u.match(/id=eq\.([^&]+)/);
      const sess = match ? inMemorySessions.get(match[1]) : null;
      return new Response(JSON.stringify(sess ? [sess] : []), { status: 200 });
    }
    if (u.includes("/rest/v1/crm_memberships")) {
      return new Response(
        JSON.stringify([{ business_id: TEST_BUSINESS_ID, role: "owner", active: true }]),
        { status: 200 }
      );
    }
    if (u.includes("/rest/v1/orders")) {
      if (opts?.method === "PATCH") {
        return new Response(JSON.stringify([{ ...mockOrder, order_status: "confirmed" }]), { status: 200 });
      }
      return new Response(JSON.stringify([mockOrder]), { status: 200 });
    }
    if (u.includes("/rest/v1/crm_payment_receipts") || u.includes("/rest/v1/crm_order_history") || u.includes("/rest/v1/crm_notifications")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (u.includes("/rest/v1/rpc/crm_create_notification")) {
      notificationCreated = true;
      return new Response(JSON.stringify({ id: "notif-new", inserted: true }), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  };

  const req = new Request(`https://crm.local/api/orders/${mockOrder.id}/status`, {
    method: "PATCH",
    headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ order_status: "confirmed" })
  });
  const res = await handleRequest(req, testEnv, mockFetch);
  assert.equal(res.status, 200);
  assert.equal(notificationCreated, true);
});

test("21. Worker sin can_validate_transfers es rechazado con 403 al validar transferencia", async () => {
  const workerCookie = await makeCookie("worker");

  const mockFetch: typeof fetch = async (url) => {
    const u = String(url);
    if (u.includes("/rest/v1/crm_sessions")) {
      const match = u.match(/id=eq\.([^&]+)/);
      const sess = match ? inMemorySessions.get(match[1]) : null;
      return new Response(JSON.stringify(sess ? [sess] : []), { status: 200 });
    }
    if (u.includes("/rest/v1/crm_memberships")) {
      return new Response(
        JSON.stringify([
          { business_id: TEST_BUSINESS_ID, role: "worker", active: true, can_validate_transfers: false }
        ]),
        { status: 200 }
      );
    }
    return new Response("Not found", { status: 404 });
  };

  const req = new Request("https://crm.local/api/orders/77777777-7777-4777-8777-777777777777/validate-payment", {
    method: "POST",
    headers: { Cookie: workerCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ confirmed_bank_deposit: true })
  });
  const res = await handleRequest(req, testEnv, mockFetch);
  assert.equal(res.status, 403);
  const data = (await res.json()) as any;
  assert.match(data.error, /permiso para validar transferencias/);
});

test("22. Usuario autorizado valida transferencia con confirmación explícita (200), actualiza pago y resuelve notificación", async () => {
  const ownerCookie = await makeCookie("owner");
  let paymentUpdated = false;
  let receiptUpdated = false;
  let notificationResolved = false;

  const orderId = "88888888-8888-4888-8888-888888888888";
  const mockOrder = {
    id: orderId,
    total_cents: 15000,
    payment_method: "transfer",
    payment_status: "pending",
    order_status: "received"
  };

  const mockFetch: typeof fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("/rest/v1/crm_sessions")) {
      const match = u.match(/id=eq\.([^&]+)/);
      const sess = match ? inMemorySessions.get(match[1]) : null;
      return new Response(JSON.stringify(sess ? [sess] : []), { status: 200 });
    }
    if (u.includes("/rest/v1/crm_memberships")) {
      return new Response(
        JSON.stringify([{ business_id: TEST_BUSINESS_ID, role: "owner", active: true }]),
        { status: 200 }
      );
    }
    if (u.includes("/rest/v1/orders")) {
      if (opts?.method === "PATCH") {
        paymentUpdated = true;
        return new Response(JSON.stringify([{ ...mockOrder, payment_status: "validated" }]), { status: 200 });
      }
      return new Response(JSON.stringify([mockOrder]), { status: 200 });
    }
    if (u.includes("/rest/v1/crm_payment_receipts")) {
      if (opts?.method === "PATCH") receiptUpdated = true;
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (u.includes("/rest/v1/crm_notifications") && opts?.method === "PATCH") {
      notificationResolved = true;
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (u.includes("/rest/v1/crm_order_history")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  };

  // Rejection if confirmed_bank_deposit is missing or false
  const reqWithoutCheck = new Request(`https://crm.local/api/orders/${orderId}/validate-payment`, {
    method: "POST",
    headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ confirmed_bank_deposit: false })
  });
  const resWithoutCheck = await handleRequest(reqWithoutCheck, testEnv, mockFetch);
  assert.equal(resWithoutCheck.status, 400);

  // Success with confirmed_bank_deposit = true
  const reqValid = new Request(`https://crm.local/api/orders/${orderId}/validate-payment`, {
    method: "POST",
    headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ confirmed_bank_deposit: true, notes: "Abono verificado en BBVA" })
  });
  const resValid = await handleRequest(reqValid, testEnv, mockFetch);
  assert.equal(resValid.status, 200);
  assert.equal(paymentUpdated, true);
  assert.equal(receiptUpdated, true);
  assert.equal(notificationResolved, true);
});

test("23. Rechazo de pago sin motivo falla (400); con motivo emite notificación de incidencia operativa (200)", async () => {
  const ownerCookie = await makeCookie("owner");
  let incidentCreated = false;

  const orderId = "99999999-9999-4999-8999-999999999999";
  const mockOrder = {
    id: orderId,
    total_cents: 20000,
    payment_method: "transfer",
    payment_status: "pending",
    order_status: "received"
  };

  const mockFetch: typeof fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("/rest/v1/crm_sessions")) {
      const match = u.match(/id=eq\.([^&]+)/);
      const sess = match ? inMemorySessions.get(match[1]) : null;
      return new Response(JSON.stringify(sess ? [sess] : []), { status: 200 });
    }
    if (u.includes("/rest/v1/crm_memberships")) {
      return new Response(
        JSON.stringify([{ business_id: TEST_BUSINESS_ID, role: "owner", active: true }]),
        { status: 200 }
      );
    }
    if (u.includes("/rest/v1/orders")) {
      if (opts?.method === "PATCH") {
        return new Response(JSON.stringify([{ ...mockOrder, payment_status: "rejected" }]), { status: 200 });
      }
      return new Response(JSON.stringify([mockOrder]), { status: 200 });
    }
    if (u.includes("/rest/v1/crm_payment_receipts") || u.includes("/rest/v1/crm_order_history") || u.includes("/rest/v1/crm_notifications")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (u.includes("/rest/v1/rpc/crm_create_notification")) {
      incidentCreated = true;
      return new Response(JSON.stringify({ id: "notif-incident", inserted: true }), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  };

  // Rejection without reason fails with 400
  const reqNoReason = new Request(`https://crm.local/api/orders/${orderId}/reject-payment`, {
    method: "POST",
    headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ rejection_reason: "   " })
  });
  const resNoReason = await handleRequest(reqNoReason, testEnv, mockFetch);
  assert.equal(resNoReason.status, 400);

  // Success with reason
  const reqWithReason = new Request(`https://crm.local/api/orders/${orderId}/reject-payment`, {
    method: "POST",
    headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ rejection_reason: "Monto no coincide con el total del pedido" })
  });
  const resWithReason = await handleRequest(reqWithReason, testEnv, mockFetch);
  assert.equal(resWithReason.status, 200);
  assert.equal(incidentCreated, true);
});

test("24. Subida/asociación de comprobante crea notificación transfer_validation con prioridad alta", async () => {
  const workerCookie = await makeCookie("worker");
  let transferNotificationCreated = false;

  const orderId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const mockReceipt = {
    id: "receipt-123",
    business_id: TEST_BUSINESS_ID,
    order_id: orderId,
    storage_path: `${TEST_BUSINESS_ID}/${orderId}/comprobante.jpg`,
    file_name: "comprobante.jpg",
    status: "pending_validation"
  };

  const mockFetch: typeof fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("/rest/v1/crm_sessions")) {
      const match = u.match(/id=eq\.([^&]+)/);
      const sess = match ? inMemorySessions.get(match[1]) : null;
      return new Response(JSON.stringify(sess ? [sess] : []), { status: 200 });
    }
    if (u.includes("/rest/v1/crm_memberships")) {
      return new Response(
        JSON.stringify([{ business_id: TEST_BUSINESS_ID, role: "worker", active: true }]),
        { status: 200 }
      );
    }
    if (u.includes("/rest/v1/orders")) {
      return new Response(JSON.stringify([{ id: orderId, business_id: TEST_BUSINESS_ID }]), { status: 200 });
    }
    if (u.includes("/rest/v1/crm_payment_receipts") && opts?.method === "POST") {
      return new Response(JSON.stringify([mockReceipt]), { status: 201 });
    }
    if (u.includes("/rest/v1/rpc/crm_create_notification")) {
      transferNotificationCreated = true;
      return new Response(JSON.stringify({ id: "notif-transfer", inserted: true }), { status: 200 });
    }
    if (u.includes("/rest/v1/crm_order_history")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  };

  const req = new Request(`https://crm.local/api/orders/${orderId}/receipt`, {
    method: "POST",
    headers: { Cookie: workerCookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      file_name: "comprobante.jpg",
      storage_path: `${TEST_BUSINESS_ID}/${orderId}/comprobante.jpg`,
      declared_amount_cents: 15000,
      bank_reference: "REF123456"
    })
  });
  const res = await handleRequest(req, testEnv, mockFetch);
  assert.equal(res.status, 201);
  assert.equal(transferNotificationCreated, true);
});

test("25. Ingesta de comprobante: asociación inequívoca a pedido pendiente de transferencia (201)", async () => {
  const workerCookie = await makeCookie("worker");
  const pendingOrder = {
    id: "12121212-1212-4212-8212-121212121212",
    folio: "MB-101",
    customer_ref: "+526221112233",
    conversation_id: "conv-unique-1",
    payment_method: "transfer",
    payment_status: "pending",
    total_cents: 14000
  };

  let insertedReceipt: any = null;
  const mockFetch: typeof fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("/rest/v1/crm_sessions")) {
      const match = u.match(/id=eq\.([^&]+)/);
      const sess = match ? inMemorySessions.get(match[1]) : null;
      return new Response(JSON.stringify(sess ? [sess] : []), { status: 200 });
    }
    if (u.includes("/rest/v1/crm_memberships")) {
      return new Response(
        JSON.stringify([{ business_id: TEST_BUSINESS_ID, role: "worker", active: true }]),
        { status: 200 }
      );
    }
    if (u.includes("/rest/v1/crm_payment_receipts")) {
      if (opts?.method === "POST") {
        insertedReceipt = JSON.parse(String(opts.body));
        return new Response(JSON.stringify([{ id: "rcpt-25", ...insertedReceipt }]), { status: 201 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (u.includes("/rest/v1/orders")) {
      return new Response(JSON.stringify([pendingOrder]), { status: 200 });
    }
    if (u.includes("/rest/v1/rpc/crm_create_notification") || u.includes("/rest/v1/crm_order_history")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  };

  const req = new Request("https://crm.local/api/receipts/ingest", {
    method: "POST",
    headers: { Cookie: workerCookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      conversation_id: "conv-unique-1",
      customer_phone: "+526221112233",
      provider_message_id: "wam-msg-001",
      file_name: "ticket-1.jpg",
      file_size: 250000,
      mime_type: "image/jpeg",
      storage_path: "receipts/ticket-1.jpg"
    })
  });

  const res = await handleRequest(req, testEnv, mockFetch);
  assert.equal(res.status, 201);
  const data = (await res.json()) as any;
  assert.equal(data.ok, true);
  assert.equal(data.duplicate, false);
  assert.equal(data.association_state, "pending_validation");
  assert.equal(insertedReceipt.order_id, pendingOrder.id);
  assert.equal(insertedReceipt.status, "pending_validation");
});

test("26. Ingesta de comprobante sin pedido pendiente queda en pending_association y emite incidencia (201)", async () => {
  const workerCookie = await makeCookie("worker");
  let incidentCreated = false;
  let insertedReceipt: any = null;

  const mockFetch: typeof fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("/rest/v1/crm_sessions")) {
      const match = u.match(/id=eq\.([^&]+)/);
      const sess = match ? inMemorySessions.get(match[1]) : null;
      return new Response(JSON.stringify(sess ? [sess] : []), { status: 200 });
    }
    if (u.includes("/rest/v1/crm_memberships")) {
      return new Response(
        JSON.stringify([{ business_id: TEST_BUSINESS_ID, role: "worker", active: true }]),
        { status: 200 }
      );
    }
    if (u.includes("/rest/v1/orders")) {
      return new Response(JSON.stringify([]), { status: 200 }); // No pending orders
    }
    if (u.includes("/rest/v1/crm_payment_receipts")) {
      if (opts?.method === "POST") {
        insertedReceipt = JSON.parse(String(opts.body));
        return new Response(JSON.stringify([{ id: "rcpt-26", ...insertedReceipt }]), { status: 201 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (u.includes("/rest/v1/rpc/crm_create_notification")) {
      incidentCreated = true;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  };

  const req = new Request("https://crm.local/api/receipts/ingest", {
    method: "POST",
    headers: { Cookie: workerCookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      conversation_id: "conv-unknown",
      customer_phone: "+526229999999",
      file_name: "receipt-unlinked.jpg",
      file_size: 150000,
      mime_type: "image/jpeg",
      storage_path: "receipts/unlinked.jpg"
    })
  });

  const res = await handleRequest(req, testEnv, mockFetch);
  assert.equal(res.status, 201);
  const data = (await res.json()) as any;
  assert.equal(data.association_state, "pending_association");
  assert.equal(insertedReceipt.order_id, null);
  assert.equal(insertedReceipt.status, "pending_association");
  assert.equal(incidentCreated, true);
});

test("27. Ingesta con múltiples pedidos pendientes evita asociación ambigua (pending_association)", async () => {
  const workerCookie = await makeCookie("worker");
  let insertedReceipt: any = null;

  const order1 = { id: "ord-mult-1", conversation_id: "conv-multi", payment_method: "transfer", payment_status: "pending" };
  const order2 = { id: "ord-mult-2", conversation_id: "conv-multi", payment_method: "transfer", payment_status: "pending" };

  const mockFetch: typeof fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("/rest/v1/crm_sessions")) {
      const match = u.match(/id=eq\.([^&]+)/);
      const sess = match ? inMemorySessions.get(match[1]) : null;
      return new Response(JSON.stringify(sess ? [sess] : []), { status: 200 });
    }
    if (u.includes("/rest/v1/crm_memberships")) {
      return new Response(
        JSON.stringify([{ business_id: TEST_BUSINESS_ID, role: "worker", active: true }]),
        { status: 200 }
      );
    }
    if (u.includes("/rest/v1/orders")) {
      return new Response(JSON.stringify([order1, order2]), { status: 200 }); // Multiple matches
    }
    if (u.includes("/rest/v1/crm_payment_receipts") && opts?.method === "POST") {
      insertedReceipt = JSON.parse(String(opts.body));
      return new Response(JSON.stringify([{ id: "rcpt-27", ...insertedReceipt }]), { status: 201 });
    }
    if (u.includes("/rest/v1/rpc/crm_create_notification")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  };

  const req = new Request("https://crm.local/api/receipts/ingest", {
    method: "POST",
    headers: { Cookie: workerCookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      conversation_id: "conv-multi",
      file_name: "receipt-ambiguous.png",
      file_size: 100000,
      mime_type: "image/png",
      storage_path: "receipts/ambig.png"
    })
  });

  const res = await handleRequest(req, testEnv, mockFetch);
  assert.equal(res.status, 201);
  const data = (await res.json()) as any;
  assert.equal(data.association_state, "pending_association");
  assert.equal(insertedReceipt.order_id, null);
  assert.equal(insertedReceipt.metadata.association_issue, "multiple_pending_orders");
});

test("28. Ingesta de imagen duplicada con mismo provider_message_id es idempotente (200, duplicate: true)", async () => {
  const workerCookie = await makeCookie("worker");
  const existingReceipt = {
    id: "existing-rcpt-28",
    business_id: TEST_BUSINESS_ID,
    provider_message_id: "wam-duplicate-123",
    status: "pending_validation"
  };

  const mockFetch: typeof fetch = async (url) => {
    const u = String(url);
    if (u.includes("/rest/v1/crm_sessions")) {
      const match = u.match(/id=eq\.([^&]+)/);
      const sess = match ? inMemorySessions.get(match[1]) : null;
      return new Response(JSON.stringify(sess ? [sess] : []), { status: 200 });
    }
    if (u.includes("/rest/v1/crm_memberships")) {
      return new Response(
        JSON.stringify([{ business_id: TEST_BUSINESS_ID, role: "worker", active: true }]),
        { status: 200 }
      );
    }
    if (u.includes("/rest/v1/crm_payment_receipts")) {
      return new Response(JSON.stringify([existingReceipt]), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  };

  const req = new Request("https://crm.local/api/receipts/ingest", {
    method: "POST",
    headers: { Cookie: workerCookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      provider_message_id: "wam-duplicate-123",
      file_name: "duplicate.jpg",
      file_size: 120000,
      mime_type: "image/jpeg",
      storage_path: "receipts/duplicate.jpg"
    })
  });

  const res = await handleRequest(req, testEnv, mockFetch);
  assert.equal(res.status, 200);
  const data = (await res.json()) as any;
  assert.equal(data.duplicate, true);
  assert.equal(data.receipt.id, existingReceipt.id);
});

test("29. Validación de archivos rechaza MIME no permitido (415) y archivo mayor a 10MB (413)", async () => {
  const workerCookie = await makeCookie("worker");
  const mockFetch: typeof fetch = async (url) => {
    const u = String(url);
    if (u.includes("/rest/v1/crm_sessions")) {
      const match = u.match(/id=eq\.([^&]+)/);
      const sess = match ? inMemorySessions.get(match[1]) : null;
      return new Response(JSON.stringify(sess ? [sess] : []), { status: 200 });
    }
    if (u.includes("/rest/v1/crm_memberships")) {
      return new Response(
        JSON.stringify([{ business_id: TEST_BUSINESS_ID, role: "worker", active: true }]),
        { status: 200 }
      );
    }
    return new Response("Not found", { status: 404 });
  };

  // Reject unsupported mime type (e.g. text/html or exe)
  const reqBadMime = new Request("https://crm.local/api/receipts/ingest", {
    method: "POST",
    headers: { Cookie: workerCookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      file_name: "malicious.html",
      mime_type: "text/html",
      storage_path: "receipts/malicious.html"
    })
  });
  const resBadMime = await handleRequest(reqBadMime, testEnv, mockFetch);
  assert.equal(resBadMime.status, 415);

  // Reject file larger than 10MB
  const reqTooLarge = new Request("https://crm.local/api/receipts/ingest", {
    method: "POST",
    headers: { Cookie: workerCookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      file_name: "huge.jpg",
      mime_type: "image/jpeg",
      file_size: 15 * 1024 * 1024,
      storage_path: "receipts/huge.jpg"
    })
  });
  const resTooLarge = await handleRequest(reqTooLarge, testEnv, mockFetch);
  assert.equal(resTooLarge.status, 413);
});

test("30. Transiciones de estado: valida flujo permitido y rechaza saltos ilegales con HTTP 422", async () => {
  const workerCookie = await makeCookie("worker");
  const orderId = "44444444-4444-4444-8444-444444444444";
  const mockOrder = {
    id: orderId,
    order_status: "received",
    fulfillment: "delivery"
  };

  const mockFetch: typeof fetch = async (url) => {
    const u = String(url);
    if (u.includes("/rest/v1/crm_sessions")) {
      const match = u.match(/id=eq\.([^&]+)/);
      const sess = match ? inMemorySessions.get(match[1]) : null;
      return new Response(JSON.stringify(sess ? [sess] : []), { status: 200 });
    }
    if (u.includes("/rest/v1/crm_memberships")) {
      return new Response(
        JSON.stringify([{ business_id: TEST_BUSINESS_ID, role: "worker", active: true }]),
        { status: 200 }
      );
    }
    if (u.includes("/rest/v1/orders")) {
      return new Response(JSON.stringify([mockOrder]), { status: 200 });
    }
    if (u.includes("/rest/v1/crm_payment_receipts") || u.includes("/rest/v1/crm_order_history") || u.includes("/rest/v1/crm_notifications")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  };

  // Illegal transition: 'received' directly to 'dispatched'
  const reqIllegal = new Request(`https://crm.local/api/orders/${orderId}/status`, {
    method: "PATCH",
    headers: { Cookie: workerCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ order_status: "dispatched" })
  });
  const resIllegal = await handleRequest(reqIllegal, testEnv, mockFetch);
  assert.equal(resIllegal.status, 422);
  const data = (await resIllegal.json()) as any;
  assert.match(data.error, /Transición no permitida/);
});

test("31. Marcar como enviado (POST /api/orders/:id/dispatch): valida delivery y estado listo (200), rechaza pickup (400)", async () => {
  const workerCookie = await makeCookie("worker");
  const deliveryOrderId = "55555555-5555-4555-8555-555555555555";
  const pickupOrderId = "66666666-6666-4666-8666-666666666666";
  const preparingOrderId = "77777777-7777-4777-8777-777777777777";

  const deliveryOrder = { id: deliveryOrderId, order_status: "ready", fulfillment: "delivery", customer_ref: "+526221113333" };
  const pickupOrder = { id: pickupOrderId, order_status: "ready", fulfillment: "pickup", customer_ref: "+526221114444" };
  const preparingOrder = { id: preparingOrderId, order_status: "preparing", fulfillment: "delivery", customer_ref: "+526221115555" };

  let statusPatched = false;
  let historyRecorded = false;

  const mockFetch: typeof fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("/rest/v1/crm_sessions")) {
      const match = u.match(/id=eq\.([^&]+)/);
      const sess = match ? inMemorySessions.get(match[1]) : null;
      return new Response(JSON.stringify(sess ? [sess] : []), { status: 200 });
    }
    if (u.includes("/rest/v1/crm_memberships")) {
      return new Response(
        JSON.stringify([{ business_id: TEST_BUSINESS_ID, role: "worker", active: true }]),
        { status: 200 }
      );
    }
    if (u.includes("/rest/v1/orders")) {
      if (opts?.method === "PATCH") {
        statusPatched = true;
        return new Response(JSON.stringify([{ ...deliveryOrder, order_status: "dispatched" }]), { status: 200 });
      }
      if (u.includes(deliveryOrderId)) return new Response(JSON.stringify([deliveryOrder]), { status: 200 });
      if (u.includes(pickupOrderId)) return new Response(JSON.stringify([pickupOrder]), { status: 200 });
      if (u.includes(preparingOrderId)) return new Response(JSON.stringify([preparingOrder]), { status: 200 });
    }
    if (u.includes("/rest/v1/crm_payment_receipts")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (u.includes("/rest/v1/crm_order_history")) {
      if (opts?.method === "POST") historyRecorded = true;
      return new Response(JSON.stringify([]), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  };

  // Rejection on pickup order
  const reqPickup = new Request(`https://crm.local/api/orders/${pickupOrderId}/dispatch`, {
    method: "POST",
    headers: { Cookie: workerCookie }
  });
  const resPickup = await handleRequest(reqPickup, testEnv, mockFetch);
  assert.equal(resPickup.status, 400);

  const reqPreparing = new Request(`https://crm.local/api/orders/${preparingOrderId}/dispatch`, {
    method: "POST",
    headers: { Cookie: workerCookie }
  });
  const resPreparing = await handleRequest(reqPreparing, testEnv, mockFetch);
  assert.equal(resPreparing.status, 422);
  assert.equal(statusPatched, false);

  // Success on delivery order
  const reqDelivery = new Request(`https://crm.local/api/orders/${deliveryOrderId}/dispatch`, {
    method: "POST",
    headers: { Cookie: workerCookie }
  });
  const resDelivery = await handleRequest(reqDelivery, testEnv, mockFetch);
  assert.equal(resDelivery.status, 200);
  assert.equal(statusPatched, true);
  assert.equal(historyRecorded, true);
  const data = (await resDelivery.json()) as any;
  assert.equal(data.order_status, "dispatched");
  assert.equal(data.notice.sent, false);
});

test("35. Todas las consultas privilegiadas de pedidos limitan el negocio y el estado esperado", async () => {
  const captured: string[] = [];
  const mockFetch: typeof fetch = async (url) => {
    captured.push(String(url));
    return new Response(JSON.stringify([]), { status: 200 });
  };

  await getOrders({}, {
    supabaseUrl: TEST_SUPABASE_URL,
    publishableKey: mockPubKey,
    serviceKey: mockServiceKey,
    businessId: TEST_BUSINESS_ID
  }, mockFetch);
  await getOrderDetails("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", {
    supabaseUrl: TEST_SUPABASE_URL,
    publishableKey: mockPubKey,
    serviceKey: mockServiceKey,
    businessId: TEST_BUSINESS_ID
  }, mockFetch);
  await updateOrderStatus("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "dispatched", {
    supabaseUrl: TEST_SUPABASE_URL,
    publishableKey: mockPubKey,
    serviceKey: mockServiceKey,
    businessId: TEST_BUSINESS_ID
  }, mockFetch, "ready");

  assert.equal(captured.length, 3);
  for (const requestUrl of captured) {
    assert.ok(requestUrl.includes(`business_id=eq.${TEST_BUSINESS_ID}`), requestUrl);
  }
  assert.ok(captured[2].includes("order_status=eq.ready"), captured[2]);
});

test("32. Búsqueda de pedidos por folio y teléfono (GET /api/orders?q=...)", async () => {
  const workerCookie = await makeCookie("worker");
  const ordersList = [
    { id: "77777777-7777-4777-8777-777777777777", folio: "MB-101", customer_ref: "+526221002000", order_status: "confirmed" },
    { id: "88888888-8888-4888-8888-888888888888", folio: "MB-202", customer_ref: "+526223004000", order_status: "ready" }
  ];

  const mockFetch: typeof fetch = async (url) => {
    const u = String(url);
    if (u.includes("/rest/v1/crm_sessions")) {
      const match = u.match(/id=eq\.([^&]+)/);
      const sess = match ? inMemorySessions.get(match[1]) : null;
      return new Response(JSON.stringify(sess ? [sess] : []), { status: 200 });
    }
    if (u.includes("/rest/v1/crm_memberships")) {
      return new Response(
        JSON.stringify([{ business_id: TEST_BUSINESS_ID, role: "worker", active: true }]),
        { status: 200 }
      );
    }
    if (u.includes("/rest/v1/orders")) {
      return new Response(JSON.stringify(ordersList), { status: 200 });
    }
    if (u.includes("/rest/v1/crm_payment_receipts")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  };

  // Search by folio "MB-101"
  const reqSearchFolio = new Request("https://crm.local/api/orders?q=MB-101", {
    method: "GET",
    headers: { Cookie: workerCookie }
  });
  const resSearchFolio = await handleRequest(reqSearchFolio, testEnv, mockFetch);
  assert.equal(resSearchFolio.status, 200);
  const dataFolio = (await resSearchFolio.json()) as any;
  assert.equal(dataFolio.orders.length, 1);
  assert.equal(dataFolio.orders[0].folio, "MB-101");

  // Search by phone "3004000"
  const reqSearchPhone = new Request("https://crm.local/api/orders?q=3004000", {
    method: "GET",
    headers: { Cookie: workerCookie }
  });
  const resSearchPhone = await handleRequest(reqSearchPhone, testEnv, mockFetch);
  assert.equal(resSearchPhone.status, 200);
  const dataPhone = (await resSearchPhone.json()) as any;
  assert.equal(dataPhone.orders.length, 1);
  assert.equal(dataPhone.orders[0].folio, "MB-202");
});

test("33. Continuidad de sesión (P0): SameSite=Lax, sliding TTL en refresh y fallback privilegiado en membresía cuando el JWT rota", async () => {
  const { sessionId, session } = makeDbSession("owner");
  // Simulate access_token about to expire (< 60s) and ttl only 4 minutes away
  session.expires_at = new Date(Date.now() + 10_000).toISOString();
  const oldTtlMs = Date.now() + 4 * 60_000;
  session.ttl = new Date(oldTtlMs).toISOString();

  const cookieVal = await createSessionCookieValue(sessionId, mockSecret);
  const ownerCookie = `crm_remote_session=${cookieVal}`;

  let patchedSessionBody: any = null;
  let userTokenMembershipAttempted = false;
  let privilegedMembershipAttempted = false;

  const mockFetch: typeof fetch = async (url, init) => {
    const u = String(url);
    const method = init?.method || "GET";
    const headers = (init?.headers || {}) as Record<string, string>;

    if (u.includes("/rest/v1/crm_sessions") && method === "GET") {
      return new Response(JSON.stringify([session]), { status: 200 });
    }
    if (u.includes("/auth/v1/token") && u.includes("grant_type=refresh_token")) {
      return new Response(
        JSON.stringify({
          access_token: ["rot", "jwt"].join("-"),
          refresh_token: ["rot", "ref"].join("-"),
          expires_in: 3600
        }),
        { status: 200 }
      );
    }
    if (u.includes("/rest/v1/crm_sessions") && method === "PATCH") {
      patchedSessionBody = JSON.parse(String(init?.body || "{}"));
      return new Response(JSON.stringify([session]), { status: 200 });
    }
    if (u.includes("/rest/v1/crm_memberships")) {
      if (headers["apikey"] === mockPubKey) {
        userTokenMembershipAttempted = true;
        // Simulate PostgREST rejecting rotated user JWT with 401
        return new Response(JSON.stringify({ message: "JWT expired" }), { status: 401 });
      }
      if (headers["apikey"] === mockServiceKey) {
        privilegedMembershipAttempted = true;
        return new Response(
          JSON.stringify([{ business_id: TEST_BUSINESS_ID, role: "owner", active: true, can_validate_transfers: true }]),
          { status: 200 }
        );
      }
    }
    return new Response("Not found", { status: 404 });
  };

  const req = new Request("https://crm.local/api/me", {
    method: "GET",
    headers: { Cookie: ownerCookie }
  });
  const res = await handleRequest(req, testEnv, mockFetch);
  assert.equal(res.status, 200);
  const me = (await res.json()) as any;
  assert.equal(me.role, "owner");
  assert.equal(userTokenMembershipAttempted, true);
  assert.equal(privilegedMembershipAttempted, true);
  assert.ok(patchedSessionBody?.ttl, "Debe extender sliding TTL al refrescar tokens");
  assert.ok(new Date(patchedSessionBody.ttl).getTime() > oldTtlMs + 3600_000);
});

test("34. Enlace Atender en Inbox (P1): propaga conversation_id autorizado al embed y bloquea conversaciones ajenas en Worker", async () => {
  const ownerCookie = await makeCookie("owner");
  const workerCookie = await makeCookie("worker");
  const envApproved = { ...testEnv, KAPSO_WORKER_EMBED_APPROVED: "true" };

  const mockFetch: typeof fetch = async (url) => {
    const u = String(url);
    if (u.includes("/rest/v1/crm_sessions")) {
      const match = u.match(/id=eq\.([^&]+)/);
      const sess = match ? inMemorySessions.get(match[1]) : null;
      return new Response(JSON.stringify(sess ? [sess] : []), { status: 200 });
    }
    if (u.includes("/rest/v1/crm_memberships")) {
      const isWorker = u.includes("user-worker-id");
      return new Response(
        JSON.stringify([
          {
            business_id: TEST_BUSINESS_ID,
            role: isWorker ? "worker" : "owner",
            active: true,
            kapso_assignee_id: isWorker ? "assignee-worker-1" : null
          }
        ]),
        { status: 200 }
      );
    }
    if (u.includes("/rest/v1/crm_handoffs")) {
      if (u.includes("conv-other-agent")) {
        return new Response(
          JSON.stringify([
            {
              provider_conversation_id: "conv-other-agent",
              reason: "customer_request",
              state: "pending",
              assigned_user_id: "other-agent-999"
            }
          ]),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify([
          {
            provider_conversation_id: "7d73c107-795f-4856-8285-934721f21c1e",
            reason: "customer_request",
            state: "pending",
            assigned_user_id: "assignee-worker-1"
          }
        ]),
        { status: 200 }
      );
    }
    return new Response("Not found", { status: 404 });
  };

  // Owner opens notification target conversation
  const reqOwner = new Request("https://crm.local/api/handoff?conversation_id=7d73c107-795f-4856-8285-934721f21c1e", {
    method: "GET",
    headers: { Cookie: ownerCookie }
  });
  const resOwner = await handleRequest(reqOwner, envApproved, mockFetch);
  assert.equal(resOwner.status, 200);
  const dataOwner = (await resOwner.json()) as any;
  assert.equal(dataOwner.status, "ready");
  assert.ok(dataOwner.embed_url.includes("conversation_id=7d73c107-795f-4856-8285-934721f21c1e"));
  assert.equal(dataOwner.target_conversation?.found, true);
  assert.equal(dataOwner.target_conversation?.authorized, true);

  // Worker tries to focus conversation assigned to another agent
  const reqWorkerOther = new Request("https://crm.local/api/handoff?conversation_id=conv-other-agent", {
    method: "GET",
    headers: { Cookie: workerCookie }
  });
  const resWorkerOther = await handleRequest(reqWorkerOther, envApproved, mockFetch);
  assert.equal(resWorkerOther.status, 200);
  const dataWorkerOther = (await resWorkerOther.json()) as any;
  assert.equal(dataWorkerOther.target_conversation?.authorized, false);
  assert.ok(!dataWorkerOther.embed_url.includes("conv-other-agent"));
});

test("36. E2E-07 Comprobantes (P1): descarga segura desde media_url / file_base64, subida a Storage privado payment-receipts y bloqueo SSRF", async () => {
  const ownerCookie = await makeCookie("owner");
  const pendingOrderId = "84aa45e1-5b85-4a83-81df-12ae18606494";
  let storageUploadUrl = "";
  let storageUploadedBytes = 0;

  const mockFetch: typeof fetch = async (url, init) => {
    const u = String(url);
    const method = init?.method || "GET";

    if (u.includes("/rest/v1/crm_sessions")) {
      const match = u.match(/id=eq\.([^&]+)/);
      const sess = match ? inMemorySessions.get(match[1]) : null;
      return new Response(JSON.stringify(sess ? [sess] : []), { status: 200 });
    }
    if (u.includes("/rest/v1/crm_memberships")) {
      return new Response(
        JSON.stringify([{ business_id: TEST_BUSINESS_ID, role: "owner", active: true, can_validate_transfers: true }]),
        { status: 200 }
      );
    }
    if (u.startsWith("https://api.kapso.ai/media/comprobante-123.png")) {
      const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
      return new Response(pngBytes, {
        status: 200,
        headers: { "Content-Type": "image/png", "Content-Length": String(pngBytes.byteLength) }
      });
    }
    if (u.includes("/storage/v1/object/payment-receipts/") && method === "POST") {
      storageUploadUrl = u;
      const bodyBytes = init?.body as Uint8Array;
      storageUploadedBytes = bodyBytes?.byteLength || 0;
      return new Response(JSON.stringify({ Key: "payment-receipts/ok" }), { status: 200 });
    }
    if (u.includes("/rest/v1/crm_payment_receipts") && method === "GET") {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (u.includes("/rest/v1/orders") && method === "GET") {
      return new Response(
        JSON.stringify([
          {
            id: pendingOrderId,
            folio: "MB-84AA45",
            customer_ref: "qa-customer",
            conversation_id: "conv-transfer-1",
            payment_method: "transfer",
            payment_status: "pending",
            total_cents: 27000
          }
        ]),
        { status: 200 }
      );
    }
    if (u.includes("/rest/v1/crm_payment_receipts") && method === "POST") {
      const body = JSON.parse(String(init?.body || "{}"));
      return new Response(
        JSON.stringify([{ id: "rec-e2e07-1", ...body }]),
        { status: 201 }
      );
    }
    if (u.includes("/rest/v1/rpc/crm_create_notification") || u.includes("/rest/v1/crm_order_history")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  };

  // 1. Ingest via media_url -> downloads from Kapso -> uploads to private Storage -> associates with MB-84AA45
  const reqIngestMedia = new Request("https://crm.local/api/receipts/ingest", {
    method: "POST",
    headers: { Cookie: ownerCookie, "Content-Type": "application/json", Origin: "https://crm.local" },
    body: JSON.stringify({
      conversation_id: "conv-transfer-1",
      provider_message_id: "wamid.media.001",
      file_name: "spei_abono.png",
      mime_type: "image/png",
      media_url: "https://api.kapso.ai/media/comprobante-123.png",
      declared_amount_cents: 27000,
      bank_reference: "SPEI-998877"
    })
  });
  const resIngestMedia = await handleRequest(reqIngestMedia, testEnv, mockFetch);
  assert.equal(resIngestMedia.status, 201);
  const dataMedia = (await resIngestMedia.json()) as any;
  assert.equal(dataMedia.association_state, "pending_validation");
  assert.equal(dataMedia.receipt.order_id, pendingOrderId);
  assert.ok(storageUploadUrl.includes(`/storage/v1/object/payment-receipts/${TEST_BUSINESS_ID}/receipts/`));
  assert.equal(storageUploadedBytes, 8);

  // 2. Reject SSRF media_url pointing to localhost/private IP
  const reqSsrf = new Request("https://crm.local/api/receipts/ingest", {
    method: "POST",
    headers: { Cookie: ownerCookie, "Content-Type": "application/json", Origin: "https://crm.local" },
    body: JSON.stringify({
      file_name: "ssrf.png",
      mime_type: "image/png",
      media_url: "https://127.0.0.1/secret.png"
    })
  });
  const resSsrf = await handleRequest(reqSsrf, testEnv, mockFetch);
  assert.equal(resSsrf.status, 400);
});

test("37. UI Frontend Bundle (P0/P1): login-panel oculto al inicio, pre-carga de pedidos y botones de aprobar/rechazar transferencia", async () => {
  const resHtml = await handleRequest(new Request("https://crm.local/"), testEnv);
  assert.equal(resHtml.status, 200);
  const html = await resHtml.text();
  assert.ok(html.includes('id="session-loading"'), "Debe mostrar indicador de verificación de sesión al cargar");
  assert.ok(html.includes('id="login-panel" class="card" hidden'), "El panel de login debe iniciar oculto hasta confirmar 401");
  assert.ok(html.includes('id="session-expired-notice"'), "Debe existir aviso explícito de expiración de sesión");
  assert.ok(html.includes('id="handoff-target-banner"'), "Debe existir banner de conversación objetivo en Inbox");
  assert.ok(html.includes('id="orders-search" type="search" autocomplete="off"'), "Búsqueda de pedidos sin autofill de navegador");

  const resJs = await handleRequest(new Request("https://crm.local/remote-app.js"), testEnv);
  assert.equal(resJs.status, 200);
  const js = await resJs.text();
  assert.ok(js.includes("Aprobar / Validar Pago"), "Debe mostrar botón explícito para aprobar/validar pago por transferencia");
  assert.ok(js.includes("Rechazar Pago"), "Debe mostrar botón explícito para rechazar pago por transferencia");
});

test("38. Idempotencia y concurrencia en despacho a cocina (POST /api/orders/:id/dispatch): peticiones paralelas generan exactamente 1 transición", async () => {
  const workerCookie = await makeCookie("worker");
  const orderId = "88888888-8888-4888-8888-888888888888";
  let currentStatus = "ready";
  let historyInserts = 0;

  const mockFetch: typeof fetch = async (url, init) => {
    const u = String(url);
    const method = init?.method || "GET";

    if (u.includes("/rest/v1/crm_sessions")) {
      const match = u.match(/id=eq\.([^&]+)/);
      const sess = match ? inMemorySessions.get(match[1]) : null;
      return new Response(JSON.stringify(sess ? [sess] : []), { status: 200 });
    }
    if (u.includes("/rest/v1/crm_memberships")) {
      return new Response(JSON.stringify([{ business_id: TEST_BUSINESS_ID, role: "worker", active: true }]), { status: 200 });
    }
    if (u.includes("/rest/v1/orders")) {
      if (method === "GET") {
        return new Response(JSON.stringify([{
          id: orderId,
          order_status: currentStatus,
          fulfillment: "delivery",
          customer_ref: "+526621234567"
        }]), { status: 200 });
      }
      if (method === "PATCH") {
        if (currentStatus === "ready") {
          currentStatus = "dispatched";
          return new Response(JSON.stringify([{
            id: orderId,
            order_status: "dispatched",
            fulfillment: "delivery"
          }]), { status: 200 });
        } else {
          // Status was already changed concurrently
          return new Response(JSON.stringify([]), { status: 200 });
        }
      }
    }
    if (u.includes("/rest/v1/crm_order_history") && method === "POST") {
      historyInserts++;
      return new Response(JSON.stringify({ ok: true }), { status: 201 });
    }
    if (u.includes("/rest/v1/crm_payment_receipts")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  };

  // Run 5 parallel dispatch calls simultaneously
  const requests = Array.from({ length: 5 }, () =>
    handleRequest(
      new Request(`https://crm.local/api/orders/${orderId}/dispatch`, {
        method: "POST",
        headers: { Cookie: workerCookie, Origin: "https://crm.local" }
      }),
      testEnv,
      mockFetch
    )
  );

  const responses = await Promise.all(requests);
  for (const res of responses) {
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.ok, true);
    assert.equal(body.order_status, "dispatched");
  }

  // Exactly 1 history audit record created despite 5 concurrent calls
  assert.equal(historyInserts, 1);
  assert.equal(currentStatus, "dispatched");
});

test("39. Reintentos de actualización de estado (PATCH /api/orders/:id/status): si ya está en nuevo estado, es idempotente", async () => {
  const workerCookie = await makeCookie("worker");
  const orderId = "99999999-9999-4999-8999-999999999999";
  let notificationCount = 0;

  const mockFetch: typeof fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/rest/v1/crm_sessions")) {
      const match = u.match(/id=eq\.([^&]+)/);
      const sess = match ? inMemorySessions.get(match[1]) : null;
      return new Response(JSON.stringify(sess ? [sess] : []), { status: 200 });
    }
    if (u.includes("/rest/v1/crm_memberships")) {
      return new Response(JSON.stringify([{ business_id: TEST_BUSINESS_ID, role: "worker", active: true }]), { status: 200 });
    }
    if (u.includes("/rest/v1/orders")) {
      // Order is already in 'confirmed' status
      return new Response(JSON.stringify([{
        id: orderId,
        order_status: "confirmed",
        fulfillment: "pickup",
        total_cents: 15000
      }]), { status: 200 });
    }
    if (u.includes("/rest/v1/rpc/crm_create_notification")) {
      notificationCount++;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (u.includes("/rest/v1/crm_order_history") || u.includes("/rest/v1/crm_payment_receipts")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  };

  const req = new Request(`https://crm.local/api/orders/${orderId}/status`, {
    method: "PATCH",
    headers: { Cookie: workerCookie, "Content-Type": "application/json", Origin: "https://crm.local" },
    body: JSON.stringify({ order_status: "confirmed" })
  });
  const res = await handleRequest(req, testEnv, mockFetch);
  assert.equal(res.status, 200);
  const data = (await res.json()) as any;
  assert.equal(data.ok, true);
  assert.equal(data.duplicate, true);
  // Zero duplicate notifications created
  assert.equal(notificationCount, 0);
});

test("40. Rutas Inbox: GET /api/inbox-embed y GET /api/handoff comparten autenticación, lógica y soporte de target_conversation_id", async () => {
  const ownerCookie = await makeCookie("owner");

  const mockFetch: typeof fetch = async (url) => {
    const u = String(url);
    if (u.includes("/rest/v1/crm_sessions")) {
      const match = u.match(/id=eq\.([^&]+)/);
      const sess = match ? inMemorySessions.get(match[1]) : null;
      return new Response(JSON.stringify(sess ? [sess] : []), { status: 200 });
    }
    if (u.includes("/rest/v1/crm_memberships")) {
      return new Response(JSON.stringify([{ business_id: TEST_BUSINESS_ID, role: "owner", active: true }]), { status: 200 });
    }
    if (u.includes("/rest/v1/crm_handoffs")) {
      return new Response(JSON.stringify([{
        conversation_id: "7d73c107-795f-4856-8285-934721f21c1e",
        assigned_user_id: "assignee-worker-1",
        state: "assigned",
        reason: "Consulta cliente"
      }]), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  };

  // 1. Sin sesión: ambos endpoints deben devolver 401 (NUNCA 404 "Ruta no encontrada")
  const unauthInbox = await handleRequest(
    new Request("https://crm.local/api/inbox-embed", { method: "GET" }),
    testEnv,
    mockFetch
  );
  assert.equal(unauthInbox.status, 401, "/api/inbox-embed sin sesión debe responder 401");

  const unauthHandoff = await handleRequest(
    new Request("https://crm.local/api/handoff", { method: "GET" }),
    testEnv,
    mockFetch
  );
  assert.equal(unauthHandoff.status, 401, "/api/handoff sin sesión debe responder 401");

  // 2. Owner autenticado: GET /api/inbox-embed
  const authInboxRes = await handleRequest(
    new Request("https://crm.local/api/inbox-embed", { method: "GET", headers: { Cookie: ownerCookie } }),
    testEnv,
    mockFetch
  );
  assert.equal(authInboxRes.status, 200);
  const inboxData = (await authInboxRes.json()) as any;
  assert.equal(inboxData.status, "ready");
  assert.equal(inboxData.embed_url, "https://inbox.kapso.ai/embed/owner-mock-token");

  // 3. Compatibilidad: GET /api/handoff
  const authHandoffRes = await handleRequest(
    new Request("https://crm.local/api/handoff", { method: "GET", headers: { Cookie: ownerCookie } }),
    testEnv,
    mockFetch
  );
  assert.equal(authHandoffRes.status, 200);
  const handoffData = (await authHandoffRes.json()) as any;
  assert.deepEqual(inboxData, handoffData, "Ambas rutas deben retornar la misma respuesta exacta");

  // 4. Parámetro target_conversation_id en /api/inbox-embed
  const targetId = "7d73c107-795f-4856-8285-934721f21c1e";
  const targetInboxRes = await handleRequest(
    new Request(`https://crm.local/api/inbox-embed?target_conversation_id=${targetId}`, {
      method: "GET",
      headers: { Cookie: ownerCookie }
    }),
    testEnv,
    mockFetch
  );
  assert.equal(targetInboxRes.status, 200);
  const targetInboxData = (await targetInboxRes.json()) as any;
  assert.equal(targetInboxData.target_conversation?.id, targetId);
  assert.equal(targetInboxData.target_conversation?.authorized, true);

  // Parámetro conversation_id en /api/handoff debe ser equivalente
  const convHandoffRes = await handleRequest(
    new Request(`https://crm.local/api/handoff?conversation_id=${targetId}`, {
      method: "GET",
      headers: { Cookie: ownerCookie }
    }),
    testEnv,
    mockFetch
  );
  assert.equal(convHandoffRes.status, 200);
  const convHandoffData = (await convHandoffRes.json()) as any;
  assert.deepEqual(targetInboxData, convHandoffData, "target_conversation_id y conversation_id deben procesarse idénticamente");

  // 5. Validación de formato de conversación inválida
  const invalidRes = await handleRequest(
    new Request("https://crm.local/api/inbox-embed?target_conversation_id=invalid<script>", {
      method: "GET",
      headers: { Cookie: ownerCookie }
    }),
    testEnv,
    mockFetch
  );
  assert.equal(invalidRes.status, 400);
  const invalidData = (await invalidRes.json()) as any;
  assert.equal(invalidData.error, "Identificador de conversación inválido");
});

test("41. Aislamiento Worker en Inbox: GET /api/inbox-embed respeta aprobación pendiente y autorización de conversaciones", async () => {
  const workerCookie = await makeCookie("worker");

  const mockFetch: typeof fetch = async (url) => {
    const u = String(url);
    if (u.includes("/rest/v1/crm_sessions")) {
      const match = u.match(/id=eq\.([^&]+)/);
      const sess = match ? inMemorySessions.get(match[1]) : null;
      return new Response(JSON.stringify(sess ? [sess] : []), { status: 200 });
    }
    if (u.includes("/rest/v1/crm_memberships")) {
      return new Response(JSON.stringify([{
        business_id: TEST_BUSINESS_ID,
        role: "worker",
        active: true,
        kapso_assignee_id: "assignee-worker-1"
      }]), { status: 200 });
    }
    if (u.includes("/rest/v1/crm_handoffs")) {
      if (u.includes("conv-other-agent")) {
        return new Response(JSON.stringify([{
          conversation_id: "conv-other-agent",
          assigned_user_id: "assignee-different-person",
          state: "assigned",
          reason: "Caso asignado a otro agente"
        }]), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  };

  // 1. Worker con KAPSO_WORKER_EMBED_APPROVED = "false" -> pending_integration, nunca URL de owner
  const unapprovedRes = await handleRequest(
    new Request("https://crm.local/api/inbox-embed", { method: "GET", headers: { Cookie: workerCookie } }),
    testEnv,
    mockFetch
  );
  assert.equal(unapprovedRes.status, 200);
  const unapprovedData = (await unapprovedRes.json()) as any;
  assert.equal(unapprovedData.status, "pending_integration");
  assert.equal(unapprovedData.embed_url, undefined);

  // 2. Worker intentando acceder a conversación de otro agente -> authorized: false
  const otherAgentRes = await handleRequest(
    new Request("https://crm.local/api/inbox-embed?target_conversation_id=conv-other-agent", {
      method: "GET",
      headers: { Cookie: workerCookie }
    }),
    testEnv,
    mockFetch
  );
  assert.equal(otherAgentRes.status, 200);
  const otherData = (await otherAgentRes.json()) as any;
  assert.equal(otherData.target_conversation?.authorized, false);
  assert.equal(otherData.target_conversation?.message, "Esta conversación está asignada a otro agente.");

  // 3. Worker con aprobación activada (approvedEnv) -> recibe URL de worker con filtros, nunca token owner
  const approvedEnv: Env = {
    ...testEnv,
    KAPSO_WORKER_EMBED_APPROVED: "true"
  };
  const approvedRes = await handleRequest(
    new Request("https://crm.local/api/inbox-embed", { method: "GET", headers: { Cookie: workerCookie } }),
    approvedEnv,
    mockFetch
  );
  assert.equal(approvedRes.status, 200);
  const approvedData = (await approvedRes.json()) as any;
  assert.equal(approvedData.status, "ready");
  assert.ok(approvedData.embed_url.includes("worker-mock-token"));
  assert.ok(!approvedData.embed_url.includes("owner-mock-token"));
});

test("42. Assets estáticos del menú: GET /menu/... sirve recurso o 404 controlado", async () => {
  const reqImg1 = new Request("https://crm.local/menu/mr-burger-hamburguesas-boneless-complementos.png", { method: "GET" });
  const resImg1 = await handleRequest(reqImg1, testEnv);
  // If not bundled with binary data, returns 404; if bundled, returns 200 image/png
  assert.ok([200, 404].includes(resImg1.status));
  if (resImg1.status === 200) {
    assert.equal(resImg1.headers.get("Content-Type"), "image/png");
    assert.ok(resImg1.headers.get("Cache-Control")?.includes("public"));
  }
});

test("43. Envío de imágenes del menú: POST /api/menu/send-image rechaza sin autenticación (401)", async () => {
  const req = new Request("https://crm.local/api/menu/send-image", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ category: "all", customer_phone: "+526623492970" })
  });
  const res = await handleRequest(req, testEnv);
  assert.equal(res.status, 401);
  const data = (await res.json()) as any;
  assert.equal(data.error, "Autenticación requerida para enviar imágenes del menú");
});

test("44. Envío de imágenes del menú: categoría 'all' envía ambas páginas en orden y resuelve teléfono de conversación", async () => {
  const sentPayloads: any[] = [];
  const mockFetch: typeof fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("/rest/v1/crm_inbound_events")) {
      return new Response(JSON.stringify([{ customer_phone: "+526621234567" }]), { status: 200 });
    }
    if (u.includes("api.kapso.ai/meta/whatsapp")) {
      const parsedBody = JSON.parse(String(opts?.body || "{}"));
      sentPayloads.push(parsedBody);
      return new Response(JSON.stringify({
        messaging_product: "whatsapp",
        messages: [{ id: `wamid.mock_${sentPayloads.length}` }]
      }), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  };

  const req = new Request("https://crm.local/api/menu/send-image", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": "mock-kapso-api-key"
    },
    body: JSON.stringify({
      category: "all",
      conversation_id: "conv-12345"
    })
  });

  const res = await handleRequest(req, testEnv, mockFetch);
  assert.equal(res.status, 200);
  const data = (await res.json()) as any;
  assert.equal(data.ok, true);
  assert.deepEqual(data.sent, ["page_1", "page_2"]);
  assert.equal(data.reply_text, "Claro, aquí está el menú 🍔");
  assert.equal(sentPayloads.length, 2);
  assert.equal(sentPayloads[0].to, "526621234567");
  assert.ok(sentPayloads[0].image.link.includes("mr-burger-hamburguesas-boneless-complementos.png"));
  assert.ok(sentPayloads[1].image.link.includes("mr-burger-bebidas-extras-postres.png"));
});

test("45. Envío de imágenes del menú: categorías específicas envían solo la página solicitada", async () => {
  const sentPayloads: any[] = [];
  const mockFetch: typeof fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("api.kapso.ai/meta/whatsapp")) {
      const parsedBody = JSON.parse(String(opts?.body || "{}"));
      sentPayloads.push(parsedBody);
      return new Response(JSON.stringify({
        messaging_product: "whatsapp",
        messages: [{ id: `wamid.mock_${sentPayloads.length}` }]
      }), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  };

  // Solicitar sólo hamburguesas
  const reqBurger = new Request("https://crm.local/api/menu/send-image", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": "mock-kapso-api-key"
    },
    body: JSON.stringify({
      category: "hamburguesas",
      customer_phone: "+526621112233"
    })
  });
  const resBurger = await handleRequest(reqBurger, testEnv, mockFetch);
  assert.equal(resBurger.status, 200);
  const dataBurger = (await resBurger.json()) as any;
  assert.equal(dataBurger.ok, true);
  assert.deepEqual(dataBurger.sent, ["page_1"]);
  assert.equal(sentPayloads.length, 1);
  assert.ok(sentPayloads[0].image.link.includes("mr-burger-hamburguesas-boneless-complementos.png"));

  // Solicitar sólo bebidas
  const reqDrink = new Request("https://crm.local/api/menu/send-image", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": "mock-kapso-api-key"
    },
    body: JSON.stringify({
      category: "bebidas",
      customer_phone: "+526621112233"
    })
  });
  const resDrink = await handleRequest(reqDrink, testEnv, mockFetch);
  assert.equal(resDrink.status, 200);
  const dataDrink = (await resDrink.json()) as any;
  assert.equal(dataDrink.ok, true);
  assert.deepEqual(dataDrink.sent, ["page_2"]);
  assert.equal(sentPayloads.length, 2);
  assert.ok(sentPayloads[1].image.link.includes("mr-burger-bebidas-extras-postres.png"));
});

test("46. Envío de imágenes del menú: fallo en API externa interrumpe envío y reporta error con precisión", async () => {
  const mockFetch: typeof fetch = async (url) => {
    const u = String(url);
    if (u.includes("api.kapso.ai/meta/whatsapp")) {
      return new Response(JSON.stringify({
        error: { message: "Re-engagement message: 24h window closed", code: 131047 }
      }), { status: 400 });
    }
    return new Response("Not found", { status: 404 });
  };

  const req = new Request("https://crm.local/api/menu/send-image", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": "mock-kapso-api-key"
    },
    body: JSON.stringify({
      category: "all",
      customer_phone: "+526629998877"
    })
  });

  const res = await handleRequest(req, testEnv, mockFetch);
  assert.equal(res.status, 400);
  const data = (await res.json()) as any;
  assert.equal(data.ok, false);
  assert.deepEqual(data.sent, []);
  assert.deepEqual(data.failed, ["page_1"]);
  assert.ok(data.error.includes("24h window closed"));
});
