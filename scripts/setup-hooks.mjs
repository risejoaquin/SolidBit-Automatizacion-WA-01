import {spawnSync} from "node:child_process";
import {chmodSync} from "node:fs";
const configured=spawnSync("git",["config","--local","core.hooksPath",".githooks"],{encoding:"utf8"});
if(configured.status!==0)throw Error("Git hooks configuration failed");
try{chmodSync(".githooks/pre-commit",0o755);}catch{
  console.warn("Hook chmod unavailable on this filesystem. Always run npm run security:staged manually before pushes.");
}
console.log("Local pre-commit security hook configured.");
