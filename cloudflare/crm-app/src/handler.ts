import type { Env, AuthenticatedUser, DbSessionRow } from "./types.ts";
import { staticAssets } from "./assets.ts";
import {
  parseSessionCookie,
  verifySessionCookieValue,
  createSessionCookieValue,
  buildSetCookieHeader
} from "./session.ts";
import {
  type SupabaseConfig,
  loginWithPassword,
  refreshSessionToken,
  getMembership,
  supabaseRequest,
  createDbSession,
  getDbSession,
  updateDbSessionTokens,
  revokeDbSession,
  checkRateLimit,
  resetRateLimit,
  getNotifications,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  resolveNotification,
  createNotification,
  getOrders,
  getOrderDetails,
  addOrderHistory,
  updateOrderStatus,
  createPaymentReceipt,
  validateOrderPayment,
  rejectOrderPayment,
  getSignedReceiptUrl,
  validateOrderStatusTransition,
  ingestPaymentReceipt,
  getHandoffConversation,
  decodeBase64Receipt,
  downloadExternalMedia,
  buildControlledReceiptStoragePath,
  uploadReceiptToPrivateStorage,
  sanitizeStoragePath
} from "./supabase.ts";
import { resolveInboxEmbed, isValidConversationId, type KapsoEmbedConfig } from "./embed.ts";

function jsonResponse(
  status: number,
  data: any,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' https://*.supabase.co data:; frame-src https://inbox.kapso.ai; base-uri 'none'; object-src 'none'",
      ...extraHeaders
    }
  });
}

function getSessionSecret(env: Env): string {
  return env.SESSION_SECRET || env.SUPABASE_SERVICE_ROLE_KEY;
}

function getSupabaseConfig(env: Env): SupabaseConfig {
  return {
    supabaseUrl: env.SUPABASE_URL,
    publishableKey: env.SUPABASE_PUBLISHABLE_KEY,
    serviceKey: env.SUPABASE_SERVICE_ROLE_KEY,
    businessId: env.CRM_BUSINESS_ID
  };
}

async function authenticate(
  request: Request,
  env: Env,
  fetchFn: typeof fetch
): Promise<AuthenticatedUser | null> {
  try {
    const cookieHeader = request.headers.get("cookie");
    const rawCookie = parseSessionCookie(cookieHeader);
    if (!rawCookie) return null;

    const sessionSecret = getSessionSecret(env);
    const sessionId = await verifySessionCookieValue(rawCookie, sessionSecret);
    if (!sessionId) return null;

    const sbConfig = getSupabaseConfig(env);

    // 1. Fetch server-side opaque session from database
    const session = await getDbSession(sessionId, sbConfig, fetchFn);
    if (!session) return null;

    let token = session.access_token;

    // 2. Refresh token in background if near expiry (< 60 seconds)
    const expiresAtMs = new Date(session.expires_at).getTime();
    if (expiresAtMs < Date.now() + 60_000) {
      try {
        const refreshed = await refreshSessionToken(session.refresh_token, sbConfig, fetchFn);
        token = refreshed.access_token;
        await updateDbSessionTokens(
          sessionId,
          refreshed.access_token,
          refreshed.refresh_token,
          Number(refreshed.expires_in) || 3600,
          sbConfig,
          fetchFn
        );
      } catch {
        // Check if a parallel request just refreshed the session tokens
        const latestSession = await getDbSession(sessionId, sbConfig, fetchFn).catch(() => null);
        if (latestSession && new Date(latestSession.expires_at).getTime() > Date.now()) {
          token = latestSession.access_token;
        } else {
          return null;
        }
      }
    }

    // 3. Always verify role & membership live against Supabase on every request
    const membership = await getMembership(
      token,
      session.user_id,
      env.CRM_BUSINESS_ID,
      sbConfig,
      fetchFn,
      true
    );
    if (!membership || !membership.active || !["owner", "manager", "operator", "worker"].includes(membership.role)) {
      return null;
    }

    return {
      sessionId: session.id,
      userId: session.user_id,
      email: session.email,
      role: membership.role,
      token,
      assigneeId: membership.kapso_assignee_id,
      canValidateTransfers: membership.role === "owner" || membership.role === "manager" || Boolean(membership.can_validate_transfers),
      paymentsReview: membership.role === "owner" || membership.role === "manager" || Boolean(membership.can_validate_transfers)
    };
  } catch {
    return null;
  }
}

