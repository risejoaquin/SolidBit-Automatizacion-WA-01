import type { Env, ParsedHandoff, AssignmentResult } from "./types.ts";

const KAPSO_OWNER_USER_ID = "e5d724a2-8961-458c-a95d-03222b17cd03";
const DEFAULT_PHONE_NUMBER_ID = "597907523413541";
const MAX_ASSIGNMENT_RETRIES = 3;

interface UpdateAssignmentParams {
  supabaseUrl: string;
  serviceKey: string;
  businessId: string;
  eventKey: string;
  effectiveAssigneeId: string | null;
  assignmentState: "assigned" | "failed" | "skipped";
  error?: string | null;
}

export async function recordAssignmentOutcomeInSupabase(
  params: UpdateAssignmentParams,
  fetchFn: typeof fetch = fetch
): Promise<void> {
  const { supabaseUrl, serviceKey, businessId, eventKey, effectiveAssigneeId, assignmentState, error } = params;

  let url: URL;
  try {
    url = new URL(supabaseUrl);
  } catch {
    return;
  }

  const endpoint = new URL("/rest/v1/rpc/crm_update_handoff_assignment", url.origin).toString();
  const headers: Record<string, string> = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
    Accept: "application/json"
  };

  const body = JSON.stringify({
    p_business_id: businessId,
    p_event_key: eventKey,
    p_effective_assignee_id: effectiveAssigneeId,
    p_assignment_state: assignmentState,
    p_error: error ? String(error).slice(0, 500) : null
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    await fetchFn(endpoint, {
      method: "POST",
      headers,
      body,
      signal: controller.signal
    });
  } catch {
    // Non-fatal logging only
  } finally {
    clearTimeout(timer);
  }
}

