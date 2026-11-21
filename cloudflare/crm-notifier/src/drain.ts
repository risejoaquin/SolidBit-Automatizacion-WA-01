import type { NotifierEnv, ClaimedTask, DrainResult } from "./types.ts";

async function timedFetch(fetchFn: typeof fetch, url: string, opts: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    return await fetchFn(url, { ...opts, signal: controller.signal, redirect: "manual" });
  } finally {
    clearTimeout(timer);
  }
}

export function buildTemplateMessage(
  phoneNumberId: string,
  to: string,
  templateName: string,
  language: string = "es_MX"
): { url: string; payload: any } {
  return {
    url: `https://api.kapso.ai/meta/whatsapp/v24.0/${phoneNumberId}/messages`,
    payload: {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: String(to),
      type: "template",
      template: {
        name: templateName,
        language: { code: language }
      }
    }
  };
}

export async function drainOutbox(
  env: NotifierEnv,
  fetchFn: typeof fetch = fetch
): Promise<DrainResult> {
  // 1. Feature flag guard
  if (env.ENABLE_KAPSO_HANDOFF_NOTICES !== "true") {
    return {
      processed: 0,
      accepted: 0,
      failed: 0,
      status: "disabled",
      reason: "Handoff notices disabled by configuration"
    };
  }

  // 2. Configuration validation
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.CRM_BUSINESS_ID) {
    return {
      processed: 0,
      accepted: 0,
      failed: 0,
      status: "misconfigured",
      reason: "Missing Supabase configuration"
    };
  }

  if (!env.KAPSO_API_KEY || !env.KAPSO_PHONE_NUMBER_ID || !env.KAPSO_WORKER_PHONE || !env.KAPSO_HANDOFF_TEMPLATE) {
    return {
      processed: 0,
      accepted: 0,
      failed: 0,
      status: "misconfigured",
      reason: "Missing Kapso notification configuration or recipient phone"
    };
  }

  const base = new URL(env.SUPABASE_URL).origin;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const sbHeaders: Record<string, string> = {
    "apikey": serviceKey,
    "Accept": "application/json",
    "Content-Type": "application/json"
  };
  if (!serviceKey.startsWith("sb_secret_")) {
    sbHeaders["Authorization"] = `Bearer ${serviceKey}`;
  }

  // 3. Atomic claim of pending notifications
  let tasks: ClaimedTask[] = [];
  try {
    const claimRes = await timedFetch(fetchFn, `${base}/rest/v1/rpc/crm_claim_handoff_notifications`, {
      method: "POST",
      headers: sbHeaders,
      body: JSON.stringify({
        p_business_id: env.CRM_BUSINESS_ID,
        p_limit: 10
      })
    });

    if (!claimRes.ok) {
      return {
        processed: 0,
        accepted: 0,
        failed: 0,
        status: "error",
        reason: "Failed to claim outbox items"
      };
    }

    tasks = (await claimRes.json()) as ClaimedTask[];
  } catch {
    return {
      processed: 0,
      accepted: 0,
      failed: 0,
      status: "error",
      reason: "Network error querying Supabase outbox claim"
    };
  }

  if (!Array.isArray(tasks) || tasks.length === 0) {
    return {
      processed: 0,
      accepted: 0,
      failed: 0,
      status: "idle"
    };
  }

  let accepted = 0;
  let failed = 0;

  // 4. Dispatch each claimed event
  const language = env.KAPSO_HANDOFF_TEMPLATE_LANGUAGE || "es_MX";
  const req = buildTemplateMessage(
    env.KAPSO_PHONE_NUMBER_ID,
    env.KAPSO_WORKER_PHONE,
    env.KAPSO_HANDOFF_TEMPLATE,
    language
  );

  for (const task of tasks) {
    try {
      const kapsoRes = await timedFetch(fetchFn, req.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": env.KAPSO_API_KEY
        },
        body: JSON.stringify(req.payload)
      });

      if (!kapsoRes.ok) {
        throw new Error(`Kapso rejected with status ${kapsoRes.status}`);
      }

      const kapsoData = await kapsoRes.json().catch(() => null);
      const messageId = kapsoData?.messages?.[0]?.id || "msg_accepted";

      // Mark outbox row as sent
      await timedFetch(
        fetchFn,
        `${base}/rest/v1/crm_handoff_outbox?business_id=eq.${env.CRM_BUSINESS_ID}&event_key=eq.${encodeURIComponent(task.event_key)}`,
        {
          method: "PATCH",
          headers: sbHeaders,
          body: JSON.stringify({
            state: "sent",
            provider_message_id: messageId,
            last_error_code: null,
            updated_at: new Date().toISOString()
          })
        }
      );

      accepted++;
    } catch {
      // Handle failure / uncertain delivery with retry limit
      const nextState = task.attempts >= 5 ? "failed" : "pending";
      await timedFetch(
        fetchFn,
        `${base}/rest/v1/crm_handoff_outbox?business_id=eq.${env.CRM_BUSINESS_ID}&event_key=eq.${encodeURIComponent(task.event_key)}`,
        {
          method: "PATCH",
          headers: sbHeaders,
          body: JSON.stringify({
            state: nextState,
            last_error_code: "DELIVERY_UNCERTAIN",
            updated_at: new Date().toISOString()
          })
        }
      ).catch(() => {});

      failed++;
    }
  }

  return {
    processed: tasks.length,
    accepted,
    failed,
    status: "completed"
  };
}
