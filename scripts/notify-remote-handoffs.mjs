/**
 * Single-instance Supabase handoff outbox worker, opt-in.
 * Sends only an approved WhatsApp UTILITY template to a configured employee.
 * Uses service key and Kapso API key server-side; no browser secrets.
 */
import {sendHandoffNotification} from "../src/integrations/kapso/notifier.js";
const env=process.env;
if(env.ENABLE_KAPSO_HANDOFF_NOTICES!=="true")throw Error("Handoff notices disabled");
for(const key of ["SUPABASE_URL","SUPABASE_SERVICE_ROLE_KEY","CRM_BUSINESS_ID",
  "KAPSO_API_KEY","KAPSO_PHONE_NUMBER_ID","KAPSO_WORKER_PHONE","KAPSO_HANDOFF_TEMPLATE"])
 if(!env[key])throw Error("Missing required private config: "+key);
const base=new URL(env.SUPABASE_URL);
if(base.protocol!=="https:"||!/^[a-z0-9-]+\.supabase\.co$/.test(base.hostname))throw Error("Invalid Supabase host");
const key=env.SUPABASE_SERVICE_ROLE_KEY;
const headers={apikey:key,Accept:"application/json",...(!key.startsWith("sb_secret_")?{Authorization:"Bearer "+key}:{})};
async function query(table,{method="GET",filter={},payload}={}){
 const url=new URL("/rest/v1/"+table,base);
 for(const [k,v]of Object.entries(filter))url.searchParams.set(k,String(v));
 const response=await fetch(url,{
  method,
  headers:{...headers,...(payload?{"Content-Type":"application/json"}:{})},
  body:payload?JSON.stringify(payload):undefined,
  redirect:"error"
 });
 if(!response.ok)throw Object.assign(new Error("Queue API failed"),{status:response.status});
 return response.status===204?null:response.json().catch(()=>null);
}
let busy=false;
async function deliver(){
 if(busy)return;busy=true;
 const result={pending:0,accepted:0,failed:0};
 try{
  const tasks=await query("rpc/crm_claim_handoff_notifications",{method:"POST",
    payload:{p_business_id:env.CRM_BUSINESS_ID,p_limit:10}});
  result.pending=tasks.length;
  for(const task of tasks){
   try{
    const sent=await sendHandoffNotification({
      apiKey:env.KAPSO_API_KEY,
      phoneNumberId:env.KAPSO_PHONE_NUMBER_ID,
      to:env.KAPSO_WORKER_PHONE,
      templateName:env.KAPSO_HANDOFF_TEMPLATE,
      language:env.KAPSO_HANDOFF_TEMPLATE_LANGUAGE||"es_MX"
    });
    await query("crm_handoff_outbox",{method:"PATCH",filter:{
      business_id:"eq."+env.CRM_BUSINESS_ID,event_key:"eq."+task.event_key
    },payload:{state:"sent",provider_message_id:sent.messageId,updated_at:new Date().toISOString()}});
    result.accepted++;
   }catch{
    await query("crm_handoff_outbox",{method:"PATCH",filter:{
      business_id:"eq."+env.CRM_BUSINESS_ID,event_key:"eq."+task.event_key
    },payload:{state:task.attempts>=5?"failed":"pending",last_error_code:"DELIVERY_UNCERTAIN",
      updated_at:new Date().toISOString()}}).catch(()=>{});
    result.failed++;
   }
  }
  console.log("Handoff notices (aggregate counts; accepted is not delivered): "+JSON.stringify(result));
 }catch{console.error("Remote handoff outbox read/write failed (sanitized)");process.exitCode=1;}
 finally{busy=false;}
}
await deliver();
if(process.argv.includes("--watch")&&!process.exitCode){
 const timer=setInterval(deliver,30000);
 console.log("Handoff notification polling active.");
 process.on("SIGINT",()=>{clearInterval(timer);process.exit(0);});
}
