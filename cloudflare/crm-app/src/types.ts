export interface Env {
  // Public variables
  SUPABASE_URL: string;
  CRM_BUSINESS_ID: string;
  KAPSO_PHONE_NUMBER_ID?: string;
  KAPSO_WORKER_ASSIGNEE_ID?: string;
  KAPSO_WORKER_EMBED_APPROVED?: string;
  ENABLE_SUPABASE_SYNC?: string;
  ENABLE_KAPSO_HANDOFF_NOTICES?: string;
  WORKER_VERSION?: string;
  COMMIT_SHA?: string;
  ENVIRONMENT?: string;

  // Cloudflare Secrets
  SUPABASE_SERVICE_ROLE_KEY: string;
  SUPABASE_PUBLISHABLE_KEY: string;
  SESSION_SECRET?: string;
  KAPSO_API_KEY?: string;
  KAPSO_MENU_TOOL_SECRET?: string;
  KAPSO_ORDER_TOOL_SECRET?: string;
  KAPSO_OWNER_EMBED_URL?: string;
  KAPSO_WORKER_EMBED_URL?: string;
}

export interface DbSessionRow {
  id: string;
  user_id: string;
  business_id: string;
  access_token: string;
  refresh_token: string;
  role: "owner" | "manager" | "operator" | "worker";
  kapso_assignee_id?: string | null;
  email: string;
  expires_at: string;
  ttl: string;
  revoked_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface AuthenticatedUser {
  sessionId: string;
  userId: string;
  email: string;
  role: "owner" | "manager" | "operator" | "worker";
  token: string;
  assigneeId?: string | null;
  canValidateTransfers?: boolean;
  paymentsReview?: boolean;
  updatedCookie?: string;
}

export interface RateLimitResult {
  allowed: boolean;
  locked?: boolean;
  attempts?: number;
  remaining?: number;
  retry_after?: number;
}

export type NotificationType =
  | "human_handoff"
  | "transfer_validation"
  | "order_confirmed"
  | "operational_incident";

export type NotificationPriority = "low" | "normal" | "high" | "urgent";

export interface CrmNotification {
  id: string;
  business_id: string;
  event_key: string;
  type: NotificationType;
  priority: NotificationPriority;
  title: string;
  message: string;
  resource_type: "conversation" | "order" | "payment" | "inventory" | "system";
  resource_id?: string | null;
  recipient_role: "owner" | "worker" | "all";
  recipient_user_id?: string | null;
  state: "pending" | "resolved" | "dismissed";
  created_at: string;
  resolved_at?: string | null;
  resolved_by?: string | null;
  read?: boolean;
  metadata: Record<string, any>;
}

export interface CrmPaymentReceipt {
  id: string;
  business_id: string;
  order_id?: string | null;
  provider_message_id?: string | null;
  conversation_id?: string | null;
  storage_path: string;
  file_name: string;
  file_size: number;
  mime_type: string;
  declared_amount_cents?: number | null;
  bank_reference?: string | null;
  status: "pending_association" | "pending_validation" | "validated" | "rejected";
  validation_notes?: string | null;
  rejection_reason?: string | null;
  validated_by?: string | null;
  validated_at?: string | null;
  created_at: string;
  updated_at: string;
  metadata: Record<string, any>;
}

export type OrderStatus =
  | "received"
  | "confirmed"
  | "preparing"
  | "ready"
  | "assigned"
  | "dispatched"
  | "delivered"
  | "cancelled";

export type PaymentStatus = "pending" | "validated" | "verified" | "rejected";

export interface CrmOrder {
  id: string;
  folio?: string | null;
  business_id?: string | null;
  confirmation_key: string;
  conversation_id?: string | null;
  provider_message_id?: string | null;
  customer_ref: string;
  items: any[];
  subtotal_cents: number;
  shipping_cents: number;
  total_cents: number;
  fulfillment: "pickup" | "delivery";
  address?: string | null;
  delivery_references?: string | null;
  payment_method: "cash" | "transfer";
  payment_status: PaymentStatus;
  order_status: OrderStatus;
  created_at: string;
  updated_at?: string;
  receipt?: CrmPaymentReceipt | null;
}

export interface CrmOrderHistory {
  id: string;
  business_id: string;
  order_id: string;
  actor_id?: string | null;
  actor_role: string;
  actor_email?: string | null;
  action: string;
  previous_status?: string | null;
  new_status?: string | null;
  notes?: string | null;
  created_at: string;
}

export class AppHttpError extends Error {
  status: number;
  code: string;

  constructor(status: number, message: string, code: string = "APP_ERROR") {
    super(message);
    this.name = "AppHttpError";
    this.status = status;
    this.code = code;
  }
}
