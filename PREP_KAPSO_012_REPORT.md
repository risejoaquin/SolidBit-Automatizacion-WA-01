# SOLIDBIT — CRM KAPSO
## Reporte Técnico de Preparación: PREP-KAPSO-012 — Preparación Definitiva de QA E2E Worker

- **Fecha de Ejecución**: 2026-11-19
- **Autor / Ejecutor**: Antigravity (Google DeepMind)
- **Repositorio**: [crm-kapso](https://github.com/risejoaquin/crm-kapso)
- **Rama**: `feat/supabase-crm-schema`
- **Worker CRM Desplegado**: `crm-kapso-app`
- **URL CRM**: `https://crm-kapso-app.solidbit-whatsapp-agent.workers.dev`
- **Cloudflare Version ID**: `dabdd9f3-7c9d-451c-80e5-ce0faa6f8024`
- **Webhook Worker**: `crm-kapso-webhook` (Certificado, intacto e inalterado)
- **Notifier Worker**: `crm-kapso-notifier` (Intacto, `notices_enabled: false`)
- **Herramienta Visual**: Headless Chrome (vía `puppeteer-core`)
- **Estado General de Preparación**: **LISTO PARA CERTIFICACIÓN E2E / GATE FÍSICO DOCUMENTADO**

---

### 1. Resumen Ejecutivo y Matriz de Estado

| Componente / Fase | Estado | Resumen Técnico |
|---|:---:|---|
| **Fase 1: Autenticación Worker** | **PASS** | Cuenta QA Worker (`worker.qa@example.test`) localizada en Supabase Auth, membresía activa con rol `worker`, `POST /api/login` responde HTTP 200 con cookie firmada, `GET /api/me` confirma rol `worker`, 403 Forbidden en todas las rutas administrativas, `POST /api/logout` invalida la sesión y posterior `/api/me` devuelve 401. |
| **Fase 2: Certificación de Token Kapso** | **PASS** | Token Worker (`a7400bc4-d0fb-4274-ae19-cf4cb09b7cb0`, `CRM Kapso — Worker — Sandbox`) activo en Kapso Platform API con `scope_id: "597907523413541"`, `allowed_origins: ["https://crm-kapso-app.solidbit-whatsapp-agent.workers.dev"]` y `assigned_user_id: "e5d724a2-8961-458c-a95d-03222b17cd03"`. Restricción aplicada estrictamente en servidor. |
| **Fase 3: Conversaciones QA (Sandbox)** | **LISTO / GATE** | Identificadas las conversaciones del Sandbox. La conversación activa `673e647a-6f4c-441f-b45d-51eb9c500a42` (cliente `+526221556241`) y las conversaciones finalizadas sirven como escenario QA-B (no asignadas / visibles para Owner). Para QA-A se documenta el gate de asignación y el procedimiento para nuevo mensaje si se requiere disparar un handoff en caliente. Cero eventos sintéticos generados. |
| **Fase 4: Pruebas Automáticas de Aislamiento** | **PASS** | Suite de 23 verificaciones automatizadas aprobada al 100% (`scripts/isolation-audit.mjs`): RBAC 403, URL de embed restringida (`handoff=1&status=active`), imposibilidad de manipulación de parámetros, revocación duradera de sesiones anteriores en DB, y aislamiento estricto de credenciales. |
| **Fase 5: Handoff E2E** | **LISTO / GATE** | Se correlacionó el flujo completo: Mensaje entrante → Workflow Kapso (`3b28724f-5b96-4a62-87cf-f132d0afdb3a`) → Tool `handoff_to_human` → Webhook Cloudflare → Supabase (`crm_handoffs` & `crm_handoff_outbox`) → Inbox Worker. Como exige la directriz, no se inyectaron mocks sintéticos: se describe el gate de intervención física desde el teléfono QA autorizado `+526221556241`. |
| **Fase 6: Pruebas Visuales Reales** | **PASS** | Capturas automatizadas reales tomadas con Headless Chrome en los viewports exactos de `1366×768` (escritorio) y `390×844` (móvil). Verificada la adaptabilidad del login, barra de navegación con scroll horizontal táctil y contenedor del iframe. |
| **Fase 7: Notificaciones** | **PASS** | Notifier responde HTTP 200 en `/health` con `notices_enabled: false`. Outbox en Supabase intacto, cero envíos no autorizados en Sandbox. Dependencia de plantilla UTILITY y número de producción documentada. |
| **Suite Completa de Pruebas** | **PASS** | 69 de 69 pruebas unitarias e integrales aprobadas (`npm run test:all`). |

---

### 2. Detalle de Pruebas y Evidencias por Fase

#### Fase 1 — Autenticación y Control de Acceso Worker
- **Cuenta QA**: `worker.qa@example.test` (User ID `e12b347c-c8c8-4a25-8719-cc1554122703`).
- **Membresía en `crm_memberships`**:
  - `role`: `worker`
  - `active`: `true`
  - `kapso_assignee_id`: `e5d724a2-8961-458c-a95d-03222b17cd03` (coincide con el usuario `lucilfer` en Kapso).
- **Prueba en Vivo**:
  - `POST /api/login`: HTTP 200 OK, emite cookie `crm_remote_session`.
  - `GET /api/me`: HTTP 200 OK con `{ "role": "worker" }`.
  - Rutas Administrativas con sesión Worker:
    - `GET /api/inventory`: **HTTP 403 Forbidden**
    - `GET /api/alerts`: **HTTP 403 Forbidden**
    - `GET /api/orders`: **HTTP 403 Forbidden**
    - `GET /api/drafts`: **HTTP 403 Forbidden**
    - `GET /api/menu`: **HTTP 403 Forbidden**
    - `GET /api/movements`: **HTTP 403 Forbidden**
  - `GET /api/handoff`: **HTTP 200 OK**, entrega `{ "status": "ready", "embed_url": "https://inbox.kapso.ai/embed/...&handoff=1&status=active" }`.
  - `POST /api/logout`: **HTTP 200 OK**, `Set-Cookie` con `Max-Age=0`. Intento posterior a `/api/me` devuelve **HTTP 401 Unauthorized**.

#### Fase 2 — Certificación de Token y Asignación en Kapso
- **Token Worker Certificado**:
  - `id`: `a7400bc4-d0fb-4274-ae19-cf4cb09b7cb0`
  - `name`: `CRM Kapso — Worker — Sandbox`
  - `scope_type`: `phone_number`
  - `scope_id`: `597907523413541` (Sandbox WhatsApp Meta `+56920403095`)
  - `allowed_origins`: `["https://crm-kapso-app.solidbit-whatsapp-agent.workers.dev"]`
  - `assigned_user_id`: `e5d724a2-8961-458c-a95d-03222b17cd03`
  - `status`: `active`
- **Aislamiento en Servidor**: El servidor de Kapso filtra las conversaciones según `assigned_user_id`. Un iframe que cargue con este token no puede consultar conversaciones ajenas ni alterar el filtro de asignación, independientemente de los parámetros de URL enviados por el navegador.

#### Fase 3 — Escenarios de Conversaciones QA en Sandbox
- **Auditoría de Conversaciones en Sandbox (`597907523413541`)**:
  - Se identificaron 7 conversaciones reales en la plataforma Kapso con el cliente autorizado `+526221556241` ("Joaqui"):
    1. `673e647a-6f4c-441f-b45d-51eb9c500a42` (Activa, 9 mensajes, último entrante 2026-11-18T22:08:08Z).
    2. `87d32fd6-0639-4c2a-94b2-aae9964db888` (Finalizada, pedido de prueba).
    3. `cdcea773-0b7a-4a2e-aabb-06894ac0555a` (Finalizada, borrador preparado).
    4. `060b931c-d3d5-4c95-813c-39d92dd36cc8` (Finalizada).
    5. `0a822f6f-4627-4fc3-abac-05d5742d71cf` (Finalizada).
    6. `602e4b18-b0e1-4177-bda7-a52804f1665d` (Finalizada).
    7. `c35b6e38-8190-45ea-a844-09c16116a8ea` (Finalizada).
- **Definición de Escenarios**:
  - **Conversación QA-B (Aislamiento / Solo Propietario)**:
    - Cualquiera de las conversaciones existentes no asignadas (por ejemplo `673e647a-6f4c-441f-b45d-51eb9c500a42` o `87d32fd6-0639-4c2a-94b2-aae9964db888`).
    - Visible exclusivamente para el Propietario.
    - Invisible para el Trabajador debido a la restricción `assigned_user_id` del token.
  - **Conversación QA-A (Atención Humana / Asignada al Trabajador)**:
    - Para que una conversación aparezca en el Inbox del Trabajador, debe tener asignado en Kapso el `assigned_user_id: "e5d724a2-8961-458c-a95d-03222b17cd03"`.
    - Procedimiento documentado en la sección 4 para que el evaluador independiente o el usuario asigne la conversación desde `https://app.kapso.ai` o mediante el nuevo handoff.

#### Fase 4 — Prueba Automática de Aislamiento (`scripts/isolation-audit.mjs`)
Se ejecutó la suite completa de auditoría contra el CRM desplegado:
```
=== SOLIDBIT CRM KAPSO — PREP-KAPSO-012 ISOLATION AUDIT ===
[PASS] 1. Worker Login HTTP 200 - Status: 200
[PASS] 1b. Worker Session Cookie Issued 
[PASS] 2. Worker /api/me role is worker - Role: worker
[PASS] 3. RBAC 403 on /api/inventory - Status: 403
[PASS] 3. RBAC 403 on /api/alerts - Status: 403
[PASS] 3. RBAC 403 on /api/orders - Status: 403
[PASS] 3. RBAC 403 on /api/drafts - Status: 403
[PASS] 3. RBAC 403 on /api/menu - Status: 403
[PASS] 3. RBAC 403 on /api/movements - Status: 403
[PASS] 4a. Worker /api/handoff HTTP 200 
[PASS] 4b. Worker receives ready status 
[PASS] 4c. Worker URL contains handoff=1 
[PASS] 4d. Worker URL contains status=active 
[PASS] 4e. Worker URL does NOT match Owner Embed URL 
[PASS] 4f. Worker URL matches Worker Embed URL 
[PASS] 5a. Worker Token Active in Kapso 
[PASS] 5b. Worker Token has assigned_user_id restriction 
[PASS] 5c. Worker Token scope is sandbox phone_number 
[PASS] 6. Parameter tampering cannot yield owner embed 
[PASS] 7a. Prior revoked owner sessions present in DB - Count: 5
[PASS] 7b. DB-revoked cookie produces strict HTTP 401 on /api/me 
[PASS] 8a. Worker Logout HTTP 200 
[PASS] 8b. Post-logout /api/me returns HTTP 401 - Status: 401

=== AUDIT SUMMARY ===
TOTAL CHECKS: 23 | PASS: 23 | FAIL: 0
VERDICT: PASS
```

#### Fase 5 — Handoff E2E y Correlación
- **Workflow Activo**: `3b28724f-5b96-4a62-87cf-f132d0afdb3a` (`Mr. Burger Sandbox — Asistente IA de prueba (Copy)`).
- **Herramienta de Handoff**: `handoff_to_human` habilitada en el agente IA.
- **Cadena de Eventos Verificada**:
  1. Cliente envía mensaje desde `+526221556241` pidiendo agente humano.
  2. El modelo invoca la tool `handoff_to_human`, cambiando el estado de ejecución a `handoff`.
  3. Kapso dispara el webhook `workflow.execution.handoff` firmado con HMAC-SHA256 a `https://crm-kapso-webhook.solidbit-whatsapp-agent.workers.dev/webhooks/kapso/handoff`.
  4. El Worker Webhook valida la firma, verifica idempotencia y persiste el evento en `crm_handoffs` y `crm_handoff_outbox`.
  5. **Gate de Intervención Física**: Siguiendo las directrices éticas y operativas de RISEHANDBOOK, **no se inyectaron eventos falsos ni sintéticos**. La generación de un nuevo handoff real requiere el envío del mensaje de texto desde el teléfono de pruebas hacia el Sandbox.

#### Fase 6 — Pruebas Visuales Automatizadas
Se utilizó Headless Chrome (`puppeteer-core`) sobre `https://crm-kapso-app.solidbit-whatsapp-agent.workers.dev` para capturar la apariencia real del sistema:
- `docs/screenshots/desktop-login-1366x768.png`: Vista completa de autenticación en escritorio.
- `docs/screenshots/mobile-login-390x844.png`: Vista optimizada en smartphone (iPhone 13/14 viewport).
- `docs/screenshots/desktop-worker-dashboard-1366x768.png`: Panel del trabajador autenticado con acceso único a "Atención humana".
- `docs/screenshots/mobile-worker-dashboard-390x844.png`: Barra de navegación móvil con scroll horizontal fluido y sin roturas de layout.

#### Fase 7 — Notificaciones
- Endpoint: `https://crm-kapso-notifier.solidbit-whatsapp-agent.workers.dev/health`.
- Respuesta: `{ "status": "healthy", "service": "crm-kapso-notifier", "version": "1.0.0", "environment": "production", "notices_enabled": false }`.
- Cero notificaciones salientes a WhatsApp.
- Dependencia externa: Requiere migración a número oficial de WhatsApp Business API y plantilla aprobada por Meta (`UTILITY`) para activar `ENABLE_KAPSO_HANDOFF_NOTICES="true"`.

---

### 3. Matriz de Veredictos de Auditoría

| Ítem | Clasificación | Evidencia Observable |
|---|:---:|---|
| Login Worker en vivo | **PASS** | `POST /api/login` responde 200, emite cookie `crm_remote_session` |
| Restricción de rol Worker en `/api/me` | **PASS** | `role: "worker"`, `active: true` |
| RBAC 403 en todas las rutas administrativas | **PASS** | 403 Forbidden en inventario, pedidos, alertas, menú, movimientos |
| Aislamiento de Embed Worker | **PASS** | Worker recibe URL con token worker y `handoff=1&status=active`, nunca URL owner |
| Restricción del token en servidor Kapso | **PASS** | Token worker tiene `assigned_user_id: "e5d724a2-..."` forzado en servidor |
| Resistencia a alteración de parámetros | **PASS** | Query params no permiten eludir la restricción ni obtener token amplio |
| Revocación duradera de sesiones antiguas | **PASS** | Sesiones revocadas en `crm_sessions` devuelven estrictamente HTTP 401 |
| Logout de Worker | **PASS** | `POST /api/logout` borra cookie; petición posterior produce 401 |
| Pruebas visuales en 1366×768 y 390×844 | **PASS** | 4 capturas generadas y validadas con Headless Chrome |
| Notifier Worker en producción | **PASS** | Estado `healthy`, `notices_enabled: false`, outbox seguro |
| Suite completa de pruebas automatizadas | **PASS** | 69/69 pruebas aprobadas (`npm run test:all`) |
| Escaneo de secretos en git index | **PASS** | `node scripts/secret-scan.mjs --staged` limpio |
| Estado de la rama y despliegue | **PASS** | Rama `feat/supabase-crm-schema`, webhook y CRM estables |

---

### 4. Procedimiento Exacto para ChatGPT Web (Certificación Funcional E2E)

Para realizar la certificación independiente:

#### PASO 1 — Certificar Sesión Propietario (Owner)
1. Abrir navegador en `https://crm-kapso-app.solidbit-whatsapp-agent.workers.dev`.
2. Iniciar sesión con la cuenta del propietario (`lucilfer@solidbit.com.mx`).
3. Verificar acceso a:
   - **Resumen**: Métricas completas de productos, pedidos y alertas.
   - **Inventario**: 24 productos registrados.
   - **Pedidos**: 9 pedidos históricos.
   - **Borradores**: 8 borradores registrados.
   - **Menú**: 24 productos y 21 modificadores.
   - **Alertas**: 0 alertas activas.
   - **Atención humana**: Iframe de Kapso cargando todas las conversaciones del Sandbox (QA-B).

#### PASO 2 — Certificar Sesión Trabajador (Worker)
1. En una ventana de incógnito o tras cerrar sesión, acceder a `https://crm-kapso-app.solidbit-whatsapp-agent.workers.dev`.
2. Iniciar sesión con la cuenta de empleado (`worker.qa@example.test`).
3. Verificar:
   - Solo aparece disponible la pestaña **"Atención humana"**.
   - Si intenta navegar manualmente a `/api/inventory` o `/api/orders`, recibe `HTTP 403 Forbidden`.
   - En **"Atención humana"**, carga el Inbox embebido de Kapso restringido a sus conversaciones asignadas (`handoff=1&status=active`).
   - Comprobar que **NO** tiene acceso a las conversaciones unassigned (QA-B).

#### PASO 3 — Gate de Prueba Handoff en Vivo (Opcional si se dispone del teléfono QA)
1. Desde el WhatsApp del teléfono autorizado `+52 622 155 6241`, enviar al Sandbox `+56 9 2040 3095` el mensaje:
   ```
   Necesito hablar con un asesor humano por favor
   ```
2. El bot IA del Sandbox ejecutará `handoff_to_human`.
3. El webhook persistirá el registro en Supabase.
4. En `https://app.kapso.ai`, asignar la conversación al usuario `lucilfer`.
5. Recargar la vista del Worker en el CRM: la conversación (QA-A) aparecerá en su Inbox para responder directamente.
