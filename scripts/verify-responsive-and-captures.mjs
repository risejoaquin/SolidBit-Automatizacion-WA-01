import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
mkdirSync("docs/screenshots/responsive-audit", { recursive: true });

// Read assets
const indexHtml = readFileSync("web/remote-index.html", "utf8");
const appJs = readFileSync("web/remote-app.js", "utf8");
const styleCss = readFileSync("web/style.css", "utf8");
const logoSvg = existsSync("web/brand/solidbit-logo.svg") ? readFileSync("web/brand/solidbit-logo.svg", "utf8") : "";
const isotypeSvg = existsSync("web/brand/solidbit-isotype-gray.svg") ? readFileSync("web/brand/solidbit-isotype-gray.svg", "utf8") : "";
const faviconSvg = existsSync("web/brand/solidbit-favicon.svg") ? readFileSync("web/brand/solidbit-favicon.svg", "utf8") : "";

// Sample data
const mockOrders = [
  {
    id: "ord_1001_demo",
    folio: "#MB-84920",
    customer_ref: "+52 662 335 7058",
    fulfillment: "delivery",
    address: "Av. Serdán #42, Col. Centro, Empalme",
    delivery_references: "Casa portón blanco frente a la plaza",
    order_status: "confirmed",
    payment_method: "transfer",
    payment_status: "pending",
    total_cents: 29500,
    created_at: new Date(Date.now() - 1000 * 60 * 12).toISOString(),
    conversation_id: "conv_qa_001_handoff",
    items: [
      { sku: "hamb-tocino", name: "Hamburguesa con Tocino", quantity: 1, unit_price_cents: 14500 },
      { sku: "comp-dedos-queso", name: "Dedos de queso", quantity: 1, unit_price_cents: 11000 }
    ]
  },
  {
    id: "ord_1002_demo",
    folio: "#MB-84921",
    customer_ref: "Carlos Ramírez",
    fulfillment: "pickup",
    address: null,
    delivery_references: null,
    order_status: "preparing",
    payment_method: "cash",
    payment_status: "pending",
    total_cents: 18000,
    created_at: new Date(Date.now() - 1000 * 60 * 25).toISOString(),
    conversation_id: "conv_qa_002_pickup",
    items: [
      { sku: "hamb-favorita", name: "Hamburguesa Favorita", quantity: 1, unit_price_cents: 18000 }
    ]
  },
  {
    id: "ord_1003_demo",
    folio: "#MB-84922",
    customer_ref: "+52 622 119 4432",
    fulfillment: "delivery",
    address: "Calle Benito Juárez #105",
    delivery_references: "Entre 3ra y 4ta",
    order_status: "ready",
    payment_method: "transfer",
    payment_status: "validated",
    total_cents: 34000,
    created_at: new Date(Date.now() - 1000 * 60 * 45).toISOString(),
    conversation_id: "conv_qa_003_delivery",
    items: [
      { sku: "combo-mr-burger", name: "Combo Mr. Burger Especial", quantity: 2, unit_price_cents: 17000 }
    ]
  }
];

const mockMenu = {
  products: [
    { sku: "hamb-clasica", category: "Hamburguesas", name: "Hamburguesa Clásica", price_cents: 12000, description: "Carne 100% res, queso cheddar, lechuga, tomate y aderezo especial", active: true },
    { sku: "hamb-tocino", category: "Hamburguesas", name: "Hamburguesa con Tocino", price_cents: 14500, description: "Carne 100% res, doble tocino crujiente, queso suizo y salsa BBQ", active: true },
    { sku: "hamb-favorita", category: "Hamburguesas", name: "Hamburguesa Favorita", price_cents: 18000, description: "Doble carne, queso mozzarella, cebolla caramelizada y champiñones", active: true },
    { sku: "comp-papas", category: "Complementos", name: "Papas Sazonadas", price_cents: 6500, description: "Papas corte tradicional con sazonador especial de la casa", active: true },
    { sku: "comp-dedos-queso", category: "Complementos", name: "Dedos de queso", price_cents: 11000, description: "6 piezas de queso mozzarella empanizado con aderezo marinara", active: true },
    { sku: "beb-refresco", category: "Bebidas", name: "Refresco 600ml", price_cents: 3500, description: "Coca-Cola, Sprite, Fanta o Joya", active: true }
  ],
  modifiers: []
};

const mockNotifications = {
  notifications: [
    {
      id: "notif_01",
      kind: "human_handoff",
      title: "Atención humana requerida",
      message: "Cliente solicita soporte para pedido con transferencia",
      resource_id: "conv_qa_001_handoff",
      created_at: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
      read_at: null
    },
    {
      id: "notif_02",
      kind: "order_confirmed",
      title: "Nuevo pedido registrado",
      message: "Pedido #MB-84920 confirmado para entrega a domicilio",
      resource_id: "ord_1001_demo",
      created_at: new Date(Date.now() - 1000 * 60 * 12).toISOString(),
      read_at: null
    }
  ]
};

