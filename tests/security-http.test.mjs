import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import path from "node:path";
import os from "node:os";
import {randomBytes} from "node:crypto";
import {createLocalApp} from "../src/local/server.js";

test("security: failed login, throttling, origin, HttpOnly cookie, authorization",async()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),"crm-sec-"));
  const password=randomBytes(24).toString("hex");
  const app=createLocalApp({
    dbPath:path.join(dir,"security.sqlite"),
    ownerEmail:"owner@qa.test",ownerPassword:password,
    workerEmail:"worker@qa.test",workerPassword:randomBytes(24).toString("hex")
  });
  await new Promise(resolve=>app.server.listen(0,"127.0.0.1",resolve));
  const base="http://127.0.0.1:"+app.server.address().port;
  const login=(pass,origin)=>fetch(base+"/api/login",{
    method:"POST",
    headers:{"Content-Type":"application/json",...(origin?{Origin:origin}:{})},
    body:JSON.stringify({email:"owner@qa.test",password:pass})
  });
  try{
    assert.equal((await login(password,"https://malicious.example")).status,403);
    assert.equal((await fetch(base+"/api/inventory")).status,401);
    for(let i=0;i<5;i++) assert.equal((await login("incorrect")).status,401);
    assert.equal((await login(password)).status,429);
    const res=await fetch(base+"/");
    assert.equal(res.status,200);
    assert.match(res.headers.get("content-security-policy"),/script-src 'self'/);
    assert.match(await res.text(),/login-form/);
  }finally{
    await app.close();rmSync(dir,{recursive:true,force:true});
  }
});
test("security: owner session uses HttpOnly cookie and endpoint requires owner",async()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),"crm-sec-"));
  const password=randomBytes(24).toString("hex");
  const app=createLocalApp({
    dbPath:path.join(dir,"security.sqlite"),
    ownerEmail:"owner@qa.test",ownerPassword:password,
    workerEmail:"worker@qa.test",workerPassword:randomBytes(24).toString("hex")
  });
  await new Promise(resolve=>app.server.listen(0,"127.0.0.1",resolve));
  const base="http://127.0.0.1:"+app.server.address().port;
  try{
    const res=await fetch(base+"/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:"owner@qa.test",password})});
    assert.equal(res.status,200);
    const cookie=res.headers.get("set-cookie");
    assert.match(cookie,/HttpOnly/);
    assert.match(cookie,/SameSite=Strict/);
    assert.equal((await fetch(base+"/api/inventory",{headers:{Cookie:cookie.split(";")[0]}})).status,200);
  }finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});
