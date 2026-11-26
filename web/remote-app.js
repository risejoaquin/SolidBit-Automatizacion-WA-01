// Mr. Burger CRM · Client Application (Solid Bit Standard)
// Clean business presentation, skeletons, empty states, error-retry, and instant session purge.

const $ = id => document.getElementById(id);
let currentUser = null;
let currentRole = null;
let canValidateTransfers = false;
let isMuted = localStorage.getItem("crm_muted") === "true";
let activeOrderFilter = "all";
let searchQuery = "";
let cachedOrders = [];
let cachedMenu = { products: [], modifiers: [] };
let cachedNotifications = [];
let seenNotificationIds = new Set();
let isInitialNotifLoad = true;
let currentModalOrderId = null;
let activeHandoffConversationId = null;

const sectionIds = ["handoff", "overview", "orders", "menu"];

const flash = (text, type = "error") => {
  const el = $("flash-message");
  if (!el) return;
  if (!text) {
    el.hidden = true;
    el.textContent = "";
    el.className = "flash";
    return;
  }
  el.textContent = text;
  el.className = "flash " + type;
  el.hidden = false;
  setTimeout(() => {
    if (el.textContent === text) {
      el.hidden = true;
      el.textContent = "";
    }
  }, 6000);
};

const money = cents => new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format((Number(cents) || 0) / 100);
const qty = x => new Intl.NumberFormat("es-MX", { maximumFractionDigits: 3 }).format(Number(x) || 0);

function handleSessionExpired(noticeText) {
  currentUser = null;
  currentRole = null;
  canValidateTransfers = false;
  localStorage.removeItem("crm_had_session");

  // Immediate DOM purge of all sensitive views
  purgeAuthenticatedViews();
  closeReceiptModal();
  closeEditProductModal();

  // Reset role-restricted navigation visibility
  document.querySelectorAll('button[data-view="overview"]').forEach(btn => {
    btn.hidden = false;
    btn.removeAttribute("hidden");
    btn.style.display = "";
  });
  document.querySelectorAll('button[data-view="menu"]').forEach(btn => {
    btn.hidden = false;
    btn.removeAttribute("hidden");
    btn.style.display = "";
  });

  if ($("session-loading")) $("session-loading").hidden = true;
  $("login-panel").hidden = false;
  $("dashboard").hidden = true;
  $("user").textContent = "";
  if ($("user-sidebar")) $("user-sidebar").textContent = "";

  const expiredBox = $("session-expired-notice");
  if (expiredBox) {
    if (noticeText) {
      expiredBox.textContent = noticeText;
      expiredBox.hidden = false;
    } else {
      expiredBox.hidden = true;
      expiredBox.textContent = "";
    }
  }
}

function purgeAuthenticatedViews() {
  cachedOrders = [];
  cachedMenu = { products: [], modifiers: [] };
  cachedNotifications = [];
  seenNotificationIds.clear();

  if ($("orders-list")) $("orders-list").replaceChildren();
  if ($("menu-categories")) $("menu-categories").replaceChildren();
  if ($("metrics")) $("metrics").replaceChildren();
  if ($("overview-recent-orders")) $("overview-recent-orders").replaceChildren();
  if ($("notif-list")) $("notif-list").replaceChildren();
  if ($("inbox-frame")) $("inbox-frame").src = "about:blank";
}

async function api(route, method = "GET", body) {
  const res = await fetch(route, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({ error: "Respuesta inválida del servidor" }));
  if (!res.ok) {
    const err = new Error(data.error || "Error de comunicación (" + res.status + ")");
    err.status = res.status;
    if (res.status === 401 && route !== "/api/me" && route !== "/api/login" && currentUser) {
      fetch("/api/me", { credentials: "same-origin" })
        .then(r => {
          if (r.status === 401) {
            handleSessionExpired("Tu sesión ha expirado. Por favor, inicia sesión nuevamente.");
          }
        })
        .catch(() => {});
    }
    throw err;
  }
  return data;
}

function node(tag, text, className) {
  const el = document.createElement(tag);
  if (text !== undefined && text !== null) el.textContent = String(text);
  if (className) el.className = className;
  return el;
}

// ==========================================
// 1. WEB AUDIO SYNTHESIZER ENGINE
// ==========================================

let audioCtx = null;
function getAudioContext() {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) audioCtx = new AudioContextClass();
  }
  if (audioCtx && audioCtx.state === "suspended") {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

document.addEventListener("click", () => getAudioContext(), { once: true });
document.addEventListener("keydown", () => getAudioContext(), { once: true });

function playTone(freq, durationMs, startTime = 0, type = "sine", gainLevel = 0.2) {
  const ctx = getAudioContext();
  if (!ctx || isMuted) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, ctx.currentTime + startTime);
  gain.gain.setValueAtTime(gainLevel, ctx.currentTime + startTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + startTime + durationMs / 1000);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(ctx.currentTime + startTime);
  osc.stop(ctx.currentTime + startTime + durationMs / 1000);
}

function playNotificationSound(type) {
  if (isMuted) return;
  try {
    if (type === "human_handoff") {
      playTone(523.25, 120, 0, "sine", 0.25);
      playTone(659.25, 120, 0.1, "sine", 0.25);
      playTone(783.99, 250, 0.2, "sine", 0.3);
    } else if (type === "transfer_validation") {
      playTone(440, 100, 0, "triangle", 0.2);
      playTone(554.37, 100, 0.08, "triangle", 0.2);
      playTone(659.25, 200, 0.16, "triangle", 0.25);
    } else if (type === "order_confirmed") {
      playTone(587.33, 80, 0, "sine", 0.2);
      playTone(880, 220, 0.09, "sine", 0.3);
    } else {
      playTone(440, 140, 0, "sine", 0.2);
      playTone(330, 250, 0.12, "sine", 0.25);
    }
  } catch {}
}

const soundToggleBtn = $("sound-toggle");
if (soundToggleBtn) {
  const updateSoundUI = () => {
    $("sound-icon").textContent = isMuted ? "🔇" : "🔊";
    $("sound-label").textContent = isMuted ? "Silenciado" : "Sonido";
  };
  updateSoundUI();
  soundToggleBtn.onclick = () => {
    isMuted = !isMuted;
    localStorage.setItem("crm_muted", isMuted ? "true" : "false");
    updateSoundUI();
    if (!isMuted) playTone(659.25, 120, 0, "sine", 0.2);
  };
}

