# Gate de liberación — un solo punto de pruebas

No declarar **listo para producción** basándose en GitHub Actions ni en pruebas unitarias solamente.

## Ejecutar en Windows, en la carpeta de trabajo
1. Actualizar la rama de desarrollo que indique el PR.
2. Crear `.env.local` fuera de Git; nunca colocar valores en reportes.
3. Ejecutar `npm run security:setup` en el clon local.
4. Ejecutar `npm run audit:local` (incluye secret scan y tests).
5. Revisar login, roles, inventario, alerta, ventas repetidas, cancelaciones y persistencia.
6. No abrir túneles externos hasta una revisión de seguridad y autorización.

## Gate de integración real (bloqueante para producción)
- Supabase: confirmar esquema concreto, credenciales y políticas RLS; probar aislamiento por negocio.
- Kapso: crear embed con alcance de número, restringir origen, validar UX y permisos del worker.
- Verificar webhook firmado conforme a especificación oficial antes de aceptar eventos públicos.
- Confirmar notificación WhatsApp al encargado, plantillas/ventana y entrega fallida.
- Probar deduplicación de eventos, reconciliación de cancelación, trazabilidad y reintentos.
- Realizar pruebas reales de navegador móvil/desktop y amenazas básicas.

## Veredictos
- **CODE COMPLETE:** funciones locales compiladas, auditadas y con tests PASS.
- **INTEGRATION READY:** credenciales y ambiente QA conectados, sin datos productivos, pruebas E2E PASS.
- **PRODUCTION READY:** revisión operativa, secretos, RLS, webhook, backups y despliegue aprobados.

Los resultados deben basarse en evidencia; nunca inferir PASS.