let currentSimRole = "owner";

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1:4567");

  // Static assets
  if (url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/remote-index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(indexHtml);
  }
  if (url.pathname === "/style.css") {
    res.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
    return res.end(styleCss);
  }
  if (url.pathname === "/remote-app.js") {
    res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
    return res.end(appJs);
  }
  if (url.pathname === "/brand/solidbit-logo.svg") {
    res.writeHead(200, { "Content-Type": "image/svg+xml" });
    return res.end(logoSvg);
  }
  if (url.pathname === "/brand/solidbit-isotype-gray.svg") {
    res.writeHead(200, { "Content-Type": "image/svg+xml" });
    return res.end(isotypeSvg);
  }
  if (url.pathname === "/brand/solidbit-favicon.svg") {
    res.writeHead(200, { "Content-Type": "image/svg+xml" });
    return res.end(faviconSvg);
  }

  // Set sim role via query param
  if (url.pathname === "/sim-role") {
    currentSimRole = url.searchParams.get("role") || "owner";
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, role: currentSimRole }));
  }

  // API Endpoints
  if (url.pathname === "/api/me") {
    if (currentSimRole === "worker") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        user_id: "usr_worker_qa",
        email: "worker.qa@example.test",
        role: "worker",
        can_validate_transfers: false
      }));
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      user_id: "usr_owner_qa",
      email: "owner.qa@example.test",
      role: "owner",
      can_validate_transfers: true
    }));
  }

  if (url.pathname === "/api/login") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ email: "owner.qa@example.test", role: currentSimRole }));
  }

  if (url.pathname === "/api/logout") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (url.pathname === "/api/orders") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ orders: mockOrders }));
  }

  if (url.pathname === "/api/menu") {
    if (currentSimRole === "worker") {
      res.writeHead(403, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Acceso restringido al propietario" }));
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(mockMenu));
  }

  if (url.pathname === "/api/notifications") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(mockNotifications));
  }

  if (url.pathname === "/api/inbox-embed" || url.pathname === "/api/handoff") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      status: "ready",
      embed_url: "about:blank?simulated_kapso_inbox=1"
    }));
  }

  if (url.pathname.match(/\/api\/orders\/.*\/receipt-url/)) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      signed_url: "/brand/solidbit-logo.svg",
      receipt: { mime_type: "image/svg+xml" }
    }));
  }

  if (url.pathname === "/api/inventory") {
    if (currentSimRole === "worker") {
      res.writeHead(403, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Acceso restringido al propietario" }));
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      products: mockMenu.products.map(p => ({ sku: p.sku, name: p.name, stock_quantity: 45, minimum_quantity: 10 })),
      low_stock_count: 0
    }));
  }

  if (url.pathname === "/api/alerts") {
    if (currentSimRole === "worker") {
      res.writeHead(403, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Acceso restringido al propietario" }));
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ alerts: [] }));
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

const VIEWPORTS = [
  { width: 1440, height: 900, name: "desktop-1440x900" },
  { width: 1024, height: 768, name: "laptop-1024x768" },
  { width: 768, height: 1024, name: "tablet-768x1024" },
  { width: 390, height: 844, name: "mobile-390x844" },
  { width: 360, height: 800, name: "mobile-360x800" }
];

