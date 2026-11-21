import {spawnSync} from "node:child_process";
function git(args) {
  const proc=spawnSync("git",args,{encoding:"utf8"});
  if(proc.status!==0) throw Error("git listing failed");
  return proc.stdout;
}
const files=git(["ls-files","-z"]).split("\0").filter(x=>/\.(?:mjs|js)$/.test(x));
let failed=0;
for(const file of files){
  const result=spawnSync(process.execPath,["--check",file],{stdio:"pipe",encoding:"utf8"});
  if(result.status!==0){
    failed++;
    console.error("Syntax FAIL: "+file);
  }
}
console.log("Syntax audit: "+(files.length-failed)+"/"+files.length+" PASS");
if(failed)process.exitCode=1;
