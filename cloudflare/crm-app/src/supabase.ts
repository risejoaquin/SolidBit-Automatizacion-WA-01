import { AppHttpError } from "./types.ts";
import type {
  DbSessionRow,
  RateLimitResult,
  CrmNotification,
  CrmPaymentReceipt,
  CrmOrderHistory
} from "./types.ts";

export interface SupabaseConfig {
  supabaseUrl: string;
  publishableKey: string;
  serviceKey: string;
  businessId: string;
}

export interface AuthTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: {
    id: string;
    email: string;
  };
}

export interface MembershipRecord {
  business_id: string;
  role: "owner" | "worker";
  active: boolean;
  kapso_assignee_id: string | null;
  can_validate_transfers?: boolean;
}

async function timedFetch(fetchFn: typeof fetch, url: string, opts: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    return await fetchFn(url, { ...opts, signal: controller.signal, redirect: "manual" });
  } finally {
    clearTimeout(timer);
  }
}

export async function supabaseRequest<T = any>(
  endpoint: string,
  options: {
    method?: string;
    body?: any;
    token?: string;
    privileged?: boolean;
    query?: Record<string, string>;
    prefer?: string;
  },
  config: SupabaseConfig,
  fetchFn: typeof fetch = fetch
): Promise<T> {
  const { supabaseUrl, publishableKey, serviceKey } = config;
  const base = new URL(supabaseUrl).origin;
  const target = new URL(endpoint, base);

  if (options.query) {
    for (const [k, v] of Object.entries(options.query)) {
      target.searchParams.set(k, String(v));
    }
  }

  const key = options.privileged ? serviceKey : publishableKey;
  const headers: Record<string, string> = {
    "apikey": key,
    "Accept": "application/json"
  };

  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (options.prefer) {
    headers["Prefer"] = options.prefer;
  }
  if (options.privileged && !key.startsWith("sb_secret_")) {
    headers["Authorization"] = `Bearer ${key}`;
  }
  if (options.token) {
    headers["Authorization"] = `Bearer ${options.token}`;
  }

  const res = await timedFetch(fetchFn, target.toString(), {
    method: options.method || "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined
  });

  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401) throw new AppHttpError(401, "Credenciales inválidas", "UNAUTHORIZED");
    if (res.status === 403) throw new AppHttpError(403, "Acceso denegado", "FORBIDDEN");
    const detail = payload?.message || payload?.error || payload?.hint || payload?.details || (typeof payload === "string" ? payload : "");
    throw new AppHttpError(res.status >= 500 ? 502 : res.status, `Error en Supabase${detail ? `: ${detail}` : ""}`, "SUPABASE_ERROR");
  }

  return payload as T;
}

export async function loginWithPassword(
  email: string,
  password: string,
  config: SupabaseConfig,
  fetchFn: typeof fetch = fetch
): Promise<AuthTokenResponse> {
  return supabaseRequest<AuthTokenResponse>(
    "/auth/v1/token",
    {
      method: "POST",
      query: { grant_type: "password" },
      body: { email, password }
    },
    config,
    fetchFn
  );
}

export async function refreshSessionToken(
  refreshToken: string,
  config: SupabaseConfig,
  fetchFn: typeof fetch = fetch
): Promise<AuthTokenResponse> {
  return supabaseRequest<AuthTokenResponse>(
    "/auth/v1/token",
    {
      method: "POST",
      query: { grant_type: "refresh_token" },
      body: { refresh_token: refreshToken }
    },
    config,
    fetchFn
  );
}

export async function getMembership(
  token: string,
  userId: string,
  businessId: string,
  config: SupabaseConfig,
  fetchFn: typeof fetch = fetch,
  allowPrivilegedFallback = false
): Promise<MembershipRecord | null> {
  const query = {
    select: "business_id,role,active,kapso_assignee_id,can_validate_transfers",
    business_id: "eq." + businessId,
    user_id: "eq." + userId,
    limit: "1"
  };

  try {
    const records = await supabaseRequest<MembershipRecord[]>(
      "/rest/v1/crm_memberships",
      {
        token,
        query
      },
      config,
      fetchFn
    );
    return records?.[0] || null;
  } catch (err) {
    if (allowPrivilegedFallback) {
      const records = await supabaseRequest<MembershipRecord[]>(
        "/rest/v1/crm_memberships",
        {
          privileged: true,
          query
        },
        config,
        fetchFn
      );
      return records?.[0] || null;
    }
    throw err;
  }
}

// --- Server-side Opaque Sessions & Distributed Rate Limits ---

export async function createDbSession(
  sessionData: {
    userId: string;
    businessId: string;
    accessToken: string;
    refreshToken: string;
    role: "owner" | "worker";
    kapsoAssigneeId?: string | null;
    email: string;
    expiresInSeconds: number;
    ttlSeconds?: number;
  },
  config: SupabaseConfig,
  fetchFn: typeof fetch = fetch
): Promise<DbSessionRow> {
  const now = Date.now();
  const expiresAt = new Date(now + sessionData.expiresInSeconds * 1000).toISOString();
  const ttl = new Date(now + (sessionData.ttlSeconds || 8 * 3600) * 1000).toISOString();

  const inserted = await supabaseRequest<DbSessionRow[]>(
    "/rest/v1/crm_sessions",
    {
      method: "POST",
      privileged: true,
      prefer: "return=representation",
      body: {
        user_id: sessionData.userId,
        business_id: sessionData.businessId,
        access_token: sessionData.accessToken,
        refresh_token: sessionData.refreshToken,
        role: sessionData.role,
        kapso_assignee_id: sessionData.kapsoAssigneeId || null,
        email: sessionData.email,
        expires_at: expiresAt,
        ttl: ttl
      }
    },
    config,
    fetchFn
  );

  if (!inserted?.[0]?.id) {
    throw new AppHttpError(500, "No se pudo registrar la sesión en la base de datos");
  }

  return inserted[0];
}

export async function getDbSession(
  sessionId: string,
  config: SupabaseConfig,
  fetchFn: typeof fetch = fetch
): Promise<DbSessionRow | null> {
  const rows = await supabaseRequest<DbSessionRow[]>(
    "/rest/v1/crm_sessions",
    {
      method: "GET",
      privileged: true,
      query: {
        select: "*",
        id: "eq." + sessionId,
        revoked_at: "is.null",
        limit: "1"
      }
    },
    config,
    fetchFn
  );

  const session = rows?.[0];
  if (!session) return null;

  // Check TTL
  if (new Date(session.ttl).getTime() <= Date.now()) {
    return null;
  }

  return session;
}

