import { readFileSync, mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";

let env = {};
try {
  const envFile = readFileSync(".env.local", "utf8");
  for (const line of envFile.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, "");
  }
} catch {}
try {
  const cfEnv = readFileSync("cloudflare/crm-app/.env.local", "utf8");
  for (const line of cfEnv.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !env[m[1]]) env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, "");
  }
} catch {}

const CRM_URL = "https://crm-kapso-app.solidbit-whatsapp-agent.workers.dev";
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const WORKER_EMAIL = env.WORKER_EMAIL;
const WORKER_PASS = env.WORKER_PASSWORD;

const VIEWPORTS = [
  { width: 1920, height: 1080, name: "desktop-1920x1080" },
  { width: 1366, height: 768, name: "laptop-1366x768" },
  { width: 768, height: 1024, name: "tablet-768x1024" },
  { width: 390, height: 844, name: "mobile-390x844" },
  { width: 360, height: 800, name: "mobile-360x800" }
];

mkdirSync("docs/screenshots/recovery-017", { recursive: true });

async function runResponsiveCapture() {
  console.log("=== FASE 8: CAPTURA DE INTERFAZ EN 5 RESOLUCIONES ===");
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"]
  });

  try {
    const page = await browser.newPage();

    // 1. Capture Login across 5 viewports
    for (const vp of VIEWPORTS) {
      await page.setViewport({ width: vp.width, height: vp.height });
      await page.goto(CRM_URL, { waitUntil: "networkidle2" });
      const path = `docs/screenshots/recovery-017/login-${vp.name}.png`;
      await page.screenshot({ path });
      console.log(`[PASS] Login capturado en ${vp.name}`);
    }

    // 2. Perform Worker Login
    await page.setViewport({ width: 1366, height: 768 });
    await page.goto(CRM_URL, { waitUntil: "networkidle2" });
    await page.type("input[type=email], input[name=email]", WORKER_EMAIL);
    await page.type("input[type=password], input[name=password]", WORKER_PASS);
    await page.click("button[type=submit]");
    await new Promise(r => setTimeout(r, 2500));

    // 3. Capture Contained Worker UI across 5 viewports
    for (const vp of VIEWPORTS) {
      await page.setViewport({ width: vp.width, height: vp.height });
      await new Promise(r => setTimeout(r, 600));
      const path = `docs/screenshots/recovery-017/worker-contained-${vp.name}.png`;
      await page.screenshot({ path });
      console.log(`[PASS] Worker View (Contenido / Seguro) capturado en ${vp.name}`);
    }

    console.log("=== TODAS LAS 10 CAPTURAS COMPLETADAS ===");
  } finally {
    await browser.close();
  }
}

runResponsiveCapture().catch(console.error);