export async function assignConversationToWorker(
  env: Env,
  handoff: ParsedHandoff,
  fetchFn: typeof fetch = fetch
): Promise<AssignmentResult> {
  const targetAgentId = env.KAPSO_WORKER_ASSIGNEE_ID || env.WORKER_ASSIGNEE_ID;
  const apiKey = env.KAPSO_API_KEY;
  const businessId = env.CRM_BUSINESS_ID;
  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const expectedPhoneNumberId = env.KAPSO_PHONE_NUMBER_ID || DEFAULT_PHONE_NUMBER_ID;

  // 1. Configuration validation
  if (!apiKey || !targetAgentId || !businessId || !supabaseUrl || !serviceKey) {
    return {
      success: false,
      status: "skipped_misconfigured",
      error: "Missing Kapso API key, target assignee ID, or Supabase credentials"
    };
  }

  // ASG-08: Security guard - Owner ID must never be used as fallback assignee
  if (targetAgentId === KAPSO_OWNER_USER_ID) {
    const errMsg = "Owner user ID cannot be used as worker assignee";
    await recordAssignmentOutcomeInSupabase(
      {
        supabaseUrl,
        serviceKey,
        businessId,
        eventKey: handoff.idempotencyKey,
        effectiveAssigneeId: null,
        assignmentState: "failed",
        error: errMsg
      },
      fetchFn
    );
    return {
      success: false,
      status: "failed",
      error: errMsg,
      retryable: false
    };
  }

  const convId = handoff.conversationId;
  const kapsoHeaders: Record<string, string> = {
    "X-API-Key": apiKey,
    "Content-Type": "application/json"
  };

  // 2. Fetch conversation details to verify channel, phone number, and current state (ASG-04, ASG-06, ASG-07)
  let convData: any = null;
  try {
    const convRes = await fetchFn(`https://api.kapso.ai/platform/v1/whatsapp/conversations/${encodeURIComponent(convId)}`, {
      method: "GET",
      headers: kapsoHeaders
    });

    if (convRes.ok) {
      const parsed = await convRes.json();
      convData = parsed?.data || parsed;
    } else if (convRes.status === 404) {
      const errMsg = "Conversation not found in Kapso platform";
      await recordAssignmentOutcomeInSupabase(
        {
          supabaseUrl,
          serviceKey,
          businessId,
          eventKey: handoff.idempotencyKey,
          effectiveAssigneeId: null,
          assignmentState: "failed",
          error: errMsg
        },
        fetchFn
      );
      return { success: false, status: "failed", error: errMsg, retryable: false };
    }
  } catch (err: unknown) {
    // If lookup fails due to network error, continue to patch attempt
  }

  // ASG-04: Channel and phone number validation
  if (convData && convData.phone_number_id && convData.phone_number_id !== expectedPhoneNumberId) {
    const errMsg = `Conversation phone_number_id mismatch (expected ${expectedPhoneNumberId})`;
    await recordAssignmentOutcomeInSupabase(
      {
        supabaseUrl,
        serviceKey,
        businessId,
        eventKey: handoff.idempotencyKey,
        effectiveAssigneeId: null,
        assignmentState: "skipped",
        error: errMsg
      },
      fetchFn
    );
    return { success: false, status: "skipped_existing_assignee", error: errMsg, retryable: false };
  }

  // 3. Check if already assigned to the target Human Agent (Idempotency ASG-09)
  try {
    const assignmentsRes = await fetchFn(
      `https://api.kapso.ai/platform/v1/whatsapp/conversations/${encodeURIComponent(convId)}/assignments`,
      { method: "GET", headers: kapsoHeaders }
    );
    if (assignmentsRes.ok) {
      const assignmentsData = await assignmentsRes.json();
      const items: any[] = assignmentsData?.data || [];
      const activeItem = items.find((item) => item.active === true);
      if (activeItem && activeItem.user_id === targetAgentId) {
        await recordAssignmentOutcomeInSupabase(
          {
            supabaseUrl,
            serviceKey,
            businessId,
            eventKey: handoff.idempotencyKey,
            effectiveAssigneeId: targetAgentId,
            assignmentState: "assigned"
          },
          fetchFn
        );
        return {
          success: true,
          status: "already_assigned",
          assigneeId: targetAgentId
        };
      }
    }
  } catch {
    // If assignments check fails, proceed with assignment attempt
  }

  // 4. Execute assignment via POST /platform/v1/whatsapp/conversations/:id/assignments
  const assignUrl = `https://api.kapso.ai/platform/v1/whatsapp/conversations/${encodeURIComponent(convId)}/assignments`;
  const assignBody = JSON.stringify({
    assignment: {
      user_id: targetAgentId
    }
  });

  const patchUrl = `https://api.kapso.ai/platform/v1/whatsapp/conversations/${encodeURIComponent(convId)}`;
  const patchBody = JSON.stringify({
    whatsapp_conversation: {
      status: "active"
    }
  });

  let lastStatus = 0;
  let lastErrorText = "";
  for (let attempt = 1; attempt <= MAX_ASSIGNMENT_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);

      const res = await fetchFn(assignUrl, {
        method: "POST",
        headers: kapsoHeaders,
        body: assignBody,
        signal: controller.signal
      });
      clearTimeout(timer);

      lastStatus = res.status;
      if (res.ok) {
        // Confirmed assignment in Kapso! Ensure conversation status is active
        try {
          await fetchFn(patchUrl, {
            method: "PATCH",
            headers: kapsoHeaders,
            body: patchBody
          });
        } catch {
          // Non-fatal status update
        }

        await recordAssignmentOutcomeInSupabase(
          {
            supabaseUrl,
            serviceKey,
            businessId,
            eventKey: handoff.idempotencyKey,
            effectiveAssigneeId: targetAgentId,
            assignmentState: "assigned"
          },
          fetchFn
        );

        return {
          success: true,
          status: "assigned",
          assigneeId: targetAgentId
        };
      }

      // If 422: Check if already assigned to targetAgentId
      if (res.status === 422) {
        const errorBody = await res.text();
        if (errorBody.includes("already has an active assignment")) {
          // Double check current active assignment
          try {
            const checkRes = await fetchFn(
              `https://api.kapso.ai/platform/v1/whatsapp/conversations/${encodeURIComponent(convId)}/assignments`,
              { method: "GET", headers: kapsoHeaders }
            );
            if (checkRes.ok) {
              const checkData = await checkRes.json();
              const items: any[] = checkData?.data || [];
              const active = items.find((i) => i.active === true);
              if (active && active.user_id === targetAgentId) {
                await recordAssignmentOutcomeInSupabase(
                  {
                    supabaseUrl,
                    serviceKey,
                    businessId,
                    eventKey: handoff.idempotencyKey,
                    effectiveAssigneeId: targetAgentId,
                    assignmentState: "assigned"
                  },
                  fetchFn
                );
                return {
                  success: true,
                  status: "already_assigned",
                  assigneeId: targetAgentId
                };
              }
            }
          } catch {}
        }
        lastErrorText = `Kapso HTTP 422: ${errorBody.slice(0, 200)}`;
        break; // Do not retry client 422
      }

      // Check for non-retryable 4xx client errors (400, 401, 403, 404)
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        lastErrorText = `Kapso HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
        break; // Do not retry client errors
      }

      // Retryable errors: 429 or 5xx
      lastErrorText = `Kapso HTTP ${res.status}`;
      if (attempt < MAX_ASSIGNMENT_RETRIES) {
        // Backoff delay: 200ms, 400ms...
        await new Promise((resolve) => setTimeout(resolve, attempt * 200));
      }
    } catch (err: unknown) {
      lastErrorText = err instanceof Error ? err.message : "Network error";
      if (attempt < MAX_ASSIGNMENT_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 200));
      }
    }
  }

  // If we reach here, assignment failed
  await recordAssignmentOutcomeInSupabase(
    {
      supabaseUrl,
      serviceKey,
      businessId,
      eventKey: handoff.idempotencyKey,
      effectiveAssigneeId: null,
      assignmentState: "failed",
      error: lastErrorText
    },
    fetchFn
  );

  return {
    success: false,
    status: "failed",
    error: lastErrorText,
    retryable: lastStatus === 429 || lastStatus >= 500
  };
}
