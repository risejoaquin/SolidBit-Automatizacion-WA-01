# Inventario de extracción Smart WHA → CRM Kapso

Rama fuente inspeccionada: `risejoaquin/smart-wha@feat/smartwa-saas-mvp-20261113`.
Destino: `risejoaquin/crm-kapso@feat/smart-wha-component-extraction`.

## Material extraído/adaptado
- `src/core/design-tokens.css` y `components.css`: subconjunto desacoplado del diseño en `public/brand/solidbit-console.css` y `solidbit-corporate.css`.
- `src/core/presentation.js`: helpers de presentación puros inspirados en `public/console-overview.js` y `public/app.js`.
- `src/core/roles.js`: adaptación restrictiva de `roleCan`/visibilidad por rol de `public/console-overview.js`, con solo dos roles.
- `src/modules/auth/authorization.js`: guard independiente del modelo SQLite/tenant propio de Smart WHA.

## No copiar
- `auth.js` completo: requiere SQLite, sesiones, API keys y JWT propios de Smart WHA.
- `public/conversations.js`: inbox propio, sustituido por inbox embebido de Kapso.
- `public/ai-studio.js`, `public/quote-wizard.js`, `public/crm-views.js`: fuera de alcance.
- `index.js`, `server.js`: código acoplado a Baileys y SaaS.
- Hojas CSS completas: selectores específicos de pantallas que no se usan.

## Seguridad y límites
Las funciones de rol de frontend son PRESENTACIÓN, no una barrera de seguridad. El guard HTTP exige `req.auth` poblado por validación de sesión del lado servidor; todavía NO hay integración de autenticación con Supabase.

Pendiente: verificar que el embed Kapso pueda limitar conversaciones delegadas, inspeccionar el esquema existente de Supabase, conectar auth real y ajustar stock transaccional/idempotente.

## Pruebas
Ejecutar `node --test tests/*.test.mjs`. Requiere Node moderno y `package.json` con `type: module`.
