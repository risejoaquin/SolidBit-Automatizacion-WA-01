export interface Env {
  // Secrets (Cloudflare Secrets)
  KAPSO_WEBHOOK_SECRET?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  KAPSO_API_KEY?: string;

  // Environment variables (Vars)
  SUPABASE_URL?: string;
  KAPSO_PROJECT_ID?: string;
  CRM_BUSINESS_ID?: string;
  WORKER_ASSIGNEE_ID?: string;
  KAPSO_WORKER_ASSIGNEE_ID?: string;
  KAPSO_PHONE_NUMBER_ID?: string;
  WORKER_VERSION?: string;
  ENVIRONMENT?: string;
}

export interface KapsoHandoffPayload {
  test?: boolean;
  event?: string;
  occurred_at?: string;
  project_id?: string;
  workflow_id?: string;
  workflow_execution_id?: string;
  status?: string;
  tracking_id?: string;
  channel?: string;
  whatsapp_conversation_id?: string;
  handoff?: {
    reason?: string;
    source?: string;
  };
}

export interface ParsedHandoff {
  idempotencyKey: string;
  projectId: string;
  executionId: string;
  conversationId: string;
  reason: string;
}

export interface HandoffRecordResult {
  recorded: boolean;
  duplicate: boolean;
}

export interface AssignmentResult {
  success: boolean;
  status: "assigned" | "already_assigned" | "skipped_existing_assignee" | "failed" | "skipped_misconfigured";
  assigneeId?: string | null;
  error?: string;
  retryable?: boolean;
}

export interface ParsedMediaReceipt {
  idempotencyKey: string;
  projectId: string;
  conversationId: string;
  customerPhone: string | null;
  providerMessageId: string;
  mediaUrl: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  declaredAmountCents: number | null;
  bankReference: string | null;
}

export interface MediaReceiptRecordResult {
  recorded: boolean;
  duplicate: boolean;
  association_state: string;
  storage_path: string;
  order_id: string | null;
}

export class WebhookHttpError extends Error {
  status: number;
  code: string;

  constructor(status: number, message: string, code: string = "WEBHOOK_ERROR") {
    super(message);
    this.name = "WebhookHttpError";
    this.status = status;
    this.code = code;
  }
}
