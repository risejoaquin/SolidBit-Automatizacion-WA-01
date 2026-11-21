/**
 * Iteración 01: laboratorio LOCAL independiente de Supabase remoto.
 * Node.js >=24; SQLite local (node:sqlite), sin paquetes externos.
 * No debe exponerse a Internet ni usarse en producción.
 */
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { randomBytes, createHash, scryptSync, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROLES } from "../core/roles.js";
import { initSalesEngine, applyConfirmedSale, reverseConfirmedSale } from "../modules/inventory/sales-engine.js";
import { resolveInboxEmbed } from "../integrations/kapso/embed.js";
import { verifyKapsoSignature, parseKapsoHandoff, initHandoffStore, recordHandoff } from "../integrations/kapso/webhook.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const staticRoot = path.resolve(here, "../../web");
const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]]
]);
const cookieName = "crm_local_session";
const digest = value => createHash("sha256").update(value).digest("hex");
const hashPassword = password => {
  const salt = randomBytes(16).toString("hex");
  return salt + ":" + scryptSync(password, salt, 64).toString("hex");
};
const checkPassword = (input, stored) => {
  if (!stored || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  const expected = Buffer.from(hash, "hex");
  if (expected.length !== 64) return false;
  return timingSafeEqual(scryptSync(input, salt, 64), expected);
};
const json = (res, status, payload) => {
  res.writeHead(status, {"Content-Type":"application/json; charset=utf-8", "Cache-Control":"no-store"});
  res.end(JSON.stringify(payload));
};
const parseCookie = (req, name) => (req.headers.cookie ?? "").split(";").map(x=>x.trim()).find(x=>x.startsWith(name+"="))?.slice(name.length+1);
const sessionCookie = (value, deleteIt=false) => `${cookieName}=${value}; HttpOnly; SameSite=Strict; Path=/; ${deleteIt?"Max-Age=0":"Max-Age=28800"}`;
async function rawBody(req) {
  if(!String(req.headers["content-type"]||"").startsWith("application/json"))throw Object.assign(new Error("Se requiere JSON"),{status:415});
  const chunks=[];let length=0;
  for await(const chunk of req) {
    length+=chunk.length;
    if(length>100_000)throw Object.assign(new Error("Webhook demasiado grande"),{status:413});
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function body(req) {
  if (!String(req.headers["content-type"]||"").startsWith("application/json")) throw Object.assign(new Error("Se requiere JSON"),{status:415});
  let raw = "";
  for await (const chunk of req) {
    raw += chunk.toString("utf8");
    if (raw.length > 100_000) throw Object.assign(new Error("Solicitud demasiado grande"),{status:413});
  }
  try {return JSON.parse(raw)} catch {throw Object.assign(new Error("JSON inválido"),{status:400})}
}
export function createLocalApp({dbPath, ownerEmail, ownerPassword, workerEmail, workerPassword, enableOrderSimulation=false, kapsoConfig={},kapsoWebhookSecret="",kapsoProjectId=""}) {
  if (!dbPath) throw Error("LOCAL_DB_PATH obligatorio");
  if (!ownerEmail || !workerEmail || !ownerPassword || !workerPassword) throw Error("Credenciales locales obligatorias (OWNER_*/WORKER_*)");
  if (ownerEmail.toLowerCase() === workerEmail.toLowerCase()) throw Error("Los usuarios deben tener correos diferentes");
  if (ownerPassword.length < 10 || workerPassword.length < 10) throw Error("Contraseñas locales: mínimo 10 caracteres");
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','worker')));
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY, sku TEXT NOT NULL UNIQUE, name TEXT NOT NULL, quantity REAL NOT NULL DEFAULT 0 CHECK(quantity>=0), minimum REAL NOT NULL DEFAULT 0 CHECK(minimum>=0), updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS inventory_movements (id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id), delta REAL NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  `);
  initSalesEngine(db);
  initHandoffStore(db);
  const insertUser = db.prepare("INSERT OR IGNORE INTO users(email,password_hash,role) VALUES (?,?,?)");
  for (const [email,password,role] of [[ownerEmail,ownerPassword,ROLES.OWNER],[workerEmail,workerPassword,ROLES.WORKER]]) {
    if (!db.prepare("SELECT id FROM users WHERE email=?").get(email.toLowerCase())) insertUser.run(email.toLowerCase(),hashPassword(password),role);
  }
  const getSession = req => {
    const token = parseCookie(req,cookieName);
    if (!token) return null;
    return db.prepare("SELECT u.id,u.email,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?").get(digest(token),Date.now())||null;
  };
  // Brute-force guard for local QA. Production needs a distributed limiter.
  const loginAttempts=new Map();
  const attemptWindowMs=10*60*1000;
  function attemptState(key){
    const entry=loginAttempts.get(key);
    if(!entry || Date.now()-entry.started>attemptWindowMs) return {started:Date.now(),failures:0};
    return entry;
  }
  function recordLoginFailure(key){
    const entry=attemptState(key);
    entry.failures++;
    if(loginAttempts.size>2048)loginAttempts.clear();
    loginAttempts.set(key,entry);
  }
  const handler = async (req,res) => {
    res.setHeader("X-Content-Type-Options","nosniff");
    res.setHeader("Referrer-Policy","no-referrer");
    res.setHeader("X-Frame-Options","DENY");
    res.setHeader("Content-Security-Policy","default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-src https://inbox.kapso.ai; base-uri 'none'; object-src 'none'");
    try {
      const url = new URL(req.url,"http://localhost");
      const method=req.method;
      if (["POST","PUT","PATCH","DELETE"].includes(method) && req.headers.origin && new URL(req.headers.origin).host!==req.headers.host) return json(res,403,{error:"Origen no autorizado"});
      if (method==="GET" && assets.has(url.pathname)) {
        const [file,contentType]=assets.get(url.pathname);
        const data=await readFile(path.join(staticRoot,file));
        res.writeHead(200,{"Content-Type":contentType,"Cache-Control":"no-store"});return res.end(data);
      }
      if(method==="POST" && url.pathname==="/webhooks/kapso/handoff") {
        if(!kapsoWebhookSecret || !kapsoProjectId) return json(res,404,{error:"Webhook no configurado"});
        const raw=await rawBody(req);
        const signature=req.headers["x-webhook-signature"];
        if(!verifyKapsoSignature(raw,signature,kapsoWebhookSecret))return json(res,401,{error:"Firma inválida"});
        const record=parseKapsoHandoff(raw,req.headers["x-idempotency-key"],kapsoProjectId);
        return json(res,200,recordHandoff(db,record));
      }
      if(method==="POST" && url.pathname==="/api/login") {
        const value=await body(req);
        const email=String(value.email||"").trim().toLowerCase();
        const attemptKey=(req.socket.remoteAddress||"local")+"|"+email;
        if(attemptState(attemptKey).failures>=5) return json(res,429,{error:"Demasiados intentos; intenta más tarde"});
        const user=db.prepare("SELECT * FROM users WHERE email=?").get(email);
        if(!user || !checkPassword(String(value.password||""),user.password_hash)){
          recordLoginFailure(attemptKey);
          return json(res,401,{error:"Credenciales inválidas"});
        }
        loginAttempts.delete(attemptKey);
        const token=randomBytes(32).toString("hex");
        db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,?)").run(digest(token),user.id,Date.now()+8*3600*1000);
        res.setHeader("Set-Cookie",sessionCookie(token));
        return json(res,200,{email:user.email,role:user.role});
      }
      if(method==="POST" && url.pathname==="/api/logout") {
        const token=parseCookie(req,cookieName);
        if(token) db.prepare("DELETE FROM sessions WHERE token_hash=?").run(digest(token));
        res.setHeader("Set-Cookie",sessionCookie("",true));
        return json(res,200,{ok:true});
      }
      const user=getSession(req);
      if(!user) return json(res,401,{error:"Sesión requerida"});
      if(method==="GET" && url.pathname==="/api/me") return json(res,200,{email:user.email,role:user.role});
      if(method==="GET" && url.pathname==="/api/handoff") {
        const embed=resolveInboxEmbed(user.role,kapsoConfig);
        return json(res,200,embed.available ? {status:"ready",embed_url:embed.url} : {status:"pending_integration",message:embed.reason});
      }
      if(user.role!==ROLES.OWNER) return json(res,403,{error:"Acceso restringido al owner"});
      // Explicit local QA simulator only. This never accepts unsigned public webhooks.
      if(url.pathname==="/api/qa/orders" && method==="POST") {
        if(!enableOrderSimulation) return json(res,404,{error:"Simulador desactivado"});
        const x=await body(req);
        const result=x.action==="reverse" ? reverseConfirmedSale(db,x) :
          x.action==="apply" ? applyConfirmedSale(db,x) :
          (()=>{throw Object.assign(new Error("Acción desconocida"),{status:400});})();
        return json(res,200,result);
      }
      const editMatch=url.pathname.match(/^\/api\/inventory\/(\d+)$/);
      if(method==="PATCH" && editMatch) {
        const x=await body(req);
        const name=String(x.name??"").trim(), minimum=Number(x.minimum);
        if(!name||name.length>200||!Number.isFinite(minimum)||minimum<0) return json(res,400,{error:"Nombre o mínimo inválido"});
        const result=db.prepare("UPDATE products SET name=?,minimum=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(name,minimum,Number(editMatch[1]));
        return json(res,result.changes?200:404,result.changes?{ok:true}:{error:"Producto inexistente"});
      }
      if(method==="GET" && url.pathname==="/api/inventory/movements") {
        const limit=Math.min(200,Math.max(1,Number(url.searchParams.get("limit")||50)||50));
        const movements=db.prepare("SELECT m.id,p.sku,p.name,m.delta,m.reason,m.created_at FROM inventory_movements m JOIN products p ON p.id=m.product_id ORDER BY m.id DESC LIMIT ?").all(limit);
        return json(res,200,{movements});
      }
      if(method==="GET" && url.pathname==="/api/inventory") {
        const products=db.prepare("SELECT id,sku,name,quantity,minimum,updated_at FROM products ORDER BY name").all();
        return json(res,200,{products,lowStock:products.filter(p=>p.quantity<=p.minimum)});
      }
      if(method==="POST" && url.pathname==="/api/inventory") {
        const x=await body(req);
        const sku=String(x.sku??"").trim(), name=String(x.name??"").trim();
        const quantity=Number(x.quantity),minimum=Number(x.minimum);
        if(!sku||!name||sku.length>80||name.length>200||![quantity,minimum].every(n=>Number.isFinite(n)&&n>=0)) return json(res,400,{error:"Producto inválido"});
        db.exec("BEGIN IMMEDIATE");
        try {
          const row=db.prepare("INSERT INTO products(sku,name,quantity,minimum) VALUES (?,?,?,?)").run(sku,name,quantity,minimum);
          db.prepare("INSERT INTO inventory_movements(product_id,delta,reason) VALUES (?,?,?)").run(Number(row.lastInsertRowid),quantity,"opening_balance");
          db.exec("COMMIT");
          return json(res,201,{id:Number(row.lastInsertRowid)});
        }catch(e){
          db.exec("ROLLBACK");
          if(e.code?.startsWith("SQLITE_CONSTRAINT")) return json(res,409,{error:"SKU duplicado"});
          throw e;
        }
      }
      const match=url.pathname.match(/^\/api\/inventory\/(\d+)\/adjust$/);
      if(method==="POST" && match) {
        const x=await body(req), delta=Number(x.delta), reason=String(x.reason??"").trim();
        if(!Number.isFinite(delta)||delta===0||!reason||reason.length>200) return json(res,400,{error:"Movimiento inválido"});
        db.exec("BEGIN IMMEDIATE");
        try{
          const product=db.prepare("SELECT id FROM products WHERE id=?").get(Number(match[1]));
          if(!product) throw Object.assign(new Error("Producto inexistente"),{status:404});
          const result=db.prepare("UPDATE products SET quantity=quantity+?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND quantity+?>=0").run(delta,Number(match[1]),delta);
          if(result.changes!==1)throw Object.assign(new Error("Stock insuficiente"),{status:409});
          db.prepare("INSERT INTO inventory_movements(product_id,delta,reason) VALUES (?,?,?)").run(Number(match[1]),delta,reason);
          db.exec("COMMIT");
        }catch(e){db.exec("ROLLBACK");throw e;}
        return json(res,200,{ok:true});
      }
      return json(res,404,{error:"Ruta no encontrada"});
    } catch(e){return json(res,e.status||500,{error:e.status?e.message:"Error interno"});}
  };
  const server=http.createServer(handler);
  return {server,db,close:()=>new Promise(resolve=>server.close(()=>{db.close();resolve();}))};
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const app=createLocalApp({
    dbPath:process.env.LOCAL_DB_PATH||"./crm-kapso-local.sqlite",
    ownerEmail:process.env.OWNER_EMAIL,ownerPassword:process.env.OWNER_PASSWORD,
    workerEmail:process.env.WORKER_EMAIL,workerPassword:process.env.WORKER_PASSWORD,
    enableOrderSimulation:process.env.ENABLE_LOCAL_ORDER_SIMULATION==="true",
    kapsoWebhookSecret:process.env.KAPSO_WEBHOOK_SECRET,
    kapsoProjectId:process.env.KAPSO_PROJECT_ID,
    kapsoConfig:{
      ownerEmbedUrl:process.env.KAPSO_OWNER_EMBED_URL,
      workerEmbedUrl:process.env.KAPSO_WORKER_EMBED_URL,
      workerApproved:process.env.KAPSO_WORKER_EMBED_APPROVED==="true",
      workerAssigneeId:process.env.KAPSO_WORKER_ASSIGNEE_ID
    }
  });
  const port=Number(process.env.PORT||3400);
  app.server.listen(port,"127.0.0.1",()=>console.log("CRM Kapso LOCAL: http://127.0.0.1:"+port));
}
