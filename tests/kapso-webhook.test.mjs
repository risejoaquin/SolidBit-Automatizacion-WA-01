import test from "node:test";
import assert from "node:assert/strict";
import {createHmac} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {verifyKapsoSignature,parseKapsoHandoff,initHandoffStore,recordHandoff} from "../src/integrations/kapso/webhook.js";

const secret = ["test", "only", "a".repeat(32)].join("-");
const raw=Buffer.from(JSON.stringify({
  event:"workflow.execution.handoff",
  project_id:"project-1",channel:"whatsapp",
  workflow_execution_id:"execution-1",
  whatsapp_conversation_id:"conversation-1",
  handoff:{reason:"Human needed"}
}));
test("signed HMAC must match the exact raw payload",()=>{
  const signature=createHmac("sha256",secret).update(raw).digest("hex");
  assert.equal(verifyKapsoSignature(raw,signature,secret),true);
  assert.equal(verifyKapsoSignature(Buffer.from(raw.toString()+" "),signature,secret),false);
  assert.equal(verifyKapsoSignature(raw,"wrong",secret),false);
  assert.equal(verifyKapsoSignature(raw,signature,undefined),false);
});
test("handoff records are durable and idempotent",()=>{
  const data=parseKapsoHandoff(raw,"handoff-key-1","project-1");
  assert.throws(()=>parseKapsoHandoff(raw,"handoff-key-1","other"),/Unexpected project/);
  const db=new DatabaseSync(":memory:");
  try{
    db.exec("PRAGMA foreign_keys=ON;");
    initHandoffStore(db);
    assert.equal(recordHandoff(db,data).recorded,true);
    assert.equal(recordHandoff(db,data).duplicate,true);
    assert.equal(db.prepare("SELECT count(*) AS c FROM handoff_events").get().c,1);
    assert.equal(db.prepare("SELECT count(*) AS c FROM handoff_outbox").get().c,1);
  }finally{db.close();}
});
