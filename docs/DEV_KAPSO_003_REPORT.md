# SOLIDBIT — CRM KAPSO
## Reporte Técnico: DEV-KAPSO-003 — Inbox Embebido, Notificaciones y Seguridad

**Fecha**: 2026-11-19  
**Proyecto**: CRM Kapso (SolidBit)  
**Ticket**: DEV-KAPSO-003  
**Repositorio**: `https://github.com/risejoaquin/crm-kapso`  
**Rama**: `feat/supabase-crm-schema` (PR #4: `https://github.com/risejoaquin/crm-kapso/pull/4`)  
**Directorio local**: `C:\Users\Lucilfer\Desktop\cmr-kapso`  
**Clasificación Técnica**: **PASS** (Listo para Certificación Funcional Independiente por ChatGPT Web)  

---

### 1. Resumen de Commits y Control de Versiones

- `378c31e` — `feat(crm): server-side opaque sessions, kapso inbox embeds, and outbox notifier worker (DEV-KAPSO-003)`
- `0ef5f40` — `docs: add DEPLOY_CF_CRM_002 executive deployment report`
- `e7eb459` — `feat(crm-app): deploy independent crm worker on cloudflare with secure sessions (DEPLOY-CF-CRM-002)`
- `061e544` — `docs: certify WEB-KAPSO-002 payload v2 and complete http replay idempotency`

*Nota: La rama `feat/supabase-crm-schema` permanece en borrador sin fusionar a `main` y sin utilizar GitHub Actions.*

---

### 2. Aplicaciones Desplegadas y URLs Públicas

| Servicio / Worker | URL Pública | Disparador / Tipo | Estado |
|---|---|---|---|
| **`crm-kapso-app`** | `https://crm-kapso-app.solidbit-whatsapp-agent.workers.dev` | HTTP (SPA + REST API) | **Activo** (v1.1.0) |
| **`crm-kapso-notifier`** | `https://crm-kapso-notifier.solidbit-whatsapp-agent.workers.dev` | Scheduled (`* * * * *`) + `POST /dispatch` | **Activo** (v1.0.0) |
| **`crm-kapso-webhook`** | `https://crm-kapso-webhook.solidbit-whatsapp-agent.workers.dev/webhooks/kapso/handoff` | HTTP Webhook POST | **Activo e Intacto** (Sin cambios) |

Healthchecks verificados en vivo:
- `GET https://crm-kapso-app.solidbit-whatsapp-agent.workers.dev/health` → HTTP 200 (`crm-kapso-app`, v1.1.0)
- `GET https://crm-kapso-notifier.solidbit-whatsapp-agent.workers.dev/health` → HTTP 200 (`crm-kapso-notifier`, v1.0.0, `notices_enabled: false`)
- `GET https://crm-kapso-webhook.solidbit-whatsapp-agent.workers.dev/health` → HTTP 200 (`crm-kapso-webhook`, v1.0.0)

---

### 3. FASE 1 — Mitigaciones de Seguridad y Sesiones Opacas

1. **Eliminación de credenciales en el navegador**:
   - Se retiraron completamente `access_token` y `refresh_token` de la cookie.
   - La cookie `crm_remote_session` ahora almacena exclusivamente un identificador opaco firmado con HMAC-SHA256: `<sessionId>.<signature>`.
   - Ningún usuario ni observador de red puede acceder a tokens de Supabase ni a claves privadas desde la cookie.
2. **Sesiones opacas del lado del servidor**:
   - Tabla `public.crm_sessions` creada mediante la migración `db/007_crm_sessions_and_rate_limits.sql`.
   - Almacena tokens cifrados/restringidos a `service_role` con RLS estricto.
   - Duración activa de 8 horas (`ttl`) y renovación automática transparente en segundo plano cuando el token expira en menos de 60 segundos.
3. **Revocación inmediata en Logout**:
   - `POST /api/logout` actualiza de forma inmediata `revoked_at = now()` en `crm_sessions` y devuelve cookie con `Max-Age=0`.
   - Cualquier solicitud subsiguiente que presente esa cookie es rechazada con HTTP 401 en todos los nodos de Cloudflare.
4. **Limitación de intentos distribuida (Rate Limiting)**:
   - Se reemplazó el `Map` en memoria por la función atómica `crm_check_rate_limit` y la tabla `crm_rate_limits` en PostgreSQL.
   - Tras 5 intentos fallidos dentro de la ventana de 10 minutos, devuelve HTTP 429 (`Demasiados intentos; vuelve más tarde`, `retry_after: 600`).
   - Se resetea atómicamente con `crm_reset_rate_limit` ante un login exitoso.
5. **Protección de Cabeceras**:
   - `Content-Security-Policy`: `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-src https://inbox.kapso.ai; base-uri 'none'; object-src 'none'`.
   - `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`.

---

### 4. FASE 2 & 3 — Configuración de Inbox Embebido de Kapso

Se aprovisionaron exactamente dos Inbox Embeds a través de la API oficial (`POST https://api.kapso.ai/platform/v1/inbox_embeds`) utilizando `KAPSO_API_KEY` autorizada:

- **WhatsApp Phone Number ID verificado**: `597907523413541` (Sandbox WhatsApp `+56920403095`).
- **Kapso Project ID**: `7edf4d72-e0af-4b96-939f-08a44014bb88` (`SolidBit`).
- **Allowed Origin**: `https://crm-kapso-app.solidbit-whatsapp-agent.workers.dev`

#### Detalle de los Embeds Generados:
1. **OWNER Embed**:
   - **ID**: `700b1a45-a341-46df-8057-beb91f50b05b`
   - **Nombre**: `CRM Kapso — Owner`
   - **Scope**: `phone_number` (`597907523413541`)
   - **Assigned User ID**: `null` (acceso a todas las conversaciones del número)
   - **URL de Embed**: `https://inbox.kapso.ai/embed/[REDACTED_OWNER_TOKEN]`
   - **Almacenamiento**: Inyectado de forma privada vía Cloudflare Secret `KAPSO_OWNER_EMBED_URL` en `crm-kapso-app`.

2. **WORKER Embed**:
   - **ID**: `c98988c9-3b75-4feb-9610-8a22b003bc08`
   - **Nombre**: `CRM Kapso — Worker`
   - **Scope**: `phone_number` (`597907523413541`)
   - **Assigned User ID**: `e5d724a2-8961-458c-a95d-03222b17cd03` (restringido en backend de Kapso al usuario trabajador)
   - **URL de Embed**: `https://inbox.kapso.ai/embed/[REDACTED_WORKER_TOKEN]`
   - **Almacenamiento**: Inyectado de forma privada vía Cloudflare Secret `KAPSO_WORKER_EMBED_URL` en `crm-kapso-app`.

#### Estado de Restricción y Membresías:
- `KAPSO_WORKER_ASSIGNEE_ID` en `crm-kapso-app`: `"e5d724a2-8961-458c-a95d-03222b17cd03"`.
- `crm_memberships.kapso_assignee_id` para el usuario worker (`e12b347c-c8c8-4a25-8719-cc1554122703`): `"e5d724a2-8961-458c-a95d-03222b17cd03"`.
- `KAPSO_WORKER_EMBED_APPROVED`: **`false`** (mantenido en falso por directriz estricta hasta la certificación de aislamiento funcional).
- **Aislamiento**: Si un usuario con rol `worker` consulta `/api/handoff`, recibe `{ status: "pending_integration", message: "Pendiente certificado de embed restringido por assigned_user_id" }`. Nunca se le entrega la URL ni el token del propietario.

---

### 5. FASE 4 — Integración en Frontend

- **Iframe oficial de Kapso**:
  - Ubicado en la pestaña "Atención humana" (`#handoff-frame`).
  - Tamaño responsive (`width: 100%`, `height: min(72vh, 900px)`), `referrerPolicy="no-referrer"`, `loading="lazy"`.
  - Estados de carga: "Cargando bandeja de atención…".
  - Manejo de expiración: Mensaje de error visible si la conexión falla o el enlace expira.
  - Al cerrar sesión (`logout`), el iframe es destruido y retirado del DOM de forma inmediata.

---

### 6. FASE 5 & 6 — Consumidor de Notificaciones y Plantilla WhatsApp

1. **Worker Consumidor (`crm-kapso-notifier`)**:
   - Desplegado en Cloudflare Workers con Cron Trigger `* * * * *` (ejecución cada minuto).
   - Reutiliza la función transaccional `crm_claim_handoff_notifications(p_business_id, p_limit)` con `FOR UPDATE SKIP LOCKED`.
   - Recuperación de interrupciones: Los registros que queden en `sending` por más de 5 minutos son reintentados automáticamente.
   - Límite de reintentos: 5 intentos máximos. Al superar 5 intentos, el estado pasa a `failed`.
   - Despacho idempotente: Al confirmarse el envío, guarda `provider_message_id` y pasa a `sent`.
2. **Plantilla WhatsApp (`crm_handoff_alert`)**:
   - **Estado Actual**: **PENDIENTE DE ALTA EN META / NO APROBADA**.
   - El número actual es Sandbox (`+56920403095`), por lo que Meta no permite plantillas personalizadas en esta línea hasta asociar un número dedicado o registrar el template en Meta Business Manager.
   - **Texto propuesto para revisión**: `"🔔 Tienes una conversación pendiente de atención humana. Ingresa al CRM para revisarla."`
   - **Categoría**: `UTILITY`.
   - **Idioma**: `es_MX`.
   - **Flag de habilitación**: `ENABLE_KAPSO_HANDOFF_NOTICES = "false"`.
   - Mientras el flag esté en `"false"`, el consumidor reporta limpiamente `{ processed: 0, status: "disabled", reason: "Handoff notices disabled by configuration" }` sin enviar mensajes reales ni intentar contactar a la API de WhatsApp.

---

### 7. Resultados de Pruebas Automatizadas (65/65 PASS)

Se ejecutan 65 pruebas automatizadas divididas en 4 suites con **100% de éxito**:

| Suite de Pruebas | Comando | Tests | Resultado |
|---|---|---|---|
| **CRM Base & SQLite** | `npm test` | 26 | **PASS (26/26)** |
| **Worker Webhook Handoff** | `npm run worker:test` | 20 | **PASS (20/20)** |
| **Worker CRM App (Auth/RBAC/Embed)** | `npm run crm:test` | 12 | **PASS (12/12)** |
| **Worker Notifier Outbox Consumer** | `npm run notifier:test` | 7 | **PASS (7/7)** |
| **Total General** | `npm run test:all` | **65** | **100% PASS** |

Detalle de cobertura DEV-KAPSO-003:
- Login de owner y worker contra Supabase Auth.
- Expiración de sesiones por TTL.
- Revocación efectiva e inmediata en logout.
- Intentos repetidos de login rechazados con HTTP 429.
- Desactivación de membresía en Supabase revoca acceso en la siguiente petición.
- Prohibición estricta de rutas owner a rol worker (HTTP 403).
- Separación de tokens de Inbox entre owner y worker.
- Restricción por `assigned_user_id` verificado.
- Rechazo de solicitudes desde orígenes no autorizados (HTTP 403).
- Manejo de token expirado en frontend.
- Idempotencia del outbox y protección contra ejecuciones concurrentes (`SKIP LOCKED`).
- Reintentos y marcado a `failed` tras 5 intentos.
- Sanitización total de errores y protección contra fuga de credenciales.
- Integridad intacta del Webhook Worker.

---

### 8. Verificación en Vivo sobre Cloudflare Workers (E2E HTTP)

Pruebas ejecutadas directamente contra la infraestructura desplegada:
1. `GET https://crm-kapso-app.solidbit-whatsapp-agent.workers.dev/health` → **HTTP 200**
2. `GET https://crm-kapso-notifier.solidbit-whatsapp-agent.workers.dev/health` → **HTTP 200**
3. `POST https://crm-kapso-notifier.solidbit-whatsapp-agent.workers.dev/dispatch` → **HTTP 200** (`status: "disabled"`, `processed: 0`)
4. `GET https://crm-kapso-webhook.solidbit-whatsapp-agent.workers.dev/health` → **HTTP 200** (confirmando cero afectación al webhook original)
5. `POST /api/login` (Owner: `lucilfer@solidbit.com.mx` / `[CREDENTIAL_REDACTED]`) → **HTTP 200**, cookie opaca emitida.
6. `GET /api/handoff` (Owner) → **HTTP 200** (`status: "ready"`, `embed_url: "https://inbox.kapso.ai/embed/..."`).
7. `POST /api/login` (Worker: `worker.qa@example.test`) → **HTTP 200**, cookie opaca emitida.
8. `GET /api/handoff` (Worker) → **HTTP 200** (`status: "pending_integration"`, sin URL owner expuesta).
9. `GET /api/inventory` (Worker) → **HTTP 403 Forbidden**.
10. `POST /api/logout` (Worker) → **HTTP 200** (Cookie revocada en DB y con `Max-Age=0`).
11. `GET /api/me` tras logout → **HTTP 401 Unauthorized** (revocación confirmada).

---

### 9. Configuraciones Pendientes para Pase a Producción

1. **Aprobación de la Plantilla WhatsApp (`crm_handoff_alert`)**:
   - Dar de alta el template `crm_handoff_alert` de categoría `UTILITY` en el Meta Business Manager asociado al número de WhatsApp en producción.
   - Una vez aprobado, configurar `KAPSO_WORKER_PHONE` en los secrets de `crm-kapso-notifier` y cambiar `ENABLE_KAPSO_HANDOFF_NOTICES` a `"true"`.
2. **Certificación de Aislamiento de Inbox Worker**:
   - Requiere que ChatGPT Web certifique que el worker sólo puede interactuar con chats asignados a `e5d724a2-8961-458c-a95d-03222b17cd03`.
   - Posterior a la certificación, cambiar `KAPSO_WORKER_EMBED_APPROVED` a `"true"`.
3. **Sincronización Bidireccional de Pedidos (`ENABLE_SUPABASE_SYNC`)**:
   - Permanece en `"false"` hasta la homologación con el punto de venta / pasarela de pedidos.

---

### 10. Instrucciones Específicas para Certificación Funcional por ChatGPT Web

1. **Prueba de Acceso Owner**:
   - Ingresar a `https://crm-kapso-app.solidbit-whatsapp-agent.workers.dev`.
   - Iniciar sesión con `lucilfer@solidbit.com.mx` / `[CREDENTIAL_REDACTED]`.
   - Navegar a "Atención humana": comprobar que cargue el iframe de Kapso Inbox y que permita ver la bandeja general.
   - Navegar a "Inventario": comprobar que liste los 24 productos y permita ajustar stock.
   - Hacer clic en "Cerrar sesión": comprobar que el iframe desaparezca y se muestre la pantalla de login.
2. **Prueba de Aislamiento Worker**:
   - Iniciar sesión con `worker.qa@example.test`.
   - Navegar a "Atención humana": comprobar que muestre el aviso "Pendiente certificado de embed restringido por assigned_user_id" y que NO cargue el iframe de owner.
   - Intentar abrir la pestaña de "Inventario": comprobar que las secciones de owner estén ocultas en la navegación y que peticiones directas a `/api/inventory` devuelvan 403.
3. **Prueba de Revocación de Sesión**:
   - Con la sesión iniciada en una pestaña, cerrar sesión.
   - Intentar refrescar la página o navegar: comprobar que la sesión esté completamente terminada (401).
4. **Prueba del Consumidor de Notificaciones**:
   - Inspeccionar `https://crm-kapso-notifier.solidbit-whatsapp-agent.workers.dev/health`.
   - Comprobar que `notices_enabled` sea `false`.
