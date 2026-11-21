# CRM Kapso

CRM reutilizable y sin branding para negocios con WhatsApp en Kapso y datos operativos en Supabase.

## Módulos
- Autenticación Supabase Auth con roles `owner` y `worker` por negocio.
- Resumen con cifras reales.
- Pedidos, borradores y menú: vistas de solo lectura de la base existente.
- Inventario independiente: stock por SKU, mínimos, alertas, movimientos auditables.
- Conciliación automática de pedidos confirmados y reversión de cancelaciones mediante transacciones PostgreSQL idempotentes.
- Inbox de Kapso embebido con alcance por número y token `assigned_user_id` para trabajadores.
- Eventos de handoff firmados y notificaciones opcionales por plantilla aprobada.
- Escáner de secretos, validación de sintaxis, pruebas unitarias/HTTP, QA local.

## El proyecto Supabase existente ya fue ampliado
Las tablas originales `orders`, `order_drafts`, `menu_products` y `menu_modifiers` siguen intactas.
Migraciones aditivas: `db/001_crm_schema.sql`, `002_crm_inventory_sync.sql`, `003_crm_access_hardening.sql`, `004_crm_handoff_outbox.sql`, `005_handoff_atomic_claim.sql`.

Se añadieron 10 tablas del CRM y se importaron 24 SKUs con existencias iniciales 0, sin activar sincronización y sin generar pedidos ficticios.

## Inicio de CRM conectado a Supabase
La fuente de verdad es Supabase. SQLite bajo `src/local` permanece solo para QA unitario y offline.

**Guía completa:** [docs/REMOTE_SETUP.md](docs/REMOTE_SETUP.md).

En Windows, clonar en `C:\Users\Lucilfer\Desktop\cmr-kapso`, instalar Git y Node.js 24+, y ejecutar:

```powershell
npm run setup:local
# Completar SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY y
# SUPABASE_SERVICE_ROLE_KEY SOLO dentro de .env.local
npm run bootstrap:remote
npm run security:setup
npm run doctor:remote
npm run audit:local
npm run start:stack
```

Abrir `http://127.0.0.1:3400`. El bootstrap crea o vincula cuentas Auth usando contraseñas privadas generadas una sola vez, sin modificar contraseñas existentes.

No se requieren paquetes npm externos para iniciar el entorno local; Node.js 24+ provee los módulos utilizados.

## Límites importantes
- La sincronización de stock está **desactivada** hasta capturar y validar existencias. Se habilita siguiendo la guía.
- Los links con tokens de Kapso no están en Git y se provisionan después de introducir la API key.
- La bandeja worker solo se habilita al certificar el token limitado por `assigned_user_id`.
- Las notificaciones WhatsApp necesitan plantilla UTILITY aprobada y configuración opt-in.
- El servidor local solo escucha en loopback; para producción exige HTTPS/proxy y revisión de seguridad.
- Ningún test de GitHub Actions se utiliza como criterio de aceptación.

## Verificación
`npm run audit:local` ejecuta revisiones y tests, conservando logs en carpeta `qa-private` excluida de Git. También existe `npm run doctor:remote` para verificar configuración privada sin mostrar secretos.

**No hay certificación de producción hasta que la suite Node, las pruebas con navegador y los flujos reales de Kapso pasen.**
