import test from "node:test";
import assert from "node:assert/strict";
import {resolveInboxEmbed} from "../src/integrations/kapso/embed.js";
test("Kapso embeds reject untrusted origins, protocols and paths",()=>{
  for(const url of [
    "http://inbox.kapso.ai/embed/token",
    "https://evilkapso.ai/embed/token",
    "javascript:alert(1)",
    "https://user:password@inbox.kapso.ai/embed/token",
    "https://app.kapso.ai/embed/token",
    "https://inbox.kapso.ai/admin"
  ])assert.equal(resolveInboxEmbed("owner",{ownerEmbedUrl:url}).available,false);
  assert.equal(resolveInboxEmbed("owner",{ownerEmbedUrl:"https://inbox.kapso.ai/embed/owner-token"}).available,true);
});
test("worker needs verified assignee token, and handoff filter is applied",()=>{
  const config={ownerEmbedUrl:"https://inbox.kapso.ai/embed/owner-token",workerEmbedUrl:"https://inbox.kapso.ai/embed/worker-token"};
  assert.equal(resolveInboxEmbed("worker",config).available,false);
  assert.equal(resolveInboxEmbed("worker",{...config,workerApproved:true}).available,false);
  const result=resolveInboxEmbed("worker",{...config,workerApproved:true,workerAssigneeId:"assigned-user-uuid"});
  assert.equal(result.available,true);
  assert.equal(new URL(result.url).searchParams.get("handoff"),"1");
  assert.equal(new URL(result.url).searchParams.get("status"),"active");
  assert.equal(resolveInboxEmbed("admin",config).available,false);
});
