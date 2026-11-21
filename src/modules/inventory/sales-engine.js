/**
 * Generic, transactionally safe inventory order processor.
 * A consumer of Kapso/Supabase confirmed-order events must authenticate the
 * event BEFORE calling these functions. This module does not accept HTTP input.
 * Deployments are isolated per business in the current MVP.
 */
import { createHash } from "node:crypto";

export function initSalesEngine(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS processed_sales (
      source TEXT NOT NULL,
      event_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('applied','reversed')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(source,event_id)
    );
    CREATE TABLE IF NOT EXISTS sale_lines (
      source TEXT NOT NULL,
      event_id TEXT NOT NULL,
      product_id INTEGER NOT NULL REFERENCES products(id),
      quantity REAL NOT NULL CHECK(quantity>0),
      PRIMARY KEY(source,event_id,product_id),
      FOREIGN KEY(source,event_id) REFERENCES processed_sales(source,event_id)
    );
  `);
}

function validId(v) { return typeof v==="string" && /^[a-zA-Z0-9:_./-]{1,128}$/.test(v); }
function normalize(source, eventId, items) {
  if (!validId(source) || !validId(eventId)) throw Object.assign(new Error("Identificador inválido"), {status:400});
  if (!Array.isArray(items) || !items.length || items.length>100) throw Object.assign(new Error("Se requieren artículos"), {status:400});
  const grouped = new Map();
  for (const row of items) {
    const sku=String(row?.sku??"").trim();
    const quantity=Number(row?.quantity);
    if (!sku || sku.length>80 || !Number.isFinite(quantity) || quantity<=0 || quantity>1_000_000) throw Object.assign(new Error("Artículo inválido"),{status:400});
    grouped.set(sku,(grouped.get(sku)||0)+quantity);
  }
  return {source,eventId,items:[...grouped].sort(([a],[b])=>a.localeCompare(b)).map(([sku,quantity])=>({sku,quantity}))};
}
const fingerprint = items => createHash("sha256").update(JSON.stringify(items)).digest("hex");
const fail=(message,status=409)=>{throw Object.assign(new Error(message),{status})};
function atomic(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {const result=fn();db.exec("COMMIT");return result;}
  catch(error){db.exec("ROLLBACK");throw error;}
}

/** Exactly-once inventory effect under an authenticated, repeatable source+eventId. */
export function applyConfirmedSale(db, input) {
  const {source,eventId,items}=normalize(input?.source,input?.eventId,input?.items);
  const hash=fingerprint(items);
  return atomic(db,()=>{
    const prior=db.prepare("SELECT fingerprint,state FROM processed_sales WHERE source=? AND event_id=?").get(source,eventId);
    if(prior){
      if(prior.fingerprint!==hash) fail("Evento duplicado con contenido diferente");
      return {applied:false,duplicate:true,state:prior.state};
    }
    const rows=[];
    for(const line of items) {
      const product=db.prepare("SELECT id,quantity FROM products WHERE sku=?").get(line.sku);
      if(!product) fail("SKU sin correspondencia: "+line.sku,422);
      if(product.quantity<line.quantity) fail("Inventario insuficiente para "+line.sku);
      rows.push({...product,sku:line.sku,sold:line.quantity});
    }
    db.prepare("INSERT INTO processed_sales(source,event_id,fingerprint,state) VALUES (?,?,?,'applied')").run(source,eventId,hash);
    for(const p of rows){
      const update=db.prepare("UPDATE products SET quantity=quantity-?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND quantity>=?").run(p.sold,p.id,p.sold);
      if(update.changes!==1) fail("Inventario insuficiente");
      db.prepare("INSERT INTO sale_lines(source,event_id,product_id,quantity) VALUES (?,?,?,?)").run(source,eventId,p.id,p.sold);
      db.prepare("INSERT INTO inventory_movements(product_id,delta,reason) VALUES (?,?,?)").run(p.id,-p.sold,"sale:"+source+":"+eventId);
    }
    return {applied:true,duplicate:false,state:"applied",items:rows.length};
  });
}

/** Restore stock exactly once when a previously applied order is cancelled. */
export function reverseConfirmedSale(db,{source,eventId}) {
  if(!validId(source)||!validId(eventId)) fail("Identificador inválido",400);
  return atomic(db,()=>{
    const existing=db.prepare("SELECT state FROM processed_sales WHERE source=? AND event_id=?").get(source,eventId);
    if(!existing) fail("Venta inexistente",404);
    if(existing.state==="reversed") return {reversed:false,duplicate:true};
    const lines=db.prepare("SELECT product_id,quantity FROM sale_lines WHERE source=? AND event_id=?").all(source,eventId);
    for(const line of lines) {
      db.prepare("UPDATE products SET quantity=quantity+?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(line.quantity,line.product_id);
      db.prepare("INSERT INTO inventory_movements(product_id,delta,reason) VALUES (?,?,?)").run(line.product_id,line.quantity,"reversal:"+source+":"+eventId);
    }
    db.prepare("UPDATE processed_sales SET state='reversed' WHERE source=? AND event_id=?").run(source,eventId);
    return {reversed:true,duplicate:false};
  });
}
