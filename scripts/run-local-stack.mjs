/**
 * Local CRM stack supervisor. No GitHub Actions or Docker.
 * Starts the Supabase-backed server and optional read-only reconciliation
 * and approved WhatsApp handoff notification workers.
 */
import {spawn} from "node:child_process";
const env=process.env;
const needed=["SUPABASE_URL","SUPABASE_PUBLISHABLE_KEY","SUPABASE_SERVICE_ROLE_KEY","CRM_BUSINESS_ID"];
const absent=needed.filter(k=>!env[k]);
if(absent.length){console.error("Missing private config keys: "+absent.join(", "));process.exit(2);}
const jobs=[
 ["CRM", "src/remote/server.js"]
];
if(env.ENABLE_SUPABASE_SYNC==="true")jobs.push(["Orders","scripts/reconcile-remote-orders.mjs","--watch"]);
if(env.ENABLE_KAPSO_HANDOFF_NOTICES==="true")jobs.push(["Handoff alerts","scripts/notify-remote-handoffs.mjs","--watch"]);
const children=[];
let shuttingDown=false;
function stop(exit=0){
 if(shuttingDown)return;
 shuttingDown=true;
 for(const [,proc]of children)if(proc.exitCode===null)proc.kill();
 process.exitCode=exit;
}
for(const [label,file,...args]of jobs){
 const proc=spawn(process.execPath,[file,...args],{stdio:["ignore","pipe","pipe"],env:process.env});
 children.push([label,proc]);
 proc.stdout.on("data",chunk=>{
  // In child applications console output must never contain credentials.
  const line=chunk.toString("utf8").trim();
  if(line)console.log("["+label+"] "+line.slice(0,1000));
 });
 proc.stderr.on("data",()=>{
  // Never relay a full stacktrace that might carry injected private details.
  console.error("["+label+"] reported an error; run local QA diagnostics privately.");
 });
 proc.on("exit",(code)=>{
  if(shuttingDown)return;
  console.error(label+" exited (code "+code+"). Stopping local stack.");
  stop(code||1);
 });
}
process.on("SIGINT",()=>stop(0));
process.on("SIGTERM",()=>stop(0));
console.log("CRM stack started locally. Externally exposed tunnels are NOT enabled.");
