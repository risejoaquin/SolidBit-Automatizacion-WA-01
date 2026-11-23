// Kapso Function: mr-burger-qa-save-order (Hardened with wamid idempotency & kitchen safety)
// Target ID: ebb0bcf9-74b7-4266-9c37-62e3e032eca0
// Purely additive and safe: passes provider_message_id (wamid) to draft and confirmation RPCs.

export async function handler(request, env) {
  const send = (x, status = 200) => new Response(JSON.stringify(x), { status, headers: { "Content-Type": "application/json" } });
  const fail = (code = "ORDER_SAVE_FAILED", status = 503) => send({ ok: false, code }, status);
  const payload = await request.json().catch(() => null);
  const input = payload?.input || {};
  const secret = env.MR_BURGER_SUPABASE_SECRET || env["DB KI"] || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) return fail();

  const baseUrl = "https://gplewdvxxldfvmeintvu.supabase.co";
  const businessId = "1c2238f8-863a-4e33-8b5b-5b5e4683e190";
  const authHeaders = (extra = {}) => {
    const h = { apikey: secret, ...extra };
    if (!String(secret).startsWith("sb_secret_")) {
      h.Authorization = "Bearer " + secret;
    }
    return h;
  };

  const rpc = async (name, body) => {
    const r = await fetch(baseUrl + "/rest/v1/rpc/" + name, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error("RPC " + name + " failed: " + r.status);
    return r.json();
  };

  const formatFolio = (rawFolio, rawId) => {
    const f = String(rawFolio || "").trim();
    if (/^#?MB-[A-Z0-9]+$/i.test(f)) {
      return "#" + f.replace(/^#/, "").toUpperCase();
    }
    const idStr = String(rawId || f).replace(/-/g, "").slice(0, 6).toUpperCase();
    return idStr ? "#MB-" + idStr : "#MB-000000";
  };

  const conversationId = String(
    input.conversation_id ||
    payload?.execution_context?.context?.conversation_id ||
    payload?.whatsapp_context?.conversation?.id ||
    ""
  ).trim() || null;

  const customerPhone = String(
    input.customer_phone ||
    payload?.execution_context?.context?.phone_number ||
    payload?.whatsapp_context?.conversation?.phone_number ||
    ""
  ).trim() || null;

  // Extract stable provider message id (wamid) from input, execution context or WhatsApp messages
  let providerMessageId = String(
    input.provider_message_id ||
    input.wamid ||
    payload?.execution_context?.vars?.message_id ||
    payload?.execution_context?.context?.message_id ||
    ""
  ).trim() || null;

  if (!providerMessageId && Array.isArray(payload?.whatsapp_context?.messages)) {
    const msgs = payload.whatsapp_context.messages;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]?.id) {
        providerMessageId = String(msgs[i].id).trim();
        break;
      }
    }
  }

  try {
    if (input.action === "send_menu_image" || input.action === "enviar_menu_imagen") {
      const crmUrl = "https://solidbit-crm-demo.solidbit-whatsapp-agent.workers.dev/api/menu/send-image";
      const apiKey = env.KAPSO_API_KEY || env.SESSION_SECRET || secret;
      const resp = await fetch(crmUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": apiKey
        },
        body: JSON.stringify({
          category: input.category || "all",
          conversation_id: conversationId,
          customer_phone: customerPhone
        })
      });
      const data = await resp.json().catch(() => ({ ok: false, error: "Error de comunicación con CRM" }));
      return send(data, resp.status);
    }

    if (input.action === "menu") {
      const r = await fetch(
        baseUrl + "/rest/v1/menu_products?active=eq.true&select=sku,category,name,price_cents,description&order=category,name",
        { headers: authHeaders() }
      );
      if (!r.ok) return fail();
      return send({ ok: true, products: await r.json() });
    }

    if (input.action === "prepare") {
      const prepared = await rpc("prepare_menu_order", {
        p_items: input.items ?? null,
        p_fulfillment: input.fulfillment ?? null,
        p_payment: input.payment ?? input.payment_method ?? null,
        p_address: input.address ?? null,
        p_references: input.references ?? input.delivery_references ?? null,
        p_provider_message_id: providerMessageId
      });
      return send(prepared);
    }

    if (
      input.action === "confirm" &&
      /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(input.draft_key || "")
    ) {
      let order = null;
      try {
        const resV2 = await rpc("confirm_qa_order_v2", {
          p_key: input.draft_key,
          p_conversation_id: conversationId,
          p_customer_phone: customerPhone,
          p_provider_message_id: providerMessageId
        });
        order = Array.isArray(resV2) ? resV2[0] : resV2;
      } catch {
        const resV1 = await rpc("confirm_qa_order", { p_key: input.draft_key });
        order = Array.isArray(resV1) ? resV1[0] : resV1;
      }
      if (!order || (!order.folio && !order.order_id)) return fail();
      const readableFolio = formatFolio(order.folio, order.order_id || order.folio);
      return send({
        ok: true,
        order_id: order.order_id || order.folio,
        folio: readableFolio,
        total_cents: order.total_cents,
        order_status: order.order_status,
        payment_status: order.payment_status
      });
    }

    if (input.action === "receipt") {
      const allowedMimes = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
      let mediaUrl = "";
      let fileName = String(input.file_name || "").trim();
      let mimeType = String(input.mime_type || "").trim().toLowerCase();

      // Prefer verbatim media URL from execution_context.vars.last_user_input or whatsapp_context.messages
      if (!input.file_base64) {
        const rawLastInput = payload?.execution_context?.vars?.last_user_input;
        const lastInput = typeof rawLastInput === "string" ? rawLastInput : JSON.stringify(rawLastInput || "");
        const lastMatch = lastInput.match(/https:\/\/api\.kapso\.ai\/(?:media\/|meta\/whatsapp\/media_download\?)[^\s\]\)'"\\]+/i);
        if (lastMatch) {
          mediaUrl = lastMatch[0];
        }
        const msgs = Array.isArray(payload?.whatsapp_context?.messages) ? payload.whatsapp_context.messages : [];
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i];
          if (m?.id && !providerMessageId) {
            providerMessageId = String(m.id);
          }
          const mUrl = m?.media?.url || m?.image?.url || m?.document?.url;
          if (mUrl && !mediaUrl) {
            mediaUrl = mUrl;
          }
          if (m?.media?.file_name && !fileName) fileName = m.media.file_name;
          if (m?.document?.filename && !fileName) fileName = m.document.filename;
          if (m?.media?.mime_type && !mimeType) mimeType = m.media.mime_type;
          if (m?.image?.mime_type && !mimeType) mimeType = m.image.mime_type;
        }
      }

      if (!mediaUrl && input.media_url) {
        mediaUrl = String(input.media_url).trim();
      }

      if (!fileName) {
        fileName = mimeType.includes("pdf") ? "comprobante.pdf" : "comprobante.jpg";
      }

      let bytes = null;
      if (input.file_base64) {
        const cleanBase64 = String(input.file_base64).replace(/^data:[^;]+;base64,/, "").trim();
        const bin = atob(cleanBase64);
        bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      } else if (mediaUrl) {
        const dlHeaders = {};
        if (env.KAPSO_API_KEY && !mediaUrl.includes("signature=")) {
          dlHeaders["X-API-Key"] = env.KAPSO_API_KEY;
        }
        const dlRes = await fetch(mediaUrl, { headers: dlHeaders });
        if (!dlRes.ok) return send({ ok: false, code: "MEDIA_DOWNLOAD_FAILED" }, 502);
        const ct = dlRes.headers.get("content-type");
        if (ct && !mimeType) mimeType = ct.split(";")[0].trim().toLowerCase();
        bytes = new Uint8Array(await dlRes.arrayBuffer());
      } else {
        const syntheticPdf = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/MediaBox[0 0 300 144]/Parent 2 0 R>>endobj xref\n0 4\n0000000000 65535 f\n0000000009 00000 n\n0000000052 00000 n\n0000000108 00000 n\ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n178\n%%EOF";
        bytes = new TextEncoder().encode(syntheticPdf);
        mimeType = "application/pdf";
        fileName = "comprobante-qa-sin-valor.pdf";
      }

      if (!bytes || bytes.byteLength === 0 || bytes.byteLength > 10485760) {
        return send({ ok: false, code: "INVALID_FILE_SIZE" }, 400);
      }
      if (!allowedMimes.includes(mimeType)) {
        return send({ ok: false, code: "UNSUPPORTED_MEDIA_TYPE" }, 415);
      }

      const datePrefix = new Date().toISOString().slice(0, 10);
      const safeRef = String(providerMessageId || conversationId || crypto.randomUUID()).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
      const storagePath = businessId + "/receipts/" + datePrefix + "/" + safeRef + "_" + fileName;
      const encodedPath = storagePath.split("/").map(s => encodeURIComponent(s)).join("/");

      const upRes = await fetch(baseUrl + "/storage/v1/object/payment-receipts/" + encodedPath, {
        method: "POST",
        headers: authHeaders({ "Content-Type": mimeType, "x-upsert": "true" }),
        body: bytes
      });
      if (!upRes.ok) return send({ ok: false, code: "STORAGE_UPLOAD_ERROR" }, 502);

      // Find pending transfer order for this conversation / customer / folio
      const ordRes = await fetch(
        baseUrl + "/rest/v1/orders?business_id=eq." + businessId + "&payment_method=eq.transfer&payment_status=eq.pending&select=id,folio,customer_ref,conversation_id,total_cents&order=created_at.desc&limit=20",
        { headers: authHeaders() }
      );
      const pendingOrders = ordRes.ok ? await ordRes.json() : [];
      const targetFolio = String(input.folio || "").trim().replace(/^#/, "").toUpperCase();

      let candidates = pendingOrders.filter(o => {
        if (input.order_id && o.id === input.order_id) return true;
        if (targetFolio && String(o.folio || "").replace(/^#/, "").toUpperCase() === targetFolio) return true;
        const matchConv = conversationId && o.conversation_id === conversationId;
        const matchPhone = customerPhone && (
          o.customer_ref === customerPhone ||
          String(o.customer_ref || "").replace(/\D/g, "") === customerPhone.replace(/\D/g, "")
        );
        return Boolean(matchConv || matchPhone);
      });

      let matchedOrder = candidates.length === 1 ? candidates[0] : null;
      const receiptStatus = matchedOrder ? "pending_validation" : "pending_association";

      const insRes = await fetch(baseUrl + "/rest/v1/crm_payment_receipts", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json", Prefer: "return=representation" }),
        body: JSON.stringify({
          business_id: businessId,
          order_id: matchedOrder ? matchedOrder.id : null,
          provider_message_id: providerMessageId,
          conversation_id: conversationId,
          storage_path: storagePath,
          file_name: fileName,
          file_size: bytes.byteLength,
          mime_type: mimeType,
          declared_amount_cents: input.declared_amount_cents ?? null,
          bank_reference: input.bank_reference ?? null,
          status: receiptStatus,
          metadata: { source: "whatsapp_kapso_function", candidate_count: candidates.length }
        })
      });
      if (!insRes.ok) return send({ ok: false, code: "RECEIPT_RECORD_FAILED" }, 502);
      const [receipt] = await insRes.json();

      if (matchedOrder) {
        const cleanFolio = formatFolio(matchedOrder.folio, matchedOrder.id);
        await rpc("crm_create_notification", {
          p_business_id: businessId,
          p_event_key: "receipt:" + receipt.id,
          p_type: "transfer_validation",
          p_priority: "high",
          p_title: "Transferencia por validar",
          p_message: "Comprobante recibido para pedido " + cleanFolio,
          p_resource_type: "order",
          p_resource_id: matchedOrder.id,
          p_recipient_role: "all",
          p_recipient_user_id: null,
          p_metadata: { order_id: matchedOrder.id, folio: cleanFolio, receipt_id: receipt.id }
        }).catch(() => {});

        await fetch(baseUrl + "/rest/v1/crm_order_history", {
          method: "POST",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({
            business_id: businessId,
            order_id: matchedOrder.id,
            actor_role: "system",
            actor_email: "kapso@solidbit.com.mx",
            action: "receipt_received",
            notes: "Comprobante " + fileName + " recibido por WhatsApp y almacenado en Storage privado"
          })
        }).catch(() => {});
      }

      return send({
        ok: true,
        receipt_id: receipt.id,
        status: receipt.status,
        order_id: matchedOrder ? matchedOrder.id : null,
        folio: matchedOrder ? formatFolio(matchedOrder.folio, matchedOrder.id) : null,
        storage_path: storagePath
      });
    }

    return send({ ok: false, code: "INVALID_ORDER" });
  } catch {
    return fail();
  }
}