export async function updateDbSessionTokens(
  sessionId: string,
  accessToken: string,
  refreshToken: string,
  expiresInSeconds: number,
  config: SupabaseConfig,
  fetchFn: typeof fetch = fetch,
  ttlSeconds: number = 8 * 3600
): Promise<void> {
  const now = Date.now();
  const expiresAt = new Date(now + expiresInSeconds * 1000).toISOString();
  const slidingTtl = new Date(now + ttlSeconds * 1000).toISOString();
  await supabaseRequest(
    "/rest/v1/crm_sessions",
    {
      method: "PATCH",
      privileged: true,
      query: { id: "eq." + sessionId },
      body: {
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: expiresAt,
        ttl: slidingTtl,
        updated_at: new Date(now).toISOString()
      }
    },
    config,
    fetchFn
  );
}

export async function getHandoffConversation(
  conversationId: string,
  config: SupabaseConfig,
  fetchFn: typeof fetch = fetch
): Promise<{
  provider_conversation_id: string;
  reason?: string | null;
  state?: string | null;
  assigned_user_id?: string | null;
  assignment_state?: string | null;
  created_at?: string | null;
} | null> {
  const rows = await supabaseRequest<any[]>(
    "/rest/v1/crm_handoffs",
    {
      method: "GET",
      privileged: true,
      query: {
        select: "provider_conversation_id,reason,state,assigned_user_id,assignment_state,created_at",
        business_id: "eq." + config.businessId,
        provider_conversation_id: "eq." + conversationId,
        order: "created_at.desc",
        limit: "1"
      }
    },
    config,
    fetchFn
  ).catch(() => []);
  return rows?.[0] || null;
}

