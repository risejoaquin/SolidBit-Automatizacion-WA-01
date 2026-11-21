# SolidBit — Sistema de identidad visual

**Origen autorizado:** archivo proporcionado por el Product Owner, `SolidBit_Brand_Assets_SVG(1).zip`.

## Componentes SVG (única fuente de recursos gráficos)

| Recurso | Archivo | Responsabilidad |
|---|---|---|
| Logo horizontal | `solidbit-logo.svg` | Identificación principal en navegación lateral y pantalla de acceso |
| Isotipo | `solidbit-isotype.svg` | Identificación compacta en cabeceras |
| Marca de agua | `solidbit-isotype-gray.svg` | Uso decorativo sutil detrás de información; opacidad interna del SVG: 10 % |
| Favicon | `solidbit-favicon.svg` | Icono del navegador y pestaña |

Los cuatro recursos mantienen geometría vectorial; no son capturas ni mapas de bits. Las variantes en esta carpeta se basan en las rutas del master suministrado. No introducir logotipos dibujados de nuevo, fuentes externas para el wordmark, emojis como identidad ni versiones generadas por IA.

## Arquitectura CSS

- `solidbit-corporate.css`: tokens, superficies, botones, tipografía y patrones generales del CRM.
- `solidbit-inbox.css`: estructura y componentes de conversaciones, separada de marca.
- `solidbit-identity.css`: composición y uso de los recursos SVG (lockup, favicon vía HTML, y marca de agua del historial).

Orden de carga en `public/index.html`: corporate → inbox → identity. Cada archivo tiene una responsabilidad y evita modificar lógica de negocio para personalizar la marca.

### Marca de agua de conversaciones

El pseudo-elemento `.inbox-detail-panel::before` utiliza el SVG gris suministrado y se posiciona **en el contenedor de la conversación**. El historial tiene fondo transparente para que el isotipo se vea, pero las burbujas mantienen superficies legibles. La marca decorativa no recibe eventos de puntero y no puede tapar controles.

No se duplica el isotipo en cada mensaje ni se utiliza `z-index: -1`, que anteriormente lo ocultaba. La cabecera y el pie permanecen por encima de la marca.

### Reglas de mantenimiento

1. Mantener los SVG dentro de `public/brand/`, versionados junto con el CRM.
2. Usar las variables `--sb-*` existentes, sin añadir colores aislados para cada pantalla.
3. Nunca cambiar código de `modules/`, reglas de cotización ni credenciales para modificar la apariencia.
4. Verificar marca en escritorio y en iPhone con Chromium mediante `tests/ci-browser-smoke.mjs`.
5. Si cambia el master, actualizar las variantes y ejecutar `tests/brand-identity.test.mjs` antes de fusionar.

## Despliegue

Esta carpeta solo contiene recursos estáticos y estilos. No altera la sesión de Baileys ni las rutas de API. Los cambios permanecen en el PR hasta que se revise y despliegue al equipo host de forma supervisada.
