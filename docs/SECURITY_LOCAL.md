# Política de secretos — CRM Kapso

## Regla absoluta
Nunca subir contraseñas, tokens, API keys, service-role keys, datos de clientes ni archivos SQLite al repositorio.

## Configuración local
- `.env.example`: sólo nombres de variables, jamás valores.
- `.env.local`: valores de la máquina, excluido por `.gitignore`.
- `npm start`: carga automáticamente `.env.local` con Node 24+.
- `npm run security:setup`: activa el hook pre-commit en ESTE clon.
- `npm run security:scan`: revisa archivos rastreados.
- `npm run security:staged`: revisa lo que se intenta publicar.
- `git status --short --ignored`: comprueba exclusiones.
- La carpeta de GitHub no tiene acceso a tu `.env.local`.

## Restricciones
- No subir reportes locales, capturas con credenciales ni volcado de consola con secretos.
- Jamás incluir `service_role` de Supabase en frontend, README, código ni variables `PUBLIC_` / `NEXT_PUBLIC_`.
- Para múltiples máquinas/producción utilizar un gestor de secretos por entorno; no compartir `.env.local` por Git.
- Antes de desplegar, revisar RLS y límites de los roles.
- Si una credencial real ya fue publicada, `.gitignore` no borra el historial: revocar/rotar y limpiar historia del repositorio. No garantizar seguridad sin auditoría completa.
- El hook puede omitirse con `--no-verify`: toda publicación desde herramientas automatizadas requiere ejecutar el escáner explícitamente. Proteger además repositorios con reglas de push protection/secret scanning donde estén disponibles.

## Claves de prueba
Las contraseñas de QA se generan fuera del repositorio y no se registran en el informe. Los tests crean credenciales aleatorias efímeras.
