# QA-KAPSO-031 — Certificación E2E independiente

**Fecha de evaluación:** 2026-11-20 (America/Hermosillo)  
**Evaluador:** auditoría independiente asistida  
**Pull request:** [#5](https://github.com/risejoaquin/crm-kapso/pull/5)  
**Dictamen global:** **BLOCKED para certificación E2E**  
**Alcance acordado:** pruebas automatizadas aisladas en local; pruebas de interfaz y flujos contra la URL de Cloudflare tras el despliegue directo a producción. No se usará ni se creará un ambiente staging.

## 1. Resumen ejecutivo

Se verificó en el navegador la aplicación desplegada y el Sandbox de Kapso. El endpoint `/health` reportó CRM `1.2.0`, commit `490c1fc`, ambiente `production`. El PR #5 está abierto en `c191b6fa02692d11374c35fb89e6a994547e17ec`; `490c1fc` es antecesor directo del HEAD del PR. El único cambio entre ambos es la sincronización de `COMMIT_SHA` en `wrangler.jsonc`, por lo que el código del CRM desplegado coincide con el código de la rama, aunque el SHA anunciado no es el HEAD actual del PR.

Owner inició sesión y el CRM mostró `lucilfer@solidbit.com.mx · owner (valida transferencias)`. La vista Resumen reportó 24 productos, 0 alertas y 9 pedidos recientes. Gestión de Pedidos mostró nueve registros etiquetados `qa-customer`, productos `*-test` y domicilios/referencias QA; el filtro «Pagos por validar» mostró un pedido de transferencia con domicilio ficticio QA. No se abrieron detalles ni se cambió estado/pago. El Centro de Notificaciones mostró una notificación `human_handoff` pendiente. Se probaron los cuatro controles de tono y el silencio persistió tras recarga. Después de recargar, la UI volvió a login; el cliente anterior mezclaba fallos de sesión y de carga inicial, así que no se determinó si la cookie siguió siendo válida.

La revisión encontró un **riesgo P0 de aislamiento por negocio** en el código original del PR: consultas privilegiadas sobre `orders` no incluían filtro `business_id`. Ese defecto ya se corrigió en el árbol local y se añadieron pruebas de regresión. También se corrigió la búsqueda de pedidos candidatos para comprobantes, el despacho desde estados prematuros y una carrera entre lectura y transición de estado. Estos cambios no están desplegados ni verificados contra el backend real.

El flujo de ingesta `/api/receipts/ingest` acepta metadatos y un `storage_path`, no recibe/descarga un medio de Kapso. En el webhook de Kapso revisado solo está implementado el evento handoff. No se halló en esta rama un consumidor de mensajes multimedia que complete WhatsApp → descarga segura → Storage privado → pedido.

## 2. Versiones y ambientes evaluados

| Elemento | Evidencia | Resultado |
|---|---|---|
| CRM visible | `https://crm-kapso-app.solidbit-whatsapp-agent.workers.dev/` | Owner autenticado y rol visible; recarga terminó en pantalla de login |
| CRM `/health` | JSON: `version=1.2.0`, `commit_sha=490c1fc`, `environment=production`, `deployed_at=2026-11-19T00:00:00Z` | PASS para identificación de versión |
| Rama local/remota del PR | HEAD y `origin/feat/dev-kapso-025-notifications-orders`: `c191b6fa02692d11374c35fb89e6a994547e17ec` | PR #5 abierto |
| Relación de commits | `490c1fc` es ancestro de `c191b6f`; diferencia: solo cambio de SHA en `wrangler.jsonc` | Código funcional coincide; metadato de commit desplegado queda una revisión atrás |
| APIs sin sesión | `/api/me`, `/api/handoff`, `/api/orders` → `401`; `/api/login` con `{}` → `400` (capturado antes de login Owner) | PASS para rechazo sin sesión |
| Kapso | Proyecto SolidBit abierto; Sandbox WhatsApp muestra 3 sesiones activas | Entorno de prueba disponible; ningún mensaje fue enviado |
| Supabase | El dashboard muestra `mr-burger-sandbox`, project ref `gplewdvxxldfvmeintvu` | No se consultaron tablas ni datos de clientes/pedidos |
| Negocio del CRM desplegado | `CRM_BUSINESS_ID=1c2238f8-863a-4e33-8b5b-5b5e4683e190` en configuración versionada | Distinto del ID de negocio ficticio del archivo SQL QA; ese SQL no se aplicó |
| Código local tras correcciones | Árbol de trabajo con cambios en `handler.ts`, `supabase.ts` y tests | No desplegado; requiere revisión final y luego validación en la URL Cloudflare de producción según flujo acordado |
| Suite automatizada | `npm run test:all` | PASS: 92 pruebas (26 + 26 + 33 + 7), 0 fallos |

**Límite del alcance:** no se usó una cuenta autenticada, no se leyeron filas comerciales ni se mutaron pedidos/pagos. Las comprobaciones de seguridad de handlers son revisión de código, no prueba de explotación ni certificación dinámica.

## 3. Matriz E2E-01 a E2E-16

| ID | Prioridad | Caso | Estado | Resultado y evidencia |
|---|---:|---|---|---|
| E2E-01 | P0 | Confirmar versión ejecutada en navegador | **PASS** | `/health` observado en navegador: CRM `1.2.0`, commit `490c1fc`, `production`; rama PR `c191b6f`. Código coincide por relación de commits; SHA de runtime no es HEAD exacto. |
| E2E-02 | P0 | Login Owner/Worker y separación de sesiones | **BLOCKED** | Owner autenticó y el rol/email aparecieron en el CRM. No se probó Worker ni aislamiento entre sesiones; al recargar, Owner volvió a login. |
| E2E-03 | P0 | Worker no accede a chats ajenos, incluida URL directa | **BLOCKED** | No se autenticó el Worker ni existe conversación QA-A/QA-B verificada. La documentación de código exige token de embed separado con `assigned_user_id`; los parámetros `handoff=1` son solo filtro visual. |
| E2E-04 | P0 | Aislamiento de pedidos entre negocios en backend | **BLOCKED (dinámica); PASS (regresión local)** | Se añadió `business_id` a listado, detalle, PATCH de estado/pago y búsqueda de pedidos candidatos. La prueba automatizada verifica el filtro. No se ejecutó el ataque controlado con dos negocios en backend real. |
| E2E-05 | P0 | WhatsApp → Kapso → webhook → asignación automática | **BLOCKED** | Sandbox visible con sesiones, pero generar el evento real requiere intervención física desde el teléfono QA y configuración comprobable del workflow. No se envió mensaje. |
| E2E-06 | P0 | Inbox Worker muestra conversación y permite responder | **BLOCKED** | No se inició sesión Worker ni se verificó el embed individual. La pestaña del Inbox de Kapso es de administración de proyecto, no evidencia de Inbox CRM Worker ni de entrega de respuesta. |
| E2E-07 | P0 | Comprobante de WhatsApp → Storage privado → CRM | **FAIL (integración incompleta en código)** | `/api/receipts/ingest` recibe JSON de metadatos/ruta; no carga ni descarga medio. El Worker webhook revisado maneja `workflow.execution.handoff`, no mensajes multimedia. No hubo ingestión real. |
| E2E-08 | P0 | Aprobar/rechazar pago con permisos y auditoría | **BLOCKED** | No se ejecutó ninguna decisión financiera. El handler comprueba permiso y confirmación bancaria/rechazo con motivo; falta prueba autenticada y auditoría en datos QA aislados. |
| E2E-09 | P1 | Notificaciones, destinatario y enlaces | **BLOCKED** | Owner vio una notificación `human_handoff` pendiente y el enlace «Atender en Inbox». No se siguió ni se verificaron otros tipos/destinatarios para no cambiar estados ni abrir conversaciones reales. |
| E2E-10 | P1 | Cuatro sonidos, silencio, recarga y reconexión | **BLOCKED** | Se activaron los cuatro controles; la UI respondió. `🔇 Silenciado` persistió tras recarga. Sin evidencia acústica no se confirma que los tonos sean distintos/entregados; quedó silenciado. |
| E2E-11 | P1 | Crear, filtrar y persistir pedidos | **BLOCKED** | Owner cargó nueve filas etiquetadas como QA; el filtro «Pagos por validar» dejó el pedido ficticio de transferencia. No se probó creación ni persistencia post-mutación. |
| E2E-12 | P1 | Transiciones válidas/ inválidas y despacho | **PASS (pruebas automatizadas); BLOCKED (E2E)** | Se restringió dispatch a `ready`, se añadió condición de estado esperado al PATCH y se agregó regresión para rechazar `preparing`. Falta validar en la URL Cloudflare tras el despliegue directo a producción. |
| E2E-13 | P1 | Mensajes/comprobantes duplicados | **BLOCKED** | La función de ingesta implementa deduplicación por `provider_message_id` y hay pruebas con mocks; no se probó webhook real ni almacenamiento en QA. |
| E2E-14 | P1 | Rechazo de usuarios sin `payments.review` | **BLOCKED** | El código devuelve `403` antes de consultar el pedido, pero no se ejecutó contra runtime autenticado. Tests locales con mocks no constituyen certificación E2E. |
| E2E-15 | P2 | Safari/móvil, navegación y notificaciones | **NOT_RUN** | No hay sesión QA móvil/Safari disponible en este entorno. |
| E2E-16 | P2 | Recuperación tras pérdida de conexión/sesión expirada | **FAIL (UI tras recarga; causa dinámica sin confirmar)** | Owner recargó y la UI mostró login. En el cliente, `session()` agrupaba el fallo de `/api/me` con fallos posteriores de notificaciones/panel y mostraba login para todos; se corrigió localmente. Falta retest en el navegador del ambiente desplegado. Pérdida de red y refresh token siguen sin probarse. |

## 4. Bloqueos críticos

1. **Aislamiento multi-negocio — corregido localmente, falta E2E (P0).** Añadido filtro `business_id` a la lectura de lista/detalle y a los PATCH de estado/pago, además de una regresión que comprueba los parámetros generados. Falta validar el comportamiento en producción con cuentas y operaciones QA seguras.
2. **Asociación de comprobantes — corregida localmente, falta E2E (P0).** La búsqueda de pedidos pendientes ahora incluye el negocio configurado. Falta probar eventos QA reales y rutas de almacenamiento privadas.
3. **No hay certificación de identidades/autorización real.** No había sesión Owner o Worker activa en CRM. La captura adjunta solo incluye identidad Worker y contraseña enmascarada. Hace falta una ejecución con dos sesiones QA independientes.
4. **Ingesta multimedia end-to-end no demostrada y aparentemente ausente.** El endpoint recibe un `storage_path` suministrado por el cliente/llamador y registra la fila; no se observó una integración que descargue un adjunto de Kapso y lo suba de forma segura al bucket privado.
5. **Fixture SQL QA separado del Worker de producción.** El archivo SQL crea el ID ficticio `a0000000-0000-4000-8000-000000000001`; la configuración del Worker declara `1c2238f8-863a-4e33-8b5b-5b5e4683e190`. No se ejecutó la semilla ni se deben reasignar datos reales.

## 5. Defectos reproducibles y hallazgos menores

### H-01 — Acceso cruzado a pedidos por UUID (P0, corregido localmente)

- **Archivo:** `cloudflare/crm-app/src/supabase.ts`.
- `getOrders` no filtra el listado al negocio configurado.
- `getOrderDetails` resuelve `orders` por `id` solamente.
- `updateOrderStatus`, `validateOrderPayment` y `rejectOrderPayment` hacen `PATCH` por `id` solamente.
- La ruta `dispatch` lee el pedido mediante `getOrderDetails` y cambia su estado mediante `updateOrderStatus`.
- **Cambio local:** agregado `business_id=eq.<config.businessId>` a listado, detalle y mutaciones de estado/pago; la búsqueda de comprobantes pendientes también está acotada por negocio.
- **Verificación pendiente:** caso automatizado local con dos business IDs ficticios; no ejecutar SQL fixture contra datos actuales.

### H-02 — `Marcar como enviado` permitía estados prematuros (P1, corregido localmente)

- **Archivo:** `cloudflare/crm-app/src/handler.ts`, bloque `POST /api/orders/:id/dispatch`.
- Antes permitía `ready`, `preparing`, `assigned`; ahora solo permite `ready`.
- El mensaje de error dice que el pedido debe estar listo, y el flujo general requiere preparación → listo antes de despacho.
- **Cambio local:** PATCH condicionado al estado `ready`; los cambios de estado normales también comprueban el estado previo esperado. Prueba de regresión automatizada para `preparing`.

### H-03 — Confirmación de pago sin atomicidad completa (P1)

- **Archivo:** `cloudflare/crm-app/src/supabase.ts`, funciones `validateOrderPayment`/`rejectOrderPayment`.
- Actualización de `orders` filtra solo por ID. Las actualizaciones de recibo/notificación fallidas se silencian con `.catch(() => {})`, así que la API puede informar éxito aunque recibo/notificación no se actualice. `rejectOrderPayment` no exige que el estado actual sea pendiente y genera clave de notificación con `Date.now()`, lo que no es idempotente.
- **Recomendación:** mover pago, recibo, historial y notificación a una RPC transaccional idempotente y condicionada a negocio/estado previo; devolver fallo si las escrituras requeridas no se completan.

### H-04 — Clave de sesión basada en service-role si falta `SESSION_SECRET` (P2 de configuración)

- **Archivo:** `cloudflare/crm-app/src/handler.ts`, `getSessionSecret`.
- Fallback de firma es `SUPABASE_SERVICE_ROLE_KEY`. No se confirma que `SESSION_SECRET` exista en Cloudflare porque es secreto y no se inspeccionó. Asegurar configuración explícita y distinta para no acoplar rotación de sesión a la clave de privilegio.

### H-05 — Identificador desplegado atrasado (P2)

- Runtime anuncia `490c1fc`, mientras HEAD del PR es `c191b6f`. La comparación de commits muestra que es solo un commit de sincronización de `COMMIT_SHA`; no se halló diferencia funcional. Actualizar el metadato en el próximo despliegue normal.

### H-06 — Cobertura automática no equivale a E2E

Hay tests unitarios/integración mock en `cloudflare/crm-app/test/crm-app.test.ts`, incluidos validación de transición, despacho desde `ready`, permisos de pago e idempotencia de comprobantes. Estos no verifican autorización real, RLS, sandbox Kapso, Storage, notificaciones físicas ni cookies separadas. No se ejecutó suite adicional en esta certificación.

## 6. Matriz de evidencias obtenidas

| Evidencia | Observación |
|---|---|
| Navegador CRM `/health` | `200`, `1.2.0`, `490c1fc`, `production` |
| Navegador CRM `/` | Owner autenticado; al recargar volvió a la pantalla de login |
| API `/api/me`, `/api/handoff`, `/api/orders` sin cookie | `401 Sesión requerida` |
| API `/api/login` con JSON vacío | `400 Credenciales inválidas` |
| Pestaña Kapso | Proyecto SolidBit; Sandbox con 3 sesiones activas; Inbox administrativo carga, sin seleccionar ni responder conversaciones |
| Fuente PR | `c191b6f`; endpoints privileged order y dispatcher examinados; refs de línea indicadas arriba |
| Seed QA | Dataset ficticio usa un business ID distinto al Worker publicado; no se ejecutó SQL |
| Cambios externos | No se enviaron mensajes, no se mutaron pedidos/pagos ni se cambió configuración/despliegue. Se probó el silencio del navegador; quedó silenciado tras recarga. |

## 7. Resultados por módulo

| Módulo | Dictamen | Motivo |
|---|---|---|
| Owner/Worker | **BLOCKED** | Identidad y rol Owner comprobados. Worker y separación de cookies no verificados; tras recarga la UI volvió a login y no se pudo determinar la validez real de la cookie |
| Inbox Kapso | **BLOCKED** | Sandbox disponible, pero falta handoff físico real y sesión embebida Worker |
| Centro de notificaciones | **BLOCKED** | Owner vio una notificación handoff pendiente; no se verificaron enlaces ni otros eventos/destinatarios |
| Gestión de pedidos | **PASS (lectura parcial + automatizado local)** / **BLOCKED (E2E)** | Nueve registros QA visibles y filtro de transferencia operativo; creación, transiciones y persistencia no validadas |
| Comprobantes | **BLOCKED** | Asociación limitada al negocio en código local; falta consumidor de multimedia y verificación real de Storage |
| Permisos financieros | **BLOCKED** | No se ejecutaron flujos autenticados contra fixtures QA aislados |

## 8. Dependencias para continuar

1. Cerrar revisión transaccional H-03 y revisar el diff local antes de liberar.
2. Desplegar directamente a producción mediante Wrangler cuando esté autorizado y revisar la URL que Wrangler confirma.
3. Repetir recarga Owner, separación Owner/Worker, permisos, transiciones y despacho en la URL de Cloudflare; detenerse ante cualquier resultado inesperado antes de mutar pedidos/pagos reales.
4. Conservar el teléfono Sandbox autorizado para generar un mensaje entrante real; no basta un evento histórico o mock.
5. Implementar o señalar el servicio que descarga el medio de WhatsApp/Kapso y lo carga en Storage privado, incluyendo validación de MIME/tamaño, path controlado e idempotencia.
6. Mantener los casos automatizados y pruebas de regresión en local; para pruebas dinámicas con datos, usar únicamente operaciones QA autorizadas y seguras en la URL desplegada.

## 9. Cambios locales y pruebas automatizadas (2026-11-20)

- `getOrders` filtra por `business_id`.
- `getOrderDetails` filtra por `business_id`.
- `updateOrderStatus` filtra por negocio y puede condicionar el estado previo para evitar actualizaciones cruzadas o carreras.
- Validación/rechazo de pago aplican negocio y estado `pending` al PATCH principal y rechazan si no hubo fila actualizada.
- La asociación de comprobantes pendientes filtra por negocio.
- El endpoint de subida de comprobante comprueba primero que el pedido pertenece al negocio accesible.
- `dispatch` acepta únicamente estado `ready` y usa PATCH condicional.
- El cliente ahora limita el estado de login al fallo de `/api/me`; errores al cargar notificaciones o el panel inicial conservan la sesión autenticada y muestran el error. Los assets edge se regeneraron.
- Se añadió regresión para el despacho desde `preparing` y aserciones de filtros por negocio.
- `npm run test:all`: PASS, 92 pruebas, 0 fallos (26 core, 26 webhook, 33 CRM y 7 notifier).
- `git diff --check`: PASS.
- UI Owner: identidad y rol visibles; Resumen muestra 24 productos, 0 stock bajo, 0 alertas y 9 pedidos recientes.
- Owner cargó nueve filas claramente etiquetadas como QA (`qa-customer`, productos `*-test`, domicilios de prueba). El filtro «Pagos por validar» mostró un pedido de transferencia QA ficticio. No se cambió pedido ni pago.
- Owner vio una notificación `human_handoff` pendiente; no se resolvió ni se abrió el Inbox.
- Los cuatro controles de sonido respondieron al click. No se obtuvo evidencia acústica para certificar que los tonos sean distinguibles.
- El estado silenciado persistió tras recarga y quedó activo.
- Al recargar, Owner volvió visualmente al login. El cliente anterior trataba cualquier fallo de carga como sesión inválida; corregido localmente, con causa dinámica aún sin confirmar hasta el retest tras despliegue QA.
- Los cambios están solo en el árbol local; no se desplegaron ni fusionaron.

## 10. Dictamen final

**BLOCKED — no aprobar todavía la certificación E2E independiente ni declarar producción lista.** Los arreglos locales y las 92 pruebas automatizadas pasaron. Owner autenticó y confirmó algunos flujos de lectura, pero su sesión no sobrevivió una recarga. Falta sesión Worker, aislamiento dinámico de tenant, transiciones sobre fixtures QA, handoff real y recorrido multimedia. No se desplegó ni se fusionó el PR.

