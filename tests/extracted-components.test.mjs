import test from "node:test";
import assert from "node:assert/strict";
import { ROLES, PERMISSIONS, hasPermission, getLandingRoute, visibleNavigation } from "../src/core/roles.js";
import { escapeHtml, initials, formatNumber, formatQuantity } from "../src/core/presentation.js";
import { requirePermission } from "../src/modules/auth/authorization.js";

test("worker only sees delegated chat", () => {
  assert.deepEqual(visibleNavigation(ROLES.WORKER).map(x => x.path), ["/handoff"]);
  assert.equal(hasPermission("worker", PERMISSIONS.EDIT_INVENTORY), false);
  assert.equal(hasPermission("worker", PERMISSIONS.REPLY_HANDOFF), true);
  assert.equal(getLandingRoute("worker"), "/handoff");
});
test("owner sees both sections", () => {
  assert.deepEqual(visibleNavigation(ROLES.OWNER).map(x => x.path), ["/inventory", "/handoff"]);
  assert.equal(hasPermission("owner", PERMISSIONS.EDIT_INVENTORY), true);
  assert.equal(getLandingRoute("owner"), "/inventory");
});
test("unknown roles fail closed", () => {
  assert.deepEqual(visibleNavigation("admin"), []);
  assert.equal(hasPermission(null, PERMISSIONS.VIEW_HANDOFF), false);
  assert.equal(getLandingRoute("admin"), "/login");
});
test("presentation helpers escape untrusted text and format safely", () => {
  assert.equal(escapeHtml("<script>&'\""), "&lt;script&gt;&amp;&#39;&quot;");
  assert.equal(initials("Ana López"), "AL");
  assert.equal(formatNumber(null), "—");
  assert.equal(formatQuantity(2.5), "2.5");
});
test("HTTP guard rejects absent auth and worker inventory writes", () => {
  const guard = requirePermission(PERMISSIONS.EDIT_INVENTORY);
  const response = () => ({ statusCode:null, status(n){this.statusCode=n;return this;}, json(body){this.body=body;return this;} });
  let nextCalled = false;
  let res = response();
  guard({auth:null},res,()=>{nextCalled=true;});
  assert.equal(res.statusCode,401);
  res=response();
  guard({auth:{userId:"u",tenantId:"t",role:"worker"}},res,()=>{nextCalled=true;});
  assert.equal(res.statusCode,403);
  assert.equal(nextCalled,false);
  res=response();
  guard({auth:{userId:"u",tenantId:"t",role:"owner"}},res,()=>{nextCalled=true;});
  assert.equal(nextCalled,true);
});