export async function revokeDbSession(
  sessionId: string,
  config: SupabaseConfig,
  fetchFn: typeof fetch = fetch
): Promise<void> {
  await supabaseRequest(
    "/rest/v1/crm_sessions",
    {
      method: "PATCH",
      privileged: true,
      query: { id: "eq." + sessionId },
      body: {
        revoked_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
    },
    config,
    fetchFn
  ).catch(() => {});
}

export async function checkRateLimit(
  key: string,
  config: SupabaseConfig,
  fetchFn: typeof fetch = fetch
): Promise<RateLimitResult> {
  try {
    const result = await supabaseRequest<RateLimitResult>(
      "/rest/v1/rpc/crm_check_rate_limit",
      {
        method: "POST",
        privileged: true,
        body: {
          p_key: key,
          p_max_attempts: 5,
          p_window_seconds: 600,
          p_lockout_seconds: 600
        }
      },
      config,
      fetchFn
    );
    return result || { allowed: true };
  } catch {
    // Fail closed on error? If Supabase RPC is down, allow or return error?
    // Return allowed: true with warning so DB hiccups don't permanently brick login
    return { allowed: true };
  }
}

export async function resetRateLimit(
  key: string,
  config: SupabaseConfig,
  fetchFn: typeof fetch = fetch
): Promise<void> {
  await supabaseRequest(
    "/rest/v1/rpc/crm_reset_rate_limit",
    {
      method: "POST",
      privileged: true,
      body: { p_key: key }
    },
    config,
    fetchFn
  ).catch(() => {});
}

// --- Notifications ---

export async function getNotifications(
  params: {
    userId: string;
    role: "owner" | "worker";
    canValidateTransfers: boolean;
    state?: string;
    limit?: number;
  },
  config: SupabaseConfig,
  fetchFn: typeof fetch = fetch
): Promise<CrmNotification[]> {
  const query: Record<string, string> = {
    select: "*",
    business_id: "eq." + config.businessId,
    order: "created_at.desc",
    limit: String(params.limit || 50)
  };

  if (params.state && params.state !== "all") {
    query.state = "eq." + params.state;
  }

  if (params.role === "worker") {
    query.recipient_role = "in.(worker,all)";
  }

  const notifications = await supabaseRequest<CrmNotification[]>(
    "/rest/v1/crm_notifications",
    {
      privileged: true,
      query
    },
    config,
    fetchFn
  );

  if (!notifications || notifications.length === 0) {
    return [];
  }

  // Filter out transfer_validation if worker lacks transfer validation permission
  let filtered = notifications;
  if (params.role === "worker") {
    filtered = filtered.filter(n => {
      if (n.recipient_user_id && n.recipient_user_id !== params.userId) {
        return false;
      }
      if (n.type === "transfer_validation" && !params.canValidateTransfers) {
        return false;
      }
      return true;
    });
  }

  // Query user read status from crm_notification_reads
  const notificationIds = filtered.map(n => n.id);
  const reads = await supabaseRequest<{ notification_id: string }[]>(
    "/rest/v1/crm_notification_reads",
    {
      privileged: true,
      query: {
        select: "notification_id",
        user_id: "eq." + params.userId,
        notification_id: `in.(${notificationIds.join(",")})`
      }
    },
    config,
    fetchFn
  ).catch(() => []);

  const readSet = new Set((reads || []).map(r => r.notification_id));
  return filtered.map(n => ({
    ...n,
    read: readSet.has(n.id)
  }));
}

export async function markNotificationAsRead(
  notificationId: string,
  userId: string,
  config: SupabaseConfig,
  fetchFn: typeof fetch = fetch
): Promise<void> {
  await supabaseRequest(
    "/rest/v1/crm_notification_reads",
    {
      method: "POST",
      privileged: true,
      prefer: "resolution=ignore-duplicates",
      body: {
        notification_id: notificationId,
        user_id: userId
      }
    },
    config,
    fetchFn
  );
}

export async function markAllNotificationsAsRead(
  notificationIds: string[],
  userId: string,
  config: SupabaseConfig,
  fetchFn: typeof fetch = fetch
): Promise<void> {
  if (notificationIds.length === 0) return;
  const rows = notificationIds.map(id => ({ notification_id: id, user_id: userId }));
  await supabaseRequest(
    "/rest/v1/crm_notification_reads",
    {
      method: "POST",
      privileged: true,
      prefer: "resolution=ignore-duplicates",
      body: rows
    },
    config,
    fetchFn
  );
}

export async function resolveNotification(
  notificationId: string,
  userId: string,
  config: SupabaseConfig,
  fetchFn: typeof fetch = fetch
): Promise<void> {
  await supabaseRequest(
    "/rest/v1/crm_notifications",
    {
      method: "PATCH",
      privileged: true,
      query: {
        id: "eq." + notificationId,
        business_id: "eq." + config.businessId
      },
      body: {
        state: "resolved",
        resolved_at: new Date().toISOString(),
        resolved_by: userId
      }
    },
    config,
    fetchFn
  );
}

export async function createNotification(
  data: {
    eventKey: string;
    type: string;
    priority: string;
    title: string;
    message: string;
    resourceType: string;
    resourceId?: string | null;
    recipientRole?: string;
    recipientUserId?: string | null;
    metadata?: Record<string, any>;
  },
  config: SupabaseConfig,
  fetchFn: typeof fetch = fetch
): Promise<any> {
  return await supabaseRequest(
    "/rest/v1/rpc/crm_create_notification",
    {
      method: "POST",
      privileged: true,
      body: {
        p_business_id: config.businessId,
        p_event_key: data.eventKey,
        p_type: data.type,
        p_priority: data.priority,
        p_title: data.title,
        p_message: data.message,
        p_resource_type: data.resourceType,
        p_resource_id: data.resourceId || null,
        p_recipient_role: data.recipientRole || "all",
        p_recipient_user_id: data.recipientUserId || null,
        p_metadata: data.metadata || {}
      }
    },
    config,
    fetchFn
  );
}

// --- Orders & Receipts ---

export async function getOrders(
  params: {
    orderStatus?: string;
    paymentStatus?: string;
    searchQuery?: string;
    limit?: number;
  },
  config: SupabaseConfig,
  fetchFn: typeof fetch = fetch
): Promise<any[]> {
  const query: Record<string, string> = {
    select: "id,folio,business_id,confirmation_key,conversation_id,customer_ref,items,subtotal_cents,shipping_cents,total_cents,fulfillment,address,delivery_references,payment_method,payment_status,order_status,created_at,updated_at",
    business_id: "eq." + config.businessId,
    order: "created_at.desc",
    limit: String(params.limit || 100)
  };
  if (params.orderStatus && params.orderStatus !== "all") {
    query.order_status = "eq." + params.orderStatus;
  }
  if (params.paymentStatus && params.paymentStatus !== "all") {
    query.payment_status = "eq." + params.paymentStatus;
  }

  const orders = await supabaseRequest<any[]>(
    "/rest/v1/orders",
    {
      privileged: true,
      query
    },
    config,
    fetchFn
  );

  if (!orders || orders.length === 0) return [];

  // Query receipts for these orders
  const orderIds = orders.map(o => o.id);
  const receipts = await supabaseRequest<CrmPaymentReceipt[]>(
    "/rest/v1/crm_payment_receipts",
    {
      privileged: true,
      query: {
        select: "*",
        business_id: "eq." + config.businessId,
        order_id: `in.(${orderIds.join(",")})`,
        order: "created_at.desc"
      }
    },
    config,
    fetchFn
  ).catch(() => []);

  const receiptMap = new Map<string, CrmPaymentReceipt>();
  for (const r of (receipts || [])) {
    if (r.order_id && !receiptMap.has(r.order_id)) {
      receiptMap.set(r.order_id, r);
    }
  }

  let mapped = orders.map(o => ({
    ...o,
    folio: o.folio || `MB-${String(o.id).slice(0, 6).toUpperCase()}`,
    receipt: receiptMap.get(o.id) || null
  }));

  if (params.searchQuery && params.searchQuery.trim()) {
    const q = params.searchQuery.trim().toLowerCase();
    const qClean = q.replace(/^#/, "");
    mapped = mapped.filter(o =>
      (o.folio && (o.folio.toLowerCase().includes(q) || o.folio.toLowerCase().includes(qClean))) ||
      (o.customer_ref && o.customer_ref.toLowerCase().includes(q)) ||
      (o.id && o.id.toLowerCase().includes(qClean))
    );
  }

  return mapped;
}

export async function getOrderDetails(
  orderId: string,
  config: SupabaseConfig,
  fetchFn: typeof fetch = fetch
): Promise<{ order: any; receipts: CrmPaymentReceipt[]; history: CrmOrderHistory[] } | null> {
  const orders = await supabaseRequest<any[]>(
    "/rest/v1/orders",
    {
      privileged: true,
      query: {
        select: "*",
        id: "eq." + orderId,
        business_id: "eq." + config.businessId,
        limit: "1"
      }
    },
    config,
    fetchFn
  );

  const order = orders?.[0];
  if (!order) return null;

  const [receipts, history] = await Promise.all([
    supabaseRequest<CrmPaymentReceipt[]>(
      "/rest/v1/crm_payment_receipts",
      {
        privileged: true,
        query: {
          select: "*",
          business_id: "eq." + config.businessId,
          order_id: "eq." + orderId,
          order: "created_at.desc"
        }
      },
      config,
      fetchFn
    ).catch(() => []),
    supabaseRequest<CrmOrderHistory[]>(
      "/rest/v1/crm_order_history",
      {
        privileged: true,
        query: {
          select: "*",
          business_id: "eq." + config.businessId,
          order_id: "eq." + orderId,
          order: "created_at.desc"
        }
      },
      config,
      fetchFn
    ).catch(() => [])
  ]);

  return { order, receipts: receipts || [], history: history || [] };
}

export async function addOrderHistory(
  entry: {
    orderId: string;
    actorId?: string | null;
    actorRole: string;
    actorEmail?: string | null;
    action: string;
    previousStatus?: string | null;
    newStatus?: string | null;
    notes?: string | null;
  },
  config: SupabaseConfig,
  fetchFn: typeof fetch = fetch
): Promise<void> {
  await supabaseRequest(
    "/rest/v1/crm_order_history",
    {
      method: "POST",
      privileged: true,
      body: {
        business_id: config.businessId,
        order_id: entry.orderId,
        actor_id: entry.actorId || null,
        actor_role: entry.actorRole,
        actor_email: entry.actorEmail || null,
        action: entry.action,
        previous_status: entry.previousStatus || null,
        new_status: entry.newStatus || null,
        notes: entry.notes || null
      }
    },
    config,
    fetchFn
  ).catch(() => {});
}

export async function updateOrderStatus(
  orderId: string,
  newStatus: string,
  config: SupabaseConfig,
  fetchFn: typeof fetch = fetch,
  expectedCurrentStatus?: string
): Promise<any> {
  const query: Record<string, string> = {
    id: "eq." + orderId,
    business_id: "eq." + config.businessId
  };
  if (expectedCurrentStatus) query.order_status = "eq." + expectedCurrentStatus;
  const updated = await supabaseRequest<any[]>(
    "/rest/v1/orders",
    {
      method: "PATCH",
      privileged: true,
      prefer: "return=representation",
      query,
      body: { order_status: newStatus }
    },
    config,
    fetchFn
  );
  return updated?.[0];
}

export async function createPaymentReceipt(
  data: {
    orderId: string;
    storagePath: string;
    fileName: string;
    fileSize?: number;
    mimeType?: string;
    declaredAmountCents?: number | null;
    bankReference?: string | null;
  },
  config: SupabaseConfig,
  fetchFn: typeof fetch = fetch
): Promise<CrmPaymentReceipt> {
  const inserted = await supabaseRequest<CrmPaymentReceipt[]>(
    "/rest/v1/crm_payment_receipts",
    {
      method: "POST",
      privileged: true,
      prefer: "return=representation",
      body: {
        business_id: config.businessId,
        order_id: data.orderId,
        storage_path: data.storagePath,
        file_name: data.fileName,
        file_size: data.fileSize || 0,
        mime_type: data.mimeType || "image/jpeg",
        declared_amount_cents: data.declaredAmountCents ?? null,
        bank_reference: data.bankReference || null,
        status: "pending_validation"
      }
    },
    config,
    fetchFn
  );
  return inserted[0];
}

export async function validateOrderPayment(
  orderId: string,
  userId: string,
  notes?: string,
  config: SupabaseConfig,
  fetchFn: typeof fetch = fetch
): Promise<void> {
  const now = new Date().toISOString();
  const updated = await supabaseRequest<any[]>(
    "/rest/v1/orders",
    {
      method: "PATCH",
      privileged: true,
      prefer: "return=representation",
      query: { id: "eq." + orderId, business_id: "eq." + config.businessId, payment_status: "eq.pending" },
      body: { payment_status: "validated" }
    },
    config,
    fetchFn
  );
  if (!updated?.length) throw new AppHttpError(409, "El pedido ya no está pendiente de pago o no pertenece al negocio", "ORDER_SCOPE_OR_STATE_CONFLICT");

  await supabaseRequest(
    "/rest/v1/crm_payment_receipts",
    {
      method: "PATCH",
      privileged: true,
      query: {
        order_id: "eq." + orderId,
        business_id: "eq." + config.businessId
      },
      body: {
        status: "validated",
        validated_by: userId,
        validated_at: now,
        validation_notes: notes || null
      }
    },
    config,
    fetchFn
  );

  await supabaseRequest(
    "/rest/v1/crm_notifications",
    {
      method: "PATCH",
      privileged: true,
      query: {
        business_id: "eq." + config.businessId,
        resource_id: "eq." + orderId,
        type: "eq.transfer_validation",
        state: "eq.pending"
      },
      body: {
        state: "resolved",
        resolved_at: now,
        resolved_by: userId
      }
    },
    config,
    fetchFn
  );
}

export async function rejectOrderPayment(
  orderId: string,
  userId: string,
  rejectionReason: string,
  config: SupabaseConfig,
  fetchFn: typeof fetch = fetch
): Promise<void> {
  const now = new Date().toISOString();
  const updated = await supabaseRequest<any[]>(
    "/rest/v1/orders",
    {
      method: "PATCH",
      privileged: true,
      prefer: "return=representation",
      query: { id: "eq." + orderId, business_id: "eq." + config.businessId, payment_status: "eq.pending" },
      body: { payment_status: "rejected" }
    },
    config,
    fetchFn
  );
  if (!updated?.length) throw new AppHttpError(409, "El pedido ya no está pendiente de pago o no pertenece al negocio", "ORDER_SCOPE_OR_STATE_CONFLICT");

  await supabaseRequest(
    "/rest/v1/crm_payment_receipts",
    {
      method: "PATCH",
      privileged: true,
      query: {
        order_id: "eq." + orderId,
        business_id: "eq." + config.businessId
      },
      body: {
        status: "rejected",
        validated_by: userId,
        validated_at: now,
        rejection_reason: rejectionReason
      }
    },
    config,
    fetchFn
  );

  await supabaseRequest(
    "/rest/v1/crm_notifications",
    {
      method: "PATCH",
      privileged: true,
      query: {
        business_id: "eq." + config.businessId,
        resource_id: "eq." + orderId,
        type: "eq.transfer_validation",
        state: "eq.pending"
      },
      body: {
        state: "resolved",
        resolved_at: now,
        resolved_by: userId
      }
    },
    config,
    fetchFn
  );
}

const ALLOWED_RECEIPT_MIMES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
const MAX_RECEIPT_SIZE_BYTES = 10 * 1024 * 1024;

export function sanitizeStoragePath(rawPath: string): string {
  const cleaned = String(rawPath || "").trim().replace(/^\/+/, "");
  if (!cleaned || cleaned.includes("..") || cleaned.includes("\\") || /[\0\r\n]/.test(cleaned)) {
    throw new AppHttpError(400, "Ruta de almacenamiento inválida", "INVALID_STORAGE_PATH");
  }
  return cleaned;
}

export function buildControlledReceiptStoragePath(
  businessId: string,
  fileName: string,
  referenceKey?: string | null
): string {
  const safeBiz = String(businessId || "default").replace(/[^a-zA-Z0-9_-]/g, "");
  const safeFile = String(fileName || "receipt.jpg")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 80) || "receipt.jpg";
  const safeRef = String(referenceKey || crypto.randomUUID())
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 64);
  const datePrefix = new Date().toISOString().slice(0, 10);
  return `${safeBiz}/receipts/${datePrefix}/${safeRef}_${safeFile}`;
}

