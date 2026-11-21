import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {initHandoffStore,recordHandoff} from "../src/integrations/kapso/webhook.js";
import {handoffTemplateRequest,drainHandoffOutbox} from "../src/integrations/kapso/notifier.js";
test("notification uses approved template shape, not free-form text",()=>{
  const request=handoffTemplateRequest({phoneNumberId:"123456789012345",to:"5216221234567",templateName:"handoff_alert"});
  assert.equal(request.payload.type,"template");
  assert.equal(request.payload.template.name,"handoff_alert");
  assert.equal(request.payload.text,undefined);
  assert.throws(()=>handoffTemplateRequest({phoneNumberId:"bad",to:"5216221234567",templateName:"handoff_alert"}));
});
test("handoff outbox sends only once in normal delivery path",async()=>{
  const db=new DatabaseSync(":memory:");
  try{
    db.exec("PRAGMA foreign_keys=ON;");
    initHandoffStore(db);
    recordHandoff(db,{idempotencyKey:"event-one",projectId:"project",conversationId:"conv",executionId:"exec",reason:"required"});
    const cfg={apiKey:"TEST_TOKEN_IS_NOT_VALID",phoneNumberId:"123456789012345",to:"5216221234567",templateName:"handoff_alert"};
    let sends=0;
    const fake=async(_url,_opts)=>{sends++;return {ok:true,json:async()=>({messages:[{id:"wamid.test-id"}]})};};
    const first=await drainHandoffOutbox(db,cfg,{fetchFn:fake});
    const second=await drainHandoffOutbox(db,cfg,{fetchFn:fake});
    assert.equal(first.sent,1);assert.equal(second.sent,0);assert.equal(sends,1);
    assert.equal(db.prepare("SELECT state FROM handoff_outbox").get().state,"sent");
  }finally{db.close();}
});
