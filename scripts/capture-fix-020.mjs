import { readFileSync, mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";

let env = {};
try {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, "");
  }
} catch {}
try {
  for (const line of readFileSync("cloudflare/crm-app/.env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !env[m[1]]) env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, "");
  }
} catch {}

const CRM_URL = "https://crm-kapso-app.solidbit-whatsapp-agent.workers.dev";
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const WORKER_EMAIL = env.WORKER_EMAIL;
const WORKER_PASS = env.WORKER_PASSWORD;

mkdirSync("docs/screenshots/fix-020", { recursive: true });

async function run() {
  console.log("=== CAPTURING FIX-020 VISUAL EVIDENCE ===");
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"]
  });

  try {
    const page = await browser.newPage();

    // 1. Desktop View (1366x768)
    await page.setViewport({ width: 1366, height: 768 });
    await page.goto(CRM_URL, { waitUntil: "networkidle2" });
    await page.type("input[type=email], input[name=email]", WORKER_EMAIL);
    await page.type("input[type=password], input[name=password]", WORKER_PASS);
    await page.click("button[type=submit]");
    await new Promise((r) => setTimeout(r, 3500));

    await page.screenshot({ path: "docs/screenshots/fix-020/worker-inbox-desktop-1366x768.png" });
    console.log("[PASS] Saved docs/screenshots/fix-020/worker-inbox-desktop-1366x768.png");

    // 2. Mobile View (390x844)
    await page.setViewport({ width: 390, height: 844 });
    await new Promise((r) => setTimeout(r, 1000));
    await page.screenshot({ path: "docs/screenshots/fix-020/worker-inbox-mobile-390x844.png" });
    console.log("[PASS] Saved docs/screenshots/fix-020/worker-inbox-mobile-390x844.png");

  } finally {
    await browser.close();
  }
}

run().catch(console.error);