document.querySelectorAll("[data-sound]").forEach(btn => {
  btn.onclick = () => playNotificationSound(btn.dataset.sound);
});

// ==========================================
// 2. NOTIFICATIONS & POLLING
// ==========================================

const notifBell = $("notif-bell");
const notifPanel = $("notif-panel");
if (notifBell && notifPanel) {
  notifBell.onclick = () => {
    notifPanel.hidden = !notifPanel.hidden;
    if (!notifPanel.hidden) {
      if (cachedNotifications && cachedNotifications.length > 0) {
        renderNotificationsList(cachedNotifications);
      } else {
        const list = $("notif-list");
        if (list && !list.querySelector(".notif-item")) {
          list.replaceChildren(node("div", "Cargando notificaciones…", "placeholder"));
        }
      }
      loadNotifications(true);
    }
  };
  $("notif-close").onclick = () => { notifPanel.hidden = true; };
}

function renderNotificationsError(errorMsg) {
  const list = $("notif-list");
  if (!list) return;
  list.replaceChildren();
  const box = node("div", "", "notif-error-box");
  box.append(
    node("p", errorMsg || "No se pudieron cargar las notificaciones.", "notif-error-msg"),
    (() => {
      const btn = node("button", "Reintentar", "btn-secondary btn-sm");
      btn.onclick = () => {
        list.replaceChildren(node("div", "Cargando notificaciones…", "placeholder"));
        loadNotifications(true);
      };
      return btn;
    })()
  );
  list.append(box);
}

async function loadNotifications(force = false) {
  if (!currentUser) return;
  try {
    const res = await api("/api/notifications");
    const notifications = Array.isArray(res?.notifications) ? res.notifications : [];
    cachedNotifications = notifications;

    const unread = notifications.filter(n => !n.read && n.state === "pending");
    const badge = $("notif-count");
    if (badge) {
      if (unread.length > 0) {
        badge.textContent = unread.length > 99 ? "99+" : String(unread.length);
        badge.hidden = false;
      } else {
        badge.hidden = true;
      }
    }

    if (!isInitialNotifLoad) {
      for (const n of notifications) {
        if (!seenNotificationIds.has(n.id) && !n.read && n.state === "pending") {
          playNotificationSound(n.type);
          break;
        }
      }
    }
    notifications.forEach(n => seenNotificationIds.add(n.id));
    isInitialNotifLoad = false;

    if (!notifPanel.hidden || force) renderNotificationsList(notifications);
  } catch (err) {
    if (!notifPanel.hidden || force) {
      renderNotificationsError(err?.message || "Error de conexión al cargar notificaciones.");
    }
  }
}

function renderNotificationsList(notifications) {
  const list = $("notif-list");
  if (!list) return;
  list.replaceChildren();

  if (!notifications || !notifications.length) {
    list.append(node("div", "No hay notificaciones recientes.", "placeholder"));
    return;
  }

  for (const n of notifications) {
    const item = node("div", "", "notif-item" + (!n.read ? " notif-unread" : ""));
    const title = node("div", n.title || "Notificación de Operación", "notif-item-title");
    const msg = node("div", n.message || "", "notif-item-msg");
    let timeStr = "";
    if (n.created_at) {
      try {
        const d = new Date(n.created_at);
        if (!isNaN(d.getTime())) {
          timeStr = d.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });
        }
      } catch {}
    }
    const time = node("div", timeStr, "notif-item-time");
    item.append(title, msg, time);

    item.onclick = async () => {
      if (!n.read) {
        await api(`/api/notifications/${n.id}/read`, "POST").catch(() => {});
        n.read = true;
        item.classList.remove("notif-unread");
        loadNotifications();
      }
      if (n.resource_type === "order" && n.resource_id) {
        notifPanel.hidden = true;
        show("orders");
        searchQuery = n.resource_id;
        if ($("orders-search")) $("orders-search").value = n.resource_id;
        renderOrders();
      } else if (n.resource_type === "conversation" && n.resource_id) {
        notifPanel.hidden = true;
        navigateToHandoff(n.resource_id);
      }
    };
    list.append(item);
  }
}

if ($("notif-mark-all")) {
  $("notif-mark-all").onclick = async () => {
    try {
      await api("/api/notifications/read-all", "POST");
      await loadNotifications(true);
    } catch {}
  };
}

let pollTimer = null;
function scheduleNextPoll() {
  clearTimeout(pollTimer);
  const delay = document.hidden ? 30000 : 5000;
  pollTimer = setTimeout(async () => {
    if (currentUser) {
      await loadNotifications();
      if (!document.hidden && !$("orders-view").hidden) {
        await orders(true);
      }
    }
    scheduleNextPoll();
  }, delay);
}
document.addEventListener("visibilitychange", () => scheduleNextPoll());

// ==========================================
// 3. NAVIGATION (Strict: Handoff -> Overview -> Orders -> Menu)
// ==========================================

function show(section) {
  if (!sectionIds.includes(section)) section = "handoff";
  for (const id of sectionIds) {
    const view = $(id + "-view");
    if (view) view.hidden = id !== section;
  }
  document.querySelectorAll("[data-view]").forEach(b => {
    const isCurrent = b.dataset.view === section;
    b.setAttribute("aria-current", isCurrent ? "page" : "false");
    b.classList.toggle("active", isCurrent);
  });
  if (window.location.hash !== "#" + section) {
    try { history.replaceState(null, "", "#" + section); } catch {}
  }
}

document.querySelectorAll("[data-view]").forEach(btn => {
  btn.onclick = () => change(btn.dataset.view);
});

