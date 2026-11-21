# Decisiones de arquitectura (propuesta inicial)

## Producto generalista
Una instancia o despliegue separado por cliente es aceptable para el MVP; el código será común. No asumir multitenancy seguro hasta que esté diseñado y probado. Si se comparte base entre clientes, exigir aislamiento a nivel de consultas, políticas RLS y pruebas de autorización.

## Flujo de inventario
Kapso confirma venta -> evento/estado persistido en Supabase -> procesador idempotente registra movimiento -> descuenta existencias de forma transaccional -> evalúa umbral -> crea alerta owner.

El momento exacto de descuento depende de los estados de pedido ya definidos por cada negocio. No restar sobre mensajes de chat ni eventos repetidos. Cancelaciones/reembolsos requieren movimiento compensatorio según reglas vigentes.

## Roles
- owner: inventario, stock mínimo, alertas, chat embebido.
- worker: únicamente chat de conversaciones delegadas. La restricción debe validarse también en el servidor, incluida la autorización de la sesión embebida.

## Reutilización Smart WHA
Candidatos: diseño, login, componentes UI, utilidades de backend. Auditar dependencias antes de extraer; no asumir que están certificados.

## Preguntas técnicas por validar
- Contrato del embed Kapso y posibilidad de restringir a conversaciones delegadas.
- Eventos de confirmación/actualización de pedidos, IDs únicos y reintentos.
- Modelo de inventario (productos vs ingredientes) por negocio.
- Cómo notificar WhatsApp al encargado respetando reglas de mensajería.


## Webhook de Delegación en Cloudflare Workers (WEBHOOK-CF-001)

### Arquitectura de Integración
```
Kapso Platform Webhook (HMAC-SHA256)
               │
               ▼
Cloudflare Worker (crm-kapso-webhook)
  - GET  /health (Liveness y Version)
  - POST /webhooks/kapso/handoff
  - Verificación Web Crypto (timing-safe)
  - Guardas: Content-Type, Size <= 100KB, Project, Event, Channel
               │
               ▼  HTTPS RPC (service_role)
Supabase (PostgreSQL 17)
  - crm_record_handoff() [Atomic transaction]
      ├── crm_handoffs (registro primario + motivo)
      └── crm_handoff_outbox (cola persistente)
               │
               ▼  Lectura autenticada
CRM Local / Web App
  - crm_memberships (RBAC estricto)
  - Interfaz de atención humana y notificaciones
```

### Invariantes de Seguridad y Disponibilidad
1. **Verificación Estricta**: La firma `X-Webhook-Signature` se verifica sobre el cuerpo crudo antes de cualquier deserialización JSON, empleando `crypto.subtle` y comparación XOR de tiempo constante.
2. **Atomicidad Transaccional**: No existen escrituras separadas no coordinadas. La función `crm_record_handoff` garantiza que la delegación y su outbox se confirman de forma conjunta o fallan juntas.
3. **Idempotencia Certificada**: Reintentos idénticos devuelven `{ recorded: false, duplicate: true }` con HTTP 200 sin duplicar registros. Reutilizaciones conflictivas de la misma clave devuelven HTTP 409.
4. **Defensa ante Fugas de Secretos**: Ningún secreto, JWT, token ni cuerpo de mensaje sensible se registra ni se devuelve en respuestas HTTP.
