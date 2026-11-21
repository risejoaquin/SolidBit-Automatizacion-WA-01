# Supabase order adapter — read-only, disabled by default

- Local inventory uses SQLite in the first deployable MVP.
- `src/integrations/supabase/order-reader.js` fetches generic order rows *without writes* from a configured Supabase project.
- It normalizes order event IDs and SKU quantities and marks transfer orders valid only after verified payment, cash orders after confirmation.
- A cancellation after application reverses the same ID once.
- Processing must use `applyConfirmedSale` and `reverseConfirmedSale` on the local DB.
- The adapter is **not** a signed Kapso webhook and must not be exposed as a public HTTP endpoint.
- Connection credentials remain server-side, never inside the browser.

## Pre-enable contract review
1. Verify the actual `items` JSON structure (SKU, quantities, modifiers) and order statuses.
2. Select a least-privilege key for read operations; do not put service-role keys in frontend.
3. Confirm scope to the exact business (single-tenant deployment by default).
4. Validate all SKU mappings and quantity units with fixture orders.
5. Prove error handling, retries, duplicate detection, refunds and re-sync.
6. Configure read-only `SUPABASE_URL` / `SUPABASE_READ_KEY` in private local environment only.
7. Verify RLS and audited access on Supabase.

No actual Supabase credentials or business data is committed.