function applyRolePermissions(role) {
  const isOwnerOrManager = role === "owner" || role === "manager";
  document.querySelectorAll('button[data-view="overview"]').forEach(btn => {
    btn.hidden = !isOwnerOrManager;
    if (!isOwnerOrManager) {
      btn.setAttribute("hidden", "");
      btn.style.display = "none";
    } else {
      btn.removeAttribute("hidden");
      btn.style.display = "";
    }
  });
  document.querySelectorAll('button[data-view="menu"]').forEach(btn => {
    btn.hidden = !isOwnerOrManager;
    if (!isOwnerOrManager) {
      btn.setAttribute("hidden", "");
      btn.style.display = "none";
    } else {
      btn.removeAttribute("hidden");
      btn.style.display = "";
    }
  });
}

async function change(name, param) {
  const isOwnerOrManager = currentRole === "owner" || currentRole === "manager";
  if (!isOwnerOrManager && (name === "overview" || name === "menu")) {
    name = "handoff";
  }
  show(name);
  flash("");
  try {
    await loaders[name](param);
  } catch (e) {
    flash(e.message || "Error al cargar la sección");
  }
}

function resolveInitialView() {
  const hash = (window.location.hash || "").replace(/^#/, "").trim();
  const isOwnerOrManager = currentRole === "owner" || currentRole === "manager";
  const allowedSections = isOwnerOrManager
    ? sectionIds
    : ["handoff", "orders"];
  if (allowedSections.includes(hash)) return hash;
  return "handoff"; // Always default landing screen
}

// ==========================================
// 4. SECTION 1: ATENCIÓN HUMANA (INBOX)
// ==========================================

async function handoff(targetConversationId = null) {
  const skeleton = $("handoff-skeleton");
  const errorBox = $("handoff-error");
  const banner = $("handoff-target-banner");
  const iframe = $("inbox-frame");

  if (skeleton) skeleton.hidden = false;
  if (errorBox) errorBox.hidden = true;

  try {
    if (targetConversationId) {
      activeHandoffConversationId = targetConversationId;
    }

    if (activeHandoffConversationId && banner) {
      banner.hidden = false;
      $("handoff-target-id").textContent = activeHandoffConversationId;
    } else if (banner) {
      banner.hidden = true;
    }

    const endpoint = activeHandoffConversationId
      ? `/api/inbox-embed?target_conversation_id=${encodeURIComponent(activeHandoffConversationId)}`
      : "/api/inbox-embed";

    const data = await api(endpoint);

    if (data.status === "ready" && data.embed_url) {
      if (iframe.src !== data.embed_url) {
        iframe.src = data.embed_url;
      }
      $("inbox-placeholder").hidden = true;
      iframe.hidden = false;
    } else {
      $("inbox-placeholder").hidden = false;
      $("inbox-placeholder").textContent = data.message || "Bandeja en preparación.";
      iframe.hidden = true;
    }
  } catch (err) {
    if (errorBox) {
      errorBox.hidden = false;
      $("handoff-error-msg").textContent = "No fue posible conectar con la bandeja de atención: " + err.message;
    }
  } finally {
    if (skeleton) skeleton.hidden = true;
  }
}

if ($("handoff-target-clear")) {
  $("handoff-target-clear").onclick = () => {
    activeHandoffConversationId = null;
    $("handoff-target-banner").hidden = true;
    handoff();
  };
}

if ($("btn-refresh-inbox")) {
  $("btn-refresh-inbox").onclick = () => handoff();
}

function navigateToHandoff(conversationId) {
  show("handoff");
  handoff(conversationId);
}

// ==========================================
// 5. SECTION 2: RESUMEN (OVERVIEW)
// ==========================================

async function overview() {
  const skeleton = $("overview-skeleton");
  const errorBox = $("overview-error");
  const host = $("metrics");
  const recentHost = $("overview-recent-orders");

  if (skeleton) skeleton.hidden = false;
  if (errorBox) errorBox.hidden = true;

  try {
    const [ordersRes, menuRes] = await Promise.all([
      api("/api/orders"),
      api("/api/menu").catch(() => ({ products: [] }))
    ]);

    const ordersList = Array.isArray(ordersRes?.orders) ? ordersRes.orders : [];
    const productsList = Array.isArray(menuRes?.products) ? menuRes.products : [];

    host.replaceChildren();

    // Calculate metrics
    const totalOrders = ordersList.length;
    const confirmedOrders = ordersList.filter(o => ["confirmed", "preparing", "ready", "dispatched", "delivered"].includes(o.order_status)).length;
    const pendingTransfers = ordersList.filter(o => o.payment_method === "transfer" && o.payment_status === "pending").length;
    const totalSalesCents = ordersList
      .filter(o => o.order_status !== "cancelled" && (o.payment_status === "validated" || o.payment_method === "cash"))
      .reduce((sum, o) => sum + (Number(o.total_cents) || 0), 0);
    const activeProducts = productsList.filter(p => p.active).length;

    // Card 1: Pedidos Totales
    const c1 = node("div", "", "metric-card");
    c1.append(node("div", "Pedidos Registrados", "metric-title"), node("div", String(totalOrders), "metric-value"), node("div", `${confirmedOrders} confirmados`, "metric-sub"));

    // Card 2: Ventas
    const c2 = node("div", "", "metric-card");
    c2.append(node("div", "Ventas Acumuladas", "metric-title"), node("div", money(totalSalesCents), "metric-value"), node("div", "Efectivo y transferencias", "metric-sub"));

    // Card 3: Pagos por validar
    const c3 = node("div", "", "metric-card");
    c3.append(node("div", "Por Validar Transferencia", "metric-title"), node("div", String(pendingTransfers), "metric-value"), node("div", pendingTransfers > 0 ? "⚠️ Requiere revisión" : "Al día", "metric-sub"));

    // Card 4: Catálogo
    const c4 = node("div", "", "metric-card");
    c4.append(node("div", "Productos en Menú", "metric-title"), node("div", String(activeProducts), "metric-value"), node("div", "Activos en WhatsApp", "metric-sub"));

    host.append(c1, c2, c3, c4);

    // Recent orders snippet
    if (recentHost) {
      recentHost.replaceChildren();
      const recent = ordersList.slice(0, 5);
      if (!recent.length) {
        recentHost.append(node("div", "Aún no hay pedidos confirmados para mostrar.", "placeholder"));
      } else {
        const table = node("table", "", "orders-table");
        const thead = node("thead", "");
        thead.innerHTML = "<tr><th>Folio</th><th>Cliente</th><th>Total</th><th>Estado</th></tr>";
        const tbody = node("tbody", "");
        for (const o of recent) {
          const tr = node("tr", "", "order-row");
          tr.innerHTML = `<td><span class="badge-folio">${o.folio || ("#" + o.id.slice(0, 6))}</span></td>
                          <td>${o.customer_ref || "Mostrador"}</td>
                          <td><strong>${money(o.total_cents)}</strong></td>
                          <td><span class="badge badge-${o.order_status}">${getOrderStatusLabel(o.order_status)}</span></td>`;
          tbody.append(tr);
        }
        table.append(thead, tbody);
        recentHost.append(table);
      }
    }
  } catch (err) {
    if (errorBox) {
      errorBox.hidden = false;
      $("overview-error-msg").textContent = "No se pudieron calcular las métricas: " + err.message;
    }
  } finally {
    if (skeleton) skeleton.hidden = true;
  }
}

if ($("btn-refresh-overview")) {
  $("btn-refresh-overview").onclick = () => overview();
}

// ==========================================
// 6. SECTION 3: GESTIÓN DE PEDIDOS
// ==========================================

function getOrderStatusLabel(st) {
  const map = {
    received: "Recibido",
    confirmed: "Confirmado",
    preparing: "En preparación",
    ready: "Listo para entrega",
    dispatched: "En camino 🛵",
    delivered: "Entregado ✅",
    cancelled: "Cancelado"
  };
  return map[st] || st;
}

function getPaymentStatusLabel(st) {
  const map = {
    pending: "Pendiente",
    validated: "Validado ✅",
    verified: "Aprobado",
    rejected: "Rechazado ❌"
  };
  return map[st] || st;
}

document.querySelectorAll("[data-order-filter]").forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll("[data-order-filter]").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    activeOrderFilter = btn.dataset.orderFilter;
    renderOrders();
  };
});

