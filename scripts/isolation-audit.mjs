import { readFileSync } from "node:fs";

let env = {};
try {
  const envFile = readFileSync(".env.local", "utf8");
  for (const line of envFile.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, "");
  }
} catch {}
try {
  const cfEnv = readFileSync("cloudflare/crm-app/.env.local", "utf8");
  for (const line of cfEnv.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !env[m[1]]) env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, "");
  }
} catch {}

const CRM_URL = "https://crm-kapso-app.solidbit-whatsapp-agent.workers.dev";
const SUPABASE_URL = env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const KAPSO_API_KEY = env.KAPSO_API_KEY;

const WORKER_EMAIL = env.WORKER_EMAIL;
const WORKER_PASS = env.WORKER_PASSWORD;

function getCookie(res) {
  const setCookies = typeof res.headers.getSetCookie === "function"
    ? res.headers.getSetCookie()
    : [res.headers.get("set-cookie") || ""];
  const raw = setCookies.find(c => c && c.startsWith("crm_remote_session=")) || setCookies[0] || "";
  return raw.split(";")[0];
}

async function runIsolationAudit() {
  console.log("=== SOLIDBIT CRM KAPSO — PREP-KAPSO-012 ISOLATION AUDIT ===");
  const results = [];

  // Helper for logging
  function assert(name, condition, details = "") {
    if (condition) {
      console.log(`[PASS] ${name} ${details ? "- " + details : ""}`);
      results.push({ name, status: "PASS", details });
    } else {
      console.error(`[FAIL] ${name} ${details ? "- " + details : ""}`);
      results.push({ name, status: "FAIL", details });
    }
  }

  // 1. Worker login
  const loginRes = await fetch(`${CRM_URL}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: WORKER_EMAIL, password: WORKER_PASS })
  });
  assert("1. Worker Login HTTP 200", loginRes.status === 200, `Status: ${loginRes.status}`);
  const cookieHeader = getCookie(loginRes);
  assert("1b. Worker Session Cookie Issued", !!cookieHeader);

  const workerHeaders = { Cookie: cookieHeader };

  // 2. /api/me check
  const meRes = await fetch(`${CRM_URL}/api/me`, { headers: workerHeaders });
  const meData = await meRes.json();
  assert("2. Worker /api/me role is worker", meRes.status === 200 && meData.role === "worker", `Role: ${meData.role}`);

  // 3. Admin endpoints RBAC 403 checks
  const adminEndpoints = [
    "/api/inventory",
    "/api/alerts",
    "/api/orders",
    "/api/drafts",
    "/api/menu",
    "/api/movements"
  ];
  for (const ep of adminEndpoints) {
    const r = await fetch(`${CRM_URL}${ep}`, { headers: workerHeaders });
    assert(`3. RBAC 403 on ${ep}`, r.status === 403, `Status: ${r.status}`);
  }

  // 4. Worker /api/handoff restricted inbox
  const handoffRes = await fetch(`${CRM_URL}/api/handoff`, { headers: workerHeaders });
  const handoffData = await handoffRes.json();
  assert("4a. Worker /api/handoff HTTP 200", handoffRes.status === 200);
  assert("4b. Worker receives ready status", handoffData.status === "ready");
  const embedUrl = handoffData.embed_url || "";
  assert("4c. Worker URL contains handoff=1", embedUrl.includes("handoff=1"));
  assert("4d. Worker URL contains status=active", embedUrl.includes("status=active"));
  
  // Check that Worker receives Worker embed URL and NEVER Owner embed URL
  const ownerEmbedBase = env.KAPSO_OWNER_EMBED_URL;
  const workerEmbedBase = env.KAPSO_WORKER_EMBED_URL;
  assert("4e. Worker URL does NOT match Owner Embed URL", !embedUrl.startsWith(ownerEmbedBase));
  assert("4f. Worker URL matches Worker Embed URL", embedUrl.startsWith(workerEmbedBase));

  // 5. Server-side token scope on Kapso Platform API
  const workerEmbedId = "6cc14fb8-05cd-4f86-ad65-dfff50a2f2f5";
  const tokenRes = await fetch(`https://api.kapso.ai/platform/v1/inbox_embeds/${workerEmbedId}`, {
    headers: { "X-API-Key": KAPSO_API_KEY, Accept: "application/json" }
  });
  const tokenData = await tokenRes.json();
  const embed = tokenData.data || {};
  assert("5a. Worker Token Active in Kapso", embed.status === "active");
  assert("5b. Worker Token has assigned_user_id restriction", embed.assigned_user_id === "6ef337c0-c724-4cd4-85ae-0c6068495840");
  assert("5c. Worker Token scope is sandbox phone_number", embed.scope_id === "597907523413541");

  // 6. Parameter bypass attempt
  // Attempt to call /api/handoff with forged query params or headers
  const tamperRes = await fetch(`${CRM_URL}/api/handoff?handoff=0&status=all&assigned_user_id=null`, {
    headers: workerHeaders
  });
  const tamperData = await tamperRes.json();
  assert("6. Parameter tampering cannot yield owner embed", !tamperData.embed_url?.startsWith(ownerEmbedBase) && tamperData.embed_url?.startsWith(workerEmbedBase));

  // 7. Revocation verification
  // 7a. Query Supabase for revoked owner sessions
  const revokedRes = await fetch(`${SUPABASE_URL}/rest/v1/crm_sessions?role=eq.owner&revoked_at=not.is.null&select=id,role,revoked_at&limit=5`, {
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` }
  });
  const revokedSessions = await revokedRes.json();
  assert("7a. Prior revoked owner sessions present in DB", revokedSessions.length > 0, `Count: ${revokedSessions.length}`);

  // 7b. Perform live revocation check: Login a test worker session, verify 200, revoke in DB, verify 401
  const tempLoginRes = await fetch(`${CRM_URL}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: WORKER_EMAIL, password: WORKER_PASS })
  });
  const tempCookie = getCookie(tempLoginRes);
  const tempMeBefore = await fetch(`${CRM_URL}/api/me`, { headers: { Cookie: tempCookie } });
  
  // Find this new session in DB
  const recentRes = await fetch(`${SUPABASE_URL}/rest/v1/crm_sessions?user_id=eq.${tempLoginRes.status === 200 ? 'e12b347c-c8c8-4a25-8719-cc1554122703' : ''}&revoked_at=is.null&order=created_at.desc&limit=1`, {
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` }
  });
  const recentSessions = await recentRes.json();
  const tempSessionId = recentSessions[0]?.id;

  let revokedEffective = false;
  if (tempSessionId) {
    // Revoke it in DB
    await fetch(`${SUPABASE_URL}/rest/v1/crm_sessions?id=eq.${tempSessionId}`, {
      method: "PATCH",
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify({ revoked_at: new Date().toISOString() })
    });

    // Request with that cookie now
    const tempMeAfter = await fetch(`${CRM_URL}/api/me`, { headers: { Cookie: tempCookie } });
    revokedEffective = tempMeAfter.status === 401;
  }
  assert("7b. DB-revoked cookie produces strict HTTP 401 on /api/me", revokedEffective);
  
  // 8. Worker Logout
  const logoutRes = await fetch(`${CRM_URL}/api/logout`, {
    method: "POST",
    headers: workerHeaders
  });
  assert("8a. Worker Logout HTTP 200", logoutRes.status === 200);

  const meAfterLogout = await fetch(`${CRM_URL}/api/me`, { headers: workerHeaders });
  assert("8b. Post-logout /api/me returns HTTP 401", meAfterLogout.status === 401, `Status: ${meAfterLogout.status}`);

  console.log("\n=== AUDIT SUMMARY ===");
  const allPass = results.every(r => r.status === "PASS");
  console.log(`TOTAL CHECKS: ${results.length} | PASS: ${results.filter(r => r.status === "PASS").length} | FAIL: ${results.filter(r => r.status === "FAIL").length}`);
  console.log(`VERDICT: ${allPass ? "PASS" : "FAIL"}`);
}

runIsolationAudit().catch(console.error);
