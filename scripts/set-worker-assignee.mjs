/**
 * Map one CRM worker's Supabase auth ID to an authorized Kapso assignee ID.
 * Only service_role can update membership. Never echoes credentials.
 * Does not automatically approve the inbox scope; human QA is mandatory.
 */
const e=process.env;
if(!process.argv.includes("--confirm"))throw Error("Use --confirm for worker assignment mapping");
for(const k of ["SUPABASE_URL","SUPABASE_SERVICE_ROLE_KEY","CRM_BUSINESS_ID","WORKER_EMAIL","KAPSO_WORKER_ASSIGNEE_ID"])
 if(!e[k])throw Error("Missing private config "+k);
const base=new URL(e.SUPABASE_URL);
if(base.protocol!=="https:"||!/^[a-z0-9-]+\.supabase\.co$/.test(base.hostname))throw Error("Invalid Supabase project URL");
const key=e.SUPABASE_SERVICE_ROLE_KEY;
const headers={apikey:key,Accept:"application/json",...(!key.startsWith("sb_secret_")?{Authorization:"Bearer "+key}:{})};
async function req(path,{method="GET",query={},body}={}){
 const url=new URL(path,base);
 for(const [k,v]of Object.entries(query))url.searchParams.set(k,String(v));
 const response=await fetch(url,{method,headers:{...headers,...(body?{"Content-Type":"application/json"}:{})},
  body:body?JSON.stringify(body):undefined,redirect:"error"});
 if(!response.ok)throw Error("Provider request refused: "+response.status);
 return response.status===204?null:response.json();
}
const users=await req("/auth/v1/admin/users",{query:{page:1,per_page:1000}});
const id=users?.users?.find(u=>u.email?.toLowerCase()===e.WORKER_EMAIL.toLowerCase())?.id;
if(!id)throw Error("Worker not found. Bootstrap users first.");
const members=await req("/rest/v1/crm_memberships",{query:{
 select:"role,active",business_id:"eq."+e.CRM_BUSINESS_ID,user_id:"eq."+id,limit:"1"}});
if(members?.[0]?.role!=="worker"||!members[0].active)throw Error("Membership not active worker");
await req("/rest/v1/crm_memberships",{method:"PATCH",query:{
 business_id:"eq."+e.CRM_BUSINESS_ID,user_id:"eq."+id
},body:{kapso_assignee_id:e.KAPSO_WORKER_ASSIGNEE_ID}});
console.log("Worker mapped to private Kapso assignee identifier in CRM membership.");
console.log("Inbox approval remains disabled until explicit isolation QA.");