if ($("orders-search")) {
  $("orders-search").oninput = e => {
    searchQuery = e.target.value.toLowerCase();
    renderOrders();
  };
}

if ($("btn-refresh-orders")) {
  $("btn-refresh-orders").onclick = () => orders();
}

async function orders(silent = false) {
  const skeleton = $("orders-skeleton");
  const errorBox = $("orders-error");

  if (!silent && skeleton) skeleton.hidden = false;
  if (errorBox) errorBox.hidden = true;

  try {
    const data = await api("/api/orders");
    cachedOrders = Array.isArray(data?.orders) ? data.orders : [];
    renderOrders();
  } catch (err) {
    if (!silent && errorBox) {
      errorBox.hidden = false;
      $("orders-error-msg").textContent = "No fue posible cargar los pedidos: " + err.message;
    }
  } finally {
    if (skeleton) skeleton.hidden = true;
  }
}

function renderOrders() {
  const host = $("orders-list");
  if (!host) return;
  host.replaceChildren();

  let filtered = cachedOrders.slice();

  // Search filter
  if (searchQuery && searchQuery.trim()) {
    filtered = filtered.filter(o =>
      (o.folio && o.folio.toLowerCase().includes(searchQuery)) ||
      (o.customer_ref && o.customer_ref.toLowerCase().includes(searchQuery)) ||
      (o.id && o.id.toLowerCase().includes(searchQuery))
    );
  }

  // Button filters
  if (activeOrderFilter === "pending_payment") {
    filtered = filtered.filter(o => o.payment_method === "transfer" && o.payment_status === "pending");
  } else if (activeOrderFilter === "kitchen") {
    filtered = filtered.filter(o => ["confirmed", "preparing"].includes(o.order_status));
  } else if (activeOrderFilter === "ready") {
    filtered = filtered.filter(o => o.order_status === "ready");
  }

  if (!filtered.length) {
    host.append(node("div", "No hay pedidos registrados con el criterio seleccionado.", "empty-state"));
    return;
  }

  const table = node("table", "", "orders-table");
  const thead = node("thead", "");
  thead.innerHTML = `
    <tr>
      <th>Folio</th>
      <th>Hora</th>
      <th>Cliente / Modalidad</th>
      <th>Artículos</th>
      <th>Total</th>
      <th>Estado Pedido</th>
      <th>Pago</th>
      <th>Acciones</th>
    </tr>
  `;
  const tbody = node("tbody", "");

  for (const o of filtered) {
    const tr = node("tr", "", "order-row");
    const displayFolio = o.folio || ("#" + o.id.slice(0, 6));
    const timeStr = o.created_at ? new Date(o.created_at).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" }) : "";
    const isDelivery = o.fulfillment === "delivery";

    // Items list summary
    let itemsText = "Sin detalles";
    if (Array.isArray(o.items) && o.items.length) {
      itemsText = o.items.map(i => `${i.name || i.sku} ×${i.quantity || 1}`).join(", ");
    }

    tr.innerHTML = `
      <td><span class="badge-folio">${displayFolio}</span></td>
      <td class="muted">${timeStr}</td>
      <td>
        <strong>${o.customer_ref || "Mostrador"}</strong>
        <div class="muted" style="font-size:0.75rem;">${isDelivery ? "🛵 Domicilio: " + (o.address || "") : "🏪 Recoger en sucursal"}</div>
      </td>
      <td style="max-width:240px;font-size:0.8rem;">${itemsText}</td>
      <td><strong>${money(o.total_cents)}</strong></td>
      <td><span class="badge badge-${o.order_status}">${getOrderStatusLabel(o.order_status)}</span></td>
      <td>
        <span class="badge badge-${o.payment_status}">${getPaymentStatusLabel(o.payment_status)}</span>
        <div class="muted" style="font-size:0.75rem;">${o.payment_method === "transfer" ? "Transferencia" : "Efectivo"}</div>
      </td>
      <td><div class="order-actions-cell" id="actions-${o.id}"></div></td>
    `;

    const actionsCell = tr.querySelector(`#actions-${o.id}`);

    // Action 1: Atender en Inbox
    if (o.conversation_id) {
      const btnInbox = node("button", "💬 Atender en Inbox", "btn-secondary btn-sm");
      btnInbox.onclick = () => navigateToHandoff(o.conversation_id);
      actionsCell.append(btnInbox);
    }

    // Action 2: Operational Flow Transitions
    if (o.order_status === "received") {
      const btn = node("button", "Confirmar Pedido", "btn-primary btn-sm");
      btn.onclick = () => updateOrderStatusAction(o.id, "confirmed");
      actionsCell.append(btn);
    } else if (o.order_status === "confirmed") {
      const btn = node("button", "Mover a Cocina", "btn-primary btn-sm");
      btn.onclick = () => updateOrderStatusAction(o.id, "preparing");
      actionsCell.append(btn);
    } else if (o.order_status === "preparing") {
      const btn = node("button", "Listo para Entrega", "btn-primary btn-sm");
      btn.onclick = () => updateOrderStatusAction(o.id, "ready");
      actionsCell.append(btn);
    } else if (o.order_status === "ready") {
      if (isDelivery) {
        const btn = node("button", "Marcar Enviado 🛵", "btn-primary btn-sm");
        btn.onclick = () => dispatchOrderAction(o.id, displayFolio);
        actionsCell.append(btn);
      } else {
        const btn = node("button", "Entregar a Cliente", "btn-primary btn-sm");
        btn.onclick = () => updateOrderStatusAction(o.id, "delivered");
        actionsCell.append(btn);
      }
    } else if (o.order_status === "dispatched") {
      const btn = node("button", "Marcar Entregado", "btn-secondary btn-sm");
      btn.onclick = () => updateOrderStatusAction(o.id, "delivered");
      actionsCell.append(btn);
    }

    // Action 3: Transfer validation
    if (o.payment_method === "transfer") {
      if (o.payment_status === "pending" && (canValidateTransfers || currentRole === "owner" || currentRole === "manager")) {
        const btnVal = node("button", "Aprobar / Validar Pago", "btn-secondary btn-sm");
        btnVal.style.color = "var(--crm-success)";
        btnVal.onclick = () => validatePaymentAction(o.id, displayFolio);
        const btnRej = node("button", "Rechazar Pago", "btn-secondary btn-sm");
        btnRej.style.color = "var(--crm-danger)";
        btnRej.onclick = () => rejectPaymentAction(o.id, displayFolio);
        actionsCell.append(btnVal, btnRej);
      }
      const btnReceipt = node("button", "Comprobante", "btn-secondary btn-sm");
      btnReceipt.onclick = () => openReceiptModal(o.id, displayFolio);
      actionsCell.append(btnReceipt);
    }

    tbody.append(tr);
  }

  table.append(thead, tbody);
  host.append(table);
}

