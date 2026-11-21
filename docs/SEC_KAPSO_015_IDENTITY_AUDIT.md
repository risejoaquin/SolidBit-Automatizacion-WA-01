# SOLIDBIT — CRM KAPSO
## Reporte de Auditoría de Seguridad: SEC-KAPSO-015 — Auditoría de Identidad Real del Worker en Kapso

- **Fecha de Evaluación**: 2026-11-19
- **Auditor**: Antigravity (Google DeepMind)
- **Repositorio**: [crm-kapso](https://github.com/risejoaquin/crm-kapso)
- **Rama**: `feat/supabase-crm-schema`
- **Proyecto Kapso**: `7edf4d72-e0af-4b96-939f-08a44014bb88` (SolidBit)
- **Proyecto Supabase**: `gplewdvxxldfvmeintvu` (`mr-burger-sandbox`)
- **Dictamen de Seguridad**: **FAIL CRÍTICO (Colisión de Identidades)**

---

### 1. Resumen Ejecutivo y Dictamen

Tras auditar exhaustivamente la API oficial de plataforma de Kapso (`GET /platform/v1/users`), la base de datos de Supabase Auth y membresías, y las variables de Cloudflare Workers, se concluye con **certeza técnica absoluta** lo siguiente:

> [!CAUTION]
> **DICTAMEN: FAIL CRÍTICO — REUTILIZACIÓN DE LA IDENTIDAD DEL PROPIETARIO**
> En el proyecto de Kapso **existe un único usuario registrado (`total_count: 1`)**, cuyo nombre es `lucilfer`, correo `joaquin.carpio261724@potros.itson.edu.mx` y rol `owner` (identificador `user_id: "e5d724a2-8961-458c-a95d-03222b17cd03"`).
> 
> Aunque en Supabase existen cuentas separadas (`lucilfer@solidbit.com.mx` como propietario y `worker.qa@example.test` como empleado), la cuenta de empleado en Supabase (`crm_memberships.kapso_assignee_id`) y el token del Worker en Cloudflare (`KAPSO_WORKER_ASSIGNEE_ID`) fueron configurados apuntando a `e5d724a2-8961-458c-a95d-03222b17cd03`, **que es la identidad del PROPIETARIO de Kapso**.
> 
> **Consecuencia**: El empleado no tiene una identidad independiente en Kapso; está operando en el Inbox bajo la identidad del dueño. Cualquier conversación personal o administrativa asignada a `lucilfer` en Kapso es accesible por el Worker.

---

### 2. Matriz de Identidades y Comparativa

| Elemento | Identidad / ID Localizado | Rol / Estado | Coincidencia de Persona | Resultado |
|---|---|:---:|:---:|:---:|
| **Owner Supabase** | `lucilfer@solidbit.com.mx`<br>`(user_id: 4b5b193f-...)` | `owner`<br>Activo | Propietario del CRM | **PASS** |
| **Worker Supabase** | `worker.qa@example.test`<br>`(user_id: e12b347c-...)` | `worker`<br>Activo | Cuenta QA de empleado | **PASS** |
| **Owner Kapso** | `joaquin.carpio261724@potros.itson.edu.mx`<br>`(user_id: e5d724a2-8961-458c-a95d-03222b17cd03)`<br>`(name: "lucilfer")` | `owner`<br>Activo | Propietario del proyecto Kapso | **PASS** |
| **Worker Kapso** | **INEXISTENTE**<br>(Solo 1 usuario en proyecto Kapso) | N/A | **No existe cuenta de empleado en Kapso** | **FAIL CRÍTICO** |
| **Token Worker** | `a7400bc4-d0fb-4274-ae19-cf4cb09b7cb0`<br>`assigned_user_id: e5d724a2-8961-...` | `active` | **Apunta al PROPIETARIO (`lucilfer`), no a un empleado** | **FAIL CRÍTICO** |
| **Conversación QA-A** | `673e647a-6f4c-441f-b45d-51eb9c500a42`<br>`assigned_user_id: e5d724a2-8961-...` | `active` | **Asignada a `lucilfer` (Propietario)** | **FAIL CRÍTICO** |

---

### 3. Respuestas a Preguntas Obligatorias de la Auditoría

1. **¿El Worker tiene una identidad Kapso propia?**
   - **NO**. La consulta directa a `GET /platform/v1/users` devolvió exactamente 1 miembro en el proyecto (`total_count: 1`). No existe ningún usuario creado, registrado o invitado en Kapso para el trabajador.
2. **¿El `assigned_user_id` del Worker pertenece realmente al empleado?**
   - **NO**. Pertenece a la cuenta `joaquin.carpio261724@potros.itson.edu.mx` (`name: "lucilfer"`, `role: "owner"`).
3. **¿El `assigned_user_id` pertenece al propietario?**
   - **SÍ**. Los metadatos de Kapso confirman que este identificador corresponde al creador y dueño del espacio de trabajo.
4. **¿Las dos cuentas del CRM utilizan accidentalmente la misma identidad de Kapso?**
   - **SÍ**. En Supabase se crearon dos usuarios Auth independientes, pero ambos convergen en la misma persona física de Kapso (`e5d724a2-...`).
5. **¿El propietario y el trabajador comparten conversaciones por diseño o por configuración errónea?**
   - **Por configuración errónea / limitación de cuentas iniciales**. Durante la configuración previa de `CONFIG-CF-006` y `FIX-KAPSO-010`, al buscar un `assigned_user_id` en Kapso, se tomó el único ID disponible en la plataforma y se le asignó al Worker.
6. **¿El Worker podría acceder a conversaciones personales o administrativas asignadas al propietario?**
   - **SÍ**. Dado que el token del Worker filtra por `assigned_user_id: "e5d724a2-8961-458c-a95d-03222b17cd03"`, toda conversación que sea asignada a `lucilfer` en Kapso es automáticamente visible y respondible por el trabajador en el CRM.
7. **¿El token Worker está restringido por usuario a nivel de Kapso y no solo mediante filtros visuales?**
   - **SÍ**. El mecanismo de aislamiento por token de Kapso funciona correctamente en el backend (solo muestra chats asignados a `e5d724a2-...`). El fallo de seguridad no es técnico del iframe, sino de **identidad**: se restringió al usuario incorrecto (el dueño).
8. **¿El empleado dispone de permisos mayores de los necesarios en Kapso?**
   - Al responder mensajes desde el iframe, las respuestas quedan registradas bajo la autoría del propietario del proyecto.

---

### 4. Evidencia Técnica Recolectada

#### A. Consulta a Kapso Platform API (`GET /platform/v1/users`)
```json
{
  "data": [
    {
      "id": "5d4f95de-93ee-4bc9-b013-a667669f13cd",
      "email": "joaquin.carpio261724@potros.itson.edu.mx",
      "name": "lucilfer",
      "role": "owner",
      "user_id": "e5d724a2-8961-458c-a95d-03222b17cd03"
    }
  ],
  "meta": {
    "page": 1,
    "per_page": 20,
    "total_pages": 1,
    "total_count": 1
  }
}
```

#### B. Registro en Supabase (`crm_memberships`)
```json
[
  {
    "business_id": "1c2238f8-863a-4e33-8b5b-5b5e4683e190",
    "user_id": "4b5b193f-b249-4713-8169-87b7468edb00",
    "role": "owner",
    "email": "lucilfer@solidbit.com.mx",
    "kapso_assignee_id": null
  },
  {
    "business_id": "1c2238f8-863a-4e33-8b5b-5b5e4683e190",
    "user_id": "e12b347c-c8c8-4a25-8719-cc1554122703",
    "role": "worker",
    "email": "worker.qa@example.test",
    "kapso_assignee_id": "e5d724a2-8961-458c-a95d-03222b17cd03"
  }
]
```

#### C. Token Worker en Kapso (`GET /platform/v1/inbox_embeds/a7400bc4-...`)
```json
{
  "id": "a7400bc4-d0fb-4274-ae19-cf4cb09b7cb0",
  "name": "CRM Kapso — Worker — Sandbox",
  "scope_type": "phone_number",
  "scope_id": "597907523413541",
  "assigned_user_id": "e5d724a2-8961-458c-a95d-03222b17cd03",
  "status": "active"
}
```

---

### 5. Medidas de Contención Inmediata

Para prevenir accesos indebidos a conversaciones del propietario por parte de sesiones con rol worker:

1. **Desactivación Preventiva en Cloudflare**:
   En `cloudflare/crm-app/wrangler.jsonc`, cambiar temporalmente:
   ```jsonc
   "KAPSO_WORKER_EMBED_APPROVED": "false"
   ```
   Esto provocará que `GET /api/handoff` para trabajadores devuelva `{ status: "pending_integration" }` de forma segura hasta completar la creación del usuario real.
2. **Mantener intacto el Webhook**:
   El webhook `crm-kapso-webhook` no se ve afectado por esta discrepancia ya que recibe eventos de forma asíncrona y no autentica sesiones de usuario.

---

### 6. Plan Correctivo para Separación Real de Identidades

Cuando el usuario lo autorice, el procedimiento exacto es:

1. **Invitar al empleado en la plataforma Kapso**:
   - Ingresar a la consola web oficial: [app.kapso.ai](https://app.kapso.ai).
   - En la sección de **Configuración de Proyecto → Miembros / Equipo**, enviar una invitación a la dirección de correo real del empleado u operador (e.g. `operador.kapso@solidbit.com.mx` o la cuenta laboral correspondiente).
   - Asignar el rol operativo mínimo (`Member` / `Agent`, no `Admin` ni `Owner`).
2. **Obtener el nuevo User ID de Kapso**:
   - Una vez aceptada la invitación, consultar `GET /platform/v1/users` vía API para obtener el `user_id` genuino del empleado (`<WORKER_REAL_KAPSO_USER_ID>`).
3. **Generar un nuevo Inbox Embed para el Worker**:
   - Ejecutar `POST /platform/v1/inbox_embeds` con:
     - `name`: `"CRM Kapso — Worker — Sandbox"`
     - `scope_type`: `"phone_number"`
     - `scope_id`: `"597907523413541"`
     - `assigned_user_id`: `"<WORKER_REAL_KAPSO_USER_ID>"`
     - `allowed_origins`: `["https://crm-kapso-app.solidbit-whatsapp-agent.workers.dev"]`
4. **Sincronizar Cloudflare y Supabase**:
   - Actualizar el secreto `KAPSO_WORKER_EMBED_URL` en Cloudflare con la URL del nuevo token.
   - Actualizar `KAPSO_WORKER_ASSIGNEE_ID` en Cloudflare con `<WORKER_REAL_KAPSO_USER_ID>`.
   - Actualizar en Supabase `crm_memberships.kapso_assignee_id` del worker con `<WORKER_REAL_KAPSO_USER_ID>`.
   - Reasignar la conversación QA-A a este nuevo usuario.
   - Reactivar `KAPSO_WORKER_EMBED_APPROVED = "true"`.

---

### 7. Respuesta Final Obligatoria

**¿El empleado del CRM está accediendo al Inbox mediante una identidad de Kapso verdaderamente independiente del propietario, o estamos reutilizando accidentalmente la identidad del dueño?**

> **RESPUESTA DEFINITIVA**:
> **Estamos reutilizando accidentalmente la identidad del dueño.**
> 
> La evidencia técnica de la API de Kapso demuestra que en el proyecto existe únicamente **1 usuario registrado**: `lucilfer` (`joaquin.carpio261724@potros.itson.edu.mx`, `role: owner`). 
> 
> El identificador `e5d724a2-8961-458c-a95d-03222b17cd03` asignado al trabajador en Supabase y al token del iframe en Cloudflare **es el identificador de ese único usuario dueño**. No existe ninguna cuenta de empleado en Kapso. Por ende, la aparente separación era únicamente a nivel de frontend del CRM, mientras que en Kapso el trabajador estaba operando con la identidad del propietario.
