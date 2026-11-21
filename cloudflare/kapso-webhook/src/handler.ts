import type { Env } from "./types.ts";
import { WebhookHttpError } from "./types.ts";
import { verifyKapsoSignature } from "./crypto.ts";
import { parseKapsoHandoff, parseKapsoMediaReceipt } from "./parse.ts";
import { recordHandoffInSupabase, ingestWebhookMediaReceipt } from "./supabase.ts";
import { assignConversationToWorker } from "./assigner.ts";

const MAX_BODY_BYTES = 100_000; // 100 KB max payload

const jsonResponse = (status: number, body: unknown, extraHeaders: Record<string, string> = {}): Response => {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
      ...extraHeaders
    }
  });
};

export async function handleRequest(
  request: Request,
  env: Env,
  fetchFn: typeof fetch = fetch,
  ctx?: { waitUntil: (promise: Promise<unknown>) => void }
): Promise<Response> {
  const url = new URL(request.url);

  // Health endpoint
  if (url.pathname === "/health" || url.pathname === "/health/") {
    if (request.method !== "GET") {
      return jsonResponse(405, { error: { code: "METHOD_NOT_ALLOWED", message: "Only GET is allowed" } }, { Allow: "GET" });
    }
    return jsonResponse(200, {
      status: "healthy",
      service: "crm-kapso-webhook",
      version: env.WORKER_VERSION || "1.0.0",
      environment: env.ENVIRONMENT || "production",
      deployed_at: "2026-11-18T23:00:00Z"
    });
  }

  // Webhook endpoint
  if (url.pathname === "/webhooks/kapso/handoff" || url.pathname === "/webhooks/kapso/handoff/") {
    if (request.method !== "POST") {
      return jsonResponse(405, { error: { code: "METHOD_NOT_ALLOWED", message: "Only POST is allowed" } }, { Allow: "POST" });
    }

    try {
      const contentType = request.headers.get("content-type") || "";
      if (!contentType.toLowerCase().includes("application/json")) {
        throw new WebhookHttpError(415, "Content-Type must be application/json", "UNSUPPORTED_MEDIA_TYPE");
      }

      const contentLengthHeader = request.headers.get("content-length");
      if (contentLengthHeader && parseInt(contentLengthHeader, 10) > MAX_BODY_BYTES) {
        throw new WebhookHttpError(413, "Payload too large: exceeds 100KB limit", "PAYLOAD_TOO_LARGE");
      }

      // Check essential environment variables fail-closed
      if (
        !env.KAPSO_WEBHOOK_SECRET ||
        !env.KAPSO_PROJECT_ID ||
        !env.SUPABASE_URL ||
        !env.SUPABASE_SERVICE_ROLE_KEY ||
        !env.CRM_BUSINESS_ID
      ) {
        throw new WebhookHttpError(503, "Webhook service configuration incomplete", "CONFIG_INCOMPLETE");
      }

      // Read raw body bytes for HMAC verification before parsing JSON
      const rawBody = await request.arrayBuffer();
      if (rawBody.byteLength > MAX_BODY_BYTES) {
        throw new WebhookHttpError(413, "Payload too large: exceeds 100KB limit", "PAYLOAD_TOO_LARGE");
      }

      const signature = request.headers.get("x-webhook-signature");
      const isValidSig = await verifyKapsoSignature(rawBody, signature, env.KAPSO_WEBHOOK_SECRET);
      if (!isValidSig) {
        throw new WebhookHttpError(401, "Invalid or missing webhook signature", "INVALID_SIGNATURE");
      }

      const idempotencyKey = request.headers.get("x-idempotency-key");
      const parsedHandoff = parseKapsoHandoff(rawBody, idempotencyKey, env.KAPSO_PROJECT_ID);

      const targetAssigneeId = env.KAPSO_WORKER_ASSIGNEE_ID || env.WORKER_ASSIGNEE_ID || null;

      const recordResult = await recordHandoffInSupabase(
        {
          supabaseUrl: env.SUPABASE_URL,
          serviceKey: env.SUPABASE_SERVICE_ROLE_KEY,
          businessId: env.CRM_BUSINESS_ID,
          workerAssigneeId: targetAssigneeId
        },
        parsedHandoff,
        fetchFn
      );

      // ASG-01: Auto-assign conversation upon newly recorded handoff
      if (recordResult.recorded) {
        const assignPromise = assignConversationToWorker(env, parsedHandoff, fetchFn).catch(() => {
          // Handled within assignConversationToWorker; non-fatal here
        });

        if (ctx && typeof ctx.waitUntil === "function") {
          ctx.waitUntil(assignPromise);
        } else {
          await assignPromise;
        }
      }

      return jsonResponse(200, {
        recorded: recordResult.recorded,
        duplicate: recordResult.duplicate
      });
    } catch (err: unknown) {
      if (err instanceof WebhookHttpError) {
        return jsonResponse(err.status, {
          error: {
            code: err.code,
            message: err.message
          }
        });
      }

      // Generic error response - never expose internal error details or secrets
      return jsonResponse(500, {
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Internal server error processing webhook"
        }
      });
    }
  }

  // Media Receipt Webhook endpoint (WhatsApp -> Kapso -> Download -> Private Storage -> CRM Order)
  if (url.pathname === "/webhooks/kapso/receipt" || url.pathname === "/webhooks/kapso/receipt/") {
    if (request.method !== "POST") {
      return jsonResponse(405, { error: { code: "METHOD_NOT_ALLOWED", message: "Only POST is allowed" } }, { Allow: "POST" });
    }

    try {
      const contentType = request.headers.get("content-type") || "";
      if (!contentType.toLowerCase().includes("application/json")) {
        throw new WebhookHttpError(415, "Content-Type must be application/json", "UNSUPPORTED_MEDIA_TYPE");
      }

      const contentLengthHeader = request.headers.get("content-length");
      if (contentLengthHeader && parseInt(contentLengthHeader, 10) > MAX_BODY_BYTES) {
        throw new WebhookHttpError(413, "Payload too large: exceeds 100KB limit", "PAYLOAD_TOO_LARGE");
      }

      if (
        !env.KAPSO_WEBHOOK_SECRET ||
        !env.KAPSO_PROJECT_ID ||
        !env.SUPABASE_URL ||
        !env.SUPABASE_SERVICE_ROLE_KEY ||
        !env.CRM_BUSINESS_ID
      ) {
        throw new WebhookHttpError(503, "Webhook service configuration incomplete", "CONFIG_INCOMPLETE");
      }

      const rawBody = await request.arrayBuffer();
      if (rawBody.byteLength > MAX_BODY_BYTES) {
        throw new WebhookHttpError(413, "Payload too large: exceeds 100KB limit", "PAYLOAD_TOO_LARGE");
      }

      const signature = request.headers.get("x-webhook-signature");
      const isValidSig = await verifyKapsoSignature(rawBody, signature, env.KAPSO_WEBHOOK_SECRET);
      if (!isValidSig) {
        throw new WebhookHttpError(401, "Invalid or missing webhook signature", "INVALID_SIGNATURE");
      }

      const idempotencyKey = request.headers.get("x-idempotency-key");
      const parsedReceipt = parseKapsoMediaReceipt(rawBody, idempotencyKey, env.KAPSO_PROJECT_ID);

      const receiptResult = await ingestWebhookMediaReceipt(
        {
          supabaseUrl: env.SUPABASE_URL,
          serviceKey: env.SUPABASE_SERVICE_ROLE_KEY,
          businessId: env.CRM_BUSINESS_ID
        },
        parsedReceipt,
        env.KAPSO_API_KEY,
        fetchFn
      );

      return jsonResponse(receiptResult.duplicate ? 200 : 201, receiptResult);
    } catch (err: unknown) {
      if (err instanceof WebhookHttpError) {
        return jsonResponse(err.status, {
          error: {
            code: err.code,
            message: err.message
          }
        });
      }

      return jsonResponse(500, {
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Internal server error processing media receipt webhook"
        }
      });
    }
  }

  // Not Found
  return jsonResponse(404, {
    error: {
      code: "NOT_FOUND",
      message: "Resource not found"
    }
  });
}
