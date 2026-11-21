/**
 * Adaptado del adaptador de presentación de Smart WHA:
 * public/console-overview.js (roleCan / renderUserSession).
 * Esta función NO reemplaza la autorización del servidor/RLS.
 */
export const ROLES = Object.freeze({ OWNER: "owner", WORKER: "worker" });
export const PERMISSIONS = Object.freeze({
  VIEW_INVENTORY: "inventory:read",
  EDIT_INVENTORY: "inventory:write",
  VIEW_ALERTS: "alerts:read",
  MANAGE_ALERTS: "alerts:write",
  VIEW_HANDOFF: "handoff:read",
  REPLY_HANDOFF: "handoff:reply"
});
const grants = Object.freeze({
  owner: Object.freeze(Object.values(PERMISSIONS)),
  worker: Object.freeze([PERMISSIONS.VIEW_HANDOFF, PERMISSIONS.REPLY_HANDOFF])
});
export function normalizeRole(role) {
  const value = String(role || "").trim().toLowerCase();
  return Object.hasOwn(grants, value) ? value : null;
}
export function hasPermission(role, permission) {
  const normalized = normalizeRole(role);
  return Boolean(normalized && grants[normalized].includes(permission));
}
export function getLandingRoute(role) {
  const normalized = normalizeRole(role);
  if (normalized === ROLES.OWNER) return "/inventory";
  if (normalized === ROLES.WORKER) return "/handoff";
  return "/login";
}
export function visibleNavigation(role) {
  return [
    { path: "/inventory", label: "Inventario", permission: PERMISSIONS.VIEW_INVENTORY },
    { path: "/handoff", label: "Atención humana", permission: PERMISSIONS.VIEW_HANDOFF }
  ].filter(item => hasPermission(role, item.permission)).map(({ path, label }) => ({path, label}));
}
