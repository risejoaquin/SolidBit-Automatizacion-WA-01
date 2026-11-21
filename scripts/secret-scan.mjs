/**
 * Prevents committing locally held secrets and high-confidence credential patterns.
 * Scans Git index by default (actual staged bytes), or tracked HEAD/worktree files.
 * Heuristics are an additional defense, not a guarantee of secrecy.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const mode = process.argv.includes("--staged") ? "staged" : "tracked";
function git(args, encoding="utf8") {
  const proc = spawnSync("git", args, {encoding, maxBuffer: 20 * 1024 * 1024});
  if (proc.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${String(proc.stderr||"").trim()}`);
  }
  return proc.stdout;
}
const names = (mode === "staged"
  ? git(["diff","--cached","--name-only","--diff-filter=ACMR","-z"], "buffer")
  : git(["ls-files","-z"], "buffer")).toString("utf8").split("\0").filter(Boolean);

const prohibitedPath = file => {
  const name = file.replaceAll("\\","/").toLowerCase();
  const parts = name.split("/");
  const base = parts.at(-1);
  if (base === ".env.example") return false;
  if (parts.some(part => ["node_modules", ".secrets", "secrets", "backups", "data"].includes(part))) return true;
  if (/^\.env($|\.)/.test(base) || /^\.npmrc$|^\.netrc$|^\.pypirc$|^\.envrc$/.test(base)) return true;
  if (/^(credentials|service[-_]account)(\.|-|_)/.test(base) || base === "credentials.json") return true;
  if (/^id_(rsa|ed25519)/.test(base)) return true;
  if (/\.(sqlite|sqlite3|db|db-wal|db-shm|sqlite-wal|sqlite-shm|db-journal|pem|key|p8|p12|pfx|jks|keystore|secret|secrets|dump|bak|backup)$/.test(base)) return true;
  if (/^local_qa_.*_report\.md$/.test(base)) return true;
  return false;
};
const signatures = [
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["Private key", /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/],
  ["Bearer token", /\bBearer\s+[A-Za-z0-9_\-.]{24,}/i],
  ["JWT value", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["OpenAI-style key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/],
  ["Hardcoded credential", /\b(?:SUPABASE_[A-Z_]*KEY|KAPSO_[A-Z_]*KEY|(?:API_|ACCESS_|REFRESH_|AUTH_)?TOKEN|(?:JWT_|CLIENT_|API_)?SECRET|(?:OWNER_|WORKER_|DB_|DATABASE_)?PASSWORD)\s*[:=]\s*["'][^"'\n]{8,}["']/i]
];
const findings = [];
for (const file of names) {
  if (prohibitedPath(file)) {findings.push(`${file}: forbidden filename`);continue;}
  let content;
  try {
    content = mode === "staged" ? git(["show",`:${file}`],"buffer") : readFileSync(file);
  } catch (e) {findings.push(`${file}: could not inspect (${e.message})`);continue;}
  if (content.includes(0)) continue;
  const value = content.toString("utf8");
  for (const [label, pattern] of signatures) {
    if (pattern.test(value)) findings.push(`${file}: ${label}`);
  }
}
if (findings.length) {
  console.error("SECURITY SCAN FAILED — detected sensitive paths/patterns:");
  for (const x of findings) console.error(" - "+x);
  console.error("Remove the files/values from Git index and history before publishing. Do not paste them into a chat.");
  process.exitCode = 1;
} else {
  console.log(`SECURITY SCAN PASS (${mode}): ${names.length} files checked`);
}
