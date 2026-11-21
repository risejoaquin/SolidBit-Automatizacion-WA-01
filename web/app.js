const $=id=>document.getElementById(id);
const message=text=>$("message").textContent=text||"";
const api=async(path,method="GET",payload)=>{
  const response=await fetch(path,{method,credentials:"same-origin",headers:payload?{"Content-Type":"application/json"}:{},body:payload?JSON.stringify(payload):undefined});
  const data=await response.json();if(!response.ok)throw Error(data.error||"Error");
  return data;
};
let currentRole=null;
function view(which){
  $("inventory-view").hidden=which!=="inventory";$("handoff-view").hidden=which!=="handoff";
}
async function refreshInventory(){
  const data=await api("/api/inventory");
  $("stock-alerts").replaceChildren();
  if(data.lowStock.length){const warning=document.createElement("div");warning.className="warning";warning.textContent="Stock bajo: "+data.lowStock.map(p=>p.name).join(", ");$("stock-alerts").append(warning);}
  const host=$("products");host.replaceChildren();
  for(const p of data.products){
    const row=document.createElement("div");row.className="row";
    const name=document.createElement("strong");name.textContent=p.name+" · "+p.sku;
    const amount=document.createElement("span");amount.textContent="Existencia: "+p.quantity+" | Mínimo: "+p.minimum;
    const adjust=document.createElement("button");adjust.textContent="Ajustar stock";
    adjust.onclick=async()=>{
      const deltaRaw=prompt("Movimiento de stock (+10 o -2):");if(deltaRaw===null)return;
      const delta=Number(deltaRaw);const reason=prompt("Motivo del ajuste:");if(reason===null)return;
      try{await api("/api/inventory/"+p.id+"/adjust","POST",{delta,reason});await refreshInventory();message("");}catch(e){message(e.message);}
    };
    const edit=document.createElement("button");
    edit.textContent="Editar mínimo";
    edit.onclick=async()=>{
      const minimumRaw=prompt("Nuevo stock mínimo:",String(p.minimum));
      if(minimumRaw===null)return;
      const minimum=Number(minimumRaw);
      try{await api("/api/inventory/"+p.id,"PATCH",{name:p.name,minimum});await refreshInventory();message("");}catch(e){message(e.message);}
    };
    row.append(name,amount,adjust,edit);host.append(row);
  }
}
async function refreshHandoff(){
  const data=await api("/api/handoff");
  $("handoff-status").textContent=data.message||"Bandeja integrada de Kapso";
  const view=$("handoff-view");
  const existing=view.querySelector("iframe");
  if(existing)existing.remove();
  const placeholder=view.querySelector(".placeholder");
  placeholder.hidden=data.status==="ready";
  if(data.status==="ready"){
    const frame=document.createElement("iframe");
    frame.title="Bandeja de atención Kapso";
    frame.src=data.embed_url;
    frame.referrerPolicy="no-referrer";
    frame.setAttribute("allow","clipboard-write");
    frame.className="kapso-frame";
    view.append(frame);
  }
}
async function refreshSession(){
  try{
    const user=await api("/api/me");currentRole=user.role;
    $("login-panel").hidden=true;$("dashboard").hidden=false;$("user").textContent=user.email+" · "+user.role;
    $("nav-inventory").hidden=user.role!=="owner";
    if(user.role==="owner"){view("inventory");await refreshInventory();}else{view("handoff");await refreshHandoff();}
  }catch{$("login-panel").hidden=false;$("dashboard").hidden=true;currentRole=null;}
}
$("login-form").onsubmit=async e=>{
  e.preventDefault();const f=new FormData(e.target);try{await api("/api/login","POST",{email:f.get("email"),password:f.get("password")});message("");await refreshSession();}catch(err){message(err.message);}
};
$("product-form").onsubmit=async e=>{
  e.preventDefault();const f=new FormData(e.target);
  try{await api("/api/inventory","POST",{sku:f.get("sku"),name:f.get("name"),quantity:Number(f.get("quantity")),minimum:Number(f.get("minimum"))});e.target.reset();message("");await refreshInventory();}catch(err){message(err.message);}
};
$("nav-inventory").onclick=async()=>{if(currentRole==="owner"){view("inventory");await refreshInventory();}};
$("nav-handoff").onclick=async()=>{view("handoff");await refreshHandoff();};
$("logout").onclick=async()=>{await api("/api/logout","POST");message("");await refreshSession();};
refreshSession();
setInterval(()=>{
  if(currentRole==="owner" && !$("inventory-view").hidden){
    refreshInventory().catch(error=>message(error.message));
  }
},30000);
