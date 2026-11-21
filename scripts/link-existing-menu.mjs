/**
 * Explicitly bind the legacy orders/menu source to a CRM business and
 * import SKUs into crm_inventory with ZERO starting stock.
 * This is additive and idempotent. Never modifies old Kapso orders or menu.
 * Sync stays OFF until --enable-after-review is supplied.
 */
const env=process.env;
if(!process.argv.includes("--confirm"))throw Error("Run with --confirm after reviewing business id and existing menu");
const required=["SUPABASE_URL","SUPABASE_SERVICE_ROLE_KEY","CRM_BUSINESS_ID"];
for(const k of required)if(!env[k])throw Error("Missing private variable "+k);
const base=new URL(env.SUPABASE_URL);
if(base.protocol!=="https:"||!/^[a-z0-9-]+\.supabase\.co$/.test(base.hostname))throw Error("Invalid origin");
const key=env.SUPABASE_SERVICE_ROLE_KEY;
const headers={apikey:key,Accept:"application/json",...(!key.startsWith("sb_secret_")?{Authorization:"Bearer "+key}:{})};
async function call(table,{method="GET",query={},body,prefer}={}){
 const url=new URL("/rest/v1/"+table,base);
 for(const [k,v]of Object.entries(query))url.searchParams.set(k,String(v));
 const response=await fetch(url,{method,headers:{...headers,...(body?{"Content-Type":"application/json"}:{}),...(prefer?{Prefer:prefer}:{})},body:body?JSON.stringify(body):undefined,redirect:"error"});
 if(!response.ok)throw Error("Supabase request rejected (HTTP "+response.status+")");
 return response.status===204?null:response.json();
}
const businessId=env.CRM_BUSINESS_ID;
const business=(await call("crm_businesses",{query:{select:"id",id:"eq."+businessId,limit:"1"}}))?.[0];
if(!business)throw Error("CRM business does not exist");
const existingSource=await call("crm_order_sources",{query:{select:"business_id,enabled",singleton:"eq.true"}});
if(existingSource.length&&existingSource[0].business_id!==businessId)throw Error("Legacy source already bound to another business");
if(!existingSource.length)await call("crm_order_sources",{method:"POST",body:{singleton:true,business_id:businessId,enabled:false}});
const menu=await call("menu_products",{query:{select:"sku,name,active",limit:"1000"}});
const stocks=await call("crm_inventory",{query:{select:"sku",business_id:"eq."+businessId,limit:"1000"}});
const existing=new Set(stocks.map(p=>p.sku));
let created=0;
for(const p of menu){
 if(existing.has(p.sku))continue;
 await call("crm_inventory",{method:"POST",body:{business_id:businessId,sku:p.sku,name:p.name,active:p.active,stock_quantity:0,minimum_quantity:0,unit:"piece"}});
 created++;
}
if(process.argv.includes("--enable-after-review")){
 const missing=await call("crm_inventory",{query:{select:"sku,stock_quantity",business_id:"eq."+businessId,limit:"1000"}});
 if(!missing.length)throw Error("Inventory not loaded");
 // An operator must explicitly acknowledge real stock quantities; zeros may be legitimate.
 if(env.CONFIRM_STOCK_COUNTS!=="YES")throw Error("CONFIRM_STOCK_COUNTS=YES required before enabling order sync");
 await call("crm_order_sources",{method:"PATCH",query:{singleton:"eq.true"},body:{enabled:true}});
}
console.log("CRM menu linked. Existing products: "+(menu.length-created)+". New inventory rows: "+created+".");
console.log("Existing orders and menu left unchanged. Auto-reconciliation enabled: "+process.argv.includes("--enable-after-review"));
