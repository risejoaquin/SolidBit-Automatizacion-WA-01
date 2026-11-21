/**
 * Read-only real Supabase RLS certification.
 * Authenticates owner and worker from private local env; no secrets logged.
 * Runs only after users and CRM membership have been bootstrapped.
 */
const e=process.env;
for(const k of ["SUPABASE_URL","SUPABASE_PUBLISHABLE_KEY","CRM_BUSINESS_ID","OWNER_EMAIL","OWNER_PASSWORD","WORKER_EMAIL","WORKER_PASSWORD"])
 if(!e[k])throw Error("Missing private config: "+k);
const base=new URL(e.SUPABASE_URL);
if(base.protocol!=="https:"||!/^[a-z0-9-]+\.supabase\.co$/.test(base.hostname))throw Error("Invalid project URL");
const key=e.SUPABASE_PUBLISHABLE_KEY;
async function getSession(email,password){
 const endpoint=new URL("/auth/v1/token?grant_type=password",base);
 const response=await fetch(endpoint,{method:"POST",headers:{apikey:key,"Content-Type":"application/json"},
  body:JSON.stringify({email,password}),redirect:"error"});
 if(!response.ok)throw Error("QA authentication failed (redacted)");
 const data=await response.json();
 if(!data.access_token)throw Error("No access token in QA response");
 return data.access_token;
}
async function rest(table,token){
 const url=new URL("/rest/v1/"+table,base);
 url.searchParams.set("select","id");
 url.searchParams.set("business_id","eq."+e.CRM_BUSINESS_ID);
 url.searchParams.set("limit","100");
 const response=await fetch(url,{headers:{apikey:key,...(token?{Authorization:"Bearer "+token}:{})},redirect:"error"});
 return {status:response.status,data:response.ok?await response.json():null};
}
const owner=await getSession(e.OWNER_EMAIL,e.OWNER_PASSWORD);
const worker=await getSession(e.WORKER_EMAIL,e.WORKER_PASSWORD);
const ownerInventory=await rest("crm_inventory",owner);
const workerInventory=await rest("crm_inventory",worker);
const anonymous=await rest("crm_inventory",null);
const checks=[
 ["Owner can read CRM inventory",ownerInventory.status===200 && Array.isArray(ownerInventory.data) && ownerInventory.data.length>0],
 ["Worker sees no inventory rows",workerInventory.status===200 && Array.isArray(workerInventory.data) && workerInventory.data.length===0],
 ["Anonymous cannot read CRM inventory",anonymous.status===401||anonymous.status===403||(anonymous.status===200&&anonymous.data?.length===0)]
];
for(const [label,passed] of checks)console.log(label+": "+(passed?"PASS":"FAIL"));
if(checks.some(([,passed])=>!passed))process.exitCode=1;
console.log("Real RLS QA done; tokens were held in memory and not logged.");
