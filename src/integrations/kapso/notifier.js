/**
 * Sends a pre-approved WhatsApp UTILITY template to the worker after handoff.
 * Never sends outside an explicit opt-in worker process. No free-form text.
 * Delivery is at-least-once; reconciliation is needed after an uncertain outcome.
 */
const phone=/^\d{10,15}$/;
const name=/^[a-z][a-z0-9_]{0,127}$/;
export function handoffTemplateRequest({phoneNumberId,to,templateName,language="es_MX"}) {
  if(!phone.test(String(phoneNumberId)) || !phone.test(String(to)) || !name.test(String(templateName)))throw Error("Invalid Kapso notification configuration");
  if(!/^[a-z]{2}_[A-Z]{2}$/.test(language))throw Error("Invalid template language");
  return {
    url:"https://api.kapso.ai/meta/whatsapp/v24.0/"+phoneNumberId+"/messages",
    payload:{messaging_product:"whatsapp",recipient_type:"individual",to:String(to),type:"template",template:{name:templateName,language:{code:language}}}
  };
}
export async function sendHandoffNotification(config,{fetchFn=fetch}={}){
  if(!config.apiKey || config.apiKey.length<16)throw Error("Kapso API key not configured");
  const request=handoffTemplateRequest(config);
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),10000);
  try{
    const response=await fetchFn(request.url,{
      method:"POST",headers:{"Content-Type":"application/json","X-API-Key":config.apiKey},
      body:JSON.stringify(request.payload),redirect:"error",signal:controller.signal
    });
    if(!response.ok)throw Object.assign(new Error("Kapso notification rejected"),{status:response.status});
    const result=await response.json();
    const id=result?.messages?.[0]?.id;
    if(typeof id!=="string" || id.length<6)throw Error("Kapso response missing message ID");
    return {messageId:id};
  }finally{clearTimeout(timer);}
}
export async function drainHandoffOutbox(db,config,{fetchFn=fetch,max=20}={}){
  let sent=0,failed=0,queued=0;
  const pending=db.prepare(`SELECT idempotency_key FROM handoff_outbox
    WHERE state='pending' OR (state='sending' AND julianday('now')-julianday(updated_at)>5.0/1440)
    ORDER BY updated_at ASC LIMIT ?`).all(Math.max(1,Math.min(50,max)));
  for(const row of pending){
    const claimed=db.prepare(`UPDATE handoff_outbox SET state='sending',attempts=attempts+1,updated_at=CURRENT_TIMESTAMP
      WHERE idempotency_key=? AND (state='pending' OR (state='sending' AND julianday('now')-julianday(updated_at)>5.0/1440))`).run(row.idempotency_key);
    if(!claimed.changes)continue;
    try{
      const result=await sendHandoffNotification(config,{fetchFn});
      db.prepare("UPDATE handoff_outbox SET state='sent',provider_message_id=?,last_error_code=NULL,updated_at=CURRENT_TIMESTAMP WHERE idempotency_key=?")
        .run(result.messageId,row.idempotency_key);
      sent++;
    }catch(e){
      const current=db.prepare("SELECT attempts FROM handoff_outbox WHERE idempotency_key=?").get(row.idempotency_key);
      const nextState=current.attempts>=5?"failed":"pending";
      db.prepare("UPDATE handoff_outbox SET state=?,last_error_code=?,updated_at=CURRENT_TIMESTAMP WHERE idempotency_key=?")
        .run(nextState,String(e.status||"DELIVERY_UNKNOWN"),row.idempotency_key);
      failed++;
    }
  }
  queued=db.prepare("SELECT count(*) as count FROM handoff_outbox WHERE state='pending'").get().count;
  return {sent,failed,queued};
}
