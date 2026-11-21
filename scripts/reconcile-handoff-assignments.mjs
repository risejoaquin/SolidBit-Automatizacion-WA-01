/**
 * Reconciles and recovers any pending or failed handoff assignments.
 * Connects directly to Supabase and Kapso with authenticated credentials.
 * Never prints secrets or tokens.
 */
import { readFileSync } from "node:fs";

let env = {};
try {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, "");
  }
} catch {}
try {
  for (const line of readFileSync("cloudflare/crm-app/.env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !env[m[1]]) env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, "");
  }
} catch {}

const SUPABASE_URL = env.SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const BUSINESS_ID = env.CRM_BUSINESS_ID;
const KAPSO_API_KEY = env.KAPSO_API_KEY;
const TARGET_ASSIGNEE = env.KAPSO_WORKER_ASSIGNEE_ID;
const PHONE_NUMBER_ID = env.KAPSO_PHONE_NUMBER_ID || "597907523413541";

if (!SUPABASE_URL || !SERVICE_KEY || !BUSINESS_ID || !KAPSO_API_KEY || !TARGET_ASSIGNEE) {
  console.error("Missing required environment variables for assignment reconciliation");
  process.exit(1);
}

const sbHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json"
};

const kapsoHeaders = {
  "X-API-Key": KAPSO_API_KEY,
  "Content-Type": "application/json"
};

async function run() {
  console.log("=== Reconciling Handoff Assignments ===");

  const targetConvIdArg = process.argv.find((a, i) => process.argv[i - 1] === "--conversation-id");
  const targetEventKeyArg = process.argv.find((a, i) => process.argv[i - 1] === "--event-key");

  let queryUrl = `${SUPABASE_URL}/rest/v1/crm_handoffs?business_id=eq.${BUSINESS_ID}&select=*`;
  if (targetConvIdArg) {
    queryUrl += `&provider_conversation_id=eq.${encodeURIComponent(targetConvIdArg)}`;
  } else if (targetEventKeyArg) {
    queryUrl += `&event_key=eq.${encodeURIComponent(targetEventKeyArg)}`;
  } else {
    queryUrl += `&assignment_state=in.(pending,failed)`;
  }

  const res = await fetch(queryUrl, { headers: sbHeaders });
  if (!res.ok) {
    console.error("Failed to query handoffs from Supabase:", res.status);
    process.exit(1);
  }

  const handoffs = await res.json();
  console.log(`Found ${handoffs.length} handoff(s) requiring assignment processing`);

  for (const h of handoffs) {
    const convId = h.provider_conversation_id;
    console.log(`\nProcessing handoff event ${h.event_key} for conversation ${convId}...`);

    try {
      // 1. Check if already assigned
      const checkRes = await fetch(`https://api.kapso.ai/platform/v1/whatsapp/conversations/${encodeURIComponent(convId)}/assignments`, {
        headers: kapsoHeaders
      });
      let alreadyAssigned = false;
      if (checkRes.ok) {
        const assignmentsData = await checkRes.json();
        const items = assignmentsData?.data || [];
        const activeItem = items.find((a) => a.active === true);
        if (activeItem && activeItem.user_id === TARGET_ASSIGNEE) {
          alreadyAssigned = true;
          console.log(`- Conversation already has active assignment to target agent ${TARGET_ASSIGNEE}`);
        }
      }

      if (!alreadyAssigned) {
        // Execute POST assignment in Kapso
        const postRes = await fetch(`https://api.kapso.ai/platform/v1/whatsapp/conversations/${encodeURIComponent(convId)}/assignments`, {
          method: "POST",
          headers: kapsoHeaders,
          body: JSON.stringify({
            assignment: {
              user_id: TARGET_ASSIGNEE
            }
          })
        });

        if (postRes.ok || postRes.status === 201) {
          console.log(`- Successfully assigned in Kapso (HTTP ${postRes.status})`);
        } else if (postRes.status === 422) {
          const errText = await postRes.text();
          if (errText.includes("already has an active assignment")) {
            console.log(`- Kapso returned 422: already has active assignment`);
          } else {
            throw new Error(`Kapso HTTP 422: ${errText}`);
          }
        } else {
          const errorText = `Kapso HTTP ${postRes.status}: ${(await postRes.text()).slice(0, 100)}`;
          throw new Error(errorText);
        }

        // Ensure status is active
        await fetch(`https://api.kapso.ai/platform/v1/whatsapp/conversations/${encodeURIComponent(convId)}`, {
          method: "PATCH",
          headers: kapsoHeaders,
          body: JSON.stringify({
            whatsapp_conversation: {
              status: "active"
            }
          })
        });
      }

      // Update Supabase
      const updateRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/crm_update_handoff_assignment`, {
        method: "POST",
        headers: sbHeaders,
        body: JSON.stringify({
          p_business_id: BUSINESS_ID,
          p_event_key: h.event_key,
          p_effective_assignee_id: TARGET_ASSIGNEE,
          p_assignment_state: "assigned"
        })
      });
      console.log(`- Supabase assignment record updated (HTTP ${updateRes.status})`);
    } catch (err) {
      console.error(`- Error processing ${convId}:`, err.message);
      await fetch(`${SUPABASE_URL}/rest/v1/rpc/crm_update_handoff_assignment`, {
        method: "POST",
        headers: sbHeaders,
        body: JSON.stringify({
          p_business_id: BUSINESS_ID,
          p_event_key: h.event_key,
          p_effective_assignee_id: null,
          p_assignment_state: "failed",
          p_error: err.message
        })
      });
    }
  }

  console.log("\nReconciliation finished.");
}

run().catch(console.error);
