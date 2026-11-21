import type { HandoffRecordResult, MediaReceiptRecordResult, ParsedHandoff, ParsedMediaReceipt } from "./types.ts";
import { WebhookHttpError } from "./types.ts";

export interface SupabaseConfig {
  supabaseUrl: string;
  serviceKey: string;
  businessId: string;
  workerAssigneeId?: string | null;
}

export async function recordHandoffInSupabase(
  config: SupabaseConfig,
  handoff: ParsedHandoff,
  fetchFn: typeof fetch = fetch
): Promise<HandoffRecordResult> {
  const { supabaseUrl, serviceKey, businessId, workerAssigneeId } = config;

  let url: URL;
  try {
    url = new URL(supabaseUrl);
  } catch {
    throw new WebhookHttpError(503, "Invalid SUPABASE_URL configuration", "INVALID_CONFIG");
  }

  if (url.protocol !== "https:" || !url.hostname.endsWith(".supabase.co")) {
    throw new WebhookHttpError(503, "SUPABASE_URL must be an HTTPS Supabase domain", "INVALID_CONFIG");
  }

  if (!serviceKey || typeof serviceKey !== "string" || serviceKey.length < 20) {
    throw new WebhookHttpError(503, "SUPABASE_SERVICE_ROLE_KEY missing or invalid", "CONFIG_MISSING");
  }

  if (!businessId || !/^[a-f0-9-]{36}$/i.test(businessId)) {
    throw new WebhookHttpError(503, "CRM_BUSINESS_ID must be a valid UUID", "CONFIG_MISSING");
  }

  const endpoint = new URL("/rest/v1/rpc/crm_record_handoff", url.origin).toString();

  const headers: Record<string, string> = {
    "apikey": serviceKey,
    "Authorization": `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
    "Accept": "application/json"
  };

  const body = JSON.stringify({
    p_business_id: businessId,
    p_event_key: handoff.idempotencyKey,
    p_conversation_id: handoff.conversationId,
    p_reason: handoff.reason,
    p_assigned_user_id: workerAssigneeId || null
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  let response: Response;
  try {
    response = await fetchFn(endpoint, {
      method: "POST",
      headers,
      body,
      signal: controller.signal
    });
  } catch (err: unknown) {
    clearTimeout(timer);
    const message = err instanceof Error ? err.message : "Network error";
    throw new WebhookHttpError(502, `Supabase connection error: ${message}`, "SUPABASE_UNAVAILABLE");
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 409) {
    throw new WebhookHttpError(409, "Idempotency key reused with different handoff data", "IDEMPOTENCY_CONFLICT");
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    if (errorText.includes("different conversation") || errorText.includes("23505")) {
      throw new WebhookHttpError(409, "Idempotency key reused with different handoff data", "IDEMPOTENCY_CONFLICT");
    }
    throw new WebhookHttpError(
      response.status >= 500 ? 502 : 500,
      "Supabase transaction error while recording handoff",
      "SUPABASE_ERROR"
    );
  }

  const result = (await response.json()) as HandoffRecordResult;
  return {
    recorded: Boolean(result.recorded),
    duplicate: Boolean(result.duplicate)
  };
}

const ALLOWED_RECEIPT_MIMES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
const MAX_RECEIPT_SIZE_BYTES = 10 * 1024 * 1024;

function isDisallowedMediaHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host === "[::1]" ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return true;
  }
  if (/^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) {
    return true;
  }
  return false;
}

export async function ingestWebhookMediaReceipt(
  config: SupabaseConfig,
  receipt: ParsedMediaReceipt,
  kapsoApiKey: string | undefined,
  fetchFn: typeof fetch = fetch
): Promise<MediaReceiptRecordResult> {
  const { supabaseUrl, serviceKey, businessId } = config;
  const base = new URL(supabaseUrl).origin;

  if (!ALLOWED_RECEIPT_MIMES.includes(receipt.mimeType)) {
    throw new WebhookHttpError(415, "Unsupported receipt media MIME type", "UNSUPPORTED_MEDIA_TYPE");
  }
  if (receipt.fileSize > MAX_RECEIPT_SIZE_BYTES) {
    throw new WebhookHttpError(413, "Receipt media exceeds 10MB limit", "FILE_TOO_LARGE");
  }

  const serviceHeaders: Record<string, string> = {
    "apikey": serviceKey,
    "Authorization": `Bearer ${serviceKey}`,
    "Accept": "application/json"
  };

  // 1. Idempotency check by providerMessageId
  const dedupeUrl = new URL("/rest/v1/crm_payment_receipts", base);
  dedupeUrl.searchParams.set("select", "id,order_id,storage_path,status");
  dedupeUrl.searchParams.set("business_id", "eq." + businessId);
  dedupeUrl.searchParams.set("provider_message_id", "eq." + receipt.providerMessageId);
  dedupeUrl.searchParams.set("limit", "1");

  const existingRes = await fetchFn(dedupeUrl.toString(), { method: "GET", headers: serviceHeaders });
  if (existingRes.ok) {
    const existingRows = (await existingRes.json().catch(() => [])) as any[];
    if (existingRows.length > 0) {
      return {
        recorded: false,
        duplicate: true,
        association_state: existingRows[0].status,
        storage_path: existingRows[0].storage_path,
        order_id: existingRows[0].order_id || null
      };
    }
  }

  // 2. Download media from Kapso / WhatsApp
  let parsedMediaUrl: URL;
  try {
    parsedMediaUrl = new URL(String(receipt.mediaUrl || "").trim().replace(/\s+/g, ""));
  } catch {
    throw new WebhookHttpError(400, "Invalid media_url", "INVALID_MEDIA_URL");
  }
  if (
    parsedMediaUrl.protocol !== "https:" ||
    parsedMediaUrl.username ||
    parsedMediaUrl.password ||
    isDisallowedMediaHost(parsedMediaUrl.hostname)
  ) {
    throw new WebhookHttpError(400, "Unsafe media_url origin", "UNSAFE_MEDIA_ORIGIN");
  }

  const downloadHeaders: Record<string, string> = {
    "Accept": "image/jpeg,image/png,image/webp,application/pdf,*/*"
  };
  if (kapsoApiKey && (parsedMediaUrl.hostname === "api.kapso.ai" || parsedMediaUrl.hostname.endsWith(".kapso.ai"))) {
    downloadHeaders["X-API-Key"] = kapsoApiKey;
    downloadHeaders["Authorization"] = `Bearer ${kapsoApiKey}`;
  }

  const mediaRes = await fetchFn(parsedMediaUrl.toString(), { method: "GET", headers: downloadHeaders });
  if (!mediaRes.ok) {
    throw new WebhookHttpError(502, `Media download failed with status ${mediaRes.status}`, "MEDIA_DOWNLOAD_FAILED");
  }

  const rawContentType = (mediaRes.headers.get("content-type") || receipt.mimeType).split(";")[0].trim().toLowerCase();
  const mimeType = rawContentType && rawContentType !== "application/octet-stream" ? rawContentType : receipt.mimeType;
  if (!ALLOWED_RECEIPT_MIMES.includes(mimeType)) {
    throw new WebhookHttpError(415, "Downloaded media MIME type not supported", "UNSUPPORTED_MEDIA_TYPE");
  }

  const mediaBytes = new Uint8Array(await mediaRes.arrayBuffer());
  if (mediaBytes.byteLength === 0) {
    throw new WebhookHttpError(400, "Downloaded media is empty", "EMPTY_MEDIA");
  }
  if (mediaBytes.byteLength > MAX_RECEIPT_SIZE_BYTES) {
    throw new WebhookHttpError(413, "Downloaded media exceeds 10MB limit", "FILE_TOO_LARGE");
  }

  // 3. Upload to private Supabase Storage bucket payment-receipts
  const safeBiz = businessId.replace(/[^a-zA-Z0-9_-]/g, "");
  const safeFile = receipt.fileName.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 80) || "comprobante.jpg";
  const safeMsg = receipt.providerMessageId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  const datePrefix = new Date().toISOString().slice(0, 10);
  const controlledPath = `${safeBiz}/receipts/${datePrefix}/${safeMsg}_${safeFile}`;
  const encodedPath = controlledPath.split("/").map(seg => encodeURIComponent(seg)).join("/");

  const storageRes = await fetchFn(`${base}/storage/v1/object/payment-receipts/${encodedPath}`, {
    method: "POST",
    headers: {
      "apikey": serviceKey,
      "Authorization": `Bearer ${serviceKey}`,
      "Content-Type": mimeType,
      "x-upsert": "true"
    },
    body: mediaBytes
  });

  if (!storageRes.ok) {
    throw new WebhookHttpError(502, "Failed to store receipt in private storage bucket", "STORAGE_UPLOAD_ERROR");
  }

  // 4. Find candidate pending transfer orders for this business
  const ordersUrl = new URL("/rest/v1/orders", base);
  ordersUrl.searchParams.set("select", "id,folio,customer_ref,conversation_id,payment_status,payment_method,total_cents");
  ordersUrl.searchParams.set("business_id", "eq." + businessId);
  ordersUrl.searchParams.set("payment_method", "eq.transfer");
  ordersUrl.searchParams.set("payment_status", "eq.pending");
  ordersUrl.searchParams.set("order", "created_at.desc");
  ordersUrl.searchParams.set("limit", "20");

  const ordersRes = await fetchFn(ordersUrl.toString(), { method: "GET", headers: serviceHeaders });
  const pendingOrders = ordersRes.ok ? ((await ordersRes.json().catch(() => [])) as any[]) : [];

  const candidates = pendingOrders.filter(o => {
    const matchConv = receipt.conversationId && o.conversation_id === receipt.conversationId;
    const matchPhone = receipt.customerPhone && (
      o.customer_ref === receipt.customerPhone ||
      String(o.customer_ref || "").replace(/\D/g, "") === receipt.customerPhone.replace(/\D/g, "")
    );
    return matchConv || matchPhone;
  });

  let matchedOrderId: string | null = null;
  let associationState: "pending_validation" | "pending_association" = "pending_association";
  let associationReason: string | null = null;

  if (candidates.length === 1) {
    matchedOrderId = candidates[0].id;
    associationState = "pending_validation";
  } else if (candidates.length > 1) {
    associationReason = "multiple_pending_orders";
  } else {
    associationReason = "no_pending_order";
  }

  // 5. Insert receipt row in crm_payment_receipts
  const insertRes = await fetchFn(`${base}/rest/v1/crm_payment_receipts`, {
    method: "POST",
    headers: {
      ...serviceHeaders,
      "Content-Type": "application/json",
      "Prefer": "return=representation"
    },
    body: JSON.stringify({
      business_id: businessId,
      order_id: matchedOrderId,
      provider_message_id: receipt.providerMessageId,
      conversation_id: receipt.conversationId,
      storage_path: controlledPath,
      file_name: receipt.fileName,
      file_size: mediaBytes.byteLength,
      mime_type: mimeType,
      declared_amount_cents: receipt.declaredAmountCents,
      bank_reference: receipt.bankReference,
      status: associationState,
      metadata: associationReason ? { association_issue: associationReason, candidate_count: candidates.length } : {}
    })
  });

  if (!insertRes.ok) {
    throw new WebhookHttpError(502, "Failed to persist payment receipt record", "SUPABASE_ERROR");
  }
  const insertedRows = (await insertRes.json().catch(() => [])) as any[];
  const insertedReceipt = insertedRows[0] || { id: receipt.providerMessageId };

  // 6. Emit notification
  await fetchFn(`${base}/rest/v1/rpc/crm_create_notification`, {
    method: "POST",
    headers: {
      ...serviceHeaders,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(
      matchedOrderId
        ? {
            p_business_id: businessId,
            p_event_key: `receipt:${insertedReceipt.id}`,
            p_type: "transfer_validation",
            p_priority: "high",
            p_title: "Transferencia por validar",
            p_message: `Comprobante recibido para pedido #${candidates[0].folio || matchedOrderId.slice(0, 8)}`,
            p_resource_type: "order",
            p_resource_id: matchedOrderId,
            p_recipient_role: "all",
            p_recipient_user_id: null,
            p_metadata: {
              order_id: matchedOrderId,
              receipt_id: insertedReceipt.id,
              storage_path: controlledPath
            }
          }
        : {
            p_business_id: businessId,
            p_event_key: `unassociated_receipt:${insertedReceipt.id}`,
            p_type: "operational_incident",
            p_priority: "high",
            p_title: "Comprobante sin pedido asociado",
            p_message:
              associationReason === "multiple_pending_orders"
                ? "Se recibió comprobante pero existen múltiples pedidos pendientes."
                : "Se recibió comprobante pero no se encontró pedido pendiente de transferencia.",
            p_resource_type: "payment",
            p_resource_id: String(insertedReceipt.id),
            p_recipient_role: "all",
            p_recipient_user_id: null,
            p_metadata: {
              receipt_id: insertedReceipt.id,
              conversation_id: receipt.conversationId,
              association_issue: associationReason
            }
          }
    )
  }).catch(() => {});

  return {
    recorded: true,
    duplicate: false,
    association_state: associationState,
    storage_path: controlledPath,
    order_id: matchedOrderId
  };
}
