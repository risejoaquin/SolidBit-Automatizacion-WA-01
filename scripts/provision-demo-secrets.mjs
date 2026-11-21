import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

function parseEnv(filePath) {
  if (!existsSync(filePath)) return {};
  const content = readFileSync(filePath, 'utf8');
  const env = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

const crmAppEnv = parseEnv(resolve(rootDir, 'cloudflare/crm-app/.env.local'));
const desktopEnv = parseEnv('C:\\Users\\Lucilfer\\Desktop\\.env');
const combinedEnv = { ...desktopEnv, ...crmAppEnv };

const plans = [
  {
    workerName: 'solidbit-crm-demo',
    dir: resolve(rootDir, 'cloudflare/crm-app'),
    secrets: [
      'SUPABASE_SERVICE_ROLE_KEY',
      'SUPABASE_PUBLISHABLE_KEY',
      'SESSION_SECRET',
      'KAPSO_API_KEY',
      'KAPSO_OWNER_EMBED_URL',
      'KAPSO_WORKER_EMBED_URL'
    ]
  },
  {
    workerName: 'solidbit-kapso-webhook-demo',
    dir: resolve(rootDir, 'cloudflare/kapso-webhook'),
    secrets: [
      'SUPABASE_SERVICE_ROLE_KEY',
      'KAPSO_API_KEY',
      'KAPSO_WEBHOOK_SECRET'
    ]
  },
  {
    workerName: 'solidbit-crm-notifier-demo',
    dir: resolve(rootDir, 'cloudflare/crm-notifier'),
    secrets: [
      'SUPABASE_SERVICE_ROLE_KEY',
      'KAPSO_API_KEY'
    ]
  }
];

function putSecret(workerName, cwd, secretName, secretValue) {
  return new Promise((resolvePromise, rejectPromise) => {
    const isWin = process.platform === 'win32';
    const cmd = isWin ? 'npx.cmd' : 'npx';
    const child = spawn(cmd, ['wrangler', 'secret', 'put', secretName, '--name', workerName], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('close', (code) => {
      if (code === 0) {
        console.log(`[OK] Secret ${secretName} set on ${workerName}`);
        resolvePromise();
      } else {
        console.error(`[FAIL] Secret ${secretName} on ${workerName} failed with code ${code}`);
        console.error(stderr.slice(0, 300));
        rejectPromise(new Error(`Failed to set secret ${secretName} on ${workerName}`));
      }
    });

    child.stdin.write(secretValue);
    child.stdin.end();
  });
}

async function main() {
  console.log('--- Provisioning Demo Cloudflare Secrets ---');
  for (const plan of plans) {
    console.log(`\nWorker: ${plan.workerName}`);
    for (const secret of plan.secrets) {
      const val = combinedEnv[secret];
      if (!val) {
        throw new Error(`Missing required secret: ${secret}`);
      }
      await putSecret(plan.workerName, plan.dir, secret, val);
    }
  }
  console.log('\nAll secrets successfully set!');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
