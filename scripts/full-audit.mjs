/**
 * Release candidate gate: one single command, no GitHub Actions.
 * All output is sanitized; full logs stay in qa-private and out of Git.
 */
import {spawnSync} from "node:child_process";
import {mkdirSync,writeFileSync} from "node:fs";
const steps=[
 ["offline","audit:local"],
 ["config","doctor:remote"],
 ["rls","security:rls"],
 ["http","qa:remote-http"]
];
mkdirSync("qa-private",{recursive:true});
const report={timestamp:new Date().toISOString(),node:process.version,checks:[]};
for(const [id,name]of steps){
 const r=spawnSync("npm",["run",name],{encoding:"utf8",shell:process.platform==="win32",stdio:"pipe"});
 const status=r.status===0?"PASS":"FAIL";
 report.checks.push({id,name,status,exit_code:r.status});
 writeFileSync("qa-private/gate-"+id+".log",(r.stdout||"")+(r.stderr||""),"utf8");
 console.log(name+": "+status);
}
writeFileSync("qa-private/FINAL_CRM_GATE.json",JSON.stringify(report,null,2)+"\n");
if(report.checks.some(x=>x.status==="FAIL")){
 console.error("QA gate blocked. Open qa-private files only on your machine; redact before sharing.");
 process.exitCode=1;
}else console.log("CRM LOCAL+REMOTE CODE GATE PASS; real Kapso messaging and production security still need E2E.");
