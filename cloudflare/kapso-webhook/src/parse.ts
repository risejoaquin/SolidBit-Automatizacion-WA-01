import type { KapsoHandoffPayload, ParsedHandoff, ParsedMediaReceipt } from "./types.ts";
import { WebhookHttpError } from "./types.ts";

const isValidId = (value: unknown): value is string =>
  typeof value === "string" && value.length >= 1 && value.length <= 180 && !/[\r\n]/.test(value);

export function parseKapsoHandoff(
  rawBody: ArrayBuffer | Uint8Array,
  idempotencyKey: string | null | undefined,
  expectedProjectId: string | undefined
): ParsedHandoff {
  if (!isValidId(idempotencyKey)) {
    throw new WebhookHttpError(400, "Missing or invalid idempotency key", "INVALID_IDEMPOTENCY_KEY");
  }

  if (!isValidId(expectedProjectId)) {
    throw new WebhookHttpError(503, "Project configuration missing", "CONFIG_MISSING");
  }

  const textDecoder = new TextDecoder("utf-8");
  let data: KapsoHandoffPayload;
  try {
    data = JSON.parse(textDecoder.decode(rawBody));
  } catch {
    throw new WebhookHttpError(400, "Invalid webhook JSON", "INVALID_JSON");
  }

  if (typeof data !== "object" || data === null) {
    throw new WebhookHttpError(400, "Webhook body must be an object", "INVALID_BODY");
  }

  if (data.event !== "workflow.execution.handoff") {
    throw new WebhookHttpError(422, "Unsupported event type: only workflow.execution.handoff is accepted", "UNSUPPORTED_EVENT");
  }

  if (data.channel !== "whatsapp") {
    throw new WebhookHttpError(422, "Unsupported channel: only whatsapp channel is accepted", "UNSUPPORTED_CHANNEL");
  }

  if (data.project_id !== expectedProjectId) {
    throw new WebhookHttpError(403, "Unexpected project ID", "FORBIDDEN_PROJECT");
  }

  const isTest = data.test === true;
  const conversationId = data.whatsapp_conversation_id || (isTest ? (data.tracking_id || data.workflow_execution_id || "sample-test-conversation") : undefined);

  if (!isValidId(conversationId) || !isValidId(data.workflow_execution_id)) {
    throw new WebhookHttpError(400, "Invalid handoff payload identifiers", "INVALID_PAYLOAD_IDS");
  }

  const rawReason = data.handoff?.reason;
  const reason = typeof rawReason === "string" ? rawReason.slice(0, 500) : "";

  return {
    idempotencyKey,
    projectId: data.project_id,
    executionId: data.workflow_execution_id,
    conversationId,
    reason
  };
}

const ALLOWED_MEDIA_EVENTS = new Set([
  "whatsapp.message.received",
  "message.received",
  "workflow.execution.receipt",
  "receipt.received"
]);

export function parseKapsoMediaReceipt(
  rawBody: ArrayBuffer | Uint8Array,
  idempotencyKey: string | null | undefined,
  expectedProjectId: string | undefined
): ParsedMediaReceipt {
  if (!isValidId(idempotencyKey)) {
    throw new WebhookHttpError(400, "Missing or invalid idempotency key", "INVALID_IDEMPOTENCY_KEY");
  }

  if (!isValidId(expectedProjectId)) {
    throw new WebhookHttpError(503, "Project configuration missing", "CONFIG_MISSING");
  }

  const textDecoder = new TextDecoder("utf-8");
  let data: any;
  try {
    data = JSON.parse(textDecoder.decode(rawBody));
  } catch {
    throw new WebhookHttpError(400, "Invalid webhook JSON", "INVALID_JSON");
  }

  if (typeof data !== "object" || data === null) {
    throw new WebhookHttpError(400, "Webhook body must be an object", "INVALID_BODY");
  }

  const isNativeV2Message =
    typeof data.message === "object" &&
    data.message !== null &&
    typeof data.conversation === "object" &&
    data.conversation !== null;

  const effectiveEvent = String(data.event || (isNativeV2Message ? "whatsapp.message.received" : ""));
  if (!ALLOWED_MEDIA_EVENTS.has(effectiveEvent)) {
    throw new WebhookHttpError(422, "Unsupported event type for media receipt", "UNSUPPORTED_EVENT");
  }

  const effectiveChannel = data.channel || (isNativeV2Message ? "whatsapp" : undefined);
  if (effectiveChannel !== "whatsapp") {
    throw new WebhookHttpError(422, "Unsupported channel: only whatsapp channel is accepted", "UNSUPPORTED_CHANNEL");
  }

  const effectiveProjectId = data.project_id !== undefined ? data.project_id : (isNativeV2Message ? expectedProjectId : undefined);
  if (effectiveProjectId !== expectedProjectId) {
    throw new WebhookHttpError(403, "Unexpected project ID", "FORBIDDEN_PROJECT");
  }

  const conversationId = String(
    data.whatsapp_conversation_id ||
    data.conversation_id ||
    data.conversation?.id ||
    ""
  ).trim();
  const mediaUrl = String(
    data.media?.url ||
    data.media_url ||
    data.message?.kapso?.media_data?.url ||
    data.message?.kapso?.media_url ||
    ""
  ).trim();
  const providerMessageId = String(
    data.provider_message_id ||
    data.message_id ||
    data.message?.id ||
    idempotencyKey
  ).trim();

  if (!isValidId(conversationId) || !mediaUrl || !isValidId(providerMessageId)) {
    throw new WebhookHttpError(400, "Missing conversation_id, media_url, or provider_message_id", "INVALID_PAYLOAD_IDS");
  }

  const fileName = String(
    data.media?.file_name ||
    data.file_name ||
    data.message?.kapso?.media_data?.filename ||
    "comprobante.jpg"
  ).trim() || "comprobante.jpg";
  const mimeType = String(
    data.media?.mime_type ||
    data.mime_type ||
    data.message?.kapso?.media_data?.content_type ||
    "image/jpeg"
  ).trim().toLowerCase();
  const fileSize = Number(
    data.media?.file_size ??
    data.file_size ??
    data.message?.kapso?.media_data?.byte_size ??
    0
  ) || 0;
  const rawPhone =
    data.customer_phone ||
    data.from ||
    data.phone_number ||
    data.conversation?.phone_number ||
    data.message?.from;
  const customerPhone = rawPhone ? String(rawPhone).trim() : null;
  const declaredAmountCents = data.declared_amount_cents !== undefined && data.declared_amount_cents !== null
    ? Number(data.declared_amount_cents)
    : null;
  const bankReference = data.bank_reference ? String(data.bank_reference).trim().slice(0, 120) : null;

  return {
    idempotencyKey,
    projectId: effectiveProjectId,
    conversationId,
    customerPhone,
    providerMessageId,
    mediaUrl,
    fileName,
    mimeType,
    fileSize,
    declaredAmountCents,
    bankReference
  };
}
