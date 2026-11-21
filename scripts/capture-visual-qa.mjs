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

mkdirSync("docs/screenshots", { recursive: true });

async function runVisualQA() {
  console.log("=== SOLIDBIT CRM KAPSO — VISUAL QA CAPTURE ===");
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"]
  });

  try {
    const page = await browser.newPage();

    // 1. Desktop Login (1366x768)
    await page.setViewport({ width: 1366, height: 768 });
    await page.goto(CRM_URL, { waitUntil: "networkidle2" });
    await page.screenshot({ path: "docs/screenshots/desktop-login-1366x768.png" });
    console.log("[OK] Saved desktop-login-1366x768.png");

    // 2. Mobile Login (390x844)
    await page.setViewport({ width: 390, height: 844 });
    await page.goto(CRM_URL, { waitUntil: "networkidle2" });
    await page.screenshot({ path: "docs/screenshots/mobile-login-390x844.png" });
    console.log("[OK] Saved mobile-login-390x844.png");

    // 3. Perform Worker Login on Desktop
    await page.setViewport({ width: 1366, height: 768 });
    await page.goto(CRM_URL, { waitUntil: "networkidle2" });
    await page.type("input[type=email], input[name=email]", WORKER_EMAIL);
    await page.type("input[type=password], input[name=password]", WORKER_PASS);
    await Promise.all([
      page.click("button[type=submit]"),
      page.waitForNavigation({ waitUntil: "networkidle2" }).catch(() => {})
    ]);
    await new Promise(r => setTimeout(r, 2000));

    // Check Worker view: Worker only has access to Handoff (Atención humana)
    await page.screenshot({ path: "docs/screenshots/desktop-worker-dashboard-1366x768.png" });
    console.log("[OK] Saved desktop-worker-dashboard-1366x768.png");

    // Check responsive navigation on mobile
    await page.setViewport({ width: 390, height: 844 });
    await new Promise(r => setTimeout(r, 1000));
    await page.screenshot({ path: "docs/screenshots/mobile-worker-dashboard-390x844.png" });
    console.log("[OK] Saved mobile-worker-dashboard-390x844.png");

    console.log("=== ALL SCREENSHOTS CAPTURED SUCCESSFULLY ===");
  } finally {
    await browser.close();
  }
}

runVisualQA().catch(console.error);
