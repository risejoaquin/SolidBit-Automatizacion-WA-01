/**
 * Local-only gate: no upload, telemetry or GitHub Actions.
 * Logs remain in the gitignored qa-private directory.
 */
import {spawnSync} from "node:child_process";
import {writeFileSync,mkdirSync} from "node:fs";

mkdirSync("qa-private",{recursive:true});
const checks=[
  {id:"ignore-env",title:"Private env ignored",cmd:"git",args:["check-ignore","-q",".env.local"]},
  {id:"ignore-db",title:"Local database ignored",cmd:"git",args:["check-ignore","-q","crm-kapso-local.sqlite"]},
  {id:"ignore-qa",title:"Private QA reports ignored",cmd:"git",args:["check-ignore","-q","qa-private/local-audit-summary.json"]},
  {id:"secrets",title:"Tracked secret scan",cmd:"npm",args:["run","security:scan"]},
  {id:"staged",title:"Staged secret scan",cmd:"npm",args:["run","security:staged"]},
  {id:"syntax",title:"Syntax",cmd:"npm",args:["run","lint:syntax"]},
  {id:"tests",title:"Unit and HTTP tests",cmd:"npm",args:["test"]}
];
const summary={version:2,generated_at:new Date().toISOString(),node:process.version,checks:[]};
for(const check of checks){
  const result=spawnSync(check.cmd,check.args,{encoding:"utf8",stdio:"pipe",shell:process.platform==="win32"});
  const status=result.status===0?"PASS":"FAIL";
  // Full diagnostics may contain local details; keep them out of Git.
  const logFile="qa-private/"+check.id+".log";
  writeFileSync(logFile,(result.stdout||"")+(result.stderr||""),"utf8");
  summary.checks.push({id:check.id,status,exit_code:result.status,local_log:logFile});
  console.log(check.title+": "+status);
}
writeFileSync("qa-private/local-audit-summary.json",JSON.stringify(summary,null,2));
if(summary.checks.some(c=>c.status==="FAIL")){
  console.error("Gate FAIL: inspect qa-private logs locally; redact before sharing any excerpt.");
  process.exitCode=1;
}else console.log("CODE QA PASS: external Kapso and Supabase integrations still require certified E2E.");
