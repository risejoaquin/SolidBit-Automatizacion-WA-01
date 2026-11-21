/**
 * Reconcile existing Kapso orders into Supabase CRM inventory.
 * Uses service_role ONLY server-side. Never fetches PII, prints tokens or
 * changes legacy order rows. Enabled only after explicit stock confirmation.
 */
const env=process.env;
if(env.ENABLE_SUPABASE_SYNC!=="true")throw Error("Remote reconciliation disabled");
for(const k of ["SUPABASE_URL","SUPABASE_SERVICE_ROLE_KEY","CRM_BUSINESS_ID"])
  if(!env[k])throw Error("Missing private variable: "+k);
const origin=new URL(env.SUPABASE_URL);
if(origin.protocol!=="https:"||!/^[a-z0-9-]+\.supabase\.co$/.test(origin.hostname))throw Error("Invalid Supabase origin");
const secret=env.SUPABASE_SERVICE_ROLE_KEY;
const headers={apikey:secret,Accept:"application/json",...(!secret.startsWith("sb_secret_")?{Authorization:"Bearer "+secret}:{})};
async function call(endpoint,{method="GET",body,query}={}){
 const url=new URL(endpoint,origin);
 for(const [k,v]of Object.entries(query||{}))url.searchParams.set(k,String(v));
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
 try{
  const response=await fetch(url,{method,headers:{...headers,...(body?{"Content-Type":"application/json"}:{})},body:body?JSON.stringify(body):undefined,redirect:"error",signal:controller.signal});
  const result=await response.json().catch(()=>null);
  if(!response.ok)throw Object.assign(new Error("Supabase reconciler rejected request"),{status:response.status});
  return result;
 }finally{clearTimeout(timer);}
}
let busy=false;
async function reconcile(){
 if(busy)return;busy=true;
 const counters={pending:0,applied:0,duplicate:0,reversed:0,skipped:0,failed:0};
 try{
  const source=(await call("/rest/v1/crm_order_sources",{query:{select:"business_id,enabled",singleton:"eq.true",limit:1}}))?.[0];
  if(!source?.enabled || source.business_id!==env.CRM_BUSINESS_ID)throw Error("Order source not enabled for configured business");
  const queue=await call("/rest/v1/crm_order_queue",{query:{
    select:"order_id,business_id,attempts",business_id:"eq."+env.CRM_BUSINESS_ID,processed_at:"is.null",
    order:"requested_at.asc",limit:"50"
  }});
  counters.pending=queue.length;
  for(const row of queue){
   try{
    const status=await call("/rest/v1/rpc/crm_reconcile_order",{method:"POST",body:{p_order_id:row.order_id}});
    if(status==="applied")counters.applied++;
    else if(status==="duplicate")counters.duplicate++;
    else if(status==="reversed_or_skipped")counters.reversed++;
    else counters.skipped++;
   }catch(e){
    counters.failed++;
    await call("/rest/v1/crm_order_queue",{method:"PATCH",
      query:{order_id:"eq."+row.order_id,business_id:"eq."+env.CRM_BUSINESS_ID},
      body:{attempts:row.attempts+1,last_error:"reconciliation_failed"}}).catch(()=>{});
   }
  }
  console.log("Order reconciliation summary (counts only): "+JSON.stringify(counters));
 }catch(e){console.error("Order reconciler blocked or unavailable; no sensitive data logged");process.exitCode=1;}
 finally{busy=false;}
}
await reconcile();
if(process.argv.includes("--watch") && !process.exitCode){
 const timer=setInterval(reconcile,30000);
 console.log("Reconciliation polling active; Ctrl+C to stop.");
 process.on("SIGINT",()=>{clearInterval(timer);process.exit(0);});
}
