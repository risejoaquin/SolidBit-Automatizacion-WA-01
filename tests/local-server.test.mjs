import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import {createLocalApp} from "../src/local/server.js";
test("local login roles, stock, logout and no worker access", async () => {
  const dir=mkdtempSync(path.join(os.tmpdir(),"crm-kapso-test-"));
  const ownerPassword=randomBytes(24).toString("hex"),workerPassword=randomBytes(24).toString("hex");
  const app=createLocalApp({dbPath:path.join(dir,"test.sqlite"),ownerEmail:"owner@example.test",ownerPassword,workerEmail:"worker@example.test",workerPassword});
  await new Promise(resolve=>app.server.listen(0,"127.0.0.1",resolve));
  const base="http://127.0.0.1:"+app.server.address().port;
  let ownerCookie="",workerCookie="";
  const request=async(url,method="GET",data,as="owner")=>{
    const response=await fetch(base+url,{method,headers:{...(data?{"content-type":"application/json"}:{}),...(as==="owner"&&ownerCookie?{Cookie:ownerCookie}:{}),...(as==="worker"&&workerCookie?{Cookie:workerCookie}:{})},body:data?JSON.stringify(data):undefined});
    return {status:response.status,data:await response.json(),cookie:response.headers.get("set-cookie")};
  };
  try {
    assert.equal((await request("/api/inventory")).status,401);
    let res=await request("/api/login","POST",{email:"owner@example.test",password:ownerPassword});
    assert.equal(res.status,200);ownerCookie=res.cookie.split(";")[0];
    res=await request("/api/login","POST",{email:"worker@example.test",password:workerPassword});
    assert.equal(res.status,200);workerCookie=res.cookie.split(";")[0];
    assert.equal((await request("/api/inventory","GET",undefined,"worker")).status,403);
    assert.equal((await request("/api/handoff","GET",undefined,"worker")).status,200);
    res=await request("/api/inventory","POST",{sku:"TEST-1",name:"Producto QA",quantity:10,minimum:3});
    assert.equal(res.status,201);
    const id=res.data.id;
    assert.equal((await request("/api/inventory/"+id+"/adjust","POST",{delta:-8,reason:"venta QA"})).status,200);
    res=await request("/api/inventory");
    assert.equal(res.data.products[0].quantity,2);
    assert.equal(res.data.lowStock.length,1);
    assert.equal((await request("/api/inventory/"+id+"/adjust","POST",{delta:-3,reason:"error QA"})).status,409);
    assert.equal((await request("/api/logout","POST")).status,200);
    assert.equal((await request("/api/inventory")).status,401);
  } finally {await app.close();rmSync(dir,{recursive:true,force:true});}
});
