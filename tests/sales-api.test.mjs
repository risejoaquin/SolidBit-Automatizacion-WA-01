import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import path from "node:path";
import os from "node:os";
import {randomBytes} from "node:crypto";
import {createLocalApp} from "../src/local/server.js";

test("owner can simulate confirmed sale/reversal, worker cannot, default stays off",async()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),"crm-kapso-sales-"));
  const ownerPassword=randomBytes(24).toString("hex");
  const workerPassword=randomBytes(24).toString("hex");
  const app=createLocalApp({
    dbPath:path.join(dir,"sales.sqlite"),ownerEmail:"owner@local.test",ownerPassword,
    workerEmail:"worker@local.test",workerPassword,enableOrderSimulation:true
  });
  await new Promise(resolve=>app.server.listen(0,"127.0.0.1",resolve));
  const base="http://127.0.0.1:"+app.server.address().port;
  async function request(pathname,method="GET",data,cookie){
    const response=await fetch(base+pathname,{
      method,
      headers:{...(data?{"content-type":"application/json"}:{}),...(cookie?{Cookie:cookie}:{})},
      body:data?JSON.stringify(data):undefined
    });
    return {code:response.status,payload:await response.json(),cookie:response.headers.get("set-cookie")?.split(";")[0]};
  }
  try {
    const owner=(await request("/api/login","POST",{email:"owner@local.test",password:ownerPassword})).cookie;
    const worker=(await request("/api/login","POST",{email:"worker@local.test",password:workerPassword})).cookie;
    const product=await request("/api/inventory","POST",{sku:"FOO",name:"Generic inventory",quantity:10,minimum:4},owner);
    assert.equal(product.code,201);
    const record={action:"apply",source:"kapso",eventId:"evt-1",items:[{sku:"FOO",quantity:7}]};
    assert.equal((await request("/api/qa/orders","POST",record,worker)).code,403);
    assert.equal((await request("/api/qa/orders","POST",record,owner)).payload.applied,true);
    assert.equal((await request("/api/qa/orders","POST",record,owner)).payload.duplicate,true);
    const low=await request("/api/inventory","GET",undefined,owner);
    assert.equal(low.payload.products[0].quantity,3);
    assert.equal(low.payload.lowStock.length,1);
    const edit=await request("/api/inventory/"+product.payload.id,"PATCH",{name:"Generic inventory updated",minimum:2},owner);
    assert.equal(edit.code,200);
    assert.equal((await request("/api/inventory/"+product.payload.id,"PATCH",{name:"X",minimum:0},worker)).code,403);
    const reverse=await request("/api/qa/orders","POST",{action:"reverse",source:"kapso",eventId:"evt-1"},owner);
    assert.equal(reverse.payload.reversed,true);
    assert.equal((await request("/api/inventory","GET",undefined,owner)).payload.products[0].quantity,10);
    const status=await request("/api/handoff","GET",undefined,worker);
    assert.equal(status.code,200);assert.equal(status.payload.status,"pending_integration");
  }finally{
    await app.close();rmSync(dir,{recursive:true,force:true});
  }
});
