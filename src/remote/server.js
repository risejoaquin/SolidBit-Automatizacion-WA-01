/**
 * CRM Kapso — Supabase-backed local server.
 * Browser receives NO Supabase/ Kapso API keys, JWTs or refresh tokens.
 * One deployment per business. Run on loopback until reverse proxy hardening.
 */
import http from "node:http";
import {randomBytes,createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {resolveInboxEmbed} from "../integrations/kapso/embed.js";
import {verifyKapsoSignature,parseKapsoHandoff} from "../integrations/kapso/webhook.js";

const files=new Map([
  ["/",["remote-index.html","text/html; charset=utf-8"]],
  ["/app.js",["app.js","text/javascript; charset=utf-8"]],
  ["/style.css",["style.css","text/css; charset=utf-8"]],
  ["/remote-app.js",["remote-app.js","text/javascript; charset=utf-8"]]
]);
const webRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../../web");
const sha=x=>createHash("sha256").update(x).digest("hex");
const cookieName="crm_remote_session";
const cookie=(value,erase=false)=>cookieName+"="+value+"; HttpOnly; SameSite=Strict; Path=/; "+(erase?"Max-Age=0":"Max-Age=28800");
const json=(res,status,payload)=>{
  res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});
  res.end(JSON.stringify(payload));
};
const error=(status,message)=>Object.assign(new Error(message),{status});
const parseCookies=req=>(req.headers.cookie||"").split(";").map(x=>x.trim()).find(x=>x.startsWith(cookieName+"="))?.slice(cookieName.length+1);
async function parseRaw(req){
  if(!String(req.headers["content-type"]||"").startsWith("application/json"))throw error(415,"Solicitud JSON requerida");
  let length=0;const chunks=[];
  for await(const chunk of req){length+=chunk.length;if(length>100000)throw error(413,"Cuerpo demasiado grande");chunks.push(chunk);}
  return Buffer.concat(chunks);
}
async function parseJson(req){
  if(!String(req.headers["content-type"]||"").startsWith("application/json"))throw error(415,"Solicitud JSON requerida");
  let length=0;const chunks=[];
  for await(const chunk of req){length+=chunk.length;if(length>100000)throw error(413,"Cuerpo demasiado grande");chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{throw error(400,"JSON inválido");}
}
async function timedFetch(fetchFn,url,opts={}){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),10000);
  try{return await fetchFn(url,{...opts,signal:controller.signal,redirect:"error"});}
  finally{clearTimeout(timer);}
}
export function createRemoteApp(config,{fetchFn=fetch}={}){
  const {supabaseUrl,publishableKey,serviceKey,businessId,kapsoConfig={},kapsoWebhookSecret,kapsoProjectId}=config;
  let url;
  try{url=new URL(supabaseUrl);}catch{throw Error("SUPABASE_URL inválida");}
  if(url.protocol!=="https:" || !/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname) || url.username || url.password){
    throw Error("SUPABASE_URL debe ser el dominio HTTPS del proyecto Supabase");
  }
  if(!publishableKey||!serviceKey||publishableKey===serviceKey)throw Error("Claves publishable y service_role independientes obligatorias");
  if(!/^[a-f0-9-]{36}$/i.test(businessId||""))throw Error("CRM_BUSINESS_ID debe ser UUID");
  const sessions=new Map();
  const loginAttempts=new Map();
  const base=url.origin;
  const request=async(endpoint,{method="GET",body,token,privileged=false,query,prefer}={})=>{
    const key=privileged?serviceKey:publishableKey;
    const headers={"apikey":key,"Accept":"application/json",...(body!==undefined?{"Content-Type":"application/json"}:{}),...(prefer?{Prefer:prefer}:{})};
    // Legacy service_role JWT is server-only; project secret keys use apikey.
    if(privileged && !key.startsWith("sb_secret_"))headers.Authorization="Bearer "+key;
    if(token)headers.Authorization="Bearer "+token;
    const target=new URL(endpoint,base);
    if(query)for(const [k,v] of Object.entries(query))target.searchParams.set(k,String(v));
    const response=await timedFetch(fetchFn,target.toString(),{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
    const payload=await response.json().catch(()=>null);
    if(!response.ok)throw error(response.status===401||response.status===403?response.status:502,
      response.status===401?"Credenciales inválidas":response.status===403?"Acceso denegado":"Error en Supabase");
    return payload;
  };
  async function refreshSession(session){
    if(session.expiresAt>Date.now()+60_000)return session;
    const next=await request("/auth/v1/token",{method:"POST",query:{grant_type:"refresh_token"},body:{refresh_token:session.refreshToken}});
    if(!next?.access_token)throw error(401,"Sesión caducada");
    session.token=next.access_token;
    session.refreshToken=next.refresh_token;
    session.expiresAt=Date.now()+(Number(next.expires_in)||3600)*1000;
    return session;
  }
  async function authenticate(req){
    const cookieToken=parseCookies(req);
    if(!cookieToken)return null;
    const session=sessions.get(sha(cookieToken));
    if(!session || session.ttl<Date.now())return null;
    await refreshSession(session);
    // Role is retrieved on every request from protected membership table,
    // never from client input or user_metadata.
    const memberships=await request("/rest/v1/crm_memberships",{token:session.token,query:{
      select:"business_id,role,active,kapso_assignee_id",business_id:"eq."+businessId,user_id:"eq."+session.userId,limit:"1"
    }});
    const m=memberships?.[0];
    if(!m?.active||!["owner","worker"].includes(m.role))return null;
    return {...session,role:m.role,assigneeId:m.kapso_assignee_id};
  }
  const table=(name,options={})=>request("/rest/v1/"+name,options);
  const handler=async(req,res)=>{
    res.setHeader("X-Content-Type-Options","nosniff");
    res.setHeader("Referrer-Policy","no-referrer");
    res.setHeader("X-Frame-Options","DENY");
    res.setHeader("Content-Security-Policy","default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-src https://inbox.kapso.ai; base-uri 'none'; object-src 'none'");
    try{
      const url=new URL(req.url,"http://localhost"),method=req.method;
      const write=["POST","PATCH","PUT","DELETE"].includes(method);
      if(write){
        // Requests from outside the same origin must never modify CRM state.
        const origin=req.headers.origin;
        if(origin && origin!=="http://"+req.headers.host && origin!=="https://"+req.headers.host)
          return json(res,403,{error:"Origen no autorizado"});
        if(req.headers["sec-fetch-site"] && !["same-origin","none"].includes(req.headers["sec-fetch-site"]))
          return json(res,403,{error:"Solicitud de otro sitio rechazada"});
      }
      if(method==="GET"&&files.has(url.pathname)){
        const [name,type]=files.get(url.pathname);
        res.writeHead(200,{"Content-Type":type,"Cache-Control":"no-store"});
        return res.end(await readFile(path.join(webRoot,name)));
      }
      if(method==="POST"&&url.pathname==="/webhooks/kapso/handoff"){
        if(!kapsoWebhookSecret || !kapsoProjectId)return json(res,404,{error:"Webhook desactivado"});
        const raw=await parseRaw(req);
        if(!verifyKapsoSignature(raw,req.headers["x-webhook-signature"],kapsoWebhookSecret))
          throw error(401,"Firma inválida");
        const event=parseKapsoHandoff(raw,req.headers["x-idempotency-key"],kapsoProjectId);
        const existing=await table("crm_handoffs",{privileged:true,query:{
          select:"event_key,provider_conversation_id",business_id:"eq."+businessId,
          event_key:"eq."+event.idempotencyKey,limit:"1"
        }});
        if(existing.length && existing[0].provider_conversation_id!==event.conversationId)
          throw error(409,"Clave de evento duplicada con contenido distinto");
        if(!existing.length){
          await table("crm_handoffs",{privileged:true,method:"POST",prefer:"resolution=ignore-duplicates",
            body:{business_id:businessId,event_key:event.idempotencyKey,
              provider_conversation_id:event.conversationId,
              assigned_user_id:kapsoConfig.workerAssigneeId||null,
              state:"pending"}});
        }
        await table("crm_handoff_outbox",{privileged:true,method:"POST",prefer:"resolution=ignore-duplicates",
          body:{business_id:businessId,event_key:event.idempotencyKey,state:"pending"}});
        return json(res,200,{recorded:existing.length===0,duplicate:existing.length>0});
      }
      if(method==="POST"&&url.pathname==="/api/login"){
        const input=await parseJson(req);
        const email=String(input.email||"").trim().toLowerCase();
        const pwd=String(input.password||"");
        if(!email||!pwd||email.length>254||pwd.length>1024)throw error(400,"Credenciales inválidas");
        const key=(req.socket.remoteAddress||"local")+":"+email;
        const state=loginAttempts.get(key)||{count:0,until:Date.now()+600000};
        if(state.until<Date.now()){state.count=0;state.until=Date.now()+600000;}
        if(state.count>=5)throw error(429,"Demasiados intentos; vuelve más tarde");
        let auth;
        try{auth=await request("/auth/v1/token",{method:"POST",query:{grant_type:"password"},body:{email,password:pwd}});}
        catch(e){state.count++;loginAttempts.set(key,state);throw error(401,"Credenciales inválidas");}
        if(!auth?.access_token||!auth?.user?.id)throw error(401,"Credenciales inválidas");
        const membership=await request("/rest/v1/crm_memberships",{token:auth.access_token,query:{
          select:"role,active",business_id:"eq."+businessId,user_id:"eq."+auth.user.id,limit:"1"
        }});
        if(!membership?.[0]?.active || !["owner","worker"].includes(membership[0].role))throw error(403,"Usuario sin acceso a este negocio");
        loginAttempts.delete(key);
        const token=randomBytes(32).toString("hex");
        sessions.set(sha(token),{token:auth.access_token,refreshToken:auth.refresh_token,userId:auth.user.id,
          email,role:membership[0].role,expiresAt:Date.now()+(Number(auth.expires_in)||3600)*1000,
          ttl:Date.now()+8*3600000});
        res.setHeader("Set-Cookie",cookie(token));
        return json(res,200,{email,role:membership[0].role});
      }
      if(method==="POST"&&url.pathname==="/api/logout"){
        const token=parseCookies(req);
        if(token)sessions.delete(sha(token));
        res.setHeader("Set-Cookie",cookie("",true));
        return json(res,200,{ok:true});
      }
      const user=await authenticate(req);
      if(!user)throw error(401,"Sesión requerida");
      if(method==="GET"&&url.pathname==="/api/me")return json(res,200,{email:user.email,role:user.role});
      if(method==="GET"&&url.pathname==="/api/handoff"){
        // Single-worker MVP: assigned_user_id must match the provisioned token.
        const actual={...kapsoConfig,workerAssigneeId:user.assigneeId};
        if(user.role==="worker" && user.assigneeId!==kapsoConfig.workerAssigneeId)actual.workerApproved=false;
        const embed=resolveInboxEmbed(user.role,actual);
        return json(res,200,embed.available?{status:"ready",embed_url:embed.url}:{status:"pending_integration",message:embed.reason});
      }
      if(user.role!=="owner")throw error(403,"Acceso restringido al propietario");

      if(method==="GET"&&url.pathname==="/api/inventory"){
        const products=await table("crm_inventory",{token:user.token,query:{select:"id,sku,name,unit,stock_quantity,minimum_quantity,active,updated_at",business_id:"eq."+businessId,order:"name.asc",limit:"500"}});
        return json(res,200,{products,lowStock:products.filter(p=>p.active&&Number(p.minimum_quantity)>0&&Number(p.stock_quantity)<=Number(p.minimum_quantity))});
      }
      if(method==="GET"&&url.pathname==="/api/movements"){
        const movements=await table("crm_stock_movements",{token:user.token,query:{select:"id,inventory_id,delta,reason,created_at",business_id:"eq."+businessId,order:"created_at.desc",limit:"100"}});
        return json(res,200,{movements});
      }
      if(method==="GET"&&url.pathname==="/api/alerts"){
        const alerts=await table("crm_alerts",{token:user.token,query:{select:"id,inventory_id,kind,message,created_at,resolved_at",business_id:"eq."+businessId,resolved_at:"is.null",order:"created_at.desc",limit:"100"}});
        return json(res,200,{alerts});
      }
      if(method==="GET"&&url.pathname==="/api/orders"){
        const bindings=await table("crm_order_sources",{privileged:true,query:{select:"business_id,enabled",singleton:"eq.true",limit:"1"}});
        if(!bindings?.length || bindings[0].business_id!==businessId)throw error(403,"Fuente de pedidos no vinculada a este negocio");

        const orders=await table("orders",{privileged:true,query:{select:"id,confirmation_key,customer_ref,items,subtotal_cents,shipping_cents,total_cents,fulfillment,address,delivery_references,payment_method,payment_status,order_status,created_at",order:"created_at.desc",limit:"100"}});
        return json(res,200,{orders});
      }
      if(method==="GET"&&url.pathname==="/api/drafts"){
        const bindings=await table("crm_order_sources",{privileged:true,query:{select:"business_id",singleton:"eq.true",limit:"1"}});
        if(!bindings?.length || bindings[0].business_id!==businessId)throw error(403,"Fuente de borradores no vinculada");
        const drafts=await table("order_drafts",{privileged:true,query:{select:"id,payload,created_at",order:"created_at.desc",limit:"100"}});
        return json(res,200,{drafts});
      }
      if(method==="GET"&&url.pathname==="/api/menu"){
        const bindings=await table("crm_order_sources",{privileged:true,query:{select:"business_id,enabled",singleton:"eq.true",limit:"1"}});
        if(!bindings?.length || bindings[0].business_id!==businessId)throw error(403,"Menú no vinculado a este negocio");

        const products=await table("menu_products",{privileged:true,query:{select:"sku,category,name,price_cents,description,active",order:"category.asc,name.asc",limit:"500"}});
        const modifiers=await table("menu_modifiers",{privileged:true,query:{select:"sku,name,price_cents,category,requires_review",limit:"500"}});
        return json(res,200,{products,modifiers});
      }
      if(method==="POST"&&url.pathname==="/api/inventory"){
        const x=await parseJson(req);
        const sku=String(x.sku||"").trim(),name=String(x.name||"").trim(),unit=String(x.unit||"piece");
        if(!sku||sku.length>80||!name||name.length>200||!["piece","kg","g","l","ml"].includes(unit))throw error(400,"Producto inválido");
        const minimum=Number(x.minimum_quantity??0);
        if(!Number.isFinite(minimum)||minimum<0)throw error(400,"Mínimo inválido");
        await table("crm_inventory",{method:"POST",token:user.token,body:{business_id:businessId,sku,name,unit,minimum_quantity:minimum,stock_quantity:0}});
        return json(res,201,{ok:true});
      }
      const match=url.pathname.match(/^\/api\/inventory\/([a-f0-9-]{36})$/i);
      if(method==="PATCH"&&match){
        const x=await parseJson(req);
        const allowed={};
        if(x.name!==undefined){const name=String(x.name).trim();if(!name||name.length>200)throw error(400,"Nombre inválido");allowed.name=name;}
        if(x.minimum_quantity!==undefined){const min=Number(x.minimum_quantity);if(!Number.isFinite(min)||min<0)throw error(400,"Mínimo inválido");allowed.minimum_quantity=min;}
        if(x.active!==undefined){if(typeof x.active!=="boolean")throw error(400,"Activo inválido");allowed.active=x.active;}
        if(!Object.keys(allowed).length)throw error(400,"No hay cambios permitidos");
        await table("crm_inventory",{method:"PATCH",token:user.token,body:allowed,query:{id:"eq."+match[1],business_id:"eq."+businessId}});
        return json(res,200,{ok:true});
      }
      const adjust=url.pathname.match(/^\/api\/inventory\/([a-f0-9-]{36})\/adjust$/i);
      if(method==="POST"&&adjust){
        const x=await parseJson(req);
        const delta=Number(x.delta),reason=String(x.reason||"").trim();
        if(!Number.isFinite(delta)||delta===0||Math.abs(delta)>1e6||!reason||reason.length>200)throw error(400,"Movimiento inválido");
        const stock=await request("/rest/v1/rpc/crm_adjust_stock",{method:"POST",token:user.token,
          body:{p_business_id:businessId,p_inventory_id:adjust[1],p_delta:delta,p_reason:reason}});
        return json(res,200,{ok:true,stock});
      }
      return json(res,404,{error:"Ruta inexistente"});
    }catch(e){
      // Never echo remote response bodies, credentials, or stack traces.
      return json(res,e.status&&[400,401,403,404,409,413,415,429].includes(e.status)?e.status:500,
        {error:e.status&&e.status<500?e.message:"Error interno"});
    }
  };
  const server=http.createServer(handler);
  return {server,close:()=>new Promise(resolve=>server.close(resolve))};
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const app=createRemoteApp({
    supabaseUrl:process.env.SUPABASE_URL,
    publishableKey:process.env.SUPABASE_PUBLISHABLE_KEY,
    serviceKey:process.env.SUPABASE_SERVICE_ROLE_KEY,
    businessId:process.env.CRM_BUSINESS_ID,
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
  app.server.listen(port,"127.0.0.1",()=>console.log("CRM Kapso Supabase: http://127.0.0.1:"+port));
}
