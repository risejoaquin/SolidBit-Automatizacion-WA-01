# CRM KAPSO — FINAL-LOCAL-QA-002 (un solo hito)

## Objetivo
Certificar en una única sesión el CRM genérico conectado a Supabase y Kapso, sin branding ni datos falsos y sin GitHub Actions. ChatGPT ya implementó y aplicó las migraciones CRM al Supabase existente. NO recrear las 4 tablas de Kapso.

## Entorno
Repositorio privado `https://github.com/risejoaquin/crm-kapso`.
Rama `feat/supabase-crm-schema`.
Ruta exacta `C:\Users\Lucilfer\Desktop\cmr-kapso`.
Windows, PowerShell, Node.js 24+ y Git.
No instalar dependencias npm que no declare el proyecto. No exponer túneles públicos.

### Fase A: sincronización y protección del entorno
1. Si falta la carpeta, clonar. Si existe, confirmar remote; no sobreescribir cambios no guardados.
2. Ejecutar `git fetch origin`, `git switch feat/supabase-crm-schema`, `git pull --ff-only`.
3. Registrar SHA HEAD, `git status --short`, Node y Git.
4. Ejecutar `npm run setup:local`. Si `.env.local` ya existe, preservarlo.
5. En `.env.local` introducir de forma privada `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`. No imprimir valores.
6. Leer `docs/REMOTE_SETUP.md`, `docs/SECURITY_LOCAL.md`, `docs/RELEASE_GATE.md`.
7. Confirmar exclusión de `.env.local`, SQLite y `qa-private` con `git check-ignore`.
8. Ejecutar `npm run security:setup`.

### Fase B: conexión a la base desplegada
1. Verificar de forma no destructiva que las tablas originales `orders`, `order_drafts`, `menu_products` y `menu_modifiers` siguen disponibles.
2. Confirmar las 10 tablas nuevas de CRM; no aplicar de nuevo migraciones que ya existan.
3. Ejecutar `npm run bootstrap:remote` para crear/verificar cuentas Auth owner/worker y recuperar el negocio piloto. Guardar ID solo en `.env.local`.
4. Confirmar que no se sobreescribieron contraseñas existentes.
5. Ejecutar `npm run doctor:remote`.
6. Comprobar que `crm_order_sources.enabled=false` y que los 24 SKUs están importados con existencias cero. **No habilitar el sincronizador sin conteos reales.**

### Fase C: auditoría automática integral
Ejecutar una sola vez:

```powershell
npm run audit:full
```

Este comando debe ejecutar:
- inspección de secretos y archivos Git ignorados,
- chequeos sintácticos,
- pruebas unitarias y HTTP locales,
- conectividad Supabase,
- pruebas RLS reales con owner, worker y anónimo,
- E2E HTTP de owner/worker contra el mismo proyecto Supabase.

Conservar logs en `qa-private`, nunca en Git.

### Fase D: pruebas funcionales del CRM
1. Ejecutar `npm start`. Acceder a `http://127.0.0.1:3400`.
2. Owner: login, resumen, inventario, pedidos, borradores, menú, alertas e inbox.
3. Worker: login y atención humana solamente. Probar 403 al intentar acceder a inventario, pedidos, menú, alertas y movimientos por API.
4. Validar respuesta de auth inválido, bloqueo tras intentos fallidos, logout y expiración.
5. Confirmar que el menú y pedidos provienen de Supabase, sin duplicación local de operaciones.
6. Cargar un producto de prueba mediante el CRM con nombre genérico, verificar stock, movimientos y umbral; NO alterar productos reales ni pedidos reales.
7. Confirmar estado de alerta y restablecimiento al superar mínimo.
8. Confirmar que los datos guardados persisten después de reiniciar el proceso, porque viven en Supabase.
9. Revisar responsive a 390×844 y escritorio a 1366×768.

### Fase E: integración Kapso
Sin autorización específica, solo probar contratos con mocks:
- token de iframe owner y token worker con `assigned_user_id` independiente;
- `handoff=1` como filtro visual, no como control de acceso;
- validación HMAC SHA-256 de webhook de proyecto, con raw body y X-Idempotency-Key;
- resistencia a reintentos y firma falsa;
- cola `crm_handoff_outbox` y reclamo atómico;
- plantilla WhatsApp aprobada sin envío real.

Si se dispone de entorno Kapso QA autorizado, comprobar iframe, controles de rol, handoff, asignación, atención y cierre, verificando que el trabajador NO puede ver conversaciones ajenas. **No enviar mensajes reales a terceros durante QA automático.**

### Fase F: veredicto
Generar `qa-private/FINAL_CRM_QA.md` y `qa-private/FINAL_CRM_GATE.json` con:
- SHA, entorno, tabla por prueba PASS/FAIL/BLOCKED;
- errores reproducibles con extractos SANITIZADOS;
- comprobación de secretos;
- resultados RLS;
- funcionalidad UI;
- limitaciones de Kapso y de envío;
- veredicto `CODE_COMPLETE`, `INTEGRATION_READY`, `PRODUCTION_READY` o BLOCKED, con evidencia.

NO subir `.env.local`, informes privados, capturas con tokens, SQLite ni claves; NO hacer push, merge, despliegue, ni GitHub Actions. Enviar a ChatGPT solamente reporte sanitizado para corregir incidentes verificados.

**Finalización**: no declarar producción lista a partir de mocks. Aprobación real exige la E2E del inbox Kapso, secretos/HTTPS y avisos WhatsApp verificados.
