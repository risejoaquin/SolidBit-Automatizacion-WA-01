import test from "node:test";
import assert from "node:assert/strict";
import {buildOrdersUrl,normalizeRemoteOrder,readOrders} from "../src/integrations/supabase/order-reader.js";
const uuid="a121e1c3-7f0a-49de-9c31-45e9e302c100";
const row={id:uuid,order_status:"confirmed",payment_method:"cash",payment_status:"pending",items:[{sku:"FOO",quantity:2}]};
test("reader only accepts HTTPS project URL",()=>{
  assert.match(buildOrdersUrl("https://example.supabase.co"),/rest\/v1\/orders/);
  assert.throws(()=>buildOrdersUrl("http://example.supabase.co"),/Only verified/);
  assert.throws(()=>buildOrdersUrl("https://evil.com"),/Only verified/);
  assert.throws(()=>buildOrdersUrl("https://example.supabase.co","orders;DROP TABLE"),/Invalid/);
});
test("order policy is explicit and deterministic",()=>{
  assert.equal(normalizeRemoteOrder(row).action,"apply");
  assert.equal(normalizeRemoteOrder({...row,payment_method:"transfer",payment_status:"pending"}),null);
  assert.equal(normalizeRemoteOrder({...row,order_status:"cancelled"}).action,"reverse");
  assert.equal(normalizeRemoteOrder({...row,order_status:"received"}),null);
  assert.throws(()=>normalizeRemoteOrder({...row,items:[{name:"No SKU",quantity:2}]}),/Unrecognized/);
});
test("read only GET with server-side credentials and no redirect",async()=>{
  let args;
  const data=await readOrders({url:buildOrdersUrl("https://example.supabase.co"),apiKey:"EXAMPLE_TEST_TOKEN_NOT_REAL",fetchFn:async(u,opts)=>{
    args={u,opts};return {ok:true,status:200,json:async()=>[row]};
  }});
  assert.equal(args.opts.method,"GET");
  assert.equal(args.opts.redirect,"error");
  assert.equal(data.length,1);
});