export function decodeBase64Receipt(
  rawBase64: string,
  fallbackMime: string = "image/jpeg"
): { bytes: Uint8Array; mimeType: string } {
  let base64 = String(rawBase64 || "").trim();
  let mimeType = fallbackMime;
  const dataUrlMatch = base64.match(/^data:([^;]+);base64,(.+)$/i);
  if (dataUrlMatch) {
    mimeType = dataUrlMatch[1].trim().toLowerCase();
    base64 = dataUrlMatch[2].trim();
  }
  base64 = base64.replace(/\s+/g, "");
  if (!base64) {
    throw new AppHttpError(400, "Contenido de archivo base64 vacío", "EMPTY_FILE_CONTENT");
  }
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw new AppHttpError(400, "Codificación base64 inválida", "INVALID_BASE64");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  if (bytes.byteLength === 0) {
    throw new AppHttpError(400, "El archivo recibido está vacío", "EMPTY_FILE_CONTENT");
  }
  if (bytes.byteLength > MAX_RECEIPT_SIZE_BYTES) {
    throw new AppHttpError(413, "El archivo excede el tamaño máximo permitido de 10 MB.", "FILE_TOO_LARGE");
  }
  if (!ALLOWED_RECEIPT_MIMES.includes(mimeType)) {
    throw new AppHttpError(415, "Tipo de archivo no permitido. Solo se aceptan JPEG, PNG, WEBP o PDF.", "UNSUPPORTED_MEDIA_TYPE");
  }
  return { bytes, mimeType };
}

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

