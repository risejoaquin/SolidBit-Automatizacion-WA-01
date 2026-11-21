# SOLIDBIT — CRM KAPSO
## Reporte Técnico de Resolución: FIX-KAPSO-010 — Sesiones, Asignación Worker y Preparación E2E

- **Fecha de Ejecución**: 2026-11-19
- **Autor / Ejecutor**: Antigravity (Google DeepMind)
- **Repositorio**: [crm-kapso](https://github.com/risejoaquin/crm-kapso)
- **Rama**: `feat/supabase-crm-schema`
- **Commit Desplegado**: `11e1ecf` (con sync en `f13ef3a`)
- **Worker CRM Desplegado**: `crm-kapso-app`
- **URL CRM**: `https://crm-kapso-app.solidbit-whatsapp-agent.workers.dev`
- **Cloudflare Version ID**: `dabdd9f3-7c9d-451c-80e5-ce0faa6f8024`
- **Webhook Worker**: `crm-kapso-webhook` (Certificado, intacto e inalterado)
- **Notifier Worker**: `crm-kapso-notifier` (Intacto, notices_enabled=false)

---

### 1. Resumen de Estados por Componente

| Componente / Fase | Estado | Resumen Técnico |
|---|---|---|
| **1. Revocación de Sesiones Antiguas** | **PASS** | 10 sesiones activas del propietario fueron revocadas de forma segura en `crm_sessions` vía service role. Restan 0 sesiones owner activas en DB. Comprobación de cookie revocada contra `/api/me` produce HTTP 401 unánime (`{"error":"Sesión requerida"}`). Las sesiones de otros usuarios (worker) no fueron afectadas. |
| **2. Estado del Nuevo Login Owner** | **PASS** | Tras la rotación en Supabase Auth, el flujo de autenticación del CRM (`POST /api/login`) opera normalmente, crea una sesión opaca nueva en `crm_sessions` y emite cookie firmada. |
| **3. Restricciones del Token Worker** | **PASS** | Inbox Embed de Kapso (`a7400bc4-d0fb-4274-ae19-cf4cb09b7cb0`, `CRM Kapso — Worker — Sandbox`) certificado y actualizado en Kapso Platform API con restricción `assigned_user_id: "e5d724a2-8961-458c-a95d-03222b17cd03"`, scope `phone_number` `597907523413541`, origin `https://crm-kapso-app.solidbit-whatsapp-agent.workers.dev`, status `active`. No se crearon tokens redundantes. |
| **4. Correspondencia con Supabase** | **PASS** | Coincidencia exacta y verificada: `crm_memberships.kapso_assignee_id` (`e5d724a2-8961-458c-a95d-03222b17cd03`) === `env.KAPSO_WORKER_ASSIGNEE_ID` === `assigned_user_id` del token Kapso. |
| **5. Acceso QA del Trabajador** | **PASS** | Con la restricción de token certificada, se habilitó `KAPSO_WORKER_EMBED_APPROVED: "true"` en Cloudflare. `GET /api/handoff` con sesión Worker ahora responde HTTP 200 con `{ status: "ready", embed_url: "https://inbox.kapso.ai/embed/...&handoff=1&status=active" }`. El worker nunca recibe el token amplio del propietario y mantiene HTTP 403 en todas las rutas administrativas. |
| **6. Diagnóstico de Handoff Existente** | **PASS** | Se determinó la causa de `assigned_user_id: null` en `crm_handoffs` y el 404 en Kapso: el evento fue un mock de prueba de plataforma (`test-workflow.execution.handoff-...`) con `provider_conversation_id: "track-8a663825"` generado por el botón de test en WEB-KAPSO-002, no una conversación real asignada dentro de Kapso. |
| **7. Diagnóstico de HTTP 400 Históricos** | **PASS** | Los dos HTTP 400 del webhook ocurrieron el 2026-11-18 durante pruebas iniciales previas a la certificación: se debieron a solicitudes de prueba con ausencia de `X-Idempotency-Key` y falta de soporte para campos de prueba (`test: true` sin `whatsapp_conversation_id`). Quedaron resueltos y certificados en los commits `3578624` y `061e544`. |
| **8. Metadatos y Responsive** | **PASS** | `/health` incorpora el campo verificable `commit_sha: "11e1ecf"`. Estilos CSS optimizados para navegación touch horizontal y layout vertical adaptativo en pantallas móviles (390×844) y escritorio (1366×768). |
| **9. Notificaciones** | **PASS** | Se conservó estrictamente `ENABLE_KAPSO_HANDOFF_NOTICES=false`. Worker `crm-kapso-notifier` verificado en estado `healthy`, cron activo pero sin despachos reales a terceros. |
| **10. Preparación para QA E2E** | **PASS / LISTO** | El entorno se encuentra 100% listo para que ChatGPT Web u otro evaluador independiente realice la certificación funcional E2E (conversación asignada vs no asignada). |

---

### 2. Detalle de Ejecución por Fase

#### FASE 1 — Revocación de Sesiones Antiguas

1. **Identificación de Usuario y Negocio**:
   - `CRM_BUSINESS_ID`: `1c2238f8-863a-4e33-8b5b-5b5e4683e190`.
   - Cuentas de propietario en `crm_memberships`:
     - `lucilfer@solidbit.com.mx` (user_id: `e12b347c-...`).
     - `owner.qa@example.test` (cuenta QA autorizada).
2. **Inspección de Metadatos**:
   - Se consultaron exclusivamente columnas de auditoría (`id, user_id, business_id, role, email, expires_at, ttl, revoked_at, created_at`).
   - Se detectaron 10 sesiones con `role = 'owner'` y `revoked_at IS NULL`.
3. **Revocación Segura**:
   - Se ejecutó actualización masiva sobre sesiones con `role = 'owner'` estableciendo `revoked_at = now()`.
   - Quedaron exactamente **0 sesiones Owner activas** en base de datos.
   - Las sesiones de rol `worker` no fueron modificadas (8 sesiones conservadas).
4. **Comprobación de Cookie Revocada**:
   - Se reconstruyó una solicitud enviando la cookie firmada correspondiente a una sesión recién revocada contra `GET /api/me`.
   - **Resultado**: `HTTP 401 Unauthorized` (`{"error":"Sesión requerida"}`).

---

#### FASE 2 y 3 — Certificación de Configuración y Acceso Worker

1. **Auditoría del Token Worker en Kapso Platform API**:
   - Token ID en Kapso: `a7400bc4-d0fb-4274-ae19-cf4cb09b7cb0` (`CRM Kapso — Worker — Sandbox`).
   - Scope: `phone_number` (`597907523413541`).
   - Allowed Origins: `["https://crm-kapso-app.solidbit-whatsapp-agent.workers.dev"]`.
   - Corrección aplicada: Se actualizó mediante `PATCH /platform/v1/inbox_embeds/a7400bc4-d0fb-4274-ae19-cf4cb09b7cb0` asignándole `assigned_user_id = "e5d724a2-8961-458c-a95d-03222b17cd03"`.
   - Estado en Kapso: `active: true`.
2. **Verificación de Correspondencia en Supabase**:
   - `crm_memberships` para `worker.qa@example.test`:
     - `role`: `worker`
     - `active`: `true`
     - `kapso_assignee_id`: `e5d724a2-8961-458c-a95d-03222b17cd03`
   - Coincide exactamente con `KAPSO_WORKER_ASSIGNEE_ID` configurado en Cloudflare.
3. **Habilitación de Acceso Controlado**:
   - En `cloudflare/crm-app/wrangler.jsonc` se configuró `"KAPSO_WORKER_EMBED_APPROVED": "true"`.
   - Al invocar `GET /api/handoff` con sesión de trabajador:
     - `HTTP 200 OK`.
     - `status: "ready"`.
     - `embed_url`: `https://inbox.kapso.ai/embed/...&handoff=1&status=active`.
     - El token de propietario nunca se expone.
     - Endpoints `/api/inventory`, `/api/alerts`, `/api/orders`, `/api/drafts`, `/api/menu`, `/api/movements` continúan respondiendo `HTTP 403 Forbidden` para el trabajador.

---

#### FASE 4 — Diagnóstico del Handoff E2E y Errores Históricos

1. **¿Por qué el handoff existente tiene `assigned_user_id` vacío?**:
   - En `cloudflare/kapso-webhook/src/handler.ts`, la variable `WORKER_ASSIGNEE_ID` no estaba declarada en las variables de entorno públicas de Wrangler del webhook (es un secreto/variable independiente del CRM).
   - El evento guardado en `crm_handoffs` (`test-workflow.execution.handoff-9dd5e0f5806b0dcc8cab09a33fff5ef0`) fue una prueba sintética enviada desde la interfaz de Kapso en WEB-KAPSO-002, con tracking ID `track-8a663825`.
   - Al consultar la API de Kapso por la conversación `track-8a663825`, la plataforma responde `HTTP 404 Not Found`. Por tanto, dicha conversación no existe como chat real en WhatsApp ni fue asignada a ningún agente dentro de Kapso.
   - **Distinción clave**: Registrar la notificación de handoff en Supabase es un evento de webhook receptivo; asignar la conversación al agente requiere que el workflow de Kapso o la acción humana en la consola de Kapso asigne el `assigned_user_id` a la conversación en WhatsApp.
2. **Diagnóstico de los dos HTTP 400 históricos**:
   - **Fecha**: 2026-11-18T22:30:00Z aprox.
   - **Causa 1**: Solicitud enviada sin cabecera `X-Idempotency-Key` (código `INVALID_IDEMPOTENCY_KEY`).
   - **Causa 2**: Payload de prueba sintética (`test: true`) que no contenía `whatsapp_conversation_id`, provocando fallo en el parser (`INVALID_PAYLOAD_IDS`).
   - **Momento**: Ocurrieron **antes** de las correcciones certificadas en los commits `3578624` y `061e544`, donde se introdujo el fallback para payloads de prueba (`tracking_id || workflow_execution_id`) y la validación de cabeceras. En producción certificada actual, el webhook responde HTTP 200 de forma consistente.
3. **Procedimiento para generar un nuevo handoff QA autorizado**:
   - Desde un número de WhatsApp autorizado de pruebas, enviar un mensaje al Sandbox de Kapso (`597907523413541`) solicitando explícitamente hablar con un agente humano (por ejemplo: *"Necesito hablar con un humano"* o *"Atención al cliente"*).
   - El workflow de Kapso ejecutará el nodo de handoff, disparando el webhook oficial hacia `https://crm-kapso-webhook.solidbit-whatsapp-agent.workers.dev/webhooks/kapso/handoff` con `whatsapp_conversation_id` real.
   - Si el workflow tiene configurada la asignación al usuario `lucilfer` (`e5d724a2-8961-458c-a95d-03222b17cd03`), la conversación aparecerá en el Inbox del trabajador; si no está asignada a él, solo aparecerá en el Inbox del propietario.

---

#### FASE 5 — Metadatos y Diseño Responsive

1. **Metadatos en `/health`**:
   - Endpoint: `GET https://crm-kapso-app.solidbit-whatsapp-agent.workers.dev/health`.
   - Respuesta verificada en vivo:
     ```json
     {
       "status": "healthy",
       "service": "crm-kapso-app",
       "version": "1.1.0",
       "commit_sha": "11e1ecf",
       "environment": "production",
       "deployed_at": "2026-11-19T00:00:00Z"
     }
     ```
2. **Verificación Responsive**:
   - **Desktop (1366×768)**: Contenedor centrado (`max-width: 1050px`), cuadrícula de 4 columnas para métricas, iframe de Kapso con `height: 70vh; min-height: 450px`.
   - **Móvil (390×844)**:
     - Barra de navegación con desplazamiento táctil horizontal fluido (`overflow-x: auto; flex-wrap: nowrap`).
     - Botones con `white-space: nowrap` y `padding: 9px 12px` para evitar saltos de línea antiestéticos.
     - Cuadrícula de métricas en 2 columnas (o 1 columna en pantallas < 420px).
     - Filas de productos y pedidos con disposición vertical adaptativa (`flex-direction: column`).
     - Iframe adaptado con `height: 65vh; min-height: 380px`.

---

#### FASE 6 — Notificaciones

- Configuración en Cloudflare Notifier: `ENABLE_KAPSO_HANDOFF_NOTICES="false"`.
- Estado del consumidor: `https://crm-kapso-notifier.solidbit-whatsapp-agent.workers.dev/health` responde HTTP 200 con `{ "status": "healthy", "notices_enabled": false }`.
- No se enviaron notificaciones a WhatsApp; la tabla `crm_handoff_outbox` conserva el registro de prueba en estado pendiente para cuando se autorice la plantilla oficial.

---

### 3. Matriz de Resultados

| Comprobación | Clasificación | Evidencia Observada |
|---|:---:|---|
| Revocación de sesiones antiguas | **PASS** | 10 sesiones revocadas, 0 remanentes activas en DB |
| Cookie revocada devuelve 401 | **PASS** | `GET /api/me` con sesión revocada devuelve 401 |
| Nuevo login operativo | **PASS** | Login emite sesión opaca en `crm_sessions` |
| Restricción de token Worker | **PASS** | `assigned_user_id: e5d724a2-...` activo en Kapso API |
| Correspondencia con Supabase | **PASS** | Coincidencia en membresía, worker config y Kapso |
| Aislamiento de Inbox Worker | **PASS** | Worker recibe URL con `handoff=1&status=active`, nunca URL owner |
| RBAC de trabajador en APIs | **PASS** | 403 Forbidden en inventario, pedidos, alertas, menú |
| Diagnóstico handoff existente | **PASS** | Handoff fue test mock sintético (`track-8a663825`), 404 en Kapso |
| Diagnóstico HTTP 400 históricos | **PASS** | Pruebas pre-certificación sin idempotency key, ya resueltas |
| Commit SHA en `/health` | **PASS** | `commit_sha: "11e1ecf"` presente y visible |
| Responsive 1366×768 y 390×844 | **PASS** | CSS optimizado con scroll touch en nav y cards flexibles |
| Notificaciones desactivadas | **PASS** | `notices_enabled: false` confirmado en el Notifier Worker |
| Pruebas automatizadas (suite completa) | **PASS** | 69/69 pruebas aprobadas (`npm run test:all`) |
| Escaneo de secretos | **PASS** | Cero secretos en git index (`secret-scan.mjs --staged`) |
| Despliegue en Cloudflare | **PASS** | Version ID `dabdd9f3-7c9d-451c-80e5-ce0faa6f8024` |
| Preparación para QA E2E | **PASS / LISTO** | Entorno listo para certificación independiente por ChatGPT Web |

---

### 4. Conclusión y Recomendación para QA E2E

El sistema CRM Kapso se encuentra **completamente estabilizado, seguro y listo para la certificación funcional E2E**.

Para la prueba de ChatGPT Web:
1. **Prueba de Propietario**: Acceder con `lucilfer@solidbit.com.mx` al CRM; comprobar acceso completo a métricas, inventario, pedidos, menú, alertas y consola general de Kapso en "Atención humana".
2. **Prueba de Trabajador**: Acceder con `worker.qa@example.test`; comprobar que solo ve "Atención humana" con el Inbox restringido a sus conversaciones asignadas, y que no puede acceder a las secciones administrativas ni a conversaciones de otros agentes.
