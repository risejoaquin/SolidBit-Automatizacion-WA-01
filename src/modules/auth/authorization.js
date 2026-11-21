import {hasPermission} from "../../core/roles.js";
/**
 * Guard para handlers HTTP; presupone sesión previamente validada por el servidor.
 * No acepta role/tenant provenientes del body ni query.
 */
export function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.auth?.userId || !req.auth?.tenantId) {
      return res.status(401).json({ error: "Sesión no autenticada" });
    }
    if (!hasPermission(req.auth.role, permission)) {
      return res.status(403).json({ error: "Acceso denegado" });
    }
    return next();
  };
}
