# SOLIDBIT — CRM KAPSO
## Reporte Técnico: CONFIG-CF-006 — Carga de Credenciales e Integración de Inbox Embed

**Fecha**: 2026-11-19  
**Proyecto**: CRM Kapso (SolidBit)  
**Ticket**: CONFIG-CF-006  
**Repositorio**: `https://github.com/risejoaquin/crm-kapso`  
**Rama**: `feat/supabase-crm-schema` (PR #4: `https://github.com/risejoaquin/crm-kapso/pull/4`)  
**Directorio local**: `C:\Users\Lucilfer\Desktop\cmr-kapso`  
**Worker CRM**: `crm-kapso-app`  
**URL Pública**: `https://crm-kapso-app.solidbit-whatsapp-agent.workers.dev`  
**Version / Deployment ID**: `5467b953-bdd6-4519-9198-7536d2256db5`  
**Clasificación Técnica**: **PASS**  

---

### 1. Archivo de Origen Identificado

- **Ruta de origen localizada**: `C:\Users\Lucilfer\Desktop\.env`
- *Nota de confidencialidad: El archivo fue leído de forma privada sin exponer valores, contraseñas ni tokens en consolas ni registros de versión.*

---

### 2. Variables Encontradas en el Origen

En el archivo `C:\Users\Lucilfer\Desktop\.env` se identificaron las siguientes variables y configuraciones:

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `KAPSO_API_KEY`
- `KAPSO_PHONE_NUMBER_ID`
- `KAPSO_PROJECT_ID`
- `KAPSO_WEBHOOK_SECRET`
- `KAPSO_WORKER_ASSIGNEE_ID`
- `ENABLE_SUPABASE_SYNC`
- `ENABLE_KAPSO_HANDOFF_NOTICES`
- `KAPSO_WORKER_EMBED_APPROVED`
- Enlaces de Inbox Embed oficiales generados en Kapso:
  - `owner: https://inbox.kapso.ai/embed/...` (`CRM Kapso — Owner — Sandbox`)
  - `worker: https://inbox.kapso.ai/embed/...` (`CRM Kapso — Worker — Sandbox`)

Ambas URLs fueron verificadas contra la API oficial de Kapso (`GET /platform/v1/inbox_embeds`), confirmando que pertenecen al dominio `https://inbox.kapso.ai/embed/`, corresponden al número autorizado `597907523413541`, tienen origen autorizado `https://crm-kapso-app.solidbit-whatsapp-agent.workers.dev` y se encuentran en estado `active`.

---

### 3. Secrets Cargados en Cloudflare

Para el Worker `crm-kapso-app`, los secretos fueron cargados y confirmados mediante `wrangler secret put` por canal seguro (pipe estándar):

1. `KAPSO_OWNER_EMBED_URL`: Cargado exitosamente como Secret.
2. `KAPSO_WORKER_EMBED_URL`: Cargado exitosamente como Secret.
3. `KAPSO_API_KEY`: Verificado y cargado como Secret.
4. `SESSION_SECRET`: Mantenido (secreto persistente para firma de sesiones opacas).
5. `SUPABASE_PUBLISHABLE_KEY`: Mantenido como Secret.
6. `SUPABASE_SERVICE_ROLE_KEY`: Mantenido como Secret.

Confirmación mediante `wrangler secret list` (6/6 activos):
- `KAPSO_API_KEY` (`secret_text`)
- `KAPSO_OWNER_EMBED_URL` (`secret_text`)
- `KAPSO_WORKER_EMBED_URL` (`secret_text`)
- `SESSION_SECRET` (`secret_text`)
- `SUPABASE_PUBLISHABLE_KEY` (`secret_text`)
- `SUPABASE_SERVICE_ROLE_KEY` (`secret_text`)

Variables públicas configuradas en `wrangler.jsonc` (sin secretos):
- `KAPSO_WORKER_ASSIGNEE_ID = "e5d724a2-8961-458c-a95d-03222b17cd03"`
- `KAPSO_PHONE_NUMBER_ID = "597907523413541"`
- `KAPSO_WORKER_EMBED_APPROVED = "false"`
- `ENABLE_SUPABASE_SYNC = "false"`
- `ENABLE_KAPSO_HANDOFF_NOTICES = "false"`

---

### 4. Estado de los Inbox y Aislamiento por Rol

- **Inbox Owner**:
  - **Estado**: **READY**.
  - El endpoint `GET /api/handoff` devuelve `{ status: "ready", embed_url: "https://inbox.kapso.ai/embed/[TOKEN]" }`.
  - La sección "Atención humana" en el frontend carga el iframe oficial de Kapso (`inbox.kapso.ai`) de forma fluida y responsiva.
- **Inbox Worker**:
  - **Estado**: **PENDING / BLOQUEADO**.
  - Dado que `KAPSO_WORKER_EMBED_APPROVED` se mantiene estrictamente en `"false"`, el endpoint devuelve `{ status: "pending_integration", message: "Pendiente certificado de embed restringido por assigned_user_id" }`.
  - El token y la URL del propietario están completamente inaccesibles para el trabajador.
  - La membresía en Supabase (`crm_memberships`) tiene asignado `kapso_assignee_id = 'e5d724a2-8961-458c-a95d-03222b17cd03'`.

---

### 5. Estado de Autenticación y Login

- **Owner**: Inicia sesión correctamente con `lucilfer@solidbit.com.mx` / `[CREDENTIAL_REDACTED]`, emite cookie opaca firmada `crm_remote_session` y permite el acceso completo al Dashboard, Inventario, Menú, Pedidos y Atención humana.
- **Worker**: Inicia sesión correctamente con `worker.qa@example.test`, con rol restringido y sin acceso a secciones privilegiadas.
- **Logout**: Revoca de forma inmediata la sesión en la base de datos `crm_sessions` y destruye la cookie (`Max-Age=0`). Cualquier intento posterior devuelve HTTP 401.

---

### 6. Matriz de Pruebas Técnicas de Verificación

| # | Prueba Técnica | Resultado | Observaciones |
|---|---|---|---|
| 1 | GET `/health` responde HTTP 200 | **PASS** | Responde 200 con metadata pública y sin secretos. |
| 2 | Login Owner sigue funcionando | **PASS** | Autentica vía Supabase Auth, emite sesión opaca en DB. |
| 3 | Login Worker sigue funcionando | **PASS** | Autentica vía Supabase Auth, rol worker validado en DB. |
| 4 | GET `/api/handoff` del owner responde status ready | **PASS** | Devuelve status `ready` y URL de embed válida. |
| 5 | Atención humana carga iframe oficial para Owner | **PASS** | El frontend monta el iframe de `inbox.kapso.ai` con `referrerPolicy="no-referrer"`. |
| 6 | Token del owner no aparece en archivos, logs ni reportes | **PASS** | Secret scanner verificado en Git y cabeceras `no-store` activas. |
| 7 | Worker no puede obtener token del owner desde su sesión | **PASS** | Sesión worker solo consulta su propio rol; nunca expone la URL owner. |
| 8 | Worker continúa bloqueado para Inbox si aprobación es false | **PASS** | Responde status `pending_integration`, bloqueando el iframe. |
| 9 | Módulos de inventario y pedidos siguen funcionando | **PASS** | Inventario lista los 24 SKUs; Pedidos consulta `orders` vía service role. |
| 10 | Worker del webhook (`crm-kapso-webhook`) intacto | **PASS** | Responde 200 en su endpoint de health sin haber sido modificado ni redesplegado. |

---

### 7. Errores Encontrados y Soluciones Aplicadas

1. **Rutas de Pedidos y Borradores (`GET /api/orders`, `GET /api/drafts`)**:
   - *Problema*: `handler.ts` intentaba consultar las tablas `crm_orders` y `crm_drafts` con el token del usuario autenticado, provocando un 404/500 ya que las tablas de e-commerce reales de Supabase son `orders` y `order_drafts`.
   - *Solución*: Se ajustó `handler.ts` para consultar `orders` y `order_drafts` con `privileged: true` (service role), replicando exactamente la arquitectura de lectura de `src/remote/server.js`. Verificado en vivo (HTTP 200).

---

### 8. Estado de Funcionalidades Opcionales (Apagadas)

- `ENABLE_SUPABASE_SYNC`: `"false"`
- `ENABLE_KAPSO_HANDOFF_NOTICES`: `"false"`
- `KAPSO_WORKER_EMBED_APPROVED`: `"false"`

---

### 9. Control de Versiones

- **Commits asociados**:
  - `45eba2f` — `fix(crm-app): query orders and order_drafts with service role for crm views (CONFIG-CF-006)`
- **Pull Request**: `https://github.com/risejoaquin/crm-kapso/pull/4`
- **Rama**: `feat/supabase-crm-schema` (sin merge a `main`, sin GitHub Actions).
