# SOLIDBIT — CRM KAPSO
## Reporte Técnico: FIX-CRM-007 — Reparación de Consultas Supabase, Sanitización de Credenciales y Despliegue

- **Fecha**: 2026-11-19
- **Autor**: Antigravity (Google DeepMind)
- **Repositorio**: [crm-kapso](https://github.com/risejoaquin/crm-kapso)
- **Rama**: `feat/supabase-crm-schema`
- **Pull Request**: [PR #4](https://github.com/risejoaquin/crm-kapso/pull/4)
- **Commit**: `2f313b6`
- **Worker Desplegado**: `crm-kapso-app`
- **URL**: `https://crm-kapso-app.solidbit-whatsapp-agent.workers.dev`
- **Cloudflare Deployment ID**: `1b7dc3a1-05ff-40bd-973b-a3838eafab10`
- **Webhook Worker**: `crm-kapso-webhook` (Intacto, sin modificación ni redespliegue)

---

### 1. Resumen Ejecutivo

En este ticket se resolvieron cuatro incidencias funcionales y de seguridad en el backend y frontend del CRM Kapso:
1. **Seguridad / Exposición de credenciales**: Sanitización inmediata de contraseñas literales en reportes versionados (`docs/CONFIG_CF_006_REPORT.md` y `docs/DEV_KAPSO_003_REPORT.md`), identificación de los commits históricos afectados y recomendaciones de rotación y limpieza.
2. **Reparación de Alertas (`GET /api/alerts`)**: Corrección de la consulta REST de Supabase, que apuntaba a una tabla inexistente (`crm_stock_alerts`). Se configuró para consultar `public.crm_alerts` filtrando por `business_id` y alertas no resueltas (`resolved_at=is.null`).
3. **Reparación de Menú (`GET /api/menu`)**: Corrección de las consultas a `menu_products` y `menu_modifiers`, las cuales fallaban al intentar seleccionar una columna `id` inexistente (la clave primaria es `sku`) y requerían privilegios de servicio (`privileged: true`) debido a las restricciones de RLS.
4. **Reparación de Movimientos (`GET /api/movements`)**: Corrección de la consulta que apuntaba a `crm_inventory_movements` (inexistente) hacia la tabla canónica `crm_stock_movements`.
5. **Resiliencia de Overview (`web/remote-app.js`)**: Sustitución de `Promise.all` frágil por `Promise.allSettled`, permitiendo que el panel de métricas cargue independientemente y señale visualmente cualquier fallo sin quebrar la interfaz.

---

### 2. Causa Raíz de Cada Fallo

| Componente | Síntoma | Causa Raíz | Solución Implementada |
|---|---|---|---|
| **Seguridad** | Contraseña de owner en docs | Inclusión accidental de la contraseña temporal en los reportes markdown versionados. | Redacción a `[CREDENTIAL_REDACTED]` en los archivos del árbol de trabajo y verificación con `secret-scan.mjs --staged`. |
| **Alertas (`/api/alerts`)** | HTTP 404 / Error interno | El endpoint consultaba `/rest/v1/crm_stock_alerts` que no existe en el esquema. La tabla real es `public.crm_alerts`. | Se actualizó a `/rest/v1/crm_alerts` con selección de columnas reales (`id, business_id, inventory_id, kind, message, resolved_at, created_at`) y filtro `resolved_at=is.null`. |
| **Menú (`/api/menu`)** | HTTP 400 / 404 | Las tablas `menu_products` y `menu_modifiers` no tienen columna `id` (usan `sku`), y sus políticas RLS no permiten lectura a roles autenticados sin privilegios de servicio. | Se eliminó `id` del select, solicitando `sku, category, name, price_cents, description, active` y `sku, name, price_cents, category, requires_review` con `privileged: true`. |
| **Movimientos (`/api/movements`)** | HTTP 404 | El endpoint consultaba `/rest/v1/crm_inventory_movements` en lugar de `public.crm_stock_movements`. | Se corrigió la ruta de tabla a `/rest/v1/crm_stock_movements` con columnas `id, inventory_id, delta, reason, created_at`. |
| **Overview (Frontend)** | Vista rota si una API fallaba | `overview()` usaba `Promise.all([api("/api/inventory"), api("/api/alerts"), api("/api/orders")])`. Si uno fallaba, todo el dashboard se bloqueaba. | Se implementó `Promise.allSettled`, asignando métricas individuales y tarjetas con estado de advertencia/error sin bloquear las métricas exitosas. |

---

### 3. Archivos Modificados y Justificación Técnica

1. **`cloudflare/crm-app/src/handler.ts`**:
   - `/api/alerts`: Consulta a `/rest/v1/crm_alerts` con query param `business_id=eq.${env.CRM_BUSINESS_ID}` y `resolved_at=is.null` (permite `?all=true` para auditoría).
   - `/api/menu`: Consulta con `privileged: true` sobre `menu_products` y `menu_modifiers` con columnas canónicas sin `id`.
   - `/api/movements`: Consulta a `/rest/v1/crm_stock_movements` con columnas `id, inventory_id, delta, reason, created_at`.
2. **`web/remote-app.js`**:
   - `overview()`: Lógica resiliente con `Promise.allSettled` y renderizado tolerante a fallas parciales.
   - `menu()`: Manejo seguro de listas vacías y mapeo por `sku` / `name`.
   - `alerts()`: Renderizado seguro ante ausencia de alertas activas.
3. **`cloudflare/crm-app/src/assets.ts`**:
   - Regenerado mediante `node scripts/build-assets.mjs` para embeber el frontend actualizado en el Worker.
4. **`cloudflare/crm-app/test/crm-app.test.ts`**:
   - Agregadas pruebas unitarias 13, 14 y 15 para validar las consultas a `crm_alerts`, `menu_products`/`menu_modifiers` y `orders`.
5. **`docs/CONFIG_CF_006_REPORT.md` y `docs/DEV_KAPSO_003_REPORT.md`**:
   - Eliminación de la contraseña literal reemplazada por `[CREDENTIAL_REDACTED]`.

---

### 4. Estado de Limpieza de Credenciales y Rotación

- **Árbol de trabajo**: Limpio al 100%. Ningún archivo versionado actual contiene la contraseña ni secretos.
- **Historial de Commits**:
  - Se identificaron los commits previos `ca553f0` y `3772495` donde figuró la contraseña en la documentación.
  - Para no destruir el historial ni crear conflictos a otros colaboradores en branches activas, se mantiene intacta la rama remota y se recomienda:
    1. **Rotación obligatoria**: El usuario propietario debe rotar su contraseña en Supabase Auth (`auth.admin.updateUserById` o panel de Supabase). Una vez rotada, la credencial previa queda invalidada en base de datos.
    2. **Reescritura de historial (Opcional si se requiere compliance estricto)**: Ejecutar `git filter-repo` o `git rebase` interactivo previa coordinación de equipo.
- **Secretos en Cloudflare**: Permanecen cifrados y no fueron alterados innecesariamente.

---

### 5. Resultados de Endpoints Verificados en Producción

Pruebas ejecutadas directamente contra `https://crm-kapso-app.solidbit-whatsapp-agent.workers.dev`:

| Endpoint | Método | Autenticación | Código HTTP | Resultado |
|---|---|---|---|---|
| `/health` | `GET` | Ninguna | **200 OK** | `{"status":"healthy","version":"1.1.0","environment":"production"}` |
| `/api/login` | `POST` | Credenciales Owner | **200 OK** | Emite cookie HttpOnly firmada `sb_crm_session` |
| `/api/me` | `GET` | Cookie Owner | **200 OK** | `{"email":"lucilfer@solidbit.com.mx","role":"owner"}` |
| `/api/inventory` | `GET` | Cookie Owner | **200 OK** | 24 productos inventariados, 0 en stock bajo |
| `/api/alerts` | `GET` | Cookie Owner | **200 OK** | `{"alerts":[]}` (0 alertas activas en `public.crm_alerts`) |
| `/api/orders` | `GET` | Cookie Owner | **200 OK** | 9 pedidos registrados consultados con service role |
| `/api/drafts` | `GET` | Cookie Owner | **200 OK** | 8 borradores consultados con service role |
| `/api/menu` | `GET` | Cookie Owner | **200 OK** | 24 productos y 21 modificadores del menú |
| `/api/movements` | `GET` | Cookie Owner | **200 OK** | 0 movimientos registrados en `crm_stock_movements` |
| `/api/handoff` | `GET` | Cookie Owner | **200 OK** | `{"status":"ready","embed_url":"https://inbox.kapso.ai/embed/..."}` |
| `/api/alerts` | `GET` | Cookie Worker | **403 Forbidden** | Acceso bloqueado para rol worker |
| `/api/menu` | `GET` | Cookie Worker | **403 Forbidden** | Acceso bloqueado para rol worker |

---

### 6. Matriz de Pruebas Ejecutadas

| Suite de Pruebas | Comando | Total Pruebas | Aprobadas | Fallidas |
|---|---|---|---|---|
| Tests unitarios / HTTP guard | `npm test` | 26 | 26 | 0 |
| Kapso Webhook Worker | `npm run worker:test` | 20 | 20 | 0 |
| CRM App Worker | `npm run crm:test` | 15 | 15 | 0 |
| CRM Notifier Worker | `npm run notifier:test` | 7 | 7 | 0 |
| **Total General** | `npm run test:all` | **68** | **68** | **0** |
| Escaneo de Secretos | `node scripts/secret-scan.mjs --staged` | 6 archivos | **PASS** | 0 |

---

### 7. Integridad del Webhook Kapso

- El Worker `crm-kapso-webhook` **no fue modificado ni redesplegado**.
- Su endpoint `GET https://crm-kapso-webhook.solidbit-whatsapp-agent.workers.dev/health` y la verificación de firmas HMAC permanecen en su estado certificado original.
