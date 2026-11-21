/**
 * Opt-in delivery worker for project handoffs. Exits without sending unless
 * ENABLE_KAPSO_HANDOFF_NOTICES=true. Never publishes keys or message contents.
 */
import {existsSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";
import {drainHandoffOutbox} from "../src/integrations/kapso/notifier.js";
import {initHandoffStore} from "../src/integrations/kapso/webhook.js";
const env=process.env;
if(env.ENABLE_KAPSO_HANDOFF_NOTICES!=="true") {
  console.error("Handoff notices disabled. No WhatsApp messages sent.");
  process.exit(2);
}
const required=["KAPSO_API_KEY","KAPSO_PHONE_NUMBER_ID","KAPSO_WORKER_PHONE","KAPSO_HANDOFF_TEMPLATE"];
if(required.some(k=>!env[k])) {console.error("Missing private handoff notification configuration");process.exit(2);}
const file=env.LOCAL_DB_PATH||"./crm-kapso-local.sqlite";
if(!existsSync(file)){console.error("Local DB missing. Start app first.");process.exit(2);}
const db=new DatabaseSync(file);
db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
initHandoffStore(db);
let busy=false;
async function run(){
  if(busy)return;busy=true;
  try{
    const result=await drainHandoffOutbox(db,{
      apiKey:env.KAPSO_API_KEY,phoneNumberId:env.KAPSO_PHONE_NUMBER_ID,
      to:env.KAPSO_WORKER_PHONE,templateName:env.KAPSO_HANDOFF_TEMPLATE,
      language:env.KAPSO_HANDOFF_TEMPLATE_LANGUAGE||"es_MX"
    });
    console.log("Handoff notification counts: "+JSON.stringify(result));
  }catch{console.error("Handoff notification worker error (details redacted)");}
  finally{busy=false;}
}
await run();
if(process.argv.includes("--watch")){
  const timer=setInterval(run,30_000);
  console.log("Handoff notice worker active. Stop with Ctrl+C.");
  process.on("SIGINT",()=>{clearInterval(timer);db.close();process.exit(0);});
}else db.close();
