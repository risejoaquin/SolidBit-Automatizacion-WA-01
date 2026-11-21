# CRM Kapso — Arranque con la base desplegada de Supabase

## Estado comprobado de este sandbox
Proyecto Supabase: `mr-burger-sandbox`, ref `gplewdvxxldfvmeintvu`.
Las 4 tablas preexistentes (orders, order_drafts, menu_products, menu_modifiers) se conservan sin modificar columnas ni registros.
Migraciones CRM `db/001` a `db/005` aplicadas en el proyecto. La quinta asegura reclamo atómico de notificaciones.
Negocio genérico creado: `negocio-piloto`, inventario 24 SKUs con cantidades 0. Fuente legacy vinculada pero conciliación OFF.
**No ejecutar otra vez estas migraciones ni inicializar un segundo negocio con el mismo legado.**

## Cómo usar en Windows sin GitHub Actions

Repositorio: https://github.com/risejoaquin/crm-kapso

Carpeta: `C:\Users\Lucilfer\Desktop\cmr-kapso`

1. Clona o actualiza la rama `feat/supabase-crm-schema`. No borres la carpeta si contiene archivos ajenos.
2. Requiere Node.js 24+ y Git. No se necesitan dependencias npm de terceros.
3. Ejecuta `npm run setup:local`. El script crea una sola vez `.env.local` ignorado por Git, con dos contraseñas fuertes. Si el archivo ya existe lo conserva intacto.
4. Abre **localmente** `.env.local` y completa:
   - `SUPABASE_URL=https://<ref>.supabase.co` para el proyecto correcto.
   - `SUPABASE_PUBLISHABLE_KEY` obtenida desde Supabase → Project Settings → API Keys.
   - `SUPABASE_SERVICE_ROLE_KEY` o clave secreta de servidor equivalente. **Nunca en frontend ni Git**.
5. Los correos `OWNER_EMAIL` y `WORKER_EMAIL` se generan con dominios QA. Puedes reemplazarlos con correos operativos antes del bootstrap; si ya existen usuarios Auth, el script no restablece sus contraseñas.
6. Ejecuta `npm run bootstrap:remote`: reutiliza `negocio-piloto`, crea o ubica dos cuentas Supabase Auth y registra los roles `owner` y `worker`. Guarda `CRM_BUSINESS_ID` solamente en `.env.local`.
7. Ejecuta `npm run security:setup`, `npm run doctor:remote` y **una sola vez** `npm run audit:full` cuando estén configuradas ambas cuentas Auth.
8. Inicia `npm run start:stack` y visita http://127.0.0.1:3400.

**No pegues el contenido de `.env.local` en ChatGPT, GitHub, screenshots ni reportes.**

## Habilitar catálogo y pedidos
Este sandbox ya tiene vinculadas las 4 tablas legacy al negocio piloto. Los pedidos y el menú se muestran al owner como solo lectura. Para un nuevo proyecto Supabase:
- Ejecutar primero las cuatro migraciones.
- Ejecutar bootstrap.
- Ejecutar `npm run menu:link` para importar SKUs a inventario con cantidad cero, sin alterar los pedidos preexistentes.

El CRM no administra precios ni reglas de pedidos de Kapso; no duplica su flujo. La vista de pedidos incluye detalles de entrega/pago y la de borradores permite inspeccionar su JSON con autorización owner.

## Inventario automático
Las existencias iniciales de los 24 productos son cero; introducir cantidades reales desde el CRM, usando el rol owner y movimientos de ajuste.
Cuando los conteos estén confirmados:
1. Comprobar los SKU de cada artículo y su unidad.
2. Añadir `CONFIRM_STOCK_COUNTS=YES` en `.env.local`.
3. Ejecutar `npm run menu:link -- --enable-after-review` (habilita únicamente la vinculación de pedidos para esa base).
4. Añadir `ENABLE_SUPABASE_SYNC=true` en `.env.local`.
5. Reiniciar `npm run start:stack`: el worker consulta `crm_order_queue` cada 30 segundos y usa `crm_reconcile_order` de PostgreSQL. Los eventos duplicados no descuentan doble; cancelación revierte.
6. Revisar errores de conciliación y stock real; no hay backfill automático de pedidos anteriores.

Las órdenes futuras seguirán siendo guardadas por Kapso en `orders`; triggers en esa tabla encolan su estado sin bloquear el flujo de entrada. Una cola con errores no debe confundirse con ventas reconciliadas.

## Inbox y delegación Kapso
- Añadir `KAPSO_API_KEY` y `KAPSO_PHONE_NUMBER_ID` en `.env.local`.
- Indicar `KAPSO_EMBED_ALLOWED_ORIGIN=http://127.0.0.1:3400` para pruebas locales.
- Identificar el `KAPSO_WORKER_ASSIGNEE_ID` real del miembro de equipo de Kapso. Ejecutar `npm run staff:kapso-assign` para asociar el usuario Auth con esa asignación.
- Ejecutar `npm run kapso:embeds` con autorización para crear los tokens. El script guarda sus URL exclusivamente en `.env.local`, sin imprimirlas.
- Comprobar que el token worker tenga `assigned_user_id` y que solo muestre conversaciones asignadas. **Solo después** establecer `KAPSO_WORKER_EMBED_APPROVED=true`.

El filtro `handoff=1` no es autorización; el token asignado sí es la restricción oficial. No publicar un token project-wide para worker.

## Webhook y aviso al encargado
- Configurar `KAPSO_PROJECT_ID` y `KAPSO_WEBHOOK_SECRET` del webhook de proyecto.
- Ruta del CRM: `POST /webhooks/kapso/handoff`, firma `X-Webhook-Signature` HMAC-SHA256 sobre bytes crudos. Registra evento y outbox en Supabase.
- Para un webhook público necesitarás un despliegue o proxy HTTPS. **No** se incluye túnel público automático; la instancia de QA escucha solo en localhost.
- Configurar una plantilla WhatsApp UTILITY aprobada. Añadir `KAPSO_HANDOFF_TEMPLATE`, `KAPSO_PHONE_NUMBER_ID`, `KAPSO_WORKER_PHONE` y finalmente `ENABLE_KAPSO_HANDOFF_NOTICES=true`.
- `npm run start:stack` iniciará el worker de avisos únicamente cuando esté habilitado. Los envíos aceptados deben verificarse con eventos de entrega; no asumir entrega final.

## Privacidad y aislamiento
Una instalación por negocio en el MVP. Para un segundo cliente, usa configuración, Auth y su negocio separados; nunca reasignes el singleton de pedidos de este proyecto a otro negocio. La clave privilegiada solo vive en backend; los usuarios se autorizan contra `crm_memberships` y RLS.

## Gates pendientes
No exponer el CRM a Internet antes de verificar auth, cookies Secure/TLS/proxy, rate-limits distribuidos, esquema de permisos por negocio, backups, plantillas aprobadas y pruebas E2E de Kapso.