export async function downloadExternalMedia(
  mediaUrl: string,
  kapsoApiKey?: string | null,
  fallbackMime: string = "image/jpeg",
  fetchFn: typeof fetch = fetch
): Promise<{ bytes: Uint8Array; mimeType: string; fileSize: number }> {
  let parsed: URL;
  try {
    parsed = new URL(String(mediaUrl || "").trim().replace(/\s+/g, ""));
  } catch {
    throw new AppHttpError(400, "URL de medio inválida", "INVALID_MEDIA_URL");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || isDisallowedMediaHost(parsed.hostname)) {
    throw new AppHttpError(400, "Origen de descarga de medio no permitido", "UNSAFE_MEDIA_ORIGIN");
  }

  const headers: Record<string, string> = {
    "Accept": "image/jpeg,image/png,image/webp,application/pdf,*/*"
  };
  if (kapsoApiKey && (parsed.hostname === "api.kapso.ai" || parsed.hostname.endsWith(".kapso.ai"))) {
    headers["X-API-Key"] = kapsoApiKey;
    headers["Authorization"] = `Bearer ${kapsoApiKey}`;
  }

  const res = await timedFetch(fetchFn, parsed.toString(), { method: "GET", headers });
  if (!res.ok) {
    throw new AppHttpError(502, `No fue posible descargar el comprobante desde el proveedor (HTTP ${res.status})`, "MEDIA_DOWNLOAD_FAILED");
  }

  const contentLength = Number(res.headers.get("content-length") || 0);
  if (contentLength > MAX_RECEIPT_SIZE_BYTES) {
    throw new AppHttpError(413, "El archivo excede el tamaño máximo permitido de 10 MB.", "FILE_TOO_LARGE");
  }

  const rawContentType = (res.headers.get("content-type") || fallbackMime).split(";")[0].trim().toLowerCase();
  const mimeType = rawContentType && rawContentType !== "application/octet-stream" ? rawContentType : fallbackMime;
  if (!ALLOWED_RECEIPT_MIMES.includes(mimeType)) {
    throw new AppHttpError(415, "Tipo de archivo no permitido. Solo se aceptan JPEG, PNG, WEBP o PDF.", "UNSUPPORTED_MEDIA_TYPE");
  }

  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  if (bytes.byteLength === 0) {
    throw new AppHttpError(400, "El medio descargado está vacío", "EMPTY_FILE_CONTENT");
  }
  if (bytes.byteLength > MAX_RECEIPT_SIZE_BYTES) {
    throw new AppHttpError(413, "El archivo excede el tamaño máximo permitido de 10 MB.", "FILE_TOO_LARGE");
  }

  return { bytes, mimeType, fileSize: bytes.byteLength };
}

export async function uploadReceiptToPrivateStorage(
  storagePath: string,
  bytes: Uint8Array,
  mimeType: string,
  config: SupabaseConfig,
  fetchFn: typeof fetch = fetch
): Promise<string> {
  const safePath = sanitizeStoragePath(storagePath);
  if (!ALLOWED_RECEIPT_MIMES.includes(mimeType)) {
    throw new AppHttpError(415, "Tipo de archivo no permitido. Solo se aceptan JPEG, PNG, WEBP o PDF.", "UNSUPPORTED_MEDIA_TYPE");
  }
  if (bytes.byteLength > MAX_RECEIPT_SIZE_BYTES) {
    throw new AppHttpError(413, "El archivo excede el tamaño máximo permitido de 10 MB.", "FILE_TOO_LARGE");
  }

  const base = new URL(config.supabaseUrl).origin;
  const encodedPath = safePath.split("/").map(seg => encodeURIComponent(seg)).join("/");
  const target = `${base}/storage/v1/object/payment-receipts/${encodedPath}`;

  const headers: Record<string, string> = {
    "apikey": config.serviceKey,
    "Content-Type": mimeType,
    "x-upsert": "true"
  };
  if (!config.serviceKey.startsWith("sb_secret_")) {
    headers["Authorization"] = `Bearer ${config.serviceKey}`;
  }

  const res = await timedFetch(fetchFn, target, {
    method: "POST",
    headers,
    body: bytes
  });

  if (!res.ok) {
    throw new AppHttpError(502, "Error al almacenar comprobante en bucket privado payment-receipts", "STORAGE_UPLOAD_ERROR");
  }

  return safePath;
}

export async function getSignedReceiptUrl(
  storagePath: string,
  expiresInSeconds: number = 3600,
  config: SupabaseConfig,
  fetchFn: typeof fetch = fetch
): Promise<string | null> {
  try {
    const res = await supabaseRequest<{ signedURL: string }>(
      `/storage/v1/object/sign/payment-receipts/${storagePath}`,
      {
        method: "POST",
        privileged: true,
        body: { expiresIn: expiresInSeconds }
      },
      config,
      fetchFn
    );
    if (!res?.signedURL) return null;
    const base = new URL(config.supabaseUrl).origin;
    return `${base}/storage/v1${res.signedURL}`;
  } catch {
    return null;
  }
}

