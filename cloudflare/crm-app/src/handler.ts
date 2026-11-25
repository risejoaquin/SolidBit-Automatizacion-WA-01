import { type Env, type AuthenticatedUser, type DbSessionRow, AppHttpError } from "./types.ts";
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
  createKapsoOrder,
  ingestPaymentReceipt,
  getHandoffConversation,
  decodeBase64Receipt,
  downloadExternalMedia,
  buildControlledReceiptStoragePath,
  uploadReceiptToPrivateStorage,
  sanitizeStoragePath
} from "./supabase.ts";
import { resolveInboxEmbed, isValidConversationId, type KapsoEmbedConfig } from "./embed.ts";
import { validateAndPriceOrder } from "./menu-catalog.ts";

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
    request.headers.get("x-order-tool-secret") ||
    request.headers.get("x-menu-tool-secret") ||
    request.headers.get("x-receipt-ingest-secret") ||
    request.headers.get("x-receipt-tool-secret") ||
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
    // 1. Authenticate (Dedicated tool secret: KAPSO_MENU_TOOL_SECRET, never KAPSO_API_KEY)
    const toolSecretHeader = request.headers.get("x-menu-tool-secret") || "";
    const authHeader = request.headers.get("authorization") || request.headers.get("x-api-key") || "";
    const token = toolSecretHeader.trim() || authHeader.replace(/^Bearer\s+/i, "").trim();

    // Explicitly disallow KAPSO_API_KEY as incoming authentication secret
    if (env.KAPSO_API_KEY && token === env.KAPSO_API_KEY) {
      return jsonResponse(401, {
        error: "KAPSO_API_KEY no está permitida como secreto de autenticación entrante. Configure y use KAPSO_MENU_TOOL_SECRET."
      });
    }

    const expectedToolSecret = env.KAPSO_MENU_TOOL_SECRET;
    const isToolAuthed = Boolean(
      (expectedToolSecret && token === expectedToolSecret) ||
      (!expectedToolSecret && env.SESSION_SECRET && token === env.SESSION_SECRET)
    );

    let authenticatedUser: AuthenticatedUser | null = null;
    if (!isToolAuthed) {
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
    };

    const page2 = {
      key: "page_2",
      name: "Bebidas, Extras y Postres",
      url: `${crmOrigin}/menu/mr-burger-bebidas-extras-postres.png`,
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
          link: page.url
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
      message_ids: messageIds
    });
  }

  // --- RECEIPT INGESTION ENDPOINT (Kapso WhatsApp Integration / S2S & Authenticated User) ---
  if (method === "POST" && url.pathname === "/api/receipts/ingest") {
    // 1. Content size guard
    const cl = request.headers.get("content-length");
    if (cl && parseInt(cl, 10) > 15 * 1024 * 1024) {
      return jsonResponse(413, {
        ok: false,
        error: "Cuerpo de solicitud demasiado grande (máximo 15MB)",
        code: "PAYLOAD_TOO_LARGE"
      });
    }

    // 2. Authentication: dedicated validated secret or authenticated user session
    const secretHeader = request.headers.get("x-receipt-ingest-secret") ||
                         request.headers.get("x-receipt-tool-secret") ||
                         request.headers.get("x-order-tool-secret") || "";
    const authHeader = request.headers.get("authorization") || request.headers.get("x-api-key") || "";
    const token = secretHeader.trim() || authHeader.replace(/^Bearer\s+/i, "").trim();

    // Explicitly disallow KAPSO_API_KEY as incoming authentication secret
    if (env.KAPSO_API_KEY && token === env.KAPSO_API_KEY) {
      return jsonResponse(401, {
        ok: false,
        error: "KAPSO_API_KEY no está permitida como secreto de autenticación entrante. Configure y use KAPSO_ORDER_TOOL_SECRET.",
        code: "INVALID_AUTH_KEY"
      });
    }

    const expectedToolSecret = env.KAPSO_ORDER_TOOL_SECRET;
    const isToolAuthed = Boolean(
      token && (
        (expectedToolSecret && token === expectedToolSecret) ||
        (!expectedToolSecret && env.SESSION_SECRET && token === env.SESSION_SECRET)
      )
    );

    let authenticatedUser: AuthenticatedUser | null = null;
    if (!isToolAuthed) {
      if (token) {
        return jsonResponse(401, {
          ok: false,
          error: "Secreto de autenticación inválido para ingesta de comprobantes",
          code: "INVALID_SECRET"
        });
      }
      authenticatedUser = await authenticate(request, env, fetchFn);
      if (!authenticatedUser) {
        return jsonResponse(401, {
          ok: false,
          error: "Autenticación requerida para ingesta de comprobantes (KAPSO_ORDER_TOOL_SECRET o sesión válida)",
          code: "UNAUTHORIZED"
        });
      }
    }

    // 3. Supabase configuration & business scope
    const sbConfig = getSupabaseConfig(env);

    // 4. Parse body
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return jsonResponse(400, {
        ok: false,
        error: "JSON inválido en el cuerpo de la solicitud",
        code: "INVALID_JSON"
      });
    }

    // Business check (fail-closed)
    if (body.business_id && body.business_id !== sbConfig.businessId) {
      return jsonResponse(403, {
        ok: false,
        error: "El comprobante no pertenece al negocio configurado.",
        code: "BUSINESS_ID_MISMATCH"
      });
    }

    const fileName = String(body.file_name || body.fileName || "comprobante.jpg").trim();
    const storagePath = String(body.storage_path || body.storagePath || "").trim();
    const fileBase64 = body.file_base64 || body.fileBase64 ? String(body.file_base64 || body.fileBase64) : null;
    const mediaUrl = body.media_url || body.mediaUrl ? String(body.media_url || body.mediaUrl).trim() : null;
    const rawMime = String(body.mime_type || body.mimeType || "image/jpeg").toLowerCase().trim();
    const declaredPaymentMethod = String(body.payment_method || body.paymentMethod || body.metadata?.payment_method || "").trim().toLowerCase();
    const conversationId = body.conversation_id ? String(body.conversation_id).trim() : null;
    const rawCustomerPhone = body.customer_phone ? String(body.customer_phone).trim() : null;
    const cleanPhone = rawCustomerPhone ? rawCustomerPhone.replace(/[^\d+]/g, "") : null;

    if (!fileName || (!storagePath && !fileBase64 && !mediaUrl)) {
      return jsonResponse(400, {
        ok: false,
        error: "Se requiere file_name junto con file_base64, media_url o storage_path",
        code: "MISSING_RECEIPT_DATA"
      });
    }

    // Card receipt constraints: ONLY image MIME allowed, requires conversation or phone
    const CARD_IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp"];
    if (declaredPaymentMethod === "card") {
      if (!CARD_IMAGE_MIMES.includes(rawMime)) {
        return jsonResponse(415, {
          ok: false,
          error: "Los comprobantes para tarjeta deben ser imágenes (JPEG, PNG o WEBP). No se admiten archivos PDF ni formatos que no sean imagen.",
          code: "CARD_RECEIPT_MUST_BE_IMAGE"
        });
      }
      if (!conversationId && !cleanPhone) {
        return jsonResponse(400, {
          ok: false,
          error: "Los comprobantes de tarjeta requieren conversation_id o customer_phone para su vinculación al pedido.",
          code: "MISSING_CONVERSATION_OR_PHONE"
        });
      }
    }

    try {
      const result = await ingestPaymentReceipt(
        {
          conversationId,
          customerPhone: cleanPhone,
          providerMessageId: body.provider_message_id ? String(body.provider_message_id) : null,
          fileName,
          fileSize: Number(body.file_size) || 0,
          mimeType: rawMime,
          storagePath: storagePath || null,
          fileBase64,
          mediaUrl,
          kapsoApiKey: (env as any).KAPSO_API_KEY || null,
          declaredAmountCents: body.declared_amount_cents !== undefined ? Number(body.declared_amount_cents) : null,
          bankReference: body.bank_reference ? String(body.bank_reference).trim() : null,
          paymentMethod: (declaredPaymentMethod === "card" || declaredPaymentMethod === "transfer") ? declaredPaymentMethod : null,
          metadata: {
            ...(body.metadata || {}),
            ...(declaredPaymentMethod ? { payment_method: declaredPaymentMethod } : {}),
            ...(cleanPhone ? { customer_phone: cleanPhone } : {})
          }
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
    } catch (err: any) {
      if (err instanceof AppHttpError) {
        return jsonResponse(err.status, {
          ok: false,
          error: err.message,
          code: err.code
        });
      }
      return jsonResponse(500, {
        ok: false,
        error: "Error interno al procesar el comprobante",
        code: "RECEIPT_INGEST_ERROR"
      });
    }
  }

  // --- KAPSO ORDER REGISTRATION ENDPOINT (Server-to-Server WhatsApp Integration) ---
  if (method === "POST" && (url.pathname === "/api/kapso/orders" || url.pathname === "/api/orders")) {
    // 1. Request size limit (max 50KB)
    const rawLen = request.headers.get("content-length");
    if (rawLen && Number(rawLen) > 51200) {
      return jsonResponse(413, {
        ok: false,
        error: "Cuerpo de solicitud demasiado grande (máximo 50KB)",
        code: "PAYLOAD_TOO_LARGE"
      });
    }

    // 2. Authenticate (Dedicated tool secret: KAPSO_ORDER_TOOL_SECRET, never KAPSO_API_KEY)
    const toolSecretHeader = request.headers.get("x-order-tool-secret") || "";
    const authHeader = request.headers.get("authorization") || request.headers.get("x-api-key") || "";
    const token = toolSecretHeader.trim() || authHeader.replace(/^Bearer\s+/i, "").trim();

    // Explicitly disallow KAPSO_API_KEY as incoming authentication secret
    if (env.KAPSO_API_KEY && token === env.KAPSO_API_KEY) {
      return jsonResponse(401, {
        ok: false,
        error: "KAPSO_API_KEY no está permitida como secreto de autenticación entrante. Configure y use KAPSO_ORDER_TOOL_SECRET.",
        code: "INVALID_AUTH_KEY"
      });
    }

    const expectedToolSecret = env.KAPSO_ORDER_TOOL_SECRET;
    const isToolAuthed = Boolean(
      (expectedToolSecret && token === expectedToolSecret) ||
      (!expectedToolSecret && env.SESSION_SECRET && token === env.SESSION_SECRET)
    );

    let authenticatedUser: AuthenticatedUser | null = null;
    if (!isToolAuthed) {
      authenticatedUser = await authenticate(request, env, fetchFn);
      if (!authenticatedUser) {
        return jsonResponse(401, {
          ok: false,
          error: "Autenticación requerida para registrar pedidos (KAPSO_ORDER_TOOL_SECRET)",
          code: "UNAUTHORIZED"
        });
      }
    }

    // 3. Strict business scope (Mr. Burger Empalme pinned by server config)
    const sbConfig = getSupabaseConfig(env);

    // 4. Parse and validate JSON payload
    let body: any;
    try {
      body = await request.json();
    } catch {
      return jsonResponse(400, {
        ok: false,
        error: "JSON inválido en el cuerpo de la solicitud",
        code: "INVALID_JSON"
      });
    }

    if (!body || typeof body !== "object") {
      return jsonResponse(400, {
        ok: false,
        error: "Se requiere un objeto JSON válido con los datos del pedido",
        code: "INVALID_BODY"
      });
    }

    // 5. Fulfillment validation and normalization
    const rawFulfillment = String(body.fulfillment || "").trim().toLowerCase();
    let fulfillment: "pickup" | "delivery";
    if (["pickup", "recoger", "para recoger", "en sucursal", "sucursal"].includes(rawFulfillment)) {
      fulfillment = "pickup";
    } else if (["delivery", "domicilio", "a domicilio", "envio", "entrega"].includes(rawFulfillment)) {
      fulfillment = "delivery";
    } else {
      return jsonResponse(400, {
        ok: false,
        error: "Modalidad de entrega inválida. Debe ser 'pickup' (para recoger) o 'delivery' (a domicilio).",
        code: "INVALID_FULFILLMENT"
      });
    }

    // 6. Customer phone validation
    const rawPhone = String(body.customer_phone || body.phone || body.phone_number || "").trim();
    const cleanPhone = rawPhone.replace(/[^\d+]/g, "");
    if (!cleanPhone || cleanPhone.replace(/\D/g, "").length < 7) {
      return jsonResponse(400, {
        ok: false,
        error: "Se requiere el número de teléfono válido del cliente (customer_phone).",
        code: "MISSING_CUSTOMER_PHONE"
      });
    }

    // 7. Location validation (Mandatory for delivery)
    let finalAddress: string | null = null;
    if (fulfillment === "delivery") {
      const rawLoc = body.location || body.address;
      if (!rawLoc) {
        return jsonResponse(400, {
          ok: false,
          error: "Se requiere ubicación GPS o dirección para pedidos a domicilio.",
          code: "MISSING_DELIVERY_LOCATION"
        });
      }

      if (typeof rawLoc === "object") {
        const lat = rawLoc.latitude ?? rawLoc.lat;
        const lng = rawLoc.longitude ?? rawLoc.lng ?? rawLoc.lon;
        const addr = rawLoc.address ?? rawLoc.name ?? "";
        if (lat !== undefined && lng !== undefined) {
          finalAddress = `GPS: ${lat}, ${lng}${addr ? ` (${addr})` : ""}`;
        } else if (addr) {
          finalAddress = String(addr).trim();
        } else {
          return jsonResponse(400, {
            ok: false,
            error: "Ubicación GPS inválida. Proporcione coordenadas (latitude, longitude) o dirección.",
            code: "INVALID_LOCATION_COORDINATES"
          });
        }
      } else {
        const strLoc = String(rawLoc).trim();
        if (!strLoc) {
          return jsonResponse(400, {
            ok: false,
            error: "Se requiere ubicación GPS o dirección no vacía para pedidos a domicilio.",
            code: "MISSING_DELIVERY_LOCATION"
          });
        }
        finalAddress = strLoc;
      }
    }

    // 8. Payment method normalization & strict validation
    const rawPayment = String(body.payment_method || body.payment || "").trim().toLowerCase();
    let paymentMethod: "cash" | "transfer" | "card";

    if (!rawPayment) {
      paymentMethod = "cash";
    } else if (["cash", "efectivo"].includes(rawPayment)) {
      paymentMethod = "cash";
    } else if (["transfer", "transferencia", "spei", "banco"].includes(rawPayment)) {
      paymentMethod = "transfer";
    } else if (["card", "tarjeta", "terminal", "debito", "credito"].includes(rawPayment)) {
      paymentMethod = "card";
    } else {
      return jsonResponse(400, {
        ok: false,
        error: `Método de pago no admitido o desconocido ('${body.payment_method || body.payment}'). Debe ser 'cash', 'transfer' o 'card'.`,
        code: "INVALID_PAYMENT_METHOD"
      });
    }

    // Check receipt for card payment (must have an existing image receipt in the conversation or explicitly passed)
    let associatedReceiptId: string | null = null;
    if (paymentMethod === "card") {
      if (env.ENABLE_CARD_PAYMENTS !== "true") {
        return jsonResponse(400, {
          ok: false,
          error: "El método de pago con tarjeta no está activo en el esquema actual de base de datos (requiere migración 013). Métodos admitidos actualmente: cash, transfer.",
          code: "CARD_PAYMENTS_DISABLED"
        });
      }

      let candidateReceipts: any[] = [];
      const convId = String(body.conversation_id || "").trim();

      if (body.receipt_id) {
        candidateReceipts = await supabaseRequest<any[]>(
          "/rest/v1/crm_payment_receipts",
          {
            privileged: true,
            query: {
              select: "id,order_id,storage_path,mime_type,status,conversation_id,metadata,business_id",
              business_id: "eq." + sbConfig.businessId,
              id: "eq." + body.receipt_id,
              limit: "1"
            }
          },
          sbConfig,
          fetchFn
        ).catch(() => []);

        if (!candidateReceipts || candidateReceipts.length === 0) {
          return jsonResponse(400, {
            ok: false,
            error: "El comprobante especificado (receipt_id) no existe o no pertenece a este negocio.",
            code: "RECEIPT_NOT_FOUND"
          });
        }

        const receipt = candidateReceipts[0];

        // 1. Business check
        if (receipt.business_id && receipt.business_id !== sbConfig.businessId) {
          return jsonResponse(400, {
            ok: false,
            error: "El comprobante no pertenece a este negocio.",
            code: "RECEIPT_BUSINESS_MISMATCH"
          });
        }

        // 2. Validate conversation and phone ownership
        const receiptConvId = String(receipt.conversation_id || "").trim();
        const receiptPhone = String(receipt.metadata?.customer_phone || "").replace(/[^\d+]/g, "");
        const sameConv = Boolean(receiptConvId && convId && receiptConvId === convId);
        const samePhone = Boolean(receiptPhone && cleanPhone && (receiptPhone === cleanPhone || receiptPhone.replace(/\D/g, "") === cleanPhone.replace(/\D/g, "")));

        if ((receiptConvId && convId && receiptConvId !== convId) || (receiptPhone && cleanPhone && !samePhone && !sameConv)) {
          return jsonResponse(400, {
            ok: false,
            error: "El comprobante de tarjeta especificado pertenece a otra conversación o cliente.",
            code: "RECEIPT_CONVERSATION_MISMATCH"
          });
        }

        // 3. Reject transfer receipt for card payment
        if (receipt.metadata?.payment_method === "transfer") {
          return jsonResponse(400, {
            ok: false,
            error: "Un comprobante de transferencia no puede utilizarse para un pedido con tarjeta.",
            code: "INVALID_RECEIPT_TYPE"
          });
        }

        // 4. Must be image MIME
        const mime = String(receipt.mime_type || "").toLowerCase();
        if (!["image/jpeg", "image/png", "image/webp"].includes(mime)) {
          return jsonResponse(400, {
            ok: false,
            error: "El comprobante para tarjeta debe ser una imagen válida (JPEG, PNG o WEBP).",
            code: "INVALID_RECEIPT_MIME"
          });
        }

        associatedReceiptId = receipt.id;
      } else {
        // Query candidate receipts for this conversation or phone
        let queryParams: Record<string, string> = {
          select: "id,order_id,storage_path,mime_type,status,conversation_id,metadata,created_at",
          business_id: "eq." + sbConfig.businessId,
          order: "created_at.desc",
          limit: "10"
        };
        if (convId) {
          queryParams.conversation_id = "eq." + convId;
        }

        const receipts = await supabaseRequest<any[]>(
          "/rest/v1/crm_payment_receipts",
          {
            privileged: true,
            query: queryParams
          },
          sbConfig,
          fetchFn
        ).catch(() => []);

        // Filter valid card receipts:
        // - Must be image MIME
        // - Must NOT be marked as transfer
        // - Must match phone if customer_phone is recorded on receipt
        const validReceipts = (receipts || []).filter(r => {
          const isImage = ["image/jpeg", "image/png", "image/webp"].includes(String(r.mime_type || "").toLowerCase());
          const isTransfer = r.metadata?.payment_method === "transfer";
          const rPhone = String(r.metadata?.customer_phone || "").replace(/[^\d+]/g, "");
          const matchPhone = !rPhone || !cleanPhone || (rPhone === cleanPhone || rPhone.replace(/\D/g, "") === cleanPhone.replace(/\D/g, ""));
          return isImage && !isTransfer && matchPhone;
        });

        if (validReceipts.length === 0) {
          return jsonResponse(400, {
            ok: false,
            error: "Para pago con tarjeta se requiere un comprobante de imagen recibido y asociado previamente en la conversación. Sin comprobante no se puede registrar el pedido.",
            code: "MISSING_CARD_PAYMENT_RECEIPT"
          });
        }

        associatedReceiptId = validReceipts[0].id;
      }
    }

    // 9. Items catalog validation and price calculation
    const rawItems = body.items;
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      return jsonResponse(400, {
        ok: false,
        error: "El pedido debe contener al menos un producto (items).",
        code: "EMPTY_ITEMS"
      });
    }

    // Fetch dynamic products and modifiers from Supabase if available
    const [dbProducts, dbModifiers] = await Promise.all([
      supabaseRequest<any[]>(
        "/rest/v1/menu_products",
        {
          privileged: true,
          query: {
            select: "sku,category,name,price_cents,description,active",
            limit: "500"
          }
        },
        sbConfig,
        fetchFn
      ).catch(() => []),
      supabaseRequest<any[]>(
        "/rest/v1/menu_modifiers",
        {
          privileged: true,
          query: {
            select: "sku,name,price_cents,category,requires_review",
            limit: "500"
          }
        },
        sbConfig,
        fetchFn
      ).catch(() => [])
    ]);

    let priced;
    try {
      priced = validateAndPriceOrder(rawItems, fulfillment, dbProducts, dbModifiers);
    } catch (valErr: any) {
      return jsonResponse(422, {
        ok: false,
        error: valErr.message || "Error al validar los productos del menú",
        code: "CATALOG_VALIDATION_ERROR"
      });
    }

    // 10. Idempotency Key construction
    const rawKey = String(body.idempotency_key || body.confirmation_key || "").trim();
    const conversationId = String(body.conversation_id || "").trim() || null;
    const digitsPhone = cleanPhone.replace(/\D/g, "");
    const itemsDigest = priced.items.map(i => `${i.sku}x${i.quantity}`).join("_");
    const confirmationKey = rawKey || `ord_${digitsPhone || conversationId || "anon"}_${itemsDigest}_${fulfillment}`;

    // 11. Create Order in CRM / Supabase
    let created;
    try {
      created = await createKapsoOrder(
        {
          confirmationKey,
          providerMessageId: body.provider_message_id || body.wamid || null,
          conversationId,
          customerPhone: cleanPhone,
          items: priced.items,
          subtotalCents: priced.subtotal_cents,
          shippingCents: priced.shipping_cents,
          totalCents: priced.total_cents,
          fulfillment,
          address: finalAddress,
          deliveryReferences: body.notes || body.delivery_references || null,
          paymentMethod,
          paymentStatus: "pending",
          orderStatus: "received",
          associatedReceiptId
        },
        sbConfig,
        fetchFn
      );
    } catch (dbErr: any) {
      const status = dbErr.status || 502;
      return jsonResponse(status, {
        error: `Error interno del CRM al registrar el pedido: ${dbErr.message || "fallo de base de datos"}`,
        code: dbErr.code || "DATABASE_ERROR"
      });
    }
    const { order, duplicate } = created;

    // 12. Determine estimated time
    const totalItemsCount = priced.items.reduce((sum, it) => sum + it.quantity, 0);
    const estimatedTime = fulfillment === "pickup"
      ? (totalItemsCount >= 15 ? "25 a 30 minutos" : "8 a 15 minutos")
      : (totalItemsCount >= 15 ? "35 a 45 minutos" : "25 minutos");

    return jsonResponse(200, {
      ok: true,
      duplicate,
      folio: order?.folio ? (order.folio.startsWith("#") ? order.folio : `#${order.folio}`) : `#MB-${String(order?.id || "000000").replace(/[^a-zA-Z0-9]/g, "").slice(0, 6).toUpperCase()}`,
      order_id: order.id,
      order_status: order.order_status,
      payment_status: (paymentMethod === "transfer" || paymentMethod === "card") ? "pending_verification" : "pending",
      subtotal_cents: order.subtotal_cents || priced.subtotal_cents,
      shipping_cents: order.shipping_cents ?? priced.shipping_cents,
      total_cents: order.total_cents || priced.total_cents,
      total_formatted: "$" + Math.round((order.total_cents || priced.total_cents) / 100),
      fulfillment,
      estimated_time: estimatedTime
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
    const state = url.searchParams.get("state") || "all";
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
    try {
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
      return jsonResponse(200, { notifications: notifications || [] });
    } catch (err: any) {
      return jsonResponse(502, {
        error: "Error al consultar notificaciones en la base de datos: " + (err.message || "desconocido"),
        code: "NOTIFICATIONS_FETCH_ERROR"
      });
    }
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

    // Check if SKU already exists
    const existingSku = await supabaseRequest<any[]>(
      "/rest/v1/menu_products",
      {
        privileged: true,
        query: { select: "sku", sku: "eq." + sku, limit: "1" }
      },
      sbConfig,
      fetchFn
    ).catch(() => []);

    if (existingSku && existingSku.length > 0) {
      return jsonResponse(409, {
        error: `El código SKU '${sku}' ya existe en el menú. Utilice un código diferente o edite el producto existente.`,
        code: "DUPLICATE_SKU"
      });
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

  // DELETE /api/menu/:sku: soft delete / deactivate product (owner and manager)
  if (method === "DELETE" && menuSkuMatch) {
    if (user.role !== "owner" && user.role !== "manager") {
      return jsonResponse(403, { error: "Acceso denegado: se requiere rol administrativo para eliminar productos del menú" });
    }
    const targetSku = menuSkuMatch[1].toLowerCase();

    const existing = await supabaseRequest<any[]>(
      "/rest/v1/menu_products",
      {
        privileged: true,
        query: { select: "sku,name,active", sku: "eq." + targetSku, limit: "1" }
      },
      sbConfig,
      fetchFn
    ).catch(() => []);

    if (!existing || existing.length === 0) {
      return jsonResponse(404, { error: "Producto no encontrado en el menú", code: "MENU_PRODUCT_NOT_FOUND" });
    }

    // Soft delete: set active = false to preserve order history and referential integrity
    const updated = await supabaseRequest<any[]>(
      "/rest/v1/menu_products",
      {
        method: "PATCH",
        privileged: true,
        prefer: "return=representation",
        query: { sku: "eq." + targetSku },
        body: { active: false }
      },
      sbConfig,
      fetchFn
    );

    return jsonResponse(200, {
      ok: true,
      deleted: true,
      soft_delete: true,
      sku: targetSku,
      product: updated?.[0] || { ...existing[0], active: false }
    });
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
