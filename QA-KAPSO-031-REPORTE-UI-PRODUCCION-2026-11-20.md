# QA-KAPSO-031 — Reporte de UI en Cloudflare

**Fecha:** 2026-11-20  
**URL probada:** `https://crm-kapso-app.solidbit-whatsapp-agent.workers.dev/`  
**Entorno confirmado por `/health`:** producción, CRM `1.2.0`, commit `490c1fc`  
**Rol visible al iniciar:** Owner  
**Alcance:** recorrido visual y de lectura en el navegador. No se editaron pedidos, pagos o inventario, no se resolvieron notificaciones y no se enviaron mensajes.

## Resultado ejecutivo

La UI desplegada abre como Owner y la bandeja embebida de Kapso muestra conversaciones de prueba. Hay dos hallazgos reproducibles de UX/sesión:

1. **P1 — La lista de pedidos no aparece al abrir inicialmente la vista.** La primera apertura mostró filtros y estado vacío; al seleccionar «Todos los pedidos» la lista cargó nueve pedidos. El filtro «Pagos por validar» mostró un pedido.
2. **P0 — La sesión Owner terminó en login durante el recorrido.** Tras navegar entre el Inbox y Gestión de pedidos, la app volvió a «Iniciar sesión». La causa no quedó determinada; impidió seguir con pruebas autenticadas.
3. **P1 — El aviso «Atender en Inbox» abrió la bandeja, pero no seleccionó la conversación vinculada.** La conversación de prueba tuvo que seleccionarse manualmente.

La segunda sesión Worker ya quedó disponible en otra pestaña. El menú muestra solo Pedidos y Atención humana. Las rutas directas de Menú y Alertas respondieron «Acceso restringido al propietario» (403), PASS para esas dos comprobaciones. El Inbox de Worker cargó con filtro «Atención humana» y tres conversaciones QA. No se encontró en esta ejecución un caso conocido asignado exclusivamente a otro agente, así que la prueba de acceso directo a un chat ajeno sigue pendiente.

Al regresar al CRM después de revisar esas rutas, la pestaña Worker mostró login. Después recargué Owner y también apareció login. Esto confirma el hallazgo P0 de persistencia de sesión; revisar la navegación y el estado de cookie/sesión.

No se verificó la versión con las correcciones locales recientes: el runtime consultado anuncia `490c1fc`, mientras que esos cambios aún no están en ese despliegue.

## Casos ejecutados

| Caso | Resultado | Observación |
|---|---|---|
| Identificar versión desplegada | PASS | `/health` devolvió `1.2.0`, `490c1fc`, `production`. |
| Acceso Owner | PASS parcial | La sesión Owner estaba activa al comenzar; luego volvió a login durante la navegación. |
| Resumen | PASS | Mostró 24 productos, 0 stock bajo, 0 alertas y 9 pedidos recientes. |
| Inventario | PARCIAL | Vista y formulario cargaron; no se probó crear/editar productos. |
| Lista de pedidos | FAIL UX | La primera carga dejó la lista sin contenido; cambiar a «Todos los pedidos» cargó nueve registros de QA. |
| Filtro «Pagos por validar» | PASS | Mostró un pedido de transferencia etiquetado como QA. No se aprobó ni rechazó. |
| Otros filtros de pedidos | PASS UI / SIN DATOS | «Confirmados», «En preparación», «Listos para entrega», «Enviados» e «Historial» mostraron estado vacío. |
| Notificaciones | PASS parcial | El panel mostró una notificación pendiente de atención humana y el enlace a Inbox. No se marcó ni resolvió. |
| Enlace a Inbox | FAIL UX | Abrió Atención humana, pero no enfocó la conversación del aviso. |
| Inbox Owner | PASS parcial | Cargó la bandeja y permitió abrir una conversación de prueba; se vio el historial y el campo vacío de respuesta. No se envió mensaje. |
| Sesión y navegación | FAIL / BLOQUEANTE | Durante la navegación autenticada la app regresó a login. No se probaron acciones posteriores. |
| Worker, permisos y sesiones separadas | PASS parcial | Sesión separada identificada; Worker solo ve Pedidos/Atención humana; rutas Owner-only probadas dan 403. Falta URL directa a chat de otro agente. |
| Worker: menú/alertas por navegación directa | PASS parcial | En la pestaña Worker, `/api/menu` y `/api/alerts` devolvieron «Acceso restringido al propietario» (403). Al volver a `/`, esa pestaña mostró login. |
| Worker: lista del Inbox | PASS parcial | Inbox cargó con filtro de atención humana y mostró tres conversaciones QA. Falta comparar contra una conversación asignada a otro agente y probar URL directa para cerrar E2E-03. |
| Sonidos y silencio | PASS parcial | Pulsé los cuatro controles de prueba; alterné silencio/sonido y dejé silencio activado. Tras recargar, el control siguió en «Silenciado». No pude confirmar acústicamente que los tonos sean distintos. |
| Confirmación/rechazo de pagos | NOT RUN | No se realizó una operación financiera. |
| Recepción de mensaje WhatsApp en vivo | NOT RUN | No se generó ni envió un mensaje durante esta ejecución. |
| Ingesta de comprobante real a Storage | NOT RUN | No se cargó ningún archivo ni se alteraron datos. |
| Safari/móvil, pérdida de red | NOT RUN | Fuera del recorrido de esta ejecución. |


## Pasos reproducibles para corregir

### P0 — Persistencia de sesión

1. Iniciar sesión como Owner.
2. Abrir Atención humana, regresar a Gestión de pedidos y navegar entre vistas.
3. Resultado observado: se muestra «Iniciar sesión» sin una acción explícita de cerrar sesión.
4. Revisar por separado el `401` de `/api/me`, la carga de notificaciones y las peticiones iniciales de cada panel. Un fallo de carga de datos no debe descartar la sesión autenticada. Registrar la causa exacta antes de corregir.

### P1 — Carga inicial de pedidos

1. Abrir Gestión de pedidos desde una sesión Owner.
2. Resultado observado: aparecen controles y pestañas, sin tarjetas de pedidos.
3. Seleccionar «Todos los pedidos».
4. Resultado observado: aparecen nueve registros.
5. Corregir el estado inicial/fetch para que la vista cargue los resultados sin requerir un segundo clic.

### P1 — Enlace desde notificación

1. Abrir Notificaciones y seleccionar «Atender en Inbox» en el aviso pendiente.
2. Resultado observado: Atención humana carga, pero no se selecciona la conversación correspondiente.
3. Propagar un identificador seguro de conversación al Inbox y seleccionar el registro objetivo, o mostrar un estado explícito si no puede localizarse.

## Límite de esta ejecución

La prueba se hizo en la URL Cloudflare existente y leyó datos QA visibles. No certifica las correcciones locales ni los flujos mutantes. Después de que Antigravity corrija y despliegue, repetir primero persistencia de sesión, carga inicial de pedidos y enlace de notificación; luego continuar con Worker, permisos, transiciones y medios QA autorizados.