// --- Order Management Enhancements (DEV-KAPSO-026) ---

export function validateOrderStatusTransition(
  currentStatus: string,
  targetStatus: string,
  fulfillment?: string
): { valid: boolean; reason?: string } {
  if (currentStatus === targetStatus) {
    return { valid: true };
  }

  // Terminal states cannot transition
  if (currentStatus === "delivered" || currentStatus === "cancelled") {
    return {
      valid: false,
      reason: `El pedido ya está en estado final (${currentStatus}) y no puede modificarse.`
    };
  }

  // Cancellation is allowed from any non-terminal state
  if (targetStatus === "cancelled") {
    return { valid: true };
  }

  const allowedTransitions: Record<string, string[]> = {
    received: ["confirmed"],
    confirmed: ["preparing"],
    preparing: ["ready"],
    ready: fulfillment === "pickup" ? ["delivered"] : ["dispatched", "assigned"],
    assigned: ["dispatched", "delivered"],
    dispatched: ["delivered"]
  };

  const nextAllowed = allowedTransitions[currentStatus] || [];
  if (nextAllowed.includes(targetStatus)) {
    return { valid: true };
  }

  return {
    valid: false,
    reason: `Transición no permitida de '${currentStatus}' a '${targetStatus}'. El flujo esperado es: Recibido → Confirmado → En preparación → Listo → ${fulfillment === "pickup" ? "Entregado" : "Enviado → Entregado"}.`
  };
}

export async function ingestPaymentReceipt(
  params: {
    conversationId?: string | null;
    customerPhone?: string | null;
    providerMessageId?: string | null;
    fileName: string;
    fileSize?: number;
    mimeType?: string;
    storagePath?: string | null;
    fileBase64?: string | null;
    mediaUrl?: string | null;
    kapsoApiKey?: string | null;
    declaredAmountCents?: number | null;
    bankReference?: string | null;
    paymentMethod?: "card" | "transfer" | null;
    metadata?: Record<string, any>;
  },
  config: SupabaseConfig,
  fetchFn: typeof fetch = fetch
): Promise<{ receipt: CrmPaymentReceipt; duplicate: boolean; associationState: string }> {
  // 1. Pre-check MIME and declared size before any remote call
  let mime = (params.mimeType || "image/jpeg").toLowerCase();
  const CARD_IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp"];
  if (params.paymentMethod === "card") {
    if (!CARD_IMAGE_MIMES.includes(mime)) {
      throw new AppHttpError(415, "Los comprobantes para tarjeta deben ser imágenes (JPEG, PNG o WEBP). No se aceptan archivos PDF.", "CARD_RECEIPT_MUST_BE_IMAGE");
    }
  } else if (!ALLOWED_RECEIPT_MIMES.includes(mime)) {
    throw new AppHttpError(415, "Tipo de archivo no permitido. Solo se aceptan JPEG, PNG, WEBP o PDF.", "UNSUPPORTED_MEDIA_TYPE");
  }
  let size = Number(params.fileSize) || 0;
  if (size > MAX_RECEIPT_SIZE_BYTES) {
    throw new AppHttpError(413, "El archivo excede el tamaño máximo permitido de 10 MB.", "FILE_TOO_LARGE");
  }

  // 2. Deduplication check by providerMessageId if provided (before downloading/uploading media)
  if (params.providerMessageId) {
    const existing = await supabaseRequest<CrmPaymentReceipt[]>(
      "/rest/v1/crm_payment_receipts",
      {
        privileged: true,
        query: {
          select: "*",
          business_id: "eq." + config.businessId,
          provider_message_id: "eq." + params.providerMessageId,
          limit: "1"
        }
      },
      config,
      fetchFn
    ).catch(() => []);

    if (existing && existing.length > 0) {
      return { receipt: existing[0], duplicate: true, associationState: existing[0].status };
    }
  }

  // 3. Resolve binary content (if fileBase64 or mediaUrl provided) & upload to private Storage
  let finalStoragePath = params.storagePath ? sanitizeStoragePath(params.storagePath) : "";
  if (params.fileBase64) {
    const decoded = decodeBase64Receipt(params.fileBase64, mime);
    mime = decoded.mimeType;
    if (params.paymentMethod === "card" && !CARD_IMAGE_MIMES.includes(mime)) {
      throw new AppHttpError(415, "El archivo decodificado para tarjeta no es una imagen válida (JPEG, PNG o WEBP).", "CARD_RECEIPT_MUST_BE_IMAGE");
    }
    size = decoded.bytes.byteLength;
    const controlledPath = finalStoragePath || buildControlledReceiptStoragePath(
      config.businessId,
      params.fileName,
      params.providerMessageId || params.conversationId
    );
    finalStoragePath = await uploadReceiptToPrivateStorage(controlledPath, decoded.bytes, mime, config, fetchFn);
  } else if (params.mediaUrl) {
    const downloaded = await downloadExternalMedia(params.mediaUrl, params.kapsoApiKey, mime, fetchFn);
    mime = downloaded.mimeType;
    if (params.paymentMethod === "card" && !CARD_IMAGE_MIMES.includes(mime)) {
      throw new AppHttpError(415, "La imagen descargada para tarjeta no es un formato de imagen permitido.", "CARD_RECEIPT_MUST_BE_IMAGE");
    }
    size = downloaded.fileSize;
    const controlledPath = finalStoragePath || buildControlledReceiptStoragePath(
      config.businessId,
      params.fileName,
      params.providerMessageId || params.conversationId
    );
    finalStoragePath = await uploadReceiptToPrivateStorage(controlledPath, downloaded.bytes, mime, config, fetchFn);
  } else if (!finalStoragePath) {
    throw new AppHttpError(400, "Se requiere file_base64, media_url o storage_path válido", "MISSING_RECEIPT_MEDIA");
  }

  // 3. Unambiguous order association
  let candidateOrders: any[] = [];
  if (params.conversationId || params.customerPhone) {
    const targetMethod = params.paymentMethod === "card" ? "card" : "transfer";
    const allPending = await supabaseRequest<any[]>(
      "/rest/v1/orders",
      {
        privileged: true,
        query: {
          select: "id,folio,customer_ref,conversation_id,payment_status,payment_method,total_cents",
          business_id: "eq." + config.businessId,
          payment_method: "eq." + targetMethod,
          payment_status: "eq.pending",
          order: "created_at.desc",
          limit: "20"
        }
      },
      config,
      fetchFn
    ).catch(() => []);

    candidateOrders = (allPending || []).filter(o => {
      const matchConv = params.conversationId && o.conversation_id === params.conversationId;
      const matchPhone = params.customerPhone && (
        o.customer_ref === params.customerPhone ||
        o.customer_ref?.replace(/\D/g, "") === params.customerPhone?.replace(/\D/g, "")
      );
      return matchConv || matchPhone;
    });
  }

  let matchedOrderId: string | null = null;
  let receiptStatus: "pending_validation" | "pending_association" = "pending_association";
  let associationReason: string | null = null;

  if (candidateOrders.length === 1) {
    matchedOrderId = candidateOrders[0].id;
    receiptStatus = "pending_validation";
  } else if (candidateOrders.length > 1) {
    receiptStatus = "pending_association";
    associationReason = "multiple_pending_orders";
  } else {
    receiptStatus = "pending_association";
    associationReason = "no_pending_order";
  }

  const receiptMeta = {
    ...(params.metadata || {}),
    ...(params.paymentMethod ? { payment_method: params.paymentMethod } : {}),
    ...(params.customerPhone ? { customer_phone: params.customerPhone } : {}),
    ...(associationReason ? { association_issue: associationReason, candidate_count: candidateOrders.length } : {})
  };

  // 4. Insert receipt
  const inserted = await supabaseRequest<CrmPaymentReceipt[]>(
    "/rest/v1/crm_payment_receipts",
    {
      method: "POST",
      privileged: true,
      prefer: "return=representation",
      body: {
        business_id: config.businessId,
        order_id: matchedOrderId,
        provider_message_id: params.providerMessageId || null,
        conversation_id: params.conversationId || null,
        storage_path: finalStoragePath,
        file_name: params.fileName,
        file_size: size,
        mime_type: mime,
        declared_amount_cents: params.declaredAmountCents ?? null,
        bank_reference: params.bankReference || null,
        status: receiptStatus,
        metadata: receiptMeta
      }
    },
    config,
    fetchFn
  );

  const receipt = inserted[0];

  // 5. Notifications and history
  if (matchedOrderId) {
    const isCard = params.paymentMethod === "card";
    await createNotification(
      {
        eventKey: `receipt:${receipt.id}`,
        type: "transfer_validation",
        priority: "high",
        title: isCard ? "Comprobante de tarjeta por validar" : "Transferencia por validar",
        message: `${isCard ? "Comprobante de tarjeta" : "Comprobante"} recibido para pedido #${candidateOrders[0].folio || matchedOrderId.slice(0, 8)}`,
        resourceType: "order",
        resourceId: matchedOrderId,
        recipientRole: "all",
        metadata: {
          order_id: matchedOrderId,
          receipt_id: receipt.id,
          declared_amount_cents: receipt.declared_amount_cents,
          payment_method: params.paymentMethod || "transfer"
        }
      },
      config,
      fetchFn
    ).catch(() => {});

    await addOrderHistory(
      {
        orderId: matchedOrderId,
        actorRole: "system",
        actorEmail: "kapso@solidbit.com.mx",
        action: "receipt_received",
        notes: `Comprobante ${params.fileName} asociado automáticamente al pedido`
      },
      config,
      fetchFn
    ).catch(() => {});
  } else {
    await createNotification(
      {
        eventKey: `unassociated_receipt:${receipt.id}`,
        type: "operational_incident",
        priority: "high",
        title: "Comprobante sin pedido asociado",
        message: associationReason === "multiple_pending_orders"
          ? "Se recibió comprobante pero existen múltiples pedidos pendientes (asociación ambigua requerida manualmente)."
          : "Se recibió comprobante pero no se encontró ningún pedido pendiente de transferencia.",
        resourceType: "payment",
        resourceId: receipt.id,
        recipientRole: "all",
        metadata: {
          receipt_id: receipt.id,
          conversation_id: params.conversationId,
          association_issue: associationReason
        }
      },
      config,
      fetchFn
    ).catch(() => {});
  }

  return { receipt, duplicate: false, associationState: receiptStatus };
}


