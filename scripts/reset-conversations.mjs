import { readFileSync } from "fs";

const env = {};
try {
  readFileSync("cloudflare/crm-app/.env.local", "utf8").split("\n").forEach(l => {
    const i = l.indexOf("=");
    if (i > 0) env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^['"]|['"]$/g, "");
  });
} catch {
  // fallback
}

const key = env.KAPSO_API_KEY || process.env.KAPSO_API_KEY;
const phoneId = env.KAPSO_PHONE_NUMBER_ID || process.env.KAPSO_PHONE_NUMBER_ID || "1462335776957834";

async function endAll() {
  const res = await fetch(`https://api.kapso.ai/platform/v1/whatsapp/conversations?phone_number_id=${phoneId}`, {
    headers: { "X-API-Key": key }
  });
  if (!res.ok) throw new Error(`Failed to list conversations: ${res.status}`);
  const data = await res.json();
  const active = (data.data || []).filter(c => c.status === "active");
  console.log(`Active conversations found: ${active.length}`);
  for (const c of active) {
    const patchRes = await fetch(`https://api.kapso.ai/platform/v1/whatsapp/conversations/${c.id}`, {
      method: "PATCH",
      headers: { "X-API-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ whatsapp_conversation: { status: "ended" } })
    });
    console.log(`Ended conversation: ${c.id} (${c.phone_number}) -> ${patchRes.status}`);
  }
}

endAll().catch(console.error);
