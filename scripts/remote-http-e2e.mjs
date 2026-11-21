/**
 * End-to-end CRM HTTP QA against REAL Supabase but read-only business data.
 * Creates a temporary loopback server, exercises Auth and role boundaries,
 * then closes it. No writes except login/refresh to Auth.
 */
import {createRemoteApp} from "../src/remote/server.js";
const e=process.env;
for(const k of ["SUPABASE_URL","SUPABASE_PUBLISHABLE_KEY","SUPABASE_SERVICE_ROLE_KEY",
 "CRM_BUSINESS_ID","OWNER_EMAIL","OWNER_PASSWORD","WORKER_EMAIL","WORKER_PASSWORD"])
 if(!e[k])throw Error("Missing private environment variable: "+k);
const app=createRemoteApp({
 supabaseUrl:e.SUPABASE_URL,
 publishableKey:e.SUPABASE_PUBLISHABLE_KEY,
 serviceKey:e.SUPABASE_SERVICE_ROLE_KEY,
 businessId:e.CRM_BUSINESS_ID,
 kapsoConfig:{
  ownerEmbedUrl:e.KAPSO_OWNER_EMBED_URL,
  workerEmbedUrl:e.KAPSO_WORKER_EMBED_URL,
  workerApproved:e.KAPSO_WORKER_EMBED_APPROVED==="true",
  workerAssigneeId:e.KAPSO_WORKER_ASSIGNEE_ID
 }
});
await new Promise(resolve=>app.server.listen(0,"127.0.0.1",resolve));
const base="http://127.0.0.1:"+app.server.address().port;
const results=[];
const check=(label,ok)=>{results.push({label,ok});console.log(label+": "+(ok?"PASS":"FAIL"));};
async function login(email,password){
 const response=await fetch(base+"/api/login",{method:"POST",headers:{"Content-Type":"application/json"},
 body:JSON.stringify({email,password})});
 return {status:response.status,cookie:response.headers.get("set-cookie")?.split(";")[0]};
}
async function get(path,cookie){
 const response=await fetch(base+path,{headers:cookie?{Cookie:cookie}:{}});
 return {status:response.status,body:await response.json().catch(()=>null)};
}
try{
 check("Unauthenticated CRM inventory denied",(await get("/api/inventory")).status===401);
 const owner=await login(e.OWNER_EMAIL,e.OWNER_PASSWORD);
 check("Owner login",owner.status===200&&Boolean(owner.cookie));
 const worker=await login(e.WORKER_EMAIL,e.WORKER_PASSWORD);
 check("Worker login",worker.status===200&&Boolean(worker.cookie));
 if(owner.cookie){
  check("Owner role verified",(await get("/api/me",owner.cookie)).body?.role==="owner");
  for(const [name,path]of [["Inventory","/api/inventory"],["Menu","/api/menu"],["Orders","/api/orders"],["Drafts","/api/drafts"],["Alerts","/api/alerts"]]){
   check("Owner "+name+" read",(await get(path,owner.cookie)).status===200);
  }
 }
 if(worker.cookie){
  check("Worker role verified",(await get("/api/me",worker.cookie)).body?.role==="worker");
  for(const path of ["/api/inventory","/api/menu","/api/orders","/api/drafts","/api/alerts","/api/movements"]){
   check("Worker "+path+" denied",(await get(path,worker.cookie)).status===403);
  }
  check("Worker handoff available or safely blocked",(await get("/api/handoff",worker.cookie)).status===200);
 }
}finally{await app.close();}
if(results.some(x=>!x.ok))process.exitCode=1;
console.log("Remote HTTP E2E complete — no customer records or credentials printed.");
