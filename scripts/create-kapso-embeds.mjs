/**
 * One-time Kapso embed provisioning from local private credentials.
 * Never prints API keys or embed tokens. Requires explicit invocation.
 */
import {readFileSync,writeFileSync,renameSync,existsSync} from "node:fs";
import {randomBytes} from "node:crypto";
const env=process.env;
const file=".env.local";
if(!existsSync(file))throw Error("Run npm run setup:local first; .env.local missing");
if(!env.KAPSO_API_KEY || !/^\d{10,20}$/.test(env.KAPSO_PHONE_NUMBER_ID||"")) {
  throw Error("Configure KAPSO_API_KEY and KAPSO_PHONE_NUMBER_ID in your private .env.local");
}
const origin=env.KAPSO_EMBED_ALLOWED_ORIGIN||"http://127.0.0.1:3400";
let parsed;
try{parsed=new URL(origin);}catch{throw Error("Invalid embedding origin");}
if(!["https:","http:"].includes(parsed.protocol) || (parsed.protocol==="http:" && !["127.0.0.1","localhost"].includes(parsed.hostname))) {
  throw Error("Embeds require HTTPS or loopback origin");
}
if(parsed.origin!==origin)throw Error("Set allowed origin without path or trailing slash");

const current=readFileSync(file,"utf8");
async function createEmbed(name,assigneeId){
  const payload={inbox_embed:{
    name,scope_type:"phone_number",scope_id:env.KAPSO_PHONE_NUMBER_ID,
    allowed_origins:[origin],default_mode:"system",language:"es",
    ...(assigneeId?{assigned_user_id:assigneeId}:{})
  }};
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),10000);
  try{
    const response=await fetch("https://api.kapso.ai/platform/v1/inbox_embeds",{
      method:"POST",headers:{"X-API-Key":env.KAPSO_API_KEY,"Content-Type":"application/json"},
      body:JSON.stringify(payload),redirect:"error",signal:controller.signal
    });
    if(!response.ok)throw Error("Kapso embed creation failed with status "+response.status);
    const data=await response.json();
    const url=data?.data?.embed_url??data?.inbox_embed?.embed_url??data?.embed_url;
    const parsedUrl=new URL(url);
    if(parsedUrl.protocol!=="https:"||parsedUrl.hostname!=="inbox.kapso.ai"||!parsedUrl.pathname.startsWith("/embed/"))throw Error("Unexpected embed origin");
    return parsedUrl.toString();
  }finally{clearTimeout(timer);}
}
function setVars(source,values){
  let lines=source.replace(/\r\n/g,"\n").split("\n");
  for(const [key,value] of Object.entries(values)){
    if(/[\r\n]/.test(value))throw Error("Unexpected newline in embed URL");
    const index=lines.findIndex(line=>line.startsWith(key+"="));
    if(index<0)lines.push(key+"="+value);
    else lines[index]=key+"="+value;
  }
  return lines.join("\n").replace(/\n*$/,"\n");
}
function existingValue(key){
  const line=readFileSync(file,"utf8").split(/\r?\n/).find(x=>x.startsWith(key+"="));
  return line?.slice(key.length+1).trim()||null;
}
function persist(values){
  const latest=readFileSync(file,"utf8");
  const temp=file+"."+randomBytes(8).toString("hex")+".tmp";
  try{
    writeFileSync(temp,setVars(latest,values),{encoding:"utf8",flag:"wx",mode:0o600});
    renameSync(temp,file);
  }catch(e){throw Error("Failed to update private env file: "+(e.code||"WRITE_ERROR"));}
}
if(!existingValue("KAPSO_OWNER_EMBED_URL")){
  const ownerUrl=await createEmbed("CRM owner inbox");
  persist({KAPSO_OWNER_EMBED_URL:ownerUrl});
}
if(env.KAPSO_WORKER_ASSIGNEE_ID && !existingValue("KAPSO_WORKER_EMBED_URL")){
  const workerUrl=await createEmbed("CRM worker handoffs",env.KAPSO_WORKER_ASSIGNEE_ID);
  persist({KAPSO_WORKER_EMBED_URL:workerUrl,KAPSO_WORKER_EMBED_APPROVED:"false"});
}
console.log("Private inbox URLs stored locally, existing embed URLs preserved.");
console.log("Worker inbox remains locked until assigned_user_id access is verified.");
