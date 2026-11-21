/**
 * Explicit one-time Supabase Auth + CRM business bootstrap.
 * Does not modify existing Kapso tables or enable order sync automatically.
 * Never prints or commits API keys, passwords, or tokens.
 */
import {existsSync,readFileSync,writeFileSync,renameSync} from "node:fs";
import {randomBytes} from "node:crypto";
const env=process.env;
if(!process.argv.includes("--confirm"))throw Error("Bootstrap disabled: use --confirm after reviewing db/ SQL migrations");
if(!existsSync(".env.local"))throw Error("Missing local .env.local");
const mandatory=["SUPABASE_URL","SUPABASE_SERVICE_ROLE_KEY","SUPABASE_PUBLISHABLE_KEY","OWNER_EMAIL","OWNER_PASSWORD","WORKER_EMAIL","WORKER_PASSWORD"];
for(const k of mandatory)if(!env[k])throw Error("Missing private environment variable: "+k);
let root;
try{root=new URL(env.SUPABASE_URL);}catch{throw Error("Invalid SUPABASE_URL");}
if(root.protocol!=="https:"||!/^[a-z0-9-]+\.supabase\.co$/.test(root.hostname))throw Error("Unsupported Supabase origin");
if(env.SUPABASE_SERVICE_ROLE_KEY===env.SUPABASE_PUBLISHABLE_KEY)throw Error("Keys must have separate roles");
const service=env.SUPABASE_SERVICE_ROLE_KEY;
const serviceHeaders={"apikey":service,...(service.startsWith("sb_secret_")?{}:{Authorization:"Bearer "+service})};
async function call(endpoint,{method="GET",body,query,headers={}}={}){
 const url=new URL(endpoint,root.origin);
 for(const [k,v]of Object.entries(query||{}))url.searchParams.set(k,String(v));
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
 try{
  const response=await fetch(url,{method,headers:{...serviceHeaders,Accept:"application/json",...(body?{"Content-Type":"application/json"}:{}),...headers},body:body?JSON.stringify(body):undefined,signal:controller.signal,redirect:"error"});
  const json=await response.json().catch(()=>null);
  if(!response.ok)throw Object.assign(new Error("Supabase bootstrap request rejected (redacted)"),{status:response.status});
  return json;
 }finally{clearTimeout(timer);}
}
async function authUser(email,password){
  // Read existing Auth users before creating, to avoid unnecessary credential rotation.
  const listed=await call("/auth/v1/admin/users",{query:{page:1,per_page:1000}});
  const existing=listed?.users?.find(u=>u.email?.toLowerCase()===email.toLowerCase());
  if(existing)return existing.id;
  const result=await call("/auth/v1/admin/users",{method:"POST",body:{email,password,email_confirm:true}});
  const user=result?.user||result;
  if(!user?.id)throw Error("Auth user creation returned no id");
  return user.id;
}
async function rows(table,query){
  return await call("/rest/v1/"+table,{query:{select:"*",...query}});
}
async function insert(table,data){
  return await call("/rest/v1/"+table,{method:"POST",body:data,headers:{Prefer:"return=representation"}});
}
const slug=String(env.CRM_BUSINESS_SLUG||"negocio-piloto").toLowerCase();
if(!/^[a-z0-9][a-z0-9-]{1,79}$/.test(slug))throw Error("CRM_BUSINESS_SLUG invalid");
const name=String(env.CRM_BUSINESS_NAME||"Negocio piloto").trim();
if(!name||name.length>160)throw Error("CRM_BUSINESS_NAME invalid");
let business=(await rows("crm_businesses",{slug:"eq."+slug,limit:1}))?.[0];
if(!business)business=(await insert("crm_businesses",{name,slug}))?.[0];
if(!business?.id)throw Error("Could not read CRM business id");
const accounts=[
  {email:env.OWNER_EMAIL,password:env.OWNER_PASSWORD,role:"owner"},
  {email:env.WORKER_EMAIL,password:env.WORKER_PASSWORD,role:"worker"}
];
if(accounts[0].email.toLowerCase()===accounts[1].email.toLowerCase())throw Error("Accounts must differ");
for(const acct of accounts){
  const userId=await authUser(acct.email,acct.password);
  const membership=(await rows("crm_memberships",{business_id:"eq."+business.id,user_id:"eq."+userId,limit:1}))?.[0];
  if(membership && (membership.role!==acct.role||!membership.active))throw Error("Existing membership differs; manual review required");
  if(!membership)await insert("crm_memberships",{business_id:business.id,user_id:userId,role:acct.role,active:true});
}
function savePrivateVariable(key,value){
 const current=readFileSync(".env.local","utf8");
 let lines=current.replace(/\r\n/g,"\n").split("\n");
 const found=lines.findIndex(line=>line.startsWith(key+"="));
 if(found<0)lines.push(key+"="+value);else lines[found]=key+"="+value;
 const temp=".env.local."+randomBytes(8).toString("hex")+".tmp";
 writeFileSync(temp,lines.join("\n").replace(/\n*$/,"\n"),{mode:0o600,flag:"wx"});
 renameSync(temp,".env.local");
}
if(env.CRM_BUSINESS_ID && env.CRM_BUSINESS_ID!==business.id)throw Error("CRM_BUSINESS_ID mismatch; aborting before config change");
savePrivateVariable("CRM_BUSINESS_ID",business.id);
console.log("CRM business and owner/worker membership ready. Private business id saved locally.");
console.log("Legacy order link remains disabled; no remote order or menu changes were made.");