async function updateOrderStatusAction(orderId, targetStatus) {
  try {
    await api(`/api/orders/${orderId}/status`, "PATCH", { order_status: targetStatus });
    flash("Estado del pedido actualizado correctamente.", "success");
    await orders(true);
  } catch (err) {
    flash(err.message || "Error al actualizar estado");
  }
}

async function dispatchOrderAction(orderId, folio) {
  try {
    await api(`/api/orders/${orderId}/dispatch`, "POST");
    flash(`Pedido ${folio} marcado como enviado a domicilio.`, "success");
    await orders(true);
  } catch (err) {
    flash(err.message || "Error al despachar pedido");
  }
}

async function validatePaymentAction(orderId, folio) {
  // Abre el formulario completo de verificación y comprobante
  openReceiptModal(orderId, folio);
}

async function rejectPaymentAction(orderId, folio) {
  // Abre el formulario de verificación enfocado en el motivo de rechazo
  openReceiptModal(orderId, folio);
  const rejectBox = $("receipt-reject-box");
  if (rejectBox) {
    rejectBox.style.display = "block";
    rejectBox.scrollIntoView({ behavior: "smooth" });
  }
}

// Receipt Modal Handler
function closeReceiptModal() {
  const modal = $("modal-receipt");
  if (modal) {
    modal.style.display = "none";
    modal.hidden = true;
    modal.setAttribute("hidden", "");
  }
  const fileInput = $("receipt-file-input");
  if (fileInput) fileInput.value = "";
  const bankRef = $("receipt-bank-ref");
  if (bankRef) bankRef.value = "";
  const rejectBox = $("receipt-reject-box");
  if (rejectBox) rejectBox.style.display = "none";
  currentModalOrderId = null;
}

