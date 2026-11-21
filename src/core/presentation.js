/**
 * Utilidades puras adaptadas de Smart WHA:
 * public/console-overview.js y public/app.js.
 * Sin DOM, sin datos ficticios y sin dependencias de Baileys/Stripe.
 */
export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
export function initials(name, fallback = "SB") {
  const parts = String(name ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 2);
  return (parts.map(x => x[0]).join("") || fallback).toUpperCase();
}
export function formatNumber(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? new Intl.NumberFormat("es-MX").format(value)
    : "—";
}
export function formatQuantity(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? new Intl.NumberFormat("es-MX", { maximumFractionDigits: 3 }).format(value)
    : "—";
}
