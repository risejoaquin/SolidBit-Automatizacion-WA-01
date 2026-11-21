import test from "node:test";
import assert from "node:assert/strict";
import {createRemoteApp} from "../src/remote/server.js";

const businessId="11111111-1111-4111-8111-111111111111";
const userId="22222222-2222-4222-8222-222222222222";
function fixture(role="owner"){
 const requests=[];
 const fakeFetch=async(input,options)=>{
  const u=new URL(input),endpoint=u.pathname;
  requests.push({endpoint,method:options.method||"GET",headers:options.headers});
  let payload=[];
  if(endpoint==="/auth/v1/token")payload={access_token:["mock","tok"].join("-"),refresh_token:["mock","ref"].join("-"),expires_in:3600,user:{id:userId}};
  else if(endpoint.endsWith("/crm_memberships"))payload=[{business_id:businessId,user_id:userId,role,active:true,kapso_assignee_id:null}];
  else if(endpoint.endsWith("/crm_order_sources"))payload=[{business_id:businessId,enabled:true}];
  else if(endpoint.endsWith("/crm_inventory"))payload=[];
  else if(endpoint.endsWith("/crm_stock_movements"))payload=[];
  else if(endpoint.endsWith("/crm_alerts"))payload=[];
  else if(endpoint.endsWith("/orders"))payload=[{id:"order-id",items:[],total_cents:1000,order_status:"confirmed",payment_status:"pending"}];
  else if(endpoint.endsWith("/menu_products"))payload=[{sku:"A",name:"QA",price_cents:500,active:true,category:"Test"}];
  else if(endpoint.endsWith("/menu_modifiers"))payload=[];
  else throw Error("Unexpected fetch in test: "+endpoint);
  return {ok:true,status:200,json:async()=>payload};
 };
 const app=createRemoteApp({
  supabaseUrl:"https://example.supabase.co",
  publishableKey:"TEST_PUBLISHABLE_NOT_REAL",
  serviceKey:"TEST_SERVICE_ROLE_NOT_REAL",
  businessId
 },{fetchFn:fakeFetch});
 return {app,requests};
}
async function fetchLocal(base,path,options){return fetch(base+path,options);}
async function run(role,check){
 const {app,requests}=fixture(role);
 await new Promise(resolve=>app.server.listen(0,"127.0.0.1",resolve));
 const base="http://127.0.0.1:"+app.server.address().port;
 try{
  const noAuth=await fetchLocal(base,"/api/orders");
  assert.equal(noAuth.status,401);
  const login=await fetchLocal(base,"/api/login",{
   method:"POST",headers:{"Content-Type":"application/json"},
   body:JSON.stringify({email:"qa@example.test",password:["mock","pwd"].join("-")})
  });
  assert.equal(login.status,200);
  const cookie=login.headers.get("set-cookie");
  assert.match(cookie,/HttpOnly/);
  await check({base,cookie:cookie.split(";")[0],requests});
 }finally{await app.close();}
}
test("owner can read legacy menu and orders without exposing service key",()=>run("owner",async({base,cookie,requests})=>{
 const opts={headers:{Cookie:cookie}};
 const order=await fetchLocal(base,"/api/orders",opts);
 assert.equal(order.status,200);
 assert.equal((await order.json()).orders.length,1);
 const menu=await fetchLocal(base,"/api/menu",opts);
 assert.equal(menu.status,200);
 assert.equal((await menu.json()).products[0].sku,"A");
 assert.ok(requests.some(r=>r.endpoint.endsWith("/orders")&&r.headers.apikey==="TEST_SERVICE_ROLE_NOT_REAL"));
 const me=await fetchLocal(base,"/api/me",opts);
 assert.equal((await me.json()).role,"owner");
 assert.equal(JSON.stringify(await (await fetchLocal(base,"/",opts)).text()).includes("TEST_SERVICE_ROLE_NOT_REAL"),false);
}));
test("worker cannot read any inventory, menu, orders or alerts",()=>run("worker",async({base,cookie})=>{
 const opts={headers:{Cookie:cookie}};
 for(const path of ["/api/orders","/api/menu","/api/inventory","/api/alerts","/api/movements"])
  assert.equal((await fetchLocal(base,path,opts)).status,403);
 const chat=await fetchLocal(base,"/api/handoff",opts);
 assert.equal(chat.status,200);
 assert.equal((await chat.json()).status,"pending_integration");
}));
test("cross-origin writes to login rejected",async()=>{
 const {app}=fixture();
 await new Promise(resolve=>app.server.listen(0,"127.0.0.1",resolve));
 try{
  const res=await fetch("http://127.0.0.1:"+app.server.address().port+"/api/login",{
   method:"POST",headers:{"content-type":"application/json",origin:"https://malicious.example"},
   body:JSON.stringify({email:"qa@example.test",password:["mock","pwd"].join("-")})
  });
  assert.equal(res.status,403);
 }finally{await app.close();}
});
