# SOLIDBIT — CRM KAPSO
## FIX-KAPSO-020 — Enrutamiento automático de conversaciones a Human Agent después del handoff

- **Fecha:** 2026-11-19
- **Autor:** Antigravity (Google DeepMind)
- **Repositorio:** [crm-kapso](https://github.com/risejoaquin/crm-kapso)
- **Rama:** `feat/supabase-crm-schema`
- **Worker Webhook Desplegado:** `crm-kapso-webhook` (v1.1.0)
- **Cloudflare Version ID:** `1e760820-f9fa-42f0-a57a-45e774610d03`
- **URL Webhook:** `https://crm-kapso-webhook.solidbit-whatsapp-agent.workers.dev/webhooks/kapso/handoff`
- **CRM Worker:** `crm-kapso-app` (v1.1.0)
- **URL CRM:** `https://crm-kapso-app.solidbit-whatsapp-agent.workers.dev`
- **Proyecto Kapso:** `7edf4d72-e0af-4b96-939f-08a44014bb88` (`SolidBit`)
- **Sandbox Phone Number ID:** `597907523413541`
- **Supabase Project:** `gplewdvxxldfvmeintvu` (`mr-burger-sandbox`)
- **Business ID:** `1c2238f8-863a-4e33-8b5b-5b5e4683e190`
- **Veredicto:** `AUTO_ASSIGNMENT_IMPLEMENTED` (con `BLOCKED_EXTERNAL_ACTION` para mensaje físico entrante de WhatsApp)

---

### 1. Respuestas Explícitas a los Requerimientos

#### ¿Cuál era la causa exacta de Unassigned?
En la arquitectura nativa de Kapso:
1. El workflow activo (`3b28724f-5b96-4a62-87cf-f132d0afdb3a`) invoca al agente IA (`agent_1794997864113`), el cual al recibir la solicitud de atención humana invoca su tool nativa `handoff_to_human(reason: "customer_request")`.
2. Esta herramienta nativa finaliza el turno del agente (`action: agent_chat_finalized`), pone la ejecución en estado `handoff` y emite el evento de proyecto `workflow.execution.handoff`.
3. Sin embargo, `handoff_to_human` no acepta ni contiene lógica de asignación a un agente específico; en la plataforma Kapso las conversaciones en handoff quedan por defecto en estado `Unassigned` a nivel de Inbox.
4. El webhook Cloudflare `crm-kapso-webhook` recibía el evento firmado y lo registraba en `crm_handoffs` y `crm_handoff_outbox`, pero no invocaba la API de asignación de Kapso. Por ende, la conversación permanecía `Unassigned` y no aparecía en el Inbox del trabajador (cuyo embed restringe la vista a `assigned_user_id = 6ef337c0-c724-4cd4-85ae-0c6068495840`) hasta que el dueño la asignaba manualmente en `app.kapso.ai`.

#### ¿Dónde se corrigió?
Se corrigió en dos capas coordinadas:
1. **Base de Datos (Supabase)**: Migración `db/008_crm_auto_assignment.sql` que amplía `public.crm_handoffs` con columnas de observabilidad y trazabilidad (`expected_assignee_id`, `effective_assignee_id`, `assignment_state`, `assignment_attempts`, `assignment_last_error`, `assignment_confirmed_at`) y la función atómica `public.crm_update_handoff_assignment`.
2. **Consumidor Backend (Cloudflare Worker)**: Módulo `cloudflare/kapso-webhook/src/assigner.ts` integrado en `handler.ts` de `crm-kapso-webhook`, que ante un nuevo handoff procesa la asignación oficial en Kapso en segundo plano (`ctx.waitUntil`) sin alterar el contrato firmado de respuesta HTTP 200.

#### ¿Se modificó un workflow, una función o un Worker?
- **Workflow**: No se modificó la definición del workflow (`3b28724f-5b96-4a62-87cf-f132d0afdb3a` sigue activa y funcional).
- **Función**: No se requirió alterar las funciones de Kapso.
- **Worker**: Se actualizó el Worker existente `crm-kapso-webhook` desplegando la versión `1.1.0` (Version ID `1e760820-f9fa-42f0-a57a-45e774610d03`).

#### ¿Qué API oficial de Kapso ejecuta la asignación?
`PATCH https://api.kapso.ai/platform/v1/whatsapp/conversations/:conversation_id`
Con autenticación `X-API-Key: <KAPSO_API_KEY>` y cuerpo:
```json
{
  "whatsapp_conversation": {
    "status": "active",
    "assignee_id": "6ef337c0-c724-4cd4-85ae-0c6068495840"
  }
}
```

#### ¿Cómo se determina el Human Agent correcto?
Se determina desde la configuración validada en variables de entorno:
- `KAPSO_WORKER_ASSIGNEE_ID` (`6ef337c0-c724-4cd4-85ae-0c6068495840`), que coincide estrictamente con la membresía del Human Agent `Joaquin Vallejo` en Kapso y con `crm_memberships.kapso_assignee_id` en Supabase.
- No existen identificadores hardcodeados en la lógica.

#### ¿Cómo se evita asignar al propietario por error?
Regla de seguridad estricta **ASG-08**:
El asignador verifica que `targetAgentId !== KAPSO_OWNER_USER_ID` (`e5d724a2-8961-458c-a95d-03222b17cd03`). Si por fallo de configuración se intentara usar el ID del dueño, la asignación es rechazada `fail-closed` con error `OWNER_ASSIGNMENT_FORBIDDEN` y el evento queda marcado como fallido en Supabase sin ejecutar asignación en Kapso.

#### ¿Cómo se previenen duplicados?
1. **Idempotencia a nivel de Webhook**: Clave de idempotencia única `X-Idempotency-Key` en PostgreSQL via `crm_record_handoff`. Si el webhook recibe un reintento del mismo evento, devuelve `{ duplicate: true }` y no dispara una nueva asignación.
2. **Idempotencia a nivel de Asignador (ASG-09)**: Antes de emitir el `PATCH`, consulta `GET /platform/v1/whatsapp/conversations?phone_number_id=...&assigned_user_id=...`. Si la conversación ya está asignada al Human Agent, omite el `PATCH` y confirma el estado en Supabase.
3. **No sobrescritura (ASG-06, ASG-07)**: Si la conversación fue tomada por otro operador o tiene un asignado distinto posterior, no se sobrescribe.

#### ¿Cómo se recuperan los fallos?
1. **Reintentos con Backoff**: En errores temporales de Kapso (HTTP 429 o 5xx), el asignador reintenta hasta 3 veces con retroceso exponencial.
2. **Persistencia de Estado**: Si todos los intentos fallan, el evento se marca en `crm_handoffs` con `assignment_state = 'failed'` y se guarda `assignment_last_error` sin credenciales.
3. **Script de Reconciliación**: Se proveyó `scripts/reconcile-handoff-assignments.mjs`, que consulta handoffs en estado `pending` o `failed` y reintenta la asignación oficial de forma controlada.

#### ¿Qué pruebas automatizadas aprobaron?
Aprobó la suite completa de 75 pruebas (`npm run test:all`):
- 26 pruebas en suite principal (`tests/*.test.mjs`)
- 26 pruebas en suite de webhook y asignación (`cloudflare/kapso-webhook/test/*.test.ts`)
- 16 pruebas en suite CRM App (`cloudflare/crm-app/test/crm-app.test.ts`)
- 7 pruebas en suite Notifier (`cloudflare/crm-notifier/test/notifier.test.ts`)

#### ¿Qué pruebas contra Kapso real aprobaron?
- **Auditoría de Aislamiento y Roles en Vivo**: 23/23 comprobaciones aprobadas (`scripts/isolation-audit.mjs`).
- **Asignación en Vivo**: Verificación empírica de asignación y persistencia sobre la conversación `07435eaa-5c15-4f37-bc74-d2403c260713`.
- **Reconciliación en Vivo**: Ejecución exitosa de `scripts/reconcile-handoff-assignments.mjs` actualizando Supabase y Kapso.

#### ¿Se desplegó la corrección?
Sí:
- Worker `crm-kapso-webhook` versión `1.1.0` desplegado en Cloudflare con Version ID `1e760820-f9fa-42f0-a57a-45e774610d03`.
- Secreto `KAPSO_API_KEY` configurado de forma segura en Cloudflare.
- Endpoint `/health` verificado con HTTP 200 y `version: 1.1.0`.

#### ¿Qué versión de workflow está activa?
Workflow: `Mr. Burger Sandbox — Asistente IA de prueba (Copy)`
ID: `3b28724f-5b96-4a62-87cf-f132d0afdb3a`
Lock Version: 24
Status: `active`

#### ¿Qué commit se publicó?
Rama: `feat/supabase-crm-schema`
Commit: Se publicará tras esta verificación (ver sección Git).

#### ¿Qué prueba E2E requiere intervención del teléfono QA?
Para certificar un nuevo handoff de extremo a extremo sin intervención manual:
- Desde el teléfono físico QA (`+526221556241`), enviar al WhatsApp Sandbox (`+56920403095`):
  `PRUEBA-MB-001 — Necesito atención humana. E2E-KAPSO-020.`
- El workflow procesará el mensaje, ejecutará `handoff_to_human`, disparará el webhook y el worker asignará automáticamente la conversación a `Joaquin Vallejo`.

---

### 2. Matriz de Aceptación

| Caso | Estado | Justificación / Evidencia |
| :--- | :---: | :--- |
| **Handoff detectado** | **PASS** | Webhook suscrito a `workflow.execution.handoff`, validación HMAC y parseo verificado. |
| **Human Agent correcto identificado** | **PASS** | Resuelto desde `KAPSO_WORKER_ASSIGNEE_ID` (`6ef337c0-c724-4cd4-85ae-0c6068495840`). |
| **Asignación automática implementada** | **PASS** | Módulo `assigner.ts` integrado en `crm-kapso-webhook` (v1.1.0). |
| **Asignación automática confirmada por Kapso** | **PASS** | Validado con `PATCH /platform/v1/whatsapp/conversations/:id` devolviendo HTTP 200. |
| **Evento duplicado no produce efectos inconsistentes** | **PASS** | Idempotencia en Supabase y omisión de reasignaciones innecesarias (ASG-09). |
| **No sobrescribe una reasignación manual posterior** | **PASS** | ASG-06 y ASG-07 implementados y certificados en pruebas unitarias. |
| **Reintento ante fallo temporal** | **PASS** | Retroceso exponencial ante HTTP 429/5xx certificado con pruebas unitarias. |
| **CRM Worker muestra conversación asignada** | **PASS** | Capturas visuales registradas en `docs/screenshots/fix-020/`. |
| **Aislamiento de otros usuarios conservado** | **PASS** | 23/23 checks de aislamiento aprobados en `isolation-audit.mjs`. |
| **Nuevo handoff real sin intervención manual** | **BLOCKED** | Gate humano: requiere envío de mensaje desde WhatsApp móvil físico hacia el Sandbox. |
| **Regresión automatizada** | **PASS** | 75/75 pruebas automáticas aprobadas sin regresiones. |
| **Despliegue verificado** | **PASS** | Worker `crm-kapso-webhook` desplegado en Cloudflare con Version ID `1e760820-f9fa-42f0-a57a-45e774610d03`. |

---

### 3. Evidencias Visuales
- [worker-inbox-desktop-1366x768.png](file:///C:/Users/Lucilfer/Desktop/cmr-kapso/docs/screenshots/fix-020/worker-inbox-desktop-1366x768.png)
- [worker-inbox-mobile-390x844.png](file:///C:/Users/Lucilfer/Desktop/cmr-kapso/docs/screenshots/fix-020/worker-inbox-mobile-390x844.png)
