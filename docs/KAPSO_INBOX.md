# Kapso inbox embebido y handoff — contrato real

Documentación oficial:
- https://docs.kapso.ai/docs/platform/inbox/embedded
- https://docs.kapso.ai/docs/platform/webhooks/security
- https://docs.kapso.ai/docs/platform/webhooks/project-webhooks
- https://docs.kapso.ai/docs/whatsapp/templates/simple-text

## Bandeja por rol

- `owner`: URL de inbox embebido asociada al número de WhatsApp correcto.
- `worker`: **otro token** de inbox embed creado con `assigned_user_id` del trabajador. Kapso restringe por token a conversaciones asignadas al usuario.
- Además, la URL del trabajador carga los filtros `handoff=1&status=active`; estos filtros son solo presentación, NO reemplazan el alcance `assigned_user_id`.
- La aplicación permite solo `https://inbox.kapso.ai/embed/...` y fija CSP al mismo host.
- `KAPSO_WORKER_EMBED_APPROVED=true` solo se establece tras comprobar con un usuario QA que no ve chats fuera de su asignación. Sin aprobación, worker ve estado de integración pendiente.

### Provisionar sin revelar tokens

En el `.env.local` privado configurar `KAPSO_API_KEY`, `KAPSO_PHONE_NUMBER_ID` y, para trabajador, `KAPSO_WORKER_ASSIGNEE_ID`. También `KAPSO_EMBED_ALLOWED_ORIGIN` si no se usa el localhost por defecto.

Ejecutar `npm run kapso:embeds` **solo cuando se haya autorizado crear los embeds**. El comando crea lo que falte y guarda `KAPSO_OWNER_EMBED_URL` / `KAPSO_WORKER_EMBED_URL` únicamente en `.env.local`. No imprime tokens ni reemplaza URLs existentes. No habilita por sí solo el acceso del worker.

**No dejar allowed_origins vacío**: Kapso interpretaría eso como cualquier origen.

## Handoff firmado

- Registrar un webhook de proyecto para `workflow.execution.handoff`, payload v2.
- El endpoint del CRM es `POST /webhooks/kapso/handoff`.
- La firma `X-Webhook-Signature` es HMAC-SHA256 hex del cuerpo crudo, verificada con `KAPSO_WEBHOOK_SECRET` mediante comparación de tiempo constante.
- Validar `KAPSO_PROJECT_ID`, canal `whatsapp`, IDs y `X-Idempotency-Key`.
- Registrar cada handoff una sola vez en `handoff_events`, con fila en `handoff_outbox`.
- Repeticiones idénticas no duplican el trabajo; idempotency key con datos distintos se rechaza.
- Si no hay configuración privada, el endpoint queda desactivado (404).

## Avisar al trabajador por WhatsApp

El trabajador puede recibir una alerta mediante un template **UTILITY previamente aprobado**, sin requerir conversación activa.

Configurar en el archivo local:
- `ENABLE_KAPSO_HANDOFF_NOTICES=true`
- `KAPSO_API_KEY`
- `KAPSO_PHONE_NUMBER_ID`
- `KAPSO_WORKER_PHONE`
- `KAPSO_HANDOFF_TEMPLATE`
- `KAPSO_HANDOFF_TEMPLATE_LANGUAGE` (opcional; es_MX)

Ejecutar `npm run notify:once` para una ejecución, o `npm run notify:watch` para un proceso local continuo. Ambos se niegan a enviar si no se habilitó explícitamente el aviso.

**Advertencias:** un mensaje aceptado por la API no garantiza entrega final; se debe comprobar delivery. Ante timeout después de un envío aceptado, el worker podría reintentar: el patrón es *at least once*, no exactamente una vez. La plantilla debe estar aprobada y su nombre e idioma ser correctos. No enviar textos libres fuera de la ventana de atención.

## Requisitos previos al lanzamiento

1. Token worker realmente vinculado a `assigned_user_id` y filtro de handoff; probar acceso cruzado y cambios de asignación.
2. Activar endpoint firmado solo en servidor seguro HTTPS, nunca sin secreto.
3. Configurar la plantilla de aviso y comprobar aceptación y entrega.
4. Confirmar que la conversación delegada se puede responder y cerrar correctamente.
5. Validar que al terminar handoff el bot no retome de forma inesperada.
6. No reutilizar enlaces embed de un negocio para otro.

No se incluyen tokens, teléfonos ni credenciales reales en GitHub.