function openReceiptModal(orderId, folio) {
  // Asegurar contexto de sesión si el dashboard está visible
  if (!currentUser) {
    if (currentRole) {
      currentUser = currentRole;
    } else if ($("dashboard") && !$("dashboard").hidden) {
      currentUser = "authenticated";
    } else {
      flash("Inicia sesión para adjuntar o inspeccionar comprobantes.", "error");
      return;
    }
  }
  currentModalOrderId = orderId;
  const modal = $("modal-receipt");
  if (!modal) return;

  const displayFolio = folio || ("#" + orderId.slice(0, 6).toUpperCase());
  $("receipt-modal-title").textContent = `Verificación de Pedido y Comprobante · ${displayFolio}`;
  $("modal-receipt-folio-badge").textContent = displayFolio;

  // Buscar pedido en cache
  const order = cachedOrders.find(o => o.id === orderId) || {};

  // Actualizar badges de estado
  const orderBadge = $("modal-receipt-order-status-badge");
  if (orderBadge) {
    orderBadge.className = `badge badge-${order.order_status || "received"}`;
    orderBadge.textContent = getOrderStatusLabel(order.order_status || "received");
  }
  const paymentBadge = $("modal-receipt-payment-status-badge");
  if (paymentBadge) {
    paymentBadge.className = `badge badge-${order.payment_status || "pending"}`;
    paymentBadge.textContent = getPaymentStatusLabel(order.payment_status || "pending");
  }

  // Ficha y formulario detallado del pedido
  const timeStr = order.created_at
    ? new Date(order.created_at).toLocaleString("es-MX", { dateStyle: "short", timeStyle: "short" })
    : "";
  if ($("modal-receipt-time")) $("modal-receipt-time").textContent = timeStr;
  if ($("modal-receipt-customer")) $("modal-receipt-customer").textContent = order.customer_ref || "Mostrador / Sin teléfono";

  const isDelivery = order.fulfillment === "delivery";
  if ($("modal-receipt-fulfillment")) {
    $("modal-receipt-fulfillment").textContent = isDelivery ? "🛵 Domicilio" : "🏪 Recoger en sucursal";
  }
  if ($("modal-receipt-address")) {
    $("modal-receipt-address").textContent = order.address || (isDelivery ? "Dirección pendiente de confirmación" : "En sucursal Mr. Burger");
  }

  // Desglose de artículos
  const itemsContainer = $("modal-receipt-items-list");
  if (itemsContainer) {
    itemsContainer.replaceChildren();
    if (Array.isArray(order.items) && order.items.length) {
      for (const item of order.items) {
        const itemRow = node("div", "", "receipt-item-row");
        const qty = item.quantity || 1;
        const unitPrice = item.price_cents ? money(item.price_cents) : "";
        const totalLine = item.price_cents ? money(item.price_cents * qty) : "";
        itemRow.innerHTML = `
          <div class="item-name-col">
            <span class="item-qty-badge">${qty}×</span>
            <strong>${item.name || item.sku || "Artículo"}</strong>
          </div>
          <div class="item-price-col muted">${unitPrice ? `${unitPrice} c/u` : ""}</div>
          <div class="item-total-col"><strong>${totalLine}</strong></div>
        `;
        itemsContainer.append(itemRow);
      }
    } else {
      itemsContainer.append(node("p", "Sin lista de artículos registrada.", "muted"));
    }
  }

  // Totales
  const shippingCents = isDelivery ? (order.delivery_fee_cents ?? 4000) : 0;
  const subtotalCents = (order.total_cents && order.total_cents > shippingCents)
    ? (order.total_cents - shippingCents)
    : (order.subtotal_cents || order.total_cents || 0);

  if ($("modal-receipt-subtotal")) $("modal-receipt-subtotal").textContent = money(subtotalCents);
  if ($("modal-receipt-shipping")) $("modal-receipt-shipping").textContent = money(shippingCents);
  if ($("modal-receipt-total")) $("modal-receipt-total").textContent = money(order.total_cents || 0);

  // Formulario de validación
  const isValidated = order.payment_status === "validated";
  const alreadyValMsg = $("receipt-already-validated-msg");
  const valFields = $("receipt-validation-fields");
  if (alreadyValMsg) alreadyValMsg.style.display = isValidated ? "block" : "none";
  if (valFields) valFields.style.display = isValidated ? "none" : "block";

  if ($("receipt-verify-amount")) {
    $("receipt-verify-amount").value = order.total_cents ? (order.total_cents / 100).toFixed(2) : "";
  }
  if ($("receipt-verify-ref")) {
    $("receipt-verify-ref").value = order.payment_reference || order.bank_reference || "";
  }
  if ($("receipt-verify-notes")) {
    $("receipt-verify-notes").value = "";
  }
  if ($("receipt-reject-box")) {
    $("receipt-reject-box").style.display = "none";
  }

  if ($("receipt-bank-helper")) {
    $("receipt-bank-helper").textContent = "Cuenta destino: Mr. Burger · 0000 0000 0000 0000 (Tarjeta Demo)";
  }

  // Visualizador del comprobante
  const preview = $("receipt-preview-container");
  preview.replaceChildren(node("p", "Cargando imagen del comprobante…", "muted"));
  const openFullLink = $("receipt-open-full");
  if (openFullLink) openFullLink.style.display = "none";

  modal.style.display = "flex";
  modal.hidden = false;
  modal.removeAttribute("hidden");

  api(`/api/orders/${orderId}/receipt-url`)
    .then(data => {
      preview.replaceChildren();
      const assetBadge = $("receipt-asset-type-badge");

      if (data.is_demo_asset) {
        if (assetBadge) {
          assetBadge.textContent = "Tarjeta destino demo (QA)";
          assetBadge.className = "badge badge-warning";
        }
      } else {
        if (assetBadge) {
          assetBadge.textContent = "Comprobante verificado";
          assetBadge.className = "badge badge-success";
        }
      }

      const imageUrl = data.signed_url || "/qa/tarjeta-destino-demo.png";

      if (openFullLink) {
        openFullLink.href = imageUrl;
        openFullLink.style.display = "inline-block";
      }

      if (data.receipt?.mime_type === "application/pdf") {
        const a = node("a", "📄 Descargar comprobante en PDF", "btn-primary");
        a.href = imageUrl;
        a.target = "_blank";
        preview.append(a);
      } else {
        const img = document.createElement("img");
        img.src = imageUrl;
        img.alt = "Comprobante bancario o tarjeta de destino";
        img.className = "receipt-img";
        preview.append(img);
      }
    })
    .catch(() => {
      preview.replaceChildren();
      const img = document.createElement("img");
      img.src = "/qa/tarjeta-destino-demo.png";
      img.alt = "Tarjeta bancaria de destino (QA)";
      img.className = "receipt-img";
      preview.append(img);

      const assetBadge = $("receipt-asset-type-badge");
      if (assetBadge) {
        assetBadge.textContent = "Tarjeta destino demo (QA)";
        assetBadge.className = "badge badge-warning";
      }
      if (openFullLink) {
        openFullLink.href = "/qa/tarjeta-destino-demo.png";
        openFullLink.style.display = "inline-block";
      }
    });
}

