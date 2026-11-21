# Creates local QA credentials without placing them in Git or prompts.
# Windows PowerShell 5.1+; run in repository root.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$file = Join-Path $root '.env.local'
if (Test-Path -LiteralPath $file) {
  Write-Host '.env.local already exists; keeping existing values unchanged.'
  exit 0
}
$random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
  $a = New-Object byte[] 32
  $b = New-Object byte[] 32
  $random.GetBytes($a)
  $random.GetBytes($b)
  $owner = ([System.BitConverter]::ToString($a)).Replace('-', '').ToLowerInvariant()
  $worker = ([System.BitConverter]::ToString($b)).Replace('-', '').ToLowerInvariant()
} finally { $random.Dispose() }
$lines = @(
  'PORT=3400'
  'LOCAL_DB_PATH=./crm-kapso-local.sqlite'
  'OWNER_EMAIL=owner.qa@example.test'
  "OWNER_PASSWORD=$owner"
  'WORKER_EMAIL=worker.qa@example.test'
  "WORKER_PASSWORD=$worker"
  'CRM_BUSINESS_SLUG=negocio-piloto'
  'CRM_BUSINESS_NAME=Negocio piloto'
  'SUPABASE_URL='
  'SUPABASE_PUBLISHABLE_KEY='
  'SUPABASE_SERVICE_ROLE_KEY='
  'ENABLE_SUPABASE_SYNC=false'
  'ENABLE_LOCAL_ORDER_SIMULATION=false'
  'KAPSO_WORKER_EMBED_APPROVED=false'
)
[System.IO.File]::WriteAllLines($file, $lines, ([System.Text.UTF8Encoding]::new($false)))
Write-Host 'Local credentials created in ignored .env.local. Never commit or share this file.'
Write-Host 'QA account emails: owner.qa@example.test and worker.qa@example.test'
Write-Host 'Read their passwords directly from your private .env.local when logging in.'
# Clear in-process reference variables. OS process memory remains outside this guarantee.
$owner = $null
$worker = $null