async function main() {
  await new Promise(resolve => server.listen(4567, resolve));
  console.log("Mock local CRM server running on http://127.0.0.1:4567");

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"]
  });

  const auditReport = [];

  try {
    const page = await browser.newPage();

    // ==========================================
    // 1. LOGIN SCREEN AUDIT (5 Viewports)
    // ==========================================
    for (const vp of VIEWPORTS) {
      await page.setViewport({ width: vp.width, height: vp.height });
      await page.goto("http://127.0.0.1:4567#login", { waitUntil: "networkidle2" });
      // Trigger logout to show login
      await page.evaluate(() => {
        handleSessionExpired();
      });
      await new Promise(r => setTimeout(r, 400));

      const scroll = await page.evaluate(() => ({
        bodyScrollWidth: document.body.scrollWidth,
        docScrollWidth: document.documentElement.scrollWidth,
        windowInnerWidth: window.innerWidth,
        hasHorizontalScroll: document.documentElement.scrollWidth > window.innerWidth || document.body.scrollWidth > window.innerWidth
      }));

      await page.screenshot({ path: `docs/screenshots/responsive-audit/1-login-${vp.name}.png` });
      console.log(`[PASS] Login in ${vp.name} - Horizontal Scroll: ${scroll.hasHorizontalScroll}`);
      auditReport.push({ screen: "Login", viewport: vp.name, hasHorizontalScroll: scroll.hasHorizontalScroll, details: scroll });
    }

    // ==========================================
    // 2. OWNER DASHBOARD AUDIT (5 Viewports)
    // ==========================================
    // Set role to owner
    await fetch("http://127.0.0.1:4567/sim-role?role=owner");

    for (const vp of VIEWPORTS) {
      await page.setViewport({ width: vp.width, height: vp.height });
      await page.goto("http://127.0.0.1:4567#handoff", { waitUntil: "networkidle2" });
      await new Promise(r => setTimeout(r, 800));

      // 2A. Handoff (Atención humana)
      let scroll = await page.evaluate(() => ({
        bodyScrollWidth: document.body.scrollWidth,
        docScrollWidth: document.documentElement.scrollWidth,
        windowInnerWidth: window.innerWidth,
        hasHorizontalScroll: document.documentElement.scrollWidth > window.innerWidth || document.body.scrollWidth > window.innerWidth
      }));
      await page.screenshot({ path: `docs/screenshots/responsive-audit/2-owner-handoff-${vp.name}.png` });
      console.log(`[PASS] Owner Handoff in ${vp.name} - Horizontal Scroll: ${scroll.hasHorizontalScroll}`);
      auditReport.push({ screen: "Owner Handoff", viewport: vp.name, hasHorizontalScroll: scroll.hasHorizontalScroll });

      // 2B. Overview (Resumen)
      await page.evaluate(() => document.querySelector('button[data-view="overview"]').click());
      await new Promise(r => setTimeout(r, 600));
      scroll = await page.evaluate(() => ({
        bodyScrollWidth: document.body.scrollWidth,
        docScrollWidth: document.documentElement.scrollWidth,
        windowInnerWidth: window.innerWidth,
        hasHorizontalScroll: document.documentElement.scrollWidth > window.innerWidth || document.body.scrollWidth > window.innerWidth
      }));
      await page.screenshot({ path: `docs/screenshots/responsive-audit/3-owner-overview-${vp.name}.png` });
      console.log(`[PASS] Owner Overview in ${vp.name} - Horizontal Scroll: ${scroll.hasHorizontalScroll}`);
      auditReport.push({ screen: "Owner Overview", viewport: vp.name, hasHorizontalScroll: scroll.hasHorizontalScroll });

      // 2C. Orders (Gestión de Pedidos)
      await page.evaluate(() => document.querySelector('button[data-view="orders"]').click());
      await new Promise(r => setTimeout(r, 600));
      scroll = await page.evaluate(() => ({
        bodyScrollWidth: document.body.scrollWidth,
        docScrollWidth: document.documentElement.scrollWidth,
        windowInnerWidth: window.innerWidth,
        hasHorizontalScroll: document.documentElement.scrollWidth > window.innerWidth || document.body.scrollWidth > window.innerWidth
      }));
      await page.screenshot({ path: `docs/screenshots/responsive-audit/4-owner-orders-${vp.name}.png` });
      console.log(`[PASS] Owner Orders in ${vp.name} - Horizontal Scroll: ${scroll.hasHorizontalScroll}`);
      auditReport.push({ screen: "Owner Orders", viewport: vp.name, hasHorizontalScroll: scroll.hasHorizontalScroll });

      // 2D. Menu (Menú y Productos)
      await page.evaluate(() => document.querySelector('button[data-view="menu"]').click());
      await new Promise(r => setTimeout(r, 600));
      scroll = await page.evaluate(() => ({
        bodyScrollWidth: document.body.scrollWidth,
        docScrollWidth: document.documentElement.scrollWidth,
        windowInnerWidth: window.innerWidth,
        hasHorizontalScroll: document.documentElement.scrollWidth > window.innerWidth || document.body.scrollWidth > window.innerWidth
      }));
      await page.screenshot({ path: `docs/screenshots/responsive-audit/5-owner-menu-${vp.name}.png` });
      console.log(`[PASS] Owner Menu in ${vp.name} - Horizontal Scroll: ${scroll.hasHorizontalScroll}`);
      auditReport.push({ screen: "Owner Menu", viewport: vp.name, hasHorizontalScroll: scroll.hasHorizontalScroll });
    }

    // ==========================================
    // 3. WORKER VIEW AUDIT (Role Isolation)
    // ==========================================
    await fetch("http://127.0.0.1:4567/sim-role?role=worker");
    for (const vp of [VIEWPORTS[0], VIEWPORTS[3], VIEWPORTS[4]]) { // Desktop, 390x844, 360x800
      await page.setViewport({ width: vp.width, height: vp.height });
      await page.goto("http://127.0.0.1:4567/?role=worker#" + Date.now(), { waitUntil: "networkidle2" });
      await new Promise(r => setTimeout(r, 800));

      const workerNav = await page.evaluate(() => {
        const overviewBtn = document.querySelector('button[data-view="overview"]');
        const menuBtn = document.querySelector('button[data-view="menu"]');
        return {
          userText: document.getElementById("user")?.textContent,
          overviewHidden: overviewBtn ? overviewBtn.hidden : true,
          menuHidden: menuBtn ? menuBtn.hidden : true
        };
      });

      const scroll = await page.evaluate(() => ({
        bodyScrollWidth: document.body.scrollWidth,
        docScrollWidth: document.documentElement.scrollWidth,
        windowInnerWidth: window.innerWidth,
        hasHorizontalScroll: document.documentElement.scrollWidth > window.innerWidth || document.body.scrollWidth > window.innerWidth
      }));

      await page.screenshot({ path: `docs/screenshots/responsive-audit/6-worker-isolated-${vp.name}.png` });
      console.log(`[PASS] Worker Isolated in ${vp.name} - Overview hidden: ${workerNav.overviewHidden}, Menu hidden: ${workerNav.menuHidden}, Scroll: ${scroll.hasHorizontalScroll}`);
      auditReport.push({ screen: "Worker Isolation", viewport: vp.name, workerNav, hasHorizontalScroll: scroll.hasHorizontalScroll });
    }

    // ==========================================
    // 4. MODALS & PANELS AUDIT
    // ==========================================
    // Restore owner role
    await fetch("http://127.0.0.1:4567/sim-role?role=owner");
    await page.setViewport({ width: 390, height: 844 });
    await page.goto("http://127.0.0.1:4567#orders", { waitUntil: "networkidle2" });
    await new Promise(r => setTimeout(r, 800));

    // 4A. Receipt Modal
    await page.evaluate(() => {
      openReceiptModal("ord_1001_demo", "#MB-84920");
    });
    await new Promise(r => setTimeout(r, 500));
    let modalScroll = await page.evaluate(() => ({
      hasHorizontalScroll: document.documentElement.scrollWidth > window.innerWidth || document.body.scrollWidth > window.innerWidth
    }));
    await page.screenshot({ path: "docs/screenshots/responsive-audit/7-modal-receipt-mobile-390x844.png" });
    console.log(`[PASS] Receipt Modal Mobile - Scroll: ${modalScroll.hasHorizontalScroll}`);
    auditReport.push({ screen: "Receipt Modal Mobile", viewport: "390x844", hasHorizontalScroll: modalScroll.hasHorizontalScroll });

    // Close Receipt Modal
    await page.evaluate(() => closeReceiptModal());
    await new Promise(r => setTimeout(r, 400));

    // 4B. Edit Product Modal
    await page.evaluate(() => {
      openEditProductModal({
        sku: "hamb-tocino",
        name: "Hamburguesa con Tocino",
        category: "Hamburguesas",
        price_cents: 14500,
        description: "Carne 100% res con doble tocino y queso suizo",
        active: true
      });
    });
    await new Promise(r => setTimeout(r, 500));
    modalScroll = await page.evaluate(() => ({
      hasHorizontalScroll: document.documentElement.scrollWidth > window.innerWidth || document.body.scrollWidth > window.innerWidth
    }));
    await page.screenshot({ path: "docs/screenshots/responsive-audit/8-modal-edit-product-mobile-390x844.png" });
    console.log(`[PASS] Edit Product Modal Mobile - Scroll: ${modalScroll.hasHorizontalScroll}`);
    auditReport.push({ screen: "Edit Product Modal Mobile", viewport: "390x844", hasHorizontalScroll: modalScroll.hasHorizontalScroll });

    // Close Edit Product Modal
    await page.evaluate(() => closeEditProductModal());
    await new Promise(r => setTimeout(r, 400));

    // 4C. Notification Dropdown Panel
    await page.evaluate(() => {
      document.getElementById("notif-bell").click();
    });
    await new Promise(r => setTimeout(r, 500));
    const notifScroll = await page.evaluate(() => ({
      hasHorizontalScroll: document.documentElement.scrollWidth > window.innerWidth || document.body.scrollWidth > window.innerWidth
    }));
    await page.screenshot({ path: "docs/screenshots/responsive-audit/9-notifications-panel-mobile-390x844.png" });
    console.log(`[PASS] Notifications Panel Mobile - Scroll: ${notifScroll.hasHorizontalScroll}`);
    auditReport.push({ screen: "Notifications Panel Mobile", viewport: "390x844", hasHorizontalScroll: notifScroll.hasHorizontalScroll });

    console.log("=== ALL RESPONSIVE AUDITS AND SCREENSHOTS COMPLETED SUCCESSFULLY ===");
  } finally {
    await browser.close();
    server.close();
  }

  // Check any failures
  const anyOverflow = auditReport.some(r => r.hasHorizontalScroll);
  console.log(`FINAL RESULT: Any Horizontal Overflow: ${anyOverflow}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
