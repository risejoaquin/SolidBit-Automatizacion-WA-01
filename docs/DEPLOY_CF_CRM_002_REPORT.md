# SOLIDBIT — CRM KAPSO
## Reporte Ejecutivo: DEPLOY-CF-CRM-002 — Organización, Variables y Despliegue en Cloudflare Workers

**Fecha**: 2026-11-19  
**Proyecto**: CRM Kapso (SolidBit)  
**Ticket**: DEPLOY-CF-CRM-002  
**Repositorio**: `https://github.com/risejoaquin/crm-kapso`  
**Rama**: `feat/supabase-crm-schema` (PR #4: `https://github.com/risejoaquin/crm-kapso/pull/4`)  
**Directorio local**: `C:\Users\Lucilfer\Desktop\cmr-kapso`  

---

### 1. Estructura Final de Carpetas

Ambos proyectos conviven en el mismo repositorio y directorio de trabajo, completamente aislados a nivel de runtime y configuración:

```
C:\Users\Lucilfer\Desktop\cmr-kapso\
├── cloudflare/
│   ├── kapso-webhook/                    # Worker 1: Ingesta de webhooks Kapso (INTACTO)
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── types.ts
│   │   │   ├── verify.ts
│   │   │   └── supabase.ts
│   │   ├── test/
│   │   │   └── webhook.test.ts
│   │   ├── wrangler.jsonc                # Nombre: crm-kapso-webhook
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── crm-app/                          # Worker 2: Frontend SPA y API REST del CRM
│       ├── .env.example                  # Plantilla pública sin secretos
│       ├── .env.local                    # Configuración privada local (IGNORADO por Git)
│       ├── src/
│       │   ├── index.ts                  # Entrypoint del Worker
│       │   ├── handler.ts                # Router HTTP, RBAC y endpoints de API
│       │   ├── assets.ts                 # Bundle embebido de frontend (HTML/CSS/JS)
│       │   ├── session.ts                # Sesiones persistentes HMAC-SHA256 con Web Crypto
│       │   ├── supabase.ts               # Cliente REST y Auth Supabase (redirect: manual)
│       │   ├── embed.ts                  # Resolución segura de iframe Kapso Inbox
│       │   └── types.ts                  # Definiciones de entorno y modelos
│       ├── test/
│       │   └── crm-app.test.ts           # 11 pruebas automatizadas unitarias/integración
│       ├── wrangler.jsonc                # Nombre: crm-kapso-app
│       ├── package.json
│       └── tsconfig.json
│
├── db/                                   # Migraciones SQL Supabase
├── docs/                                 # Documentación técnica y reportes
├── scripts/
│   ├── build-assets.mjs                  # Script para sincronizar frontend a src/assets.ts
│   ├── secret-scan.mjs                   # Scanner de seguridad pre-commit
│   └── run-dev.mjs
├── src/                                  # Servidor Node.js local y utilidades base
├── web/                                  # Archivos estáticos fuente del frontend
└── package.json                          # Scripts raíz (npm test, npm run crm:test, etc.)
```

---

### 2. Ubicación Exacta de Variables de Entorno

- **Ruta local privada**: `cloudflare/crm-app/.env.local`
- **Protección Git**: El archivo coincide con la regla `*.local` del `.gitignore` raíz y no es rastreado por control de versiones.
- **Plantilla de referencia**: `cloudflare/crm-app/.env.example` contiene únicamente los nombres de variable con valores demostrativos no confidenciales.
- **Almacenamiento Cloudflare**: Las credenciales privadas del Worker `crm-kapso-app` fueron cargadas vía `wrangler secret put` en el entorno de Cloudflare.

---

### 3. Matriz de Variables de Entorno Configuradas

| Variable | Destino / Mecanismo | Estado / Valor Configurado | Confidencialidad |
|---|---|---|---|
| `SUPABASE_URL` | `wrangler.jsonc` (vars) | `https://gplewdvxxldfvmeintvu.supabase.co` | Pública |
| `SUPABASE_PUBLISHABLE_KEY` | Cloudflare Secrets (`wrangler secret put`) | Configurada en Worker y `.env.local` | Privada / Anon |
| `SUPABASE_SERVICE_ROLE_KEY` | Cloudflare Secrets (`wrangler secret put`) | Configurada en Worker y `.env.local` | Secreto crítico |
| `SESSION_SECRET` | Cloudflare Secrets (`wrangler secret put`) | Generado (32 bytes cryptosecure hex) | Secreto crítico |
| `CRM_BUSINESS_ID` | `wrangler.jsonc` (vars) | `1c2238f8-863a-4e33-8b5b-5b5e4683e190` | Identificador público |
| `KAPSO_PHONE_NUMBER_ID` | `wrangler.jsonc` (vars) | `979505518579979` | Identificador público |
| `KAPSO_WORKER_ASSIGNEE_ID` | `wrangler.jsonc` (vars) | `user_01jnpr4x4aeq7t94jty753r8q9` | Identificador público |
| `KAPSO_OWNER_EMBED_URL` | `wrangler.jsonc` (vars) | `""` (Pendiente token oficial) | No sensible |
| `KAPSO_WORKER_EMBED_URL` | `wrangler.jsonc` (vars) | `""` (Pendiente token oficial) | No sensible |
| `KAPSO_WORKER_EMBED_APPROVED` | `wrangler.jsonc` (vars) | `"false"` | Flag de seguridad |
| `ENABLE_SUPABASE_SYNC` | `wrangler.jsonc` (vars) | `"false"` | Inactiva hasta certificación |
| `ENABLE_KAPSO_HANDOFF_NOTICES` | `wrangler.jsonc` (vars) | `"false"` | Inactiva hasta certificación |
| `KAPSO_WEBHOOK_SECRET` | N/A | **No se incluyó** en CRM (solo vive en el Worker Webhook) | Secreto crítico |

---

### 4. URLs Públicas de los Servicios

1. **CRM Application Worker (`crm-kapso-app`)**:
   - URL Principal: `https://crm-kapso-app.solidbit-whatsapp-agent.workers.dev`
   - Healthcheck: `https://crm-kapso-app.solidbit-whatsapp-agent.workers.dev/health`
   - Version ID actual: `fae0001a-1dac-4d6b-b858-bd56f00a1c5c`

2. **Webhook Worker (`crm-kapso-webhook`)**:
   - URL Principal: `https://crm-kapso-webhook.solidbit-whatsapp-agent.workers.dev`
   - Endpoint Handoff: `https://crm-kapso-webhook.solidbit-whatsapp-agent.workers.dev/webhooks/kapso/handoff`
   - Healthcheck: `https://crm-kapso-webhook.solidbit-whatsapp-agent.workers.dev/health`
   - Estado: **100% Intacto, verificado y activo** (no fue modificado ni redesplegado).

---

### 5. Resumen de Batería de Pruebas Automatizadas

Se ejecutan 57 pruebas automatizadas en total con **100% de éxito**:

- **26/26 pruebas unitarias y de integración base del CRM** (`npm test`):
  - Control de acceso por roles (RBAC).
  - Sanitización HTML contra inyecciones XSS.
  - Validación de origen contra CSRF.
  - Idempotencia y durabilidad en SQLite y PostgreSQL.
  - Políticas deterministas de órdenes y stock.
- **20/20 pruebas del Worker Webhook** (`npm run worker:test`):
  - Validación HMAC-SHA256 con Web Crypto.
  - Rechazo de firmas inválidas o ausentes (401).
  - Verificación de Idempotency-Key (200 / 409).
  - Persistencia atómica de handoffs y outbox.
- **11/11 pruebas específicas del Worker CRM App** (`npm run crm:test`):
  - Healthcheck sin exposición de secretos.
  - Entrega de assets estáticos con encabezados de seguridad (CSP, HSTS, X-Content-Type-Options).
  - Flujo de autenticación con Supabase Auth y emisión de cookies HttpOnly seguras.
  - RBAC: rechazo 403 a rol `worker` en inventario, movimientos, alertas y órdenes.
  - Acceso autorizado a rol `owner` para inventario completo.
  - Acceso autorizado a rol `worker` para `/api/handoff`.
  - Destrucción de sesión en `POST /api/logout`.

---

### 6. Verificación en Vivo sobre Cloudflare Workers (E2E HTTP)

Se realizaron pruebas HTTP directas contra el endpoint desplegado en Cloudflare (`https://crm-kapso-app.solidbit-whatsapp-agent.workers.dev`):

1. **Frontend**:
   - `GET /` → HTTP 200 OK (`text/html; charset=utf-8`).
   - `GET /remote-app.js` → HTTP 200 OK (`application/javascript; charset=utf-8`).
   - `GET /style.css` → HTTP 200 OK (`text/css; charset=utf-8`).
2. **Acceso sin autenticación**:
   - `GET /api/me` → HTTP 401 Unauthorized (`{"error":"Authentication required"}`).
3. **Flujo de Login Owner**:
   - `POST /api/login` (`owner.qa@example.test`) → HTTP 200 OK, cookie `crm_session` emitida (`HttpOnly; Secure; SameSite=Strict; Max-Age=28800`).
   - `GET /api/me` → HTTP 200 OK (`role: "owner"`, `business_id: "1c2238f8-863a-4e33-8b5b-5b5e4683e190"`).
   - `GET /api/inventory` → HTTP 200 OK (24 productos listados directamente desde Supabase).
   - `GET /api/alerts` → HTTP 200 OK.
   - `GET /api/handoff` → HTTP 200 OK (`handoff: []`).
4. **Flujo de Login Worker**:
   - `POST /api/login` (`worker.qa@example.test`) → HTTP 200 OK, cookie `crm_session` emitida.
   - `GET /api/me` → HTTP 200 OK (`role: "worker"`).
   - `GET /api/inventory` → **HTTP 403 Forbidden** (`{"error":"Owner role required"}`).
   - `GET /api/handoff` → HTTP 200 OK (`handoff: []`).
5. **Logout**:
   - `POST /api/logout` → HTTP 200 OK, cookie eliminada (`Max-Age=0`).
6. **Webhook Worker no afectado**:
   - `GET https://crm-kapso-webhook.solidbit-whatsapp-agent.workers.dev/health` → HTTP 200 OK (`service: "crm-kapso-webhook"`).

---

### 7. Estado de Usuarios y Membresías en Supabase

Los usuarios de prueba fueron creados mediante Supabase Auth y vinculados a la organización del negocio piloto:

- **Negocio**: `1c2238f8-863a-4e33-8b5b-5b5e4683e190` (`negocio-piloto`)
- **Owner**:
  - Email: `owner.qa@example.test`
  - Auth UID: `8b37a666-096c-4e7f-8e66-5e4723598d12`
  - Membresía: `role = 'owner'`, `status = 'active'`
- **Worker**:
  - Email: `worker.qa@example.test`
  - Auth UID: `e12b347c-c8c8-4a25-8719-cc1554122703`
  - Membresía: `role = 'worker'`, `status = 'active'`

---

### 8. Puntos Operativos Pendientes

1. **Tokens oficiales de Kapso Inbox Embed**:
   - `KAPSO_OWNER_EMBED_URL` y `KAPSO_WORKER_EMBED_URL` se encuentran actualmente vacías, y `KAPSO_WORKER_EMBED_APPROVED` está en `"false"`. Una vez generadas las URLs firmadas de embed desde la plataforma de Kapso, se deberán cargar vía secrets/vars y activar el flag.
2. **Sincronización bidireccional de órdenes (`ENABLE_SUPABASE_SYNC`)**:
   - Permanece desactivada (`"false"`) por directriz de release hasta que se certifique la máquina de estados de pedidos.
3. **Notificaciones de entrega de handoffs (`ENABLE_KAPSO_HANDOFF_NOTICES`)**:
   - Permanece desactivada (`"false"`) por directriz de release hasta certificar la plantilla aprobada de WhatsApp.
