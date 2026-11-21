import test from "node:test";
import assert from "node:assert/strict";
import {randomBytes,createHmac} from "node:crypto";
import {mkdtempSync,rmSync} from "node:fs";
import path from "node:path";
import os from "node:os";
import {createLocalApp} from "../src/local/server.js";

test("Kapso HTTP webhook rejects forgery and persists one handoff",async()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),"crm-webhook-"));
  const secret=randomBytes(32).toString("hex");
  const app=createLocalApp({
    dbPath:path.join(dir,"db.sqlite"),
    ownerEmail:"owner@qa.test",ownerPassword:randomBytes(24).toString("hex"),
    workerEmail:"worker@qa.test",workerPassword:randomBytes(24).toString("hex"),
    kapsoWebhookSecret:secret,kapsoProjectId:"project-test"
  });
  await new Promise(resolve=>app.server.listen(0,"127.0.0.1",resolve));
  const base="http://127.0.0.1:"+app.server.address().port;
  const raw=Buffer.from(JSON.stringify({
    event:"workflow.execution.handoff",project_id:"project-test",channel:"whatsapp",
    workflow_execution_id:"exec-test",whatsapp_conversation_id:"conversation-test"
  }));
  const signature=createHmac("sha256",secret).update(raw).digest("hex");
  const send=async(sig,key,body=raw)=>{
    const res=await fetch(base+"/webhooks/kapso/handoff",{
      method:"POST",headers:{"Content-Type":"application/json","X-Webhook-Signature":sig,"X-Idempotency-Key":key},
      body
    });
    return {status:res.status,payload:await res.json()};
  };
  try{
    assert.equal((await send("invalid","event-1")).status,401);
    const first=await send(signature,"event-1");
    assert.equal(first.status,200);assert.equal(first.payload.recorded,true);
    const again=await send(signature,"event-1");
    assert.equal(again.status,200);assert.equal(again.payload.duplicate,true);
    assert.equal(app.db.prepare("SELECT count(*) as n FROM handoff_events").get().n,1);
    assert.equal(app.db.prepare("SELECT count(*) as n FROM handoff_outbox").get().n,1);
    const wrong=Buffer.from(raw.toString().replace("project-test","other-project"));
    const wrongSig=createHmac("sha256",secret).update(wrong).digest("hex");
    assert.equal((await send(wrongSig,"event-2",wrong)).status,403);
  }finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});
