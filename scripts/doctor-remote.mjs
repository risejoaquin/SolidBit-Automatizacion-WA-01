/**
 * Sanitized configuration and connection doctor.
 * Does not print, persist or send secrets beyond the intended Supabase API.
 */
import {spawnSync} from "node:child_process";
const e=process.env;
const checks=[];
const pass=(name,okay,reason)=>checks.push({name,status:okay?"PASS":"BLOCKED",reason:okay?undefined:reason});
const required=["SUPABASE_URL","SUPABASE_PUBLISHABLE_KEY","SUPABASE_SERVICE_ROLE_KEY",
"CRM_BUSINESS_ID","OWNER_EMAIL","WORKER_EMAIL","OWNER_PASSWORD","WORKER_PASSWORD"];
pass("Environment variables",required.every(k=>Boolean(e[k])),"Complete .env.local privately");
const ignore=spawnSync("git",["check-ignore","-q",".env.local"],{stdio:"ignore"});
pass(".env.local ignored by Git",ignore.status===0,"Verify .gitignore");
let url=null;
try{url=new URL(e.SUPABASE_URL);}catch{}
pass("Supabase HTTPS project origin",Boolean(url&&url.protocol==="https:"&&/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname)),"Use valid project URL");
if(url&&checks[0].status==="PASS"&&checks[2].status==="PASS"){
 const key=e.SUPABASE_SERVICE_ROLE_KEY;
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
 try{
  const target=new URL("/rest/v1/crm_businesses",url.origin);
  target.searchParams.set("select","id");
  target.searchParams.set("id","eq."+e.CRM_BUSINESS_ID);
  target.searchParams.set("limit","1");
  const response=await fetch(target,{
   headers:{apikey:key,Accept:"application/json",...(!key.startsWith("sb_secret_")?{Authorization:"Bearer "+key}:{})},
   signal:controller.signal,redirect:"error"
  });
  const data=response.ok?await response.json():[];
  pass("CRM business and private Supabase connection",response.ok&&data.length===1,
    "Verify migrations, service role, business binding and API grants");
 }catch{pass("CRM business and private Supabase connection",false,"Supabase unreachable or authentication refused");}
 finally{clearTimeout(timer);}
}
pass("Kapso owner inbox configuration",Boolean(e.KAPSO_OWNER_EMBED_URL),"Create scoped inbox embed when ready");
pass("Kapso worker assignment verification",e.KAPSO_WORKER_EMBED_APPROVED==="true"&&Boolean(e.KAPSO_WORKER_ASSIGNEE_ID),
 "Keep worker inbox blocked until tested with assigned_user_id");
pass("Order synchronization enabled",e.ENABLE_SUPABASE_SYNC==="true",
 "Keep disabled until quantities and mapping are verified");
for(const item of checks)console.log(item.name+": "+item.status+(item.reason?" — "+item.reason:""));
const critical=checks.slice(0,4).some(x=>x.status==="BLOCKED");
if(critical)process.exitCode=1;
console.log("Doctor finished. Optional Kapso and automatic stock gates are separate from initial CRM login.");
