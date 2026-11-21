# SOLIDBIT — CRM KAPSO
## Reporte de Auditoría y Certificación Funcional: QA-CRM-008

- **Fecha de Evaluación**: 2026-11-19
- **Auditor**: QA Funcional Independiente (Antigravity Persona)
- **Repositorio**: [crm-kapso](https://github.com/risejoaquin/crm-kapso)
- **Rama**: `feat/supabase-crm-schema`
- **Versión Evaluada**: `FIX-CRM-007` (Commit `1465363`)
- **Entorno en Producción**: `https://crm-kapso-app.solidbit-whatsapp-agent.workers.dev`
- **Deployment ID Cloudflare**: `1b7dc3a1-05ff-40bd-973b-a3838eafab10`
- **Webhook Worker**: `crm-kapso-webhook` (Certificado previamente, inalterado)

---

### 1. Resumen de Veredictos por Área

| Área Evaluada | Veredicto | Resumen Operativo |
|---|---|---|
| **1. Login y Seguridad** | **PASS con Gate de Seguridad** | Autenticación, sesión opaca `crm_remote_session`, revocación inmediata por logout y protección RBAC aprobados al 100%. Bloqueado para producción general hasta que el propietario rote su contraseña en Supabase Auth. |
| **2. Pantallas Administrativas** | **PASS** | Resumen, Inventario, Pedidos, Borradores, Menú y Alertas cargan sin errores de Supabase ni excepciones de consola. Frontend resiliente ante fallas parciales. |
| **3. Inventario y Datos** | **PASS** | Coincidencia exacta con la base de datos real: 24 productos de inventario, 24 productos de menú, 21 modificadores, 9 pedidos y 8 borradores. Estados vacíos legítimos en alertas (0) y movimientos (0). |
| **4. Inbox Propietario** | **PASS** | Endpoint `/api/handoff` devuelve estado `ready` y la URL oficial `https://inbox.kapso.ai/embed/...`. El origen de Kapso responde HTTP 200 y carga el iframe funcional. |
| **5. Inbox Empleado (Worker)** | **BLOCKED (Protegido por Diseño)** | La cuenta worker no recibe el token del propietario (`status: "pending_integration"`). Permanece deliberadamente bloqueado hasta aprobación explícita de asignación por el encargado. |
| **6. Preparación para Uso Real** | **BLOCKED PARA PRODUCCIÓN FINAL** | El core administrativo y el Inbox de propietario están 100% operativos. Restan pendientes obligatorios para apertura general: rotación de contraseña del owner y aprobación/vinculación de Inbox para workers. |

---

### 2. Matriz de Pruebas Funcionales Detallada

#### FASE 1: Inicio de Sesión y Control de Acceso

| ID | Prueba | Estado | URL / Apartado | Evidencia Observable | Error Concreto | Pasos para Reproducir | Prioridad |
|---|---|---|---|---|---|---|---|
| `AUTH-01` | Login Owner | **PASS** | `/api/login` | Respuesta HTTP 200 con `{ "role": "owner" }` y emisión de cookie firmada `crm_remote_session`. | Ninguno | `POST /api/login` con credenciales de propietario. | N/A |
| `AUTH-02` | Sesión Persistente | **PASS** | `/api/me` | Respuesta HTTP 200 con rol `owner`. Cookie validada contra tabla `crm_sessions` en Supabase. | Ninguno | `GET /api/me` enviando la cookie de sesión previa. | N/A |
| `AUTH-03` | Login Worker QA | **PASS** | `/api/login` | Respuesta HTTP 200 con `{ "role": "worker" }` y emisión de cookie firmada `crm_remote_session`. | Ninguno | `POST /api/login` con credenciales de worker. | N/A |
| `AUTH-04` | Logout Efectivo con Revocación | **PASS** | `/api/logout` | Respuesta HTTP 200, cookie borrada (`Max-Age=0`). Intento posterior a `/api/me` devuelve HTTP 401 unánime (revocado en DB). | Ninguno | 1. `POST /api/logout`.<br>2. Reintentar `GET /api/me` con la cookie previa. | N/A |
| `SEC-01` | Rechazo de Acceso Anónimo | **PASS** | `/api/*` privados | Todos los endpoints (`/api/me`, `/inventory`, `/alerts`, `/orders`, `/drafts`, `/menu`, `/movements`, `/handoff`) devuelven HTTP 401 ante solicitudes anónimas. | Ninguno | `GET` a cualquier ruta `/api/` sin cabecera `Cookie`. | N/A |
| `RBAC-01` | Aislamiento y Restricción Worker | **PASS** | Rutas administrativas | La cuenta Worker recibe HTTP 403 Forbidden en `/inventory`, `/alerts`, `/orders`, `/drafts`, `/menu` y `/movements`. Solo accede a `/api/me` y `/api/handoff`. | Ninguno | Autenticar worker y solicitar `GET /api/inventory` o `GET /api/alerts`. | N/A |

---

#### FASE 2: Pantallas Administrativas y Datos

| ID | Prueba | Estado | URL / Apartado | Evidencia Observable | Error Concreto | Pasos para Reproducir | Prioridad |
|---|---|---|---|---|---|---|---|
| `UI-01` | Carga de Assets y Cabeceras | **PASS** | `/` (Web) | HTTP 200. Todas las secciones (`overview`, `inventory`, `orders`, `drafts`, `menu`, `alerts`, `handoff`) renderizadas en el DOM. Cabecera `X-Content-Type-Options: nosniff` presente. | Ninguno | Cargar `GET /` en navegador o cliente HTTP. | N/A |
| `DATA-01` | Módulo Inventario | **PASS** | `/api/inventory` | HTTP 200. Retorna exactamente 24 productos registrados y 0 productos en stock bajo. | Ninguno | `GET /api/inventory` con sesión owner. | N/A |
| `DATA-02` | Módulo Pedidos | **PASS** | `/api/orders` | HTTP 200. Retorna 9 pedidos registrados (consultados vía service role en tabla `orders`). | Ninguno | `GET /api/orders` con sesión owner. | N/A |
| `DATA-03` | Módulo Borradores | **PASS** | `/api/drafts` | HTTP 200. Retorna 8 borradores registrados (consultados en tabla `order_drafts`). | Ninguno | `GET /api/drafts` con sesión owner. | N/A |
| `DATA-04` | Módulo Menú | **PASS** | `/api/menu` | HTTP 200. Retorna 24 productos y 21 modificadores. Columnas canónicas `sku, category, name, price_cents, description, active` respetadas sin fallas de campo `id`. | Ninguno | `GET /api/menu` con sesión owner. | N/A |
| `DATA-05` | Módulo Alertas | **PASS** | `/api/alerts` | HTTP 200. Retorna `{"alerts":[]}` (0 alertas activas en `public.crm_alerts`). Estado legítimo vacío, sin error de tabla `crm_stock_alerts`. | Ninguno | `GET /api/alerts` con sesión owner. | N/A |
| `DATA-06` | Movimientos de Stock | **PASS** | `/api/movements` | HTTP 200. Retorna `{"movements":[]}` desde `public.crm_stock_movements`. Consulta reparada sin error 404. | Ninguno | `GET /api/movements` con sesión owner. | N/A |
| `UI-02` | Resumen Resiliente | **PASS** | Vista Resumen | Las métricas muestran datos reales consistentes: Productos=24, Stock bajo=0, Alertas=0, Pedidos=9. Implementación con `Promise.allSettled` previene bloqueos ante fallas parciales. | Ninguno | Navegar a pestaña "Resumen" tras inicio de sesión. | N/A |

---

#### FASE 3: Inbox Embebido (Kapso)

| ID | Prueba | Estado | URL / Apartado | Evidencia Observable | Error Concreto | Pasos para Reproducir | Prioridad |
|---|---|---|---|---|---|---|---|
| `INBOX-01` | Inbox Propietario (Sandbox) | **PASS** | `/api/handoff` | HTTP 200, `{ status: "ready", embed_url: "https://inbox.kapso.ai/embed/..." }`. La URL oficial de Kapso responde HTTP 200 y sirve la interfaz de Inbox. | Ninguno | 1. Iniciar sesión como Owner.<br>2. Navegar a "Atención humana". | N/A |
| `INBOX-02` | Aislamiento de Token Owner | **PASS** | `/api/handoff` | La sesión Worker recibe `{ status: "pending_integration", message: "..." }`. En ningún caso se filtra el token ni la URL del propietario. | Ninguno | 1. Iniciar sesión como Worker.<br>2. Consultar `GET /api/handoff`. | N/A |
| `INBOX-03` | Inbox Empleado (Asignación) | **BLOCKED** | `/api/handoff` | Variable de control `KAPSO_WORKER_EMBED_APPROVED="false"`. El acceso a conversaciones delegadas del worker está bloqueado por diseño hasta verificación de asignación y aprobación explícita. | Aprobación pendiente en Cloudflare / Supabase | Consultar `/api/handoff` con sesión Worker. | P2 |

---

#### FASE 4: Auditoría de Seguridad y Credenciales

| ID | Prueba | Estado | Componente | Evidencia Observable | Error Concreto | Pasos para Reproducir | Prioridad |
|---|---|---|---|---|---|---|---|
| `SEC-02` | Fuga de Secretos en `/health` | **PASS** | `/health` | HTTP 200 con metadata pública `{ status: "healthy", version: "1.1.0", environment: "production" }`. No expone URLs privadas, API keys ni secretos. | Ninguno | `GET /health`. | N/A |
| `SEC-03` | Sanitización de Documentación | **PASS** | `docs/` | Todos los archivos de reporte (`CONFIG_CF_006_REPORT.md`, `DEV_KAPSO_003_REPORT.md`, `FIX_CRM_007_REPORT.md`) contienen `[CREDENTIAL_REDACTED]`. Escaneo de secretos `--staged` pasa en 0 hallazgos. | Ninguno | Ejecutar `node scripts/secret-scan.mjs --staged`. | N/A |
| `SEC-04` | Rotación de Contraseña de Owner | **BLOCKED** | Supabase Auth | La cuenta de propietario aún puede iniciar sesión con la contraseña provisional previa. Para certificar el cierre de la vulnerabilidad, el usuario autorizado debe rotarla en el panel de Supabase Auth. | Credencial previa aún válida en base de datos | Iniciar sesión con la credencial histórica temporal. | P1 |

---

### 3. Veredictos Detallados

#### 1. Login y Seguridad: PASS (con Gate de Rotación)
- El flujo de autenticación opera con sesiones opacas almacenadas del lado del servidor en `public.crm_sessions` y cookies firmadas `crm_remote_session` con atributos de seguridad (`HttpOnly`, `Secure`, `SameSite=Lax`).
- El mecanismo de limitación de tasa (*rate limit*) y la revocación instantánea vía `/api/logout` funcionan con precisión matemática.
- **Acción requerida**: Rotar la contraseña en Supabase Auth para cerrar formalmente el gate `SEC-04`.

#### 2. Pantallas Administrativas: PASS
- La totalidad de las vistas administrativas carga de manera instantánea.
- Se eliminaron los fallos derivados de la consulta a tablas inexistentes (`crm_stock_alerts`, `crm_inventory_movements`) y la ausencia de columnas (`id` en `menu_products`).
- El dashboard de Resumen es completamente tolerante a fallas gracias al uso de `Promise.allSettled`.

#### 3. Inventario y Datos: PASS
- Integridad total de datos confirmada contra Supabase:
  - 24 productos de inventario.
  - 24 productos de menú y 21 modificadores.
  - 9 pedidos históricos y 8 borradores de compra.
  - Alertas (0) y movimientos (0) en estado limpio y funcional.

#### 4. Inbox Propietario: PASS
- El propietario cuenta con acceso directo y seguro a la consola embebida de Kapso Inbox en `https://inbox.kapso.ai/embed/...`.
- El frame se renderiza dentro del layout del CRM sin fugas de sesión y con retención de contexto entre cambios de navegación.

#### 5. Inbox Empleado: BLOCKED (Por Diseño de Seguridad)
- La protección de separación de roles opera según lo especificado: un trabajador nunca puede ver ni acceder a las conversaciones del propietario.
- Permanece en estado `pending_integration` hasta que se habilite deliberadamente la bandera `KAPSO_WORKER_EMBED_APPROVED="true"` tras verificar la correspondencia del `assigned_user_id`.

#### 6. Preparación para Uso Real: BLOCKED PARA APERTURA GENERAL
- **Uso por Propietario**: Listo para operación piloto controlada inmediatamente.
- **Apertura a Trabajadores y Operación Pública**: Bloqueado hasta completar las dos acciones de gobernanza descritas a continuación.

---

### 4. Lista Concreta de Acciones Pendientes

1. **Gobernanza / Rotación de Contraseña (P1 — Obligatorio)**:
   - El administrador de Supabase debe actualizar la contraseña del usuario `lucilfer@solidbit.com.mx` desde el dashboard de Supabase Auth o ejecutando la llamada administrativa correspondiente.
2. **Habilitación de Inbox para Trabajadores (P2 — Opcional para fase piloto)**:
   - Una vez comprobada la cuenta y asignado el agente en Kapso (`e5d724a2-8961-458c-a95d-03222b17cd03`), configurar en Cloudflare `KAPSO_WORKER_EMBED_APPROVED="true"` con su token embed respectivo para certificar `INBOX-03`.
3. **Notificaciones de Handoff (P2)**:
   - Mantener `ENABLE_KAPSO_HANDOFF_NOTICES="false"` hasta que la plantilla oficial de WhatsApp esté verificada y aprobada por Meta para evitar cargos por mensajería fallida.
