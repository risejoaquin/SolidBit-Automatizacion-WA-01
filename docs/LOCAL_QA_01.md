# Iteración 01 — QA local en Windows

Ruta exacta: `C:\Users\Lucilfer\Desktop\cmr-kapso`
Rama: `feat/local-mvp-iteration-01`

## Precondiciones
Node.js 24 o superior, Git instalado. No se requiere Docker, instalar paquetes npm ni conectar Supabase remoto.
No usar secretos reales. Aplicación ligada a `127.0.0.1:3400`.

## Ejecutar (PowerShell)
```powershell
$dest = 'C:\Users\Lucilfer\Desktop\cmr-kapso'
if (!(Test-Path $dest)) {
  git clone https://github.com/risejoaquin/crm-kapso.git $dest
}
Set-Location $dest
git fetch origin
git switch feat/local-mvp-iteration-01
git pull --ff-only origin feat/local-mvp-iteration-01
node --version
$env:LOCAL_DB_PATH = "$dest\crm-kapso-local.sqlite"
$env:PORT = "3400"
# Antes de ejecutar, crea .env.local con las variables de .env.example.
# Introduce valores solo en el equipo local. No los copies al chat, GitHub o reportes.
# Instala el hook y analiza archivos antes de cualquier push.
npm run security:setup
npm run security:scan
npm run security:staged
npm test
npm start
```

Acceder a `http://127.0.0.1:3400`. No abrir túnel de Cloudflare en esta iteración. La base local se crea automáticamente; no borres archivos preexistentes.

## Criterios
- `npm test` sin fallos.
- Login owner y worker.
- Worker no puede consultar inventario (HTTP 403) ni verlo en la interfaz.
- Owner crea producto, ajusta stock y observa alerta bajo umbral.
- Stock no puede ser negativo.
- Logout invalida sesión.
- Atención humana comunica explícitamente que Kapso está pendiente.
- Los datos sobreviven reiniciar proceso local.

## Salida requerida
`node --version`, resumen de `npm test`, servidor, HTTP 200/401/403/409, evidencia de pruebas visuales, fallos con stacktrace y archivos modificados.
No modificar Supabase remoto ni Kapso. No fusionar PRs ni subir cambios a GitHub automáticamente.
