/**
 * Read-only Supabase/PostgREST confirmed order reader.
 * Credentials remain server-side. This does not create/edit remote records.
 * The returned order format is normalized by validateOrder below.
 */
const ident=/^[a-z_][a-z0-9_]{0,63}$/;
function configError(message){throw Object.assign(new Error(message),{code:"CONFIG"});}
export function buildOrdersUrl(base, table="orders",limit=300) {
  if(!ident.test(table))configError("Invalid configured table name");
  let url;
  try{url=new URL(base);}catch{configError("SUPABASE_URL missing or invalid");}
  if(url.protocol!=="https:" || url.username || url.password || !/^([a-z0-9-]+)\.supabase\.co$/.test(url.hostname)){
    configError("Only verified HTTPS supabase.co project origins allowed");
  }
  const endpoint=new URL("/rest/v1/"+table,url);
  endpoint.searchParams.set("select","id,items,order_status,payment_status,payment_method");
  endpoint.searchParams.set("order","created_at.desc");
  endpoint.searchParams.set("limit",String(Math.min(Math.max(limit,1),500)));
  return endpoint.toString();
}
export function normalizeRemoteOrder(row){
  const eventId=String(row?.id??"");
  if(!/^[0-9a-f-]{36}$/i.test(eventId))throw Error("Remote order requires UUID id");
  if(!Array.isArray(row.items)||!row.items.length)throw Error("Order without items");
  const items=row.items.map(x=>({
    sku:String(x?.sku??x?.product_sku??"").trim(),
    quantity:Number(x?.quantity??x?.qty??0)
  }));
  for(const i of items)if(!i.sku||!Number.isFinite(i.quantity)||i.quantity<=0)throw Error("Unrecognized order item schema");
  const orderStatus=String(row.order_status??"").toLowerCase();
  const method=String(row.payment_method??"").toLowerCase();
  const payment=String(row.payment_status??"").toLowerCase();
  // This policy MUST be reviewed for each client before enabling the sync.
  if(orderStatus==="cancelled")return {action:"reverse",source:"supabase",eventId};
  if(!["confirmed","preparing","ready","assigned","delivered"].includes(orderStatus))return null;
  if(method==="transfer" && payment!=="verified")return null;
  if(!["cash","transfer"].includes(method))return null;
  return {action:"apply",source:"supabase",eventId,items};
}
export async function readOrders({url,apiKey,accessToken,fetchFn=fetch,timeoutMs=10000}){
  if(!apiKey || apiKey.length<12)configError("SUPABASE_READ_KEY missing");
  const ctrl=new AbortController();
  const timer=setTimeout(()=>ctrl.abort(),timeoutMs);
  try{
    const response=await fetchFn(url,{
      method:"GET",
      headers:{apikey:apiKey,...(accessToken?{Authorization:"Bearer "+accessToken}:{}),Accept:"application/json"},
      signal:ctrl.signal,
      redirect:"error"
    });
    if(!response.ok)throw Error("Supabase reader failed with HTTP "+response.status);
    const data=await response.json();
    if(!Array.isArray(data))throw Error("Unexpected Supabase response");
    return data;
  }finally{clearTimeout(timer);}
}
