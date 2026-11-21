# Procedimiento de Despliegue, Rollback y Operación — Cloudflare Worker (WEBHOOK-CF-001)

## 1. Identificación del Servicio
- **Nombre del Worker**: `crm-kapso-webhook`
- **Subdominio / Host**: `https://crm-kapso-webhook.solidbit-whatsapp-agent.workers.dev`
- **Endpoint de Salud**: `GET /health`
- **Endpoint de Webhook**: `POST /webhooks/kapso/handoff`
- **Entorno**: `production`; pruebas automatizadas en local. No se configura un entorno staging.
- **Compatibilidad**: Node.js compatibility (`2025-02-14`, flags: `nodejs_compat`)

---

## 2. Configuración y Secretos

### Variables Públicas (wrangler.jsonc)
- `SUPABASE_URL`: `https://gplewdvxxldfvmeintvu.supabase.co`
- `KAPSO_PROJECT_ID`: `7edf4d72-e0af-4b96-939f-08a44014bb88`
- `CRM_BUSINESS_ID`: `1c2238f8-863a-4e33-8b5b-5b5e4683e190`
- `WORKER_VERSION`: `1.0.0`
- `ENVIRONMENT`: `production`

### Secretos Criptográficos (Cloudflare Secrets)
*Nunca incluidos en repositorio ni logs:*
- `KAPSO_WEBHOOK_SECRET`: Clave HMAC-SHA256 compartida con Kapso para validar `X-Webhook-Signature`.
- `SUPABASE_SERVICE_ROLE_KEY`: Clave de servicio para ejecutar la función atómica `public.crm_record_handoff`.

Comandos para gestión de secretos:
```bash
cd cloudflare/kapso-webhook
npx wrangler secret put KAPSO_WEBHOOK_SECRET
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
```

---

## 3. Procedimiento de Despliegue

### Requisitos Previos
- Node.js 24+
- Sesión iniciada en Cloudflare Wrangler (`npx wrangler whoami`)
- Sesión iniciada en Kapso CLI (`kapso status`)
- Migración `db/006_crm_record_handoff.sql` aplicada en Supabase

### Pasos de Despliegue
1. Ejecutar pruebas unitarias y de integración:
   ```bash
   npm run worker:test
   ```
2. Verificar que no existan secretos en el árbol de trabajo:
   ```bash
   npm run security:staged
   ```
3. Desplegar a producción:
   ```bash
   cd cloudflare/kapso-webhook
   npx wrangler deploy
   ```
4. Comprobar salud del servicio:
   ```bash
   curl -s "https://crm-kapso-webhook.solidbit-whatsapp-agent.workers.dev/health"
   ```

---

## 4. Procedimiento de Rollback y Recuperación

### Rollback Inmediato (Cloudflare Version Management)
Cloudflare Workers mantiene historial inmutable de versiones desplegadas.

1. Listar versiones previas disponibles:
   ```bash
   cd cloudflare/kapso-webhook
   npx wrangler deployments list
   ```
2. Revertir a la versión estable previa:
   ```bash
   npx wrangler rollback <version-id>
   ```
3. El tráfico se redirige instantáneamente (< 1.5 segundos) a la versión anterior sin pérdida de configuración ni secretos.

### Recuperación ante Fallas de Red o Supabase
- El Worker responde HTTP 502/503 si Supabase es inaccesible.
- Kapso reintenta automáticamente la entrega siguiendo su ventana exponencial (10s, 40s, 90s).
- La idempotencia garantizada en `crm_record_handoff` evita duplicación de registros una vez recuperada la base de datos.
- Las notificaciones pendientes permanecen en `crm_handoff_outbox` para su posterior procesamiento sin riesgo de pérdida.

---

## 5. Reporte de Auditoría de Seguridad

- **Firma HMAC**: Verificada en Web Crypto con `crypto.subtle.sign` y comparación XOR de tiempo constante. Rechaza adulteraciones, firmas ausentes y claves cortas.
- **Validación de Entrada**: Límite estricto de 100 KB por cuerpo (`MAX_BODY_BYTES = 100_000`), rechazo de métodos no permitidos (405) y tipos MIME no JSON (415).
- **Aislamiento Multi-Tenant**: Verificación de `project_id` contra `KAPSO_PROJECT_ID` autorizado y vinculación estricta al `business_id` en Supabase.
- **Fail-Closed**: El Worker detiene el procesamiento inmediatamente (503) si cualquiera de los secretos requeridos no está presente.