export interface CreateKapsoOrderParams {
  confirmationKey: string;
  providerMessageId?: string | null;
  conversationId?: string | null;
  customerPhone: string;
  items: any[];
  subtotalCents: number;
  shippingCents: number;
  totalCents: number;
  fulfillment: "pickup" | "delivery";
  address?: string | null;
  deliveryReferences?: string | null;
  paymentMethod: "cash" | "transfer" | "card";
  paymentStatus: "pending";
  orderStatus: "received";
  associatedReceiptId?: string | null;
}

/**
 * Converts any arbitrary text string (e.g. an idempotency key) into a deterministic RFC 4122 v5 UUID.
 * Uses the standard DNS namespace (6ba7b810-9dad-11d1-80b4-00c04fd430c8) and SHA-1 as specified in RFC 4122 Section 4.3.
 * If the input is already a valid UUID string, returns it normalized.
 */
export async function toDeterministicUuid(
  input: string,
  namespace: string = "6ba7b810-9dad-11d1-80b4-00c04fd430c8"
): Promise<string> {
  const trimmed = String(input || "").trim().toLowerCase();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
    return trimmed;
  }
  const cleanNs = namespace.replace(/-/g, "");
  const nsBytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    nsBytes[i] = parseInt(cleanNs.substr(i * 2, 2), 16);
  }
  const nameBytes = new TextEncoder().encode(trimmed);
  const combined = new Uint8Array(nsBytes.length + nameBytes.length);
  combined.set(nsBytes);
  combined.set(nameBytes, nsBytes.length);

  const hashBuffer = await crypto.subtle.digest("SHA-1", combined);
  const hash = new Uint8Array(hashBuffer);

  // RFC 4122 Section 4.3: Set octet 6 high nibble to version 5 (0101)
  hash[6] = (hash[6] & 0x0f) | 0x50;
  // RFC 4122 Section 4.3: Set octet 8 high 2 bits to variant 1 (10)
  hash[8] = (hash[8] & 0x3f) | 0x80;

  const hex = Array.from(hash.slice(0, 16)).map(b => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export async function createKapsoOrder(
  params: CreateKapsoOrderParams,
  config: SupabaseConfig,
  fetchFn: typeof fetch = fetch
): Promise<{ order: any; duplicate: boolean }> {
  const confirmationUuid = params.confirmationKey
    ? await toDeterministicUuid(params.confirmationKey)
    : crypto.randomUUID();

  // 1. Check exact confirmation_key idempotency using valid UUID
  // Do NOT hide errors with .catch(() => []): a failure querying Supabase must fail-closed and not proceed to insert.
  if (confirmationUuid) {
    const existingByKey = await supabaseRequest<any[]>(
      "/rest/v1/orders",
      {
        privileged: true,
        query: {
          select: "*",
          business_id: "eq." + config.businessId,
          confirmation_key: "eq." + confirmationUuid,
          limit: "1"
        }
      },
      config,
      fetchFn
    );

    if (existingByKey && existingByKey.length > 0) {
      return { order: existingByKey[0], duplicate: true };
    }
  }

  // 2. Check duplicate message burst (same customer/conversation, same total, same fulfillment in last 90 seconds)
  // Do NOT hide errors with .catch(() => []): a read failure must fail-closed.
  const recentOrders = await supabaseRequest<any[]>(
    "/rest/v1/orders",
    {
      privileged: true,
      query: {
        select: "*",
        business_id: "eq." + config.businessId,
        customer_ref: "eq." + params.customerPhone,
        fulfillment: "eq." + params.fulfillment,
        total_cents: "eq." + params.totalCents,
        order: "created_at.desc",
        limit: "5"
      }
    },
    config,
    fetchFn
  );

  if (recentOrders && recentOrders.length > 0) {
    const latest = recentOrders[0];
    const diffMs = Date.now() - new Date(latest.created_at).getTime();
    if (diffMs >= 0 && diffMs < 90000 && latest.order_status === "received") {
      return { order: latest, duplicate: true };
    }
  }

  const orderId = crypto.randomUUID();
  const rawHex = orderId.replace(/-/g, "").slice(0, 6).toUpperCase();
  const folio = "MB-" + rawHex;

  const inserted = await supabaseRequest<any[]>(
    "/rest/v1/orders",
    {
      method: "POST",
      privileged: true,
      prefer: "return=representation",
      body: {
        id: orderId,
        business_id: config.businessId,
        confirmation_key: confirmationUuid,
        conversation_id: params.conversationId || null,
        customer_ref: params.customerPhone,
        items: params.items,
        subtotal_cents: params.subtotalCents,
        shipping_cents: params.fulfillment === "delivery" ? (params.shippingCents > 0 ? params.shippingCents : 4000) : 0,
        fulfillment: params.fulfillment,
        address: params.fulfillment === "delivery" ? (params.address || null) : null,
        delivery_references: params.fulfillment === "delivery" ? (params.deliveryReferences || "Ubicación compartida por WhatsApp") : null,
        payment_method: params.paymentMethod,
        payment_status: params.paymentStatus,
        order_status: params.orderStatus,
        folio: folio
      }
    },
    config,
    fetchFn
  );

  if (!inserted || inserted.length === 0 || !inserted[0]?.id) {
    throw new AppHttpError(502, "Fallo al confirmar la persistencia del pedido en base de datos", "ORDER_PERSISTENCE_FAILED");
  }

  const newOrder = inserted[0];

  // 3. Link associated payment receipt if present (e.g. card/transfer receipt)
  if (params.associatedReceiptId) {
    await supabaseRequest(
      "/rest/v1/crm_payment_receipts",
      {
        method: "PATCH",
        privileged: true,
        query: {
          id: "eq." + params.associatedReceiptId,
          business_id: "eq." + config.businessId
        },
        body: {
          order_id: orderId,
          status: "pending_validation"
        }
      },
      config,
      fetchFn
    ).catch(() => null);
  }

  // 4. Emit CRM Notification
  const isPendingHumanValidation = params.paymentMethod === "transfer" || params.paymentMethod === "card";
  const notifType = isPendingHumanValidation ? "transfer_validation" : "order_confirmed";
  const notifPriority = isPendingHumanValidation ? "high" : "normal";
  const notifTitle = params.paymentMethod === "card"
    ? "Pedido con tarjeta pendiente (#" + folio + ")"
    : params.paymentMethod === "transfer"
    ? "Pedido por transferencia pendiente (#" + folio + ")"
    : "Nuevo pedido recibido (#" + folio + ")";
  const notifMessage = isPendingHumanValidation
    ? "Pedido #" + folio + " ($" + Math.round(params.totalCents / 100) + ") con pago " + (params.paymentMethod === "card" ? "tarjeta" : "transferencia") + " pendiente de comprobante y validación."
    : "Pedido #" + folio + " (" + (params.fulfillment === "delivery" ? "Domicilio" : "Recoger") + ") recibido por $" + Math.round(params.totalCents / 100) + ".";

  await createNotification(
    {
      businessId: config.businessId,
      eventKey: (isPendingHumanValidation ? "order_validation_pending:" + params.paymentMethod + ":" : "order_confirmed:") + orderId,
      type: notifType,
      priority: notifPriority,
      title: notifTitle,
      message: notifMessage,
      resourceType: "order",
      resourceId: orderId,
      recipientRole: "all",
      metadata: {
        order_id: orderId,
        folio: "#" + folio,
        total_cents: params.totalCents,
        fulfillment: params.fulfillment,
        payment_method: params.paymentMethod,
        payment_status: params.paymentStatus
      }
    },
    config,
    fetchFn
  ).catch(() => null);

  // 5. Record order history
  await addOrderHistory(
    {
      orderId: orderId,
      action: "created",
      newStatus: "received",
      notes: "Pedido registrado vía WhatsApp/Kapso (" + (params.fulfillment === "delivery" ? "Domicilio" : "Para recoger") + ", pago: " + params.paymentMethod + ")",
      actorRole: "system"
    },
    config,
    fetchFn
  ).catch(() => null);

  return { order: newOrder, duplicate: false };
}
