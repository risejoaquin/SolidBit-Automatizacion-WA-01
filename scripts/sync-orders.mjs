/**
 * Optional read-only reconciliation of confirmed orders from Supabase into
 * the LOCAL inventory. ENABLE_SUPABASE_SYNC must be true. Never writes remote.
 * Single-business deployment; no shared-tenant sync.
 */
import {DatabaseSync} from "node:sqlite";
import {existsSync} from "node:fs";
import {buildOrdersUrl, readOrders, normalizeRemoteOrder} from "../src/integrations/supabase/order-reader.js";
import {initSalesEngine,applyConfirmedSale,reverseConfirmedSale} from "../src/modules/inventory/sales-engine.js";

const env=process.env;
if(env.ENABLE_SUPABASE_SYNC!=="true") {
  console.error("Supabase reconciliation is disabled. Set ENABLE_SUPABASE_SYNC=true only after contract review.");
  process.exit(2);
}
const dbPath=env.LOCAL_DB_PATH||"./crm-kapso-local.sqlite";
if(!existsSync(dbPath)){
  console.error("Local database missing. Start the local CRM first; sync will never create an empty DB.");
  process.exit(2);
}
const url=buildOrdersUrl(env.SUPABASE_URL,env.SUPABASE_ORDER_TABLE||"orders",Number(env.SUPABASE_SYNC_LIMIT||300));
const db=new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
initSalesEngine(db);
let busy=false, failures=0;
async function sync(){
  if(busy)return;
  busy=true;
  let totals={remote:0,applied:0,reversed:0,duplicates:0,skipped:0,failed:0};
  try{
    const orders=await readOrders({url,apiKey:env.SUPABASE_READ_KEY,accessToken:env.SUPABASE_ACCESS_TOKEN});
    totals.remote=orders.length;
    for(const row of orders){
      try{
        const event=normalizeRemoteOrder(row);
        if(!event){totals.skipped++;continue;}
        const result=event.action==="apply"?applyConfirmedSale(db,event):reverseConfirmedSale(db,event);
        if(result.duplicate)totals.duplicates++;
        else if(result.applied)totals.applied++;
        else if(result.reversed)totals.reversed++;
      }catch(error){
        // Exclude row data, tokens and customer content from logs.
        totals.failed++;
        console.error("One remote order could not reconcile; code="+(error.status||"VALIDATION"));
      }
    }
    if(totals.failed)failures++;
    console.log("Sync summary (counts only): "+JSON.stringify(totals));
  }catch(error){
    failures++;
    console.error("Sync failed: "+(error.code||"REMOTE_UNAVAILABLE"));
  }finally{busy=false;}
}
await sync();
if(process.argv.includes("--watch")){
  const seconds=Math.min(3600,Math.max(15,Number(env.SUPABASE_SYNC_INTERVAL_SECONDS||30)));
  console.log("Read-only polling every "+seconds+" seconds; Ctrl+C to stop.");
  const timer=setInterval(sync,seconds*1000);
  const shutdown=()=>{
    clearInterval(timer);db.close();process.exit(failures?1:0);
  };
  process.on("SIGINT",shutdown);
  process.on("SIGTERM",shutdown);
}else{
  db.close();
  if(failures)process.exitCode=1;
}