// Botones de acción dentro del modal
if ($("btn-modal-validate-payment")) {
  $("btn-modal-validate-payment").onclick = async () => {
    if (!currentModalOrderId) return;
    const btn = $("btn-modal-validate-payment");
    btn.disabled = true;
    btn.textContent = "Validando abono…";

    try {
      const ref = $("receipt-verify-ref")?.value?.trim() || "";
      const amt = $("receipt-verify-amount")?.value?.trim() || "";
      const notes = $("receipt-verify-notes")?.value?.trim() || "";
      const fullNotes = [notes, ref ? `Ref SPEI: ${ref}` : "", amt ? `Monto: $${amt}` : ""].filter(Boolean).join(" · ");

      await api(`/api/orders/${currentModalOrderId}/validate-payment`, "POST", {
        confirmed_bank_deposit: true,
        notes: fullNotes || "Abono verificado en cuenta bancaria"
      });

      flash("Pago validado correctamente en la cuenta bancaria.", "success");
      closeReceiptModal();
      await orders(true);
    } catch (err) {
      flash(err.message || "Error al validar abono", "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "✅ Aprobar / Validar Pago";
    }
  };
}

if ($("btn-modal-toggle-reject")) {
  $("btn-modal-toggle-reject").onclick = () => {
    const box = $("receipt-reject-box");
    if (!box) return;
    const isHidden = box.style.display === "none";
    box.style.display = isHidden ? "block" : "none";
    if (isHidden) {
      box.scrollIntoView({ behavior: "smooth" });
    }
  };
}

if ($("receipt-reject-reason-select")) {
  $("receipt-reject-reason-select").onchange = (e) => {
    const custom = $("receipt-reject-custom-reason");
    if (custom) {
      custom.style.display = e.target.value === "otro" ? "block" : "none";
    }
  };
}

if ($("btn-modal-cancel-reject")) {
  $("btn-modal-cancel-reject").onclick = () => {
    const box = $("receipt-reject-box");
    if (box) box.style.display = "none";
  };
}

if ($("btn-modal-confirm-reject")) {
  $("btn-modal-confirm-reject").onclick = async () => {
    if (!currentModalOrderId) return;
    const select = $("receipt-reject-reason-select");
    let reason = select?.value || "";
    if (reason === "otro") {
      reason = $("receipt-reject-custom-reason")?.value?.trim() || "";
    }
    if (!reason) {
      alert("Por favor selecciona o escribe el motivo de rechazo.");
      return;
    }

    const btn = $("btn-modal-confirm-reject");
    btn.disabled = true;
    btn.textContent = "Rechazando…";

    try {
      await api(`/api/orders/${currentModalOrderId}/reject-payment`, "POST", {
        rejection_reason: reason
      });
      flash("Comprobante rechazado. Se actualizó el estado a 'rejected'.", "success");
      closeReceiptModal();
      await orders(true);
    } catch (err) {
      flash(err.message || "Error al rechazar abono", "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Confirmar Rechazo";
    }
  };
}

if ($("modal-receipt-close")) $("modal-receipt-close").onclick = closeReceiptModal;
if ($("modal-receipt-cancel")) $("modal-receipt-cancel").onclick = closeReceiptModal;

const modalBackdropEl = $("modal-receipt");
if (modalBackdropEl) {
  modalBackdropEl.onclick = (e) => {
    if (e.target === modalBackdropEl) {
      closeReceiptModal();
    }
  };
}

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeReceiptModal();
  }
});

if ($("modal-receipt-submit")) {
  $("modal-receipt-submit").onclick = async () => {
    const fileInput = $("receipt-file-input");
    if (!fileInput.files.length) {
      alert("Selecciona un archivo primero.");
      return;
    }
    const file = fileInput.files[0];
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const base64 = reader.result;
        await api(`/api/orders/${currentModalOrderId}/receipt`, "POST", {
          file_name: file.name,
          mime_type: file.type,
          file_base64: base64,
          bank_reference: $("receipt-bank-ref").value || null
        });
        flash("Comprobante subido y asociado con éxito al pedido.", "success");
        closeReceiptModal();
        fileInput.value = "";
        orders(true);
      } catch (err) {
        flash(err.message || "Error al subir comprobante");
      }
    };
    reader.readAsDataURL(file);
  };
}

// ==========================================
// 7. SECTION 4: MENÚ Y CATÁLOGO
// ==========================================

const toggleAddProductBtn = $("btn-toggle-add-product");
const addProductPanel = $("add-product-panel");
if (toggleAddProductBtn && addProductPanel) {
  toggleAddProductBtn.onclick = () => {
    addProductPanel.hidden = !addProductPanel.hidden;
    if (!addProductPanel.hidden) {
      addProductPanel.scrollIntoView({ behavior: "smooth" });
    }
  };
  $("btn-cancel-add-product").onclick = () => { addProductPanel.hidden = true; };
}

if ($("menu-form")) {
  $("menu-form").onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const priceCents = Math.round(Number(fd.get("price")) * 100);
    const body = {
      sku: fd.get("sku"),
      category: fd.get("category"),
      name: fd.get("name"),
      price_cents: priceCents,
      description: fd.get("description"),
      active: fd.get("active") === "on"
    };

    try {
      await api("/api/menu", "POST", body);
      flash("Producto agregado al menú exitosamente.", "success");
      e.target.reset();
      addProductPanel.hidden = true;
      await menu();
    } catch (err) {
      flash(err.message || "Error al guardar producto");
    }
  };
}

async function menu() {
  const skeleton = $("menu-skeleton");
  const errorBox = $("menu-error");
  const host = $("menu-categories");

  if (skeleton) skeleton.hidden = false;
  if (errorBox) errorBox.hidden = true;

  try {
    const data = await api("/api/menu");
    cachedMenu = data;
    renderMenu();
  } catch (err) {
    if (errorBox) {
      errorBox.hidden = false;
      $("menu-error-msg").textContent = "No fue posible cargar el menú: " + err.message;
    }
  } finally {
    if (skeleton) skeleton.hidden = true;
  }
}