export async function handleRequest(
  request: Request,
  env: Env,
  fetchFn: typeof fetch = fetch
): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method;

  // Security guard for state-mutating requests (bypass for server-to-server authenticated requests)
  const isMutating = ["POST", "PATCH", "PUT", "DELETE"].includes(method);
  const hasS2SAuth = Boolean(
    request.headers.get("x-api-key") ||
    request.headers.get("authorization")?.startsWith("Bearer ")
  );
  if (isMutating && !hasS2SAuth) {
    const origin = request.headers.get("origin");
    if (origin && origin !== url.origin) {
      return jsonResponse(403, { error: "Origen no autorizado" });
    }
    const secFetchSite = request.headers.get("sec-fetch-site");
    if (secFetchSite && !["same-origin", "none"].includes(secFetchSite)) {
      return jsonResponse(403, { error: "Solicitud de otro sitio rechazada" });
    }
  }

  // 1. Health check
  if (url.pathname === "/health" || url.pathname === "/health/") {
    if (method !== "GET") {
      return jsonResponse(405, { error: "Only GET is allowed" }, { Allow: "GET" });
    }
    return jsonResponse(200, {
      status: "healthy",
      service: "crm-kapso-app",
      version: env.WORKER_VERSION || "1.1.0",
      commit_sha: env.COMMIT_SHA || "11e1ecf",
      environment: env.ENVIRONMENT || "production",
      deployed_at: "2026-11-19T00:00:00Z"
    });
  }

  // 2. Static Assets (including menu images)
  if (method === "GET" && staticAssets[url.pathname]) {
    const asset = staticAssets[url.pathname];
    if (!asset.content) {
      return jsonResponse(404, { error: "Recurso no disponible en este momento" });
    }
    if (asset.isBase64) {
      const binary = Uint8Array.from(atob(asset.content), c => c.charCodeAt(0));
      return new Response(binary, {
        status: 200,
        headers: {
          "Content-Type": asset.contentType,
          "Cache-Control": "public, max-age=86400",
          "Access-Control-Allow-Origin": "*",
          "X-Content-Type-Options": "nosniff"
        }
      });
    }
    return new Response(asset.content, {
      status: 200,
      headers: {
        "Content-Type": asset.contentType,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "X-Frame-Options": "DENY",
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' https://*.supabase.co data:; frame-src https://inbox.kapso.ai; base-uri 'none'; object-src 'none'"
      }
    });
  }

  // --- MENU IMAGE DISPATCH ENDPOINT (Kapso WhatsApp Integration) ---
  if (method === "POST" && url.pathname === "/api/menu/send-image") {
    // 1. Authenticate (Server-to-Server API key or CRM Session Cookie)
    const authHeader = request.headers.get("authorization") || request.headers.get("x-api-key") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    const validSecrets = [
      env.KAPSO_API_KEY,
      env.SESSION_SECRET,
      env.SUPABASE_SERVICE_ROLE_KEY
    ].filter(Boolean) as string[];

    const isS2S = validSecrets.some(sec => sec === token);
    let authenticatedUser: AuthenticatedUser | null = null;
    if (!isS2S) {
      authenticatedUser = await authenticate(request, env, fetchFn);
      if (!authenticatedUser) {
        return jsonResponse(401, { error: "Autenticación requerida para enviar imágenes del menú" });
      }
    }

    // 2. Parse input body
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return jsonResponse(400, { error: "Payload JSON inválido" });
    }

    // 3. Resolve recipient phone from conversation context or input
    let targetPhone = String(body.customer_phone || body.phone || "").trim();
    const conversationId = String(body.conversation_id || "").trim();

    if (!targetPhone && conversationId) {
      try {
        const sbConfig = getSupabaseConfig(env);
        const events = await supabaseRequest<any[]>(
          "/rest/v1/crm_inbound_events",
          {
            privileged: true,
            query: {
              business_id: "eq." + env.CRM_BUSINESS_ID,
              conversation_id: "eq." + conversationId,
              customer_phone: "not.is.null",
              select: "customer_phone",
              limit: "1"
            }
          },
          sbConfig,
          fetchFn
        );
        if (events && events.length > 0 && events[0]?.customer_phone) {
          targetPhone = events[0].customer_phone;
        } else {
          const orders = await supabaseRequest<any[]>(
            "/rest/v1/orders",
            {
              privileged: true,
              query: {
                business_id: "eq." + env.CRM_BUSINESS_ID,
                conversation_id: "eq." + conversationId,
                customer_phone: "not.is.null",
                select: "customer_phone",
                limit: "1"
              }
            },
            sbConfig,
            fetchFn
          );
          if (orders && orders.length > 0 && orders[0]?.customer_phone) {
            targetPhone = orders[0].customer_phone;
          }
        }
      } catch {
        // Fallback or error handled below
      }
    }

    // Validate phone format (E.164 digits)
    const cleanPhone = targetPhone.replace(/[\s\-\(\)]/g, "");
    if (!cleanPhone || !/^\+?[1-9]\d{7,14}$/.test(cleanPhone)) {
      return jsonResponse(422, {
        error: "No fue posible resolver un destinatario válido desde el contexto de la conversación"
      });
    }

    const whatsappRecipient = cleanPhone.replace(/^\+/, "");

    // 4. Validate connected phone number ID and Kapso credentials
    const expectedPhoneId = "1462335776957834";
    const configuredPhoneId = String(env.KAPSO_PHONE_NUMBER_ID || expectedPhoneId).trim();
    if (configuredPhoneId !== expectedPhoneId) {
      return jsonResponse(500, {
        error: "KAPSO_PHONE_NUMBER_ID no coincide con el número oficial conectado para Mr. Burger"
      });
    }

    if (!env.KAPSO_API_KEY) {
      return jsonResponse(500, {
        error: "KAPSO_API_KEY no configurada en el servidor"
      });
    }

    // 5. Select pages according to requested category
    const category = String(body.category || "all").trim().toLowerCase();
    const crmOrigin = url.origin;

    const page1 = {
      key: "page_1",
      name: "Hamburguesas, Boneless y Complementos",
      url: `${crmOrigin}/menu/mr-burger-hamburguesas-boneless-complementos.png`,
      caption: "🍔 Mr. Burger · Hamburguesas, Boneless y Complementos"
    };

    const page2 = {
      key: "page_2",
      name: "Bebidas, Extras y Postres",
      url: `${crmOrigin}/menu/mr-burger-bebidas-extras-postres.png`,
      caption: "🥤 Mr. Burger · Bebidas, Extras y Postres"
    };

    let pagesToSend: typeof page1[] = [];
    if (["hamburguesas", "boneless", "complementos", "page_1", "1"].includes(category)) {
      pagesToSend = [page1];
    } else if (["bebidas", "extras", "postres", "page_2", "2"].includes(category)) {
      pagesToSend = [page2];
    } else {
      // General request: send both in order
      pagesToSend = [page1, page2];
    }

    // 6. Send each image in order via Kapso Meta Proxy
    const sent: string[] = [];
    const messageIds: string[] = [];

    for (let i = 0; i < pagesToSend.length; i++) {
      const page = pagesToSend[i];
      const kapsoEndpoint = `https://api.kapso.ai/meta/whatsapp/v24.0/${configuredPhoneId}/messages`;
      const messagePayload = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: whatsappRecipient,
        type: "image",
        image: {
          link: page.url,
          caption: page.caption
        }
      };

      let response: Response;
      try {
        response = await fetchFn(kapsoEndpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": env.KAPSO_API_KEY
          },
          body: JSON.stringify(messagePayload)
        });
      } catch (err: any) {
        return jsonResponse(502, {
          ok: false,
          partial: sent.length > 0,
          sent,
          failed: [page.key],
          error: "Error de red al conectar con Kapso/WhatsApp"
        });
      }

      const resJson = await response.json().catch(() => ({}));
      if (!response.ok) {
        const errorMsg = (resJson as any)?.error?.message || `HTTP ${response.status} de API de mensajería`;
        return jsonResponse(response.status >= 500 ? 502 : 400, {
          ok: false,
          partial: sent.length > 0,
          sent,
          failed: [page.key],
          error: errorMsg
        });
      }

      const msgId = (resJson as any)?.messages?.[0]?.id || `wamid.menu_${Date.now()}_${i}`;
      sent.push(page.key);
      messageIds.push(msgId);
    }

    return jsonResponse(200, {
      ok: true,
      sent,
      message_ids: messageIds,
      reply_text: "Claro, aquí está el menú 🍔"
    });
  }

  const sbConfig = getSupabaseConfig(env);

  // 3. Login
  if (method === "POST" && url.pathname === "/api/login") {
    let body: any;
    try {
      body = await request.json();
    } catch {
      return jsonResponse(400, { error: "JSON inválido" });
    }

    const email = String(body?.email || "").trim().toLowerCase();
    const password = String(body?.password || "");
    if (!email || !password || email.length > 254 || password.length > 1024) {
      return jsonResponse(400, { error: "Credenciales inválidas" });
    }

    const clientIp = request.headers.get("cf-connecting-ip") || "local";
    const rateLimitKey = `login:${clientIp}:${email}`;

    // Distributed rate limit check via Supabase RPC
    const rateLimit = await checkRateLimit(rateLimitKey, sbConfig, fetchFn);
    if (!rateLimit.allowed) {
      return jsonResponse(429, {
        error: "Demasiados intentos; vuelve más tarde",
        retry_after: rateLimit.retry_after || 600
      });
    }

    let auth;
    try {
      auth = await loginWithPassword(email, password, sbConfig, fetchFn);
    } catch {
      return jsonResponse(401, { error: "Credenciales inválidas" });
    }

    if (!auth?.access_token || !auth?.user?.id) {
      return jsonResponse(401, { error: "Credenciales inválidas" });
    }

    const membership = await getMembership(auth.access_token, auth.user.id, env.CRM_BUSINESS_ID, sbConfig, fetchFn);
    if (!membership?.active || !["owner", "worker"].includes(membership.role)) {
      return jsonResponse(403, { error: "Usuario sin acceso a este negocio" });
    }

    // Reset rate limit on successful authentication
    await resetRateLimit(rateLimitKey, sbConfig, fetchFn);

    // Create server-side opaque session in database
    const dbSession = await createDbSession(
      {
        userId: auth.user.id,
        businessId: env.CRM_BUSINESS_ID,
        accessToken: auth.access_token,
        refreshToken: auth.refresh_token,
        role: membership.role,
        kapsoAssigneeId: membership.kapso_assignee_id,
        email,
        expiresInSeconds: Number(auth.expires_in) || 3600
      },
      sbConfig,
      fetchFn
    );

    // Emit signed opaque cookie with session ID only
    const sessionSecret = getSessionSecret(env);
    const cookieVal = await createSessionCookieValue(dbSession.id, sessionSecret);
    const cookieHeader = buildSetCookieHeader(cookieVal);

    return jsonResponse(200, { email, role: membership.role }, { "Set-Cookie": cookieHeader });
  }

  // 4. Logout (Immediate server-side revocation)
  if (method === "POST" && url.pathname === "/api/logout") {
    const cookieHeader = request.headers.get("cookie");
    const rawCookie = parseSessionCookie(cookieHeader);
    if (rawCookie) {
      const sessionSecret = getSessionSecret(env);
      const sessionId = await verifySessionCookieValue(rawCookie, sessionSecret);
      if (sessionId) {
        await revokeDbSession(sessionId, sbConfig, fetchFn);
      }
    }
    const eraseHeader = buildSetCookieHeader("", true);
    return jsonResponse(200, { ok: true }, { "Set-Cookie": eraseHeader });
  }

  // 5. Authenticate remaining routes
  const user = await authenticate(request, env, fetchFn);
  if (!user) {
    return jsonResponse(401, { error: "Sesión requerida" });
  }

  try {
    // GET /api/me
    if (method === "GET" && url.pathname === "/api/me") {
      return jsonResponse(200, {
        email: user.email,
        role: user.role,
        assignee_id: user.assigneeId || null,
        can_validate_transfers: Boolean(user.canValidateTransfers),
        payments_review: Boolean(user.paymentsReview)
      });
    }

    // Both CRM inbox views resolve to the same authenticated, role-checked embed.
    if (
      method === "GET" &&
      (url.pathname === "/api/handoff" || url.pathname === "/api/inbox-embed")
    ) {
      const requestedConvId =
        url.searchParams.get("conversation_id")?.trim() ||
        url.searchParams.get("target_conversation_id")?.trim() ||
        null;
      let targetConversation: {
        id: string;
        found: boolean;
        authorized: boolean;
        reason?: string | null;
        state?: string | null;
        assigned_user_id?: string | null;
        message?: string;
      } | null = null;

      let verifiedConversationId: string | null = null;
      if (requestedConvId) {
        if (!isValidConversationId(requestedConvId)) {
          return jsonResponse(400, { error: "Identificador de conversación inválido" });
        }
        const handoffRow = await getHandoffConversation(requestedConvId, sbConfig, fetchFn);
        const expectedWorkerId = user.assigneeId || env.KAPSO_WORKER_ASSIGNEE_ID;
        const isUnauthorizedWorker =
          user.role === "worker" &&
          Boolean(handoffRow?.assigned_user_id) &&
          handoffRow!.assigned_user_id !== expectedWorkerId;

        if (isUnauthorizedWorker) {
          targetConversation = {
            id: requestedConvId,
            found: false,
            authorized: false,
            message: "Esta conversación está asignada a otro agente."
          };
        } else if (handoffRow) {
          verifiedConversationId = requestedConvId;
          targetConversation = {
            id: requestedConvId,
            found: true,
            authorized: true,
            reason: handoffRow.reason || null,
            state: handoffRow.state || null,
            assigned_user_id: handoffRow.assigned_user_id || null
          };
        } else {
          verifiedConversationId = requestedConvId;
          targetConversation = {
            id: requestedConvId,
            found: false,
            authorized: true,
            message: "No se encontró registro previo de handoff para este identificador, pero se propagó al visor."
          };
        }
      }

      const kapsoConfig: KapsoEmbedConfig = {
        ownerEmbedUrl: env.KAPSO_OWNER_EMBED_URL,
        workerEmbedUrl: env.KAPSO_WORKER_EMBED_URL,
        workerApproved: env.KAPSO_WORKER_EMBED_APPROVED === "true",
        workerAssigneeId: user.assigneeId || env.KAPSO_WORKER_ASSIGNEE_ID,
        conversationId: verifiedConversationId
      };

      if (user.role === "worker" && user.assigneeId !== env.KAPSO_WORKER_ASSIGNEE_ID) {
        kapsoConfig.workerApproved = false;
      }

      const embed = resolveInboxEmbed(user.role, kapsoConfig);
      return jsonResponse(
        200,
        embed.available
          ? {
              status: "ready",
              embed_url: embed.url,
              ...(targetConversation ? { target_conversation: targetConversation } : {})
            }
          : {
              status: "pending_integration",
              message: embed.reason,
              ...(targetConversation ? { target_conversation: targetConversation } : {})
            }
      );
    }

  // --- NOTIFICATIONS API (Owner and Worker) ---

  // GET /api/notifications
  if (method === "GET" && url.pathname === "/api/notifications") {
    const state = url.searchParams.get("state") || "pending";
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
    const notifications = await getNotifications(
      {
        userId: user.userId,
        role: user.role,
        canValidateTransfers: Boolean(user.canValidateTransfers),
        state,
        limit
      },
      sbConfig,
      fetchFn
    );
    return jsonResponse(200, { notifications });
  }

  // POST /api/notifications/:id/read
  const readNotificationMatch = url.pathname.match(/^\/api\/notifications\/([^/]+)\/read$/);
  if (method === "POST" && readNotificationMatch) {
    const notificationId = readNotificationMatch[1];
    await markNotificationAsRead(notificationId, user.userId, sbConfig, fetchFn);
    return jsonResponse(200, { ok: true, id: notificationId });
  }

  // POST /api/notifications/read-all
  if (method === "POST" && url.pathname === "/api/notifications/read-all") {
    const body = await request.json().catch(() => ({}));
    let ids: string[] = Array.isArray(body?.ids) ? body.ids : [];
    if (ids.length === 0) {
      const list = await getNotifications(
        {
          userId: user.userId,
          role: user.role,
          canValidateTransfers: Boolean(user.canValidateTransfers),
          state: "all",
          limit: 100
        },
        sbConfig,
        fetchFn
      );
      ids = list.filter(n => !n.read).map(n => n.id);
    }
    await markAllNotificationsAsRead(ids, user.userId, sbConfig, fetchFn);
    return jsonResponse(200, { ok: true, count: ids.length });
  }

  // POST /api/notifications/:id/resolve
  const resolveNotificationMatch = url.pathname.match(/^\/api\/notifications\/([^/]+)\/resolve$/);
  if (method === "POST" && resolveNotificationMatch) {
    const notificationId = resolveNotificationMatch[1];
    await resolveNotification(notificationId, user.userId, sbConfig, fetchFn);
    return jsonResponse(200, { ok: true, id: notificationId });
  }

  // --- ORDERS API (Owner and Worker) ---

  // GET /api/orders
  if (method === "GET" && url.pathname === "/api/orders") {
    const orderStatus = url.searchParams.get("status") || url.searchParams.get("order_status") || undefined;
    const paymentStatus = url.searchParams.get("payment_status") || undefined;
    const searchQuery = url.searchParams.get("q") || url.searchParams.get("search") || undefined;
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 100));
    const orders = await getOrders({ orderStatus, paymentStatus, searchQuery, limit }, sbConfig, fetchFn);
    return jsonResponse(200, { orders });
  }

  // GET /api/orders/:id
  const orderDetailMatch = url.pathname.match(/^\/api\/orders\/([0-9a-f-]{36})$/i);
  if (method === "GET" && orderDetailMatch) {
    const orderId = orderDetailMatch[1];
    const details = await getOrderDetails(orderId, sbConfig, fetchFn);
    if (!details) {
      return jsonResponse(404, { error: "Pedido no encontrado" });
    }
    return jsonResponse(200, details);
  }

  // PATCH /api/orders/:id/status
  const orderStatusMatch = url.pathname.match(/^\/api\/orders\/([0-9a-f-]{36})\/status$/i);
  if (method === "PATCH" && orderStatusMatch) {
    const orderId = orderStatusMatch[1];
    const body = await request.json().catch(() => null);
    const newStatus = String(body?.order_status || "").trim().toLowerCase();
    const notes = typeof body?.notes === "string" ? body.notes.trim() : "";
    const validStatuses = ["received", "confirmed", "preparing", "ready", "assigned", "dispatched", "delivered", "cancelled"];
    if (!validStatuses.includes(newStatus)) {
      return jsonResponse(400, { error: "Estado de pedido inválido" });
    }

    const details = await getOrderDetails(orderId, sbConfig, fetchFn);
    if (!details) {
      return jsonResponse(404, { error: "Pedido no encontrado" });
    }
    const previousStatus = details.order.order_status;

    // Idempotent retry: if already in requested status, return success with duplicate: true
    if (previousStatus === newStatus) {
      return jsonResponse(200, { ok: true, order: details.order, duplicate: true });
    }

    // Validate state transition rule (Fase 5)
    const transition = validateOrderStatusTransition(previousStatus, newStatus, details.order.fulfillment);
    if (!transition.valid) {
      return jsonResponse(422, { error: transition.reason });
    }

    const updated = await updateOrderStatus(orderId, newStatus, sbConfig, fetchFn, previousStatus);
    if (!updated) {
      // Check if a concurrent request already transitioned to newStatus
      const recheck = await getOrderDetails(orderId, sbConfig, fetchFn);
      if (recheck?.order?.order_status === newStatus) {
        return jsonResponse(200, { ok: true, order: recheck.order, duplicate: true });
      }
      return jsonResponse(409, { error: "El pedido cambió mientras se procesaba la solicitud; vuelve a cargarlo." });
    }

    await addOrderHistory(
      {
        orderId,
        actorId: user.userId,
        actorRole: user.role,
        actorEmail: user.email,
        action: "status_change",
        previousStatus,
        newStatus,
        notes: notes || `Cambio de estado a ${newStatus}`
      },
      sbConfig,
      fetchFn
    );

    if (newStatus === "confirmed" && previousStatus !== "confirmed") {
      await createNotification(
        {
          eventKey: `order_confirmed:${orderId}`,
          type: "order_confirmed",
          priority: "normal",
          title: "Pedido confirmado",
          message: `El pedido #${orderId.slice(0, 8)} ha sido confirmado y está listo para preparación`,
          resourceType: "order",
          resourceId: orderId,
          recipientRole: "all",
          metadata: { order_id: orderId, total_cents: details.order.total_cents }
        },
        sbConfig,
        fetchFn
      ).catch(() => {});
    }

    return jsonResponse(200, { ok: true, order: updated });
  }

  // POST /api/orders/:id/dispatch ("Marcar como enviado" - Fase 5)
  const orderDispatchMatch = url.pathname.match(/^\/api\/orders\/([0-9a-f-]{36})\/dispatch$/i);
  if (method === "POST" && orderDispatchMatch) {
    const orderId = orderDispatchMatch[1];
    const details = await getOrderDetails(orderId, sbConfig, fetchFn);
    if (!details) {
      return jsonResponse(404, { error: "Pedido no encontrado" });
    }

    if (details.order.fulfillment !== "delivery") {
      return jsonResponse(400, {
        error: "Solo los pedidos con entrega a domicilio pueden marcarse como enviados."
      });
    }

    // Idempotent retry: if order was already dispatched, return idempotent 200 without duplicate history
    if (details.order.order_status === "dispatched") {
      return jsonResponse(200, {
        ok: true,
        order_status: "dispatched",
        duplicate: true,
        notice: {
          enabled: env.ENABLE_SUPABASE_SYNC === "true",
          order_id: orderId,
          customer_ref: details.order.customer_ref,
          status: "dispatched",
          sent: false
        }
      });
    }

    if (details.order.order_status !== "ready") {
      return jsonResponse(422, {
        error: `No se puede marcar como enviado un pedido en estado '${details.order.order_status}'. Debe estar listo para entrega.`
      });
    }

    const previousStatus = details.order.order_status;
    const updated = await updateOrderStatus(orderId, "dispatched", sbConfig, fetchFn, "ready");
    if (!updated) {
      // Re-fetch to check if a concurrent dispatch request just completed
      const recheck = await getOrderDetails(orderId, sbConfig, fetchFn);
      if (recheck?.order?.order_status === "dispatched") {
        return jsonResponse(200, {
          ok: true,
          order_status: "dispatched",
          duplicate: true,
          notice: {
            enabled: env.ENABLE_SUPABASE_SYNC === "true",
            order_id: orderId,
            customer_ref: details.order.customer_ref,
            status: "dispatched",
            sent: false
          }
        });
      }
      return jsonResponse(409, { error: "El pedido cambió mientras se procesaba la solicitud; vuelve a cargarlo." });
    }

    await addOrderHistory(
      {
        orderId,
        actorId: user.userId,
        actorRole: user.role,
        actorEmail: user.email,
        action: "mark_dispatched",
        previousStatus,
        newStatus: "dispatched",
        notes: "Pedido despachado / marcado como enviado para entrega a domicilio"
      },
      sbConfig,
      fetchFn
    );

    const outboundCustomerNotice = {
      enabled: env.ENABLE_SUPABASE_SYNC === "true",
      order_id: orderId,
      customer_ref: details.order.customer_ref,
      status: "dispatched",
      sent: false
    };

    return jsonResponse(200, { ok: true, order_status: "dispatched", notice: outboundCustomerNotice });
  }

  // POST /api/receipts/ingest (Recepción de comprobantes con descarga segura, Storage privado y asociación inequívoca)
  if (method === "POST" && url.pathname === "/api/receipts/ingest") {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return jsonResponse(400, { error: "JSON inválido" });
    }

    const fileName = String(body.file_name || body.fileName || "comprobante.jpg").trim();
    const storagePath = String(body.storage_path || body.storagePath || "").trim();
    const fileBase64 = body.file_base64 || body.fileBase64 ? String(body.file_base64 || body.fileBase64) : null;
    const mediaUrl = body.media_url || body.mediaUrl ? String(body.media_url || body.mediaUrl).trim() : null;

    if (!fileName || (!storagePath && !fileBase64 && !mediaUrl)) {
      return jsonResponse(400, { error: "Se requiere file_name junto con file_base64, media_url o storage_path" });
    }

    const result = await ingestPaymentReceipt(
      {
        conversationId: body.conversation_id ? String(body.conversation_id) : null,
        customerPhone: body.customer_phone ? String(body.customer_phone) : null,
        providerMessageId: body.provider_message_id ? String(body.provider_message_id) : null,
        fileName,
        fileSize: Number(body.file_size) || 0,
        mimeType: String(body.mime_type || "image/jpeg"),
        storagePath: storagePath || null,
        fileBase64,
        mediaUrl,
        kapsoApiKey: (env as any).KAPSO_API_KEY || null,
        declaredAmountCents: body.declared_amount_cents !== undefined ? Number(body.declared_amount_cents) : null,
        bankReference: body.bank_reference ? String(body.bank_reference).trim() : null,
        metadata: body.metadata || {}
      },
      sbConfig,
      fetchFn
    );

    return jsonResponse(result.duplicate ? 200 : 201, {
      ok: true,
      receipt: result.receipt,
      duplicate: result.duplicate,
      association_state: result.associationState
    });
  }

  // POST /api/orders/:id/receipt
  const orderReceiptUploadMatch = url.pathname.match(/^\/api\/orders\/([0-9a-f-]{36})\/receipt$/i);
  if (method === "POST" && orderReceiptUploadMatch) {
    const orderId = orderReceiptUploadMatch[1];
    const body = await request.json().catch(() => null);
    const fileName = String(body?.file_name || body?.fileName || "").trim();
    const rawStoragePath = String(body?.storage_path || body?.storagePath || "").trim();
    const fileBase64 = body?.file_base64 || body?.fileBase64 ? String(body.file_base64 || body.fileBase64) : null;
    const mediaUrl = body?.media_url || body?.mediaUrl ? String(body.media_url || body.mediaUrl).trim() : null;
    if (!fileName || (!rawStoragePath && !fileBase64 && !mediaUrl)) {
      return jsonResponse(400, { error: "Datos de comprobante incompletos" });
    }

    const orderDetails = await getOrderDetails(orderId, sbConfig, fetchFn);
    if (!orderDetails) {
      return jsonResponse(404, { error: "Pedido no encontrado" });
    }

    let finalMime = String(body.mime_type || "image/jpeg").toLowerCase();
    let finalSize = Number(body.file_size) || 0;
    let finalStoragePath = rawStoragePath ? sanitizeStoragePath(rawStoragePath) : "";

    if (fileBase64) {
      const decoded = decodeBase64Receipt(fileBase64, finalMime);
      finalMime = decoded.mimeType;
      finalSize = decoded.bytes.byteLength;
      const controlledPath = finalStoragePath || buildControlledReceiptStoragePath(env.CRM_BUSINESS_ID, fileName, orderId);
      finalStoragePath = await uploadReceiptToPrivateStorage(controlledPath, decoded.bytes, finalMime, sbConfig, fetchFn);
    } else if (mediaUrl) {
      const downloaded = await downloadExternalMedia(mediaUrl, (env as any).KAPSO_API_KEY || null, finalMime, fetchFn);
      finalMime = downloaded.mimeType;
      finalSize = downloaded.fileSize;
      const controlledPath = finalStoragePath || buildControlledReceiptStoragePath(env.CRM_BUSINESS_ID, fileName, orderId);
      finalStoragePath = await uploadReceiptToPrivateStorage(controlledPath, downloaded.bytes, finalMime, sbConfig, fetchFn);
    }

    const receipt = await createPaymentReceipt(
      {
        orderId,
        storagePath: finalStoragePath,
        fileName,
        fileSize: finalSize,
        mimeType: finalMime,
        declaredAmountCents: body.declared_amount_cents !== undefined ? Number(body.declared_amount_cents) : null,
        bankReference: body.bank_reference ? String(body.bank_reference).trim() : null
      },
      sbConfig,
      fetchFn
    );

    await createNotification(
      {
        eventKey: `receipt:${receipt.id}`,
        type: "transfer_validation",
        priority: "high",
        title: "Transferencia por validar",
        message: `Comprobante recibido para pedido #${orderId.slice(0, 8)}`,
        resourceType: "order",
        resourceId: orderId,
        recipientRole: "all",
        metadata: {
          order_id: orderId,
          receipt_id: receipt.id,
          declared_amount_cents: receipt.declared_amount_cents
        }
      },
      sbConfig,
      fetchFn
    ).catch(() => {});

    await addOrderHistory(
      {
        orderId,
        actorId: user.userId,
        actorRole: user.role,
        actorEmail: user.email,
        action: "upload_receipt",
        notes: `Comprobante adjuntado: ${fileName}`
      },
      sbConfig,
      fetchFn
    );

    return jsonResponse(201, { ok: true, receipt });
  }

  // GET /api/orders/:id/receipt-url
  const orderReceiptUrlMatch = url.pathname.match(/^\/api\/orders\/([0-9a-f-]{36})\/receipt-url$/i);
  if (method === "GET" && orderReceiptUrlMatch) {
    const orderId = orderReceiptUrlMatch[1];
    const details = await getOrderDetails(orderId, sbConfig, fetchFn);
    if (!details || details.receipts.length === 0) {
      return jsonResponse(404, { error: "Comprobante no encontrado" });
    }
    const latestReceipt = details.receipts[0];
    const signedUrl = await getSignedReceiptUrl(latestReceipt.storage_path, 3600, sbConfig, fetchFn);
    return jsonResponse(200, {
      ok: true,
      receipt: latestReceipt,
      signed_url: signedUrl
    });
  }

  // POST /api/orders/:id/validate-payment
  const validatePaymentMatch = url.pathname.match(/^\/api\/orders\/([0-9a-f-]{36})\/validate-payment$/i);
  if (method === "POST" && validatePaymentMatch) {
    const orderId = validatePaymentMatch[1];
    if (!user.canValidateTransfers && !user.paymentsReview) {
      return jsonResponse(403, { error: "Acceso denegado: permiso para validar transferencias (payments.review) requerido" });
    }

    const body = await request.json().catch(() => null);
    if (body?.confirmed_bank_deposit !== true) {
      return jsonResponse(400, { error: "Se requiere confirmación explícita de verificación en cuenta bancaria" });
    }
    const notes = typeof body?.notes === "string" ? body.notes.trim() : "";

    const details = await getOrderDetails(orderId, sbConfig, fetchFn);
    if (!details) {
      return jsonResponse(404, { error: "Pedido no encontrado" });
    }
    if (details.order.payment_status === "validated") {
      return jsonResponse(409, { error: "El pago ya ha sido validado previamente" });
    }

    await validateOrderPayment(orderId, user.userId, notes, sbConfig, fetchFn);

    await addOrderHistory(
      {
        orderId,
        actorId: user.userId,
        actorRole: user.role,
        actorEmail: user.email,
        action: "validate_payment",
        previousStatus: details.order.payment_status,
        newStatus: "validated",
        notes: notes || "Abono verificado en cuenta bancaria"
      },
      sbConfig,
      fetchFn
    );

    return jsonResponse(200, { ok: true, payment_status: "validated" });
  }

  // POST /api/orders/:id/reject-payment
  const rejectPaymentMatch = url.pathname.match(/^\/api\/orders\/([0-9a-f-]{36})\/reject-payment$/i);
  if (method === "POST" && rejectPaymentMatch) {
    const orderId = rejectPaymentMatch[1];
    if (!user.canValidateTransfers && !user.paymentsReview) {
      return jsonResponse(403, { error: "Acceso denegado: permiso para validar transferencias (payments.review) requerido" });
    }

    const body = await request.json().catch(() => null);
    const reason = String(body?.rejection_reason || "").trim();
    if (!reason) {
      return jsonResponse(400, { error: "El motivo de rechazo es obligatorio" });
    }

    const details = await getOrderDetails(orderId, sbConfig, fetchFn);
    if (!details) {
      return jsonResponse(404, { error: "Pedido no encontrado" });
    }
    if (details.order.payment_status !== "pending") {
      return jsonResponse(409, { error: "El pago ya fue procesado previamente" });
    }

    await rejectOrderPayment(orderId, user.userId, reason, sbConfig, fetchFn);

    const latestReceiptId = details.receipts?.[0]?.id || "order";
    await createNotification(
      {
        eventKey: `reject_payment:${orderId}:${latestReceiptId}`,
        type: "operational_incident",
        priority: "high",
        title: "Comprobante rechazado",
        message: `Comprobante rechazado para pedido #${orderId.slice(0, 8)}: ${reason}`,
        resourceType: "order",
        resourceId: orderId,
        recipientRole: "all",
        metadata: { order_id: orderId, rejection_reason: reason }
      },
      sbConfig,
      fetchFn
    );

    await addOrderHistory(
      {
        orderId,
        actorId: user.userId,
        actorRole: user.role,
        actorEmail: user.email,
        action: "reject_payment",
        previousStatus: details.order.payment_status,
        newStatus: "rejected",
        notes: `Rechazado: ${reason}`
      },
      sbConfig,
      fetchFn
    );

    return jsonResponse(200, { ok: true, payment_status: "rejected" });
  }

  // --- MENU MANAGEMENT ENDPOINTS (Mr. Burger CRM) ---
  // GET /api/menu: owner and manager
  if (method === "GET" && url.pathname === "/api/menu") {
    if (user.role !== "owner" && user.role !== "manager") {
      return jsonResponse(403, { error: "Acceso restringido al propietario" });
    }
    const [products, modifiers] = await Promise.all([
      supabaseRequest<any[]>(
        "/rest/v1/menu_products",
        {
          privileged: true,
          query: {
            select: "sku,category,name,price_cents,description,active",
            order: "category.asc,name.asc",
            limit: "500"
          }
        },
        sbConfig,
        fetchFn
      ),
      supabaseRequest<any[]>(
        "/rest/v1/menu_modifiers",
        {
          privileged: true,
          query: {
            select: "sku,name,price_cents,category,requires_review",
            order: "category.asc,name.asc",
            limit: "500"
          }
        },
        sbConfig,
        fetchFn
      )
    ]);
    return jsonResponse(200, { products: products || [], modifiers: modifiers || [] });
  }

  // POST /api/menu: add new product to the active menu (owner and manager)
  if (method === "POST" && url.pathname === "/api/menu") {
    if (user.role !== "owner" && user.role !== "manager") {
      return jsonResponse(403, { error: "Acceso denegado: se requiere rol administrativo para agregar productos" });
    }
    const body = await request.json().catch(() => null);
    const sku = String(body?.sku || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    const name = String(body?.name || "").trim();
    const category = String(body?.category || "Hamburguesas").trim();
    const description = String(body?.description || "").trim();
    const priceCents = Math.round(Number(body?.price_cents));
    const active = body?.active !== false;

    if (!sku || sku.length < 2 || sku.length > 80) {
      return jsonResponse(400, { error: "El código SKU es obligatorio (2-80 caracteres alfanuméricos)" });
    }
    if (!name || name.length < 2 || name.length > 200) {
      return jsonResponse(400, { error: "El nombre del producto es obligatorio (2-200 caracteres)" });
    }
    if (!Number.isFinite(priceCents) || priceCents < 0) {
      return jsonResponse(400, { error: "El precio en centavos debe ser un valor positivo" });
    }

    const created = await supabaseRequest<any[]>(
      "/rest/v1/menu_products",
      {
        method: "POST",
        privileged: true,
        prefer: "return=representation",
        body: {
          sku,
          name,
          category,
          price_cents: priceCents,
          description,
          active
        }
      },
      sbConfig,
      fetchFn
    );

    return jsonResponse(201, { ok: true, product: created?.[0] });
  }

  // PATCH /api/menu/:sku: activate or deactivate product (owner and manager)
  const menuSkuMatch = url.pathname.match(/^\/api\/menu\/([a-z0-9_-]+)$/i);
  if (method === "PATCH" && menuSkuMatch) {
    if (user.role !== "owner" && user.role !== "manager") {
      return jsonResponse(403, { error: "Acceso denegado: se requiere rol administrativo para modificar el menú" });
    }
    const targetSku = menuSkuMatch[1].toLowerCase();
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return jsonResponse(400, { error: "Cuerpo de solicitud inválido" });
    }

    const updates: Record<string, any> = {};
    if (body.active !== undefined) updates.active = Boolean(body.active);
    if (body.price_cents !== undefined) {
      const p = Math.round(Number(body.price_cents));
      if (!Number.isFinite(p) || p < 0) return jsonResponse(400, { error: "Precio inválido" });
      updates.price_cents = p;
    }
    if (body.name !== undefined) updates.name = String(body.name).trim();
    if (body.description !== undefined) updates.description = String(body.description).trim();
    if (body.category !== undefined) updates.category = String(body.category).trim();

    if (Object.keys(updates).length === 0) {
      return jsonResponse(400, { error: "Sin campos para actualizar" });
    }

    const updated = await supabaseRequest<any[]>(
      "/rest/v1/menu_products",
      {
        method: "PATCH",
        privileged: true,
        prefer: "return=representation",
        query: { sku: "eq." + targetSku },
        body: updates
      },
      sbConfig,
      fetchFn
    );

    if (!updated || updated.length === 0) {
      return jsonResponse(404, { error: "Producto no encontrado en el menú" });
    }

    return jsonResponse(200, { ok: true, product: updated[0] });
  }

  // All remaining routes require "owner" role
  if (user.role !== "owner") {
    return jsonResponse(403, { error: "Acceso restringido al propietario" });
  }

  // GET /api/inventory
    if (method === "GET" && url.pathname === "/api/inventory") {
      const products = await supabaseRequest<any[]>(
        "/rest/v1/crm_inventory",
        {
          token: user.token,
          query: {
            select: "id,sku,name,unit,stock_quantity,minimum_quantity,active,updated_at",
            business_id: "eq." + env.CRM_BUSINESS_ID,
            order: "name.asc",
            limit: "500"
          }
        },
        sbConfig,
        fetchFn
      );
      const lowStock = products.filter(
        p => p.active && Number(p.minimum_quantity) > 0 && Number(p.stock_quantity) <= Number(p.minimum_quantity)
      );
      return jsonResponse(200, { products, lowStock });
    }

    // POST /api/inventory
    if (method === "POST" && url.pathname === "/api/inventory") {
      const body = await request.json().catch(() => null);
      const sku = String(body?.sku || "").trim();
      const name = String(body?.name || "").trim();
      const unit = String(body?.unit || "piece");
      if (!sku || sku.length > 80 || !name || name.length > 200 || !["piece", "kg", "g", "l", "ml"].includes(unit)) {
        return jsonResponse(400, { error: "Producto inválido" });
      }
      const minQty = Math.max(0, Number(body?.minimum_quantity) || 0);

      const created = await supabaseRequest<any[]>(
        "/rest/v1/crm_inventory",
        {
          method: "POST",
          token: user.token,
          prefer: "return=representation",
          body: {
            business_id: env.CRM_BUSINESS_ID,
            sku,
            name,
            unit,
            minimum_quantity: minQty,
            stock_quantity: 0,
            active: true
          }
        },
        sbConfig,
        fetchFn
      );
      return jsonResponse(201, created[0]);
    }

    // POST /api/inventory/:id/adjust
    const adjustMatch = url.pathname.match(/^\/api\/inventory\/([^/]+)\/adjust$/);
    if (method === "POST" && adjustMatch) {
      const productId = adjustMatch[1];
      const body = await request.json().catch(() => null);
      const delta = Number(body?.delta);
      const reason = String(body?.reason || "").trim();
      if (!Number.isFinite(delta) || delta === 0 || !reason || reason.length > 200) {
        return jsonResponse(400, { error: "Movimiento inválido" });
      }

      const result = await supabaseRequest(
        "/rest/v1/rpc/crm_adjust_inventory",
        {
          method: "POST",
          token: user.token,
          body: {
            p_business_id: env.CRM_BUSINESS_ID,
            p_product_id: productId,
            p_delta: delta,
            p_reason: reason
          }
        },
        sbConfig,
        fetchFn
      );
      return jsonResponse(200, result);
    }

    // PATCH /api/inventory/:id
    const updateMatch = url.pathname.match(/^\/api\/inventory\/([^/]+)$/);
    if (method === "PATCH" && updateMatch) {
      const productId = updateMatch[1];
      const body = await request.json().catch(() => null);
      const updates: Record<string, any> = {};
      if (body?.minimum_quantity !== undefined) {
        updates.minimum_quantity = Math.max(0, Number(body.minimum_quantity) || 0);
      }
      if (body?.active !== undefined) {
        updates.active = Boolean(body.active);
      }
      if (Object.keys(updates).length === 0) {
        return jsonResponse(400, { error: "Sin cambios válidos" });
      }
      const updated = await supabaseRequest<any[]>(
        "/rest/v1/crm_inventory",
        {
          method: "PATCH",
          token: user.token,
          prefer: "return=representation",
          query: {
            id: "eq." + productId,
            business_id: "eq." + env.CRM_BUSINESS_ID
          },
          body: updates
        },
        sbConfig,
        fetchFn
      );
      return jsonResponse(200, updated[0]);
    }

    // GET /api/movements
    if (method === "GET" && url.pathname === "/api/movements") {
      const movements = await supabaseRequest<any[]>(
        "/rest/v1/crm_stock_movements",
        {
          token: user.token,
          query: {
            select: "id,inventory_id,delta,reason,created_at",
            business_id: "eq." + env.CRM_BUSINESS_ID,
            order: "created_at.desc",
            limit: "100"
          }
        },
        sbConfig,
        fetchFn
      );
      return jsonResponse(200, { movements });
    }

    // GET /api/alerts
    if (method === "GET" && url.pathname === "/api/alerts") {
      const showAll = url.searchParams.get("all") === "true";
      const query: Record<string, string> = {
        select: "id,business_id,inventory_id,kind,message,resolved_at,created_at",
        business_id: "eq." + env.CRM_BUSINESS_ID,
        order: "created_at.desc",
        limit: "100"
      };
      if (!showAll) {
        query.resolved_at = "is.null";
      }
      const alerts = await supabaseRequest<any[]>(
        "/rest/v1/crm_alerts",
        {
          token: user.token,
          query
        },
        sbConfig,
        fetchFn
      );
      return jsonResponse(200, { alerts });
    }

    // GET /api/drafts
    if (method === "GET" && url.pathname === "/api/drafts") {
      const drafts = await supabaseRequest<any[]>(
        "/rest/v1/order_drafts",
        {
          privileged: true,
          query: {
            select: "id,payload,created_at",
            order: "created_at.desc",
            limit: "100"
          }
        },
        sbConfig,
        fetchFn
      );
      return jsonResponse(200, { drafts });
    }

    // GET /api/menu
    if (method === "GET" && url.pathname === "/api/menu") {
      const [products, modifiers] = await Promise.all([
        supabaseRequest<any[]>(
          "/rest/v1/menu_products",
          {
            privileged: true,
            query: {
              select: "sku,category,name,price_cents,description,active",
              order: "category.asc,name.asc",
              limit: "500"
            }
          },
          sbConfig,
          fetchFn
        ),
        supabaseRequest<any[]>(
          "/rest/v1/menu_modifiers",
          {
            privileged: true,
            query: {
              select: "sku,name,price_cents,category,requires_review",
              order: "category.asc,name.asc",
              limit: "500"
            }
          },
          sbConfig,
          fetchFn
        )
      ]);
      return jsonResponse(200, { products, modifiers });
    }

    return jsonResponse(404, { error: "Ruta no encontrada" });
  } catch (error: any) {
    const status = error.status || 500;
    const msg = status >= 500 ? "Error interno del servidor" : error.message;
    return jsonResponse(status, { error: msg });
  }
}