function renderMenu() {
  const host = $("menu-categories");
  if (!host) return;
  host.replaceChildren();

  const products = Array.isArray(cachedMenu?.products) ? cachedMenu.products : [];

  if (!products.length) {
    host.append(node("div", "No hay productos en el menú todavía. Agrega el primer producto.", "empty-state"));
    return;
  }

  // Group by category
  const categories = {};
  for (const p of products) {
    const cat = p.category || "General";
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(p);
  }

  for (const [catName, prods] of Object.entries(categories)) {
    const catHeader = node("h3", catName, "menu-category-title");
    host.append(catHeader);

    const grid = node("div", "", "menu-grid");
    for (const p of prods) {
      const card = node("div", "", "menu-card" + (!p.active ? " inactive" : ""));

      // Header: Name & Price
      const header = node("div", "", "menu-card-header");
      header.append(
        node("h4", p.name, "menu-card-name"),
        node("span", money(p.price_cents), "menu-card-price")
      );

      // Description
      const desc = node("p", p.description || "Sin descripción adicional.", "menu-card-desc");

      // Footer: SKU + Status + Action Buttons (Toggle, Edit, Delete)
      const footer = node("div", "", "menu-card-footer");
      const leftInfo = node("div", "");
      leftInfo.append(
        node("span", p.sku, "badge-folio"),
        node("span", p.active ? "Activo" : "Inactivo", "badge " + (p.active ? "badge-delivered" : "badge-cancelled"))
      );

      const actionBtns = node("div", "", "card-actions-group");
      actionBtns.style.display = "flex";
      actionBtns.style.gap = "6px";
      actionBtns.style.alignItems = "center";

      const toggleBtn = node("button", p.active ? "Desactivar" : "Activar", "btn-secondary btn-sm");
      toggleBtn.onclick = async () => {
        try {
          await api(`/api/menu/${p.sku}`, "PATCH", { active: !p.active });
          p.active = !p.active;
          flash(`Producto ${p.name} marcado como ${p.active ? "activo" : "inactivo"}.`, "success");
          renderMenu();
        } catch (err) {
          flash(err.message || "Error al actualizar estado");
        }
      };

      const editBtn = node("button", "Editar", "btn-secondary btn-sm");
      editBtn.onclick = () => openEditProductModal(p);

      const deleteBtn = node("button", "Eliminar", "btn-danger btn-sm");
      deleteBtn.onclick = async () => {
        if (!confirm(`¿Deseas dar de baja lógica del menú el producto "${p.name}" (${p.sku})?`)) return;
        try {
          await api(`/api/menu/${p.sku}`, "DELETE");
          p.active = false;
          flash(`Producto "${p.name}" dado de baja lógica correctamente.`, "success");
          renderMenu();
        } catch (err) {
          flash(err.message || "Error al eliminar producto");
        }
      };

      actionBtns.append(toggleBtn, editBtn, deleteBtn);
      footer.append(leftInfo, actionBtns);
      card.append(header, desc, footer);
      grid.append(card);
    }
    host.append(grid);
  }
}

function openEditProductModal(product) {
  const modal = $("modal-edit-product");
  if (!modal) return;
  $("edit-sku").value = product.sku;
  $("edit-name").value = product.name || "";
  $("edit-category").value = product.category || "Hamburguesas";
  $("edit-price").value = Math.round((Number(product.price_cents) || 0) / 100);
  $("edit-desc").value = product.description || "";
  $("edit-active").checked = Boolean(product.active);
  modal.style.display = "flex";
  modal.hidden = false;
}

function closeEditProductModal() {
  const modal = $("modal-edit-product");
  if (!modal) return;
  modal.style.display = "none";
  modal.hidden = true;
}

if ($("modal-edit-close")) $("modal-edit-close").onclick = closeEditProductModal;
if ($("modal-edit-cancel")) $("modal-edit-cancel").onclick = closeEditProductModal;

const modalEditBackdropEl = $("modal-edit-product");
if (modalEditBackdropEl) {
  modalEditBackdropEl.onclick = (e) => {
    if (e.target === modalEditBackdropEl) {
      closeEditProductModal();
    }
  };
}

if ($("edit-product-form")) {
  $("edit-product-form").onsubmit = async (e) => {
    e.preventDefault();
    const sku = $("edit-sku").value;
    const name = $("edit-name").value.trim();
    const category = $("edit-category").value;
    const priceVal = parseFloat($("edit-price").value);
    const description = $("edit-desc").value.trim();
    const active = $("edit-active").checked;

    if (!name) {
      flash("El nombre del producto es obligatorio");
      return;
    }
    if (isNaN(priceVal) || priceVal < 0) {
      flash("El precio debe ser un número positivo");
      return;
    }

    try {
      await api(`/api/menu/${sku}`, "PATCH", {
        name,
        category,
        price_cents: Math.round(priceVal * 100),
        description,
        active
      });
      flash(`Producto "${name}" actualizado con éxito.`, "success");
      closeEditProductModal();
      await menu(true);
    } catch (err) {
      flash(err.message || "Error al actualizar producto");
    }
  };
}

// Loaders map
const loaders = { handoff, overview, orders, menu };

// ==========================================
// 8. SESSION & LOGIN
// ==========================================

async function checkSession() {
  try {
    const user = await api("/api/me");
    currentUser = user.user_id || user.userId || user.email || "authenticated";
    currentRole = user.role;
    canValidateTransfers = Boolean(user.can_validate_transfers || user.payments_review);
    localStorage.setItem("crm_had_session", "true");

    if ($("session-loading")) $("session-loading").hidden = true;
    $("login-panel").hidden = true;
    $("dashboard").hidden = false;

    // Display user and role cleanly
    const roleLabels = { owner: "Propietario", manager: "Gerente", operator: "Operador", worker: "Operador" };
    const userDisplay = `${user.email} (${roleLabels[user.role] || user.role})`;
    $("user").textContent = userDisplay;
    if ($("user-sidebar")) $("user-sidebar").textContent = user.email;
    if ($("user-sidebar-role")) $("user-sidebar-role").textContent = (roleLabels[user.role] || user.role).toUpperCase();
    if ($("topbar-date")) {
      $("topbar-date").textContent = new Date().toLocaleDateString("es-MX", { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    }

    applyRolePermissions(user.role);

    const initial = resolveInitialView();
    await change(initial);
    await loadNotifications();
    scheduleNextPoll();
  } catch (err) {
    handleSessionExpired();
  }
}

if ($("login-form")) {
  $("login-form").onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const email = fd.get("email");
    const password = fd.get("password");
    flash("");
    try {
      await api("/api/login", "POST", { email, password });
      e.target.reset();
      await checkSession();
    } catch (err) {
      flash(err.message || "Credenciales incorrectas");
    }
  };
}

const handleLogout = async () => {
  try {
    await api("/api/logout", "POST");
  } catch {}
  handleSessionExpired();
  flash("Has cerrado sesión correctamente.", "success");
};

if ($("logout")) {
  $("logout").onclick = handleLogout;
}
if ($("logout-mobile")) {
  $("logout-mobile").onclick = handleLogout;
}

// Start on load
window.addEventListener("DOMContentLoaded", () => {
  closeReceiptModal();
  checkSession();
});
