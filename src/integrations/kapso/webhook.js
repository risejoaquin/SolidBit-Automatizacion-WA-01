import {createHmac,timingSafeEqual} from "node:crypto";

/** Official Kapso X-Webhook-Signature: hex HMAC-SHA256 over RAW bytes. */
export function verifyKapsoSignature(rawBody,signature,secret){
  if(!secret || typeof secret!=="string" || secret.length<16) return false;
  if(typeof signature!=="string" || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  if(!Buffer.isBuffer(rawBody)) return false;
  const expected=Buffer.from(createHmac("sha256",secret).update(rawBody).digest("hex"),"utf8");
  const supplied=Buffer.from(signature.toLowerCase(),"utf8");
  return expected.length===supplied.length && timingSafeEqual(expected,supplied);
}
const validId=value=>typeof value==="string" && value.length>=1 && value.length<=180 && !/[\r\n]/.test(value);
export function parseKapsoHandoff(rawBody,idempotencyKey,expectedProjectId){
  if(!validId(idempotencyKey))throw Object.assign(new Error("Missing idempotency key"),{status:400});
  if(!validId(expectedProjectId))throw Object.assign(new Error("Project configuration missing"),{status:503});
  let data;
  try{data=JSON.parse(rawBody.toString("utf8"));}catch{throw Object.assign(new Error("Invalid webhook JSON"),{status:400});}
  if(data?.event!=="workflow.execution.handoff" || data.channel!=="whatsapp")throw Object.assign(new Error("Not a handoff event"),{status:422});
  if(data.project_id!==expectedProjectId)throw Object.assign(new Error("Unexpected project"),{status:403});
  if(!validId(data.whatsapp_conversation_id) || !validId(data.workflow_execution_id))throw Object.assign(new Error("Invalid handoff payload"),{status:400});
  return {idempotencyKey,projectId:data.project_id,conversationId:data.whatsapp_conversation_id,
    executionId:data.workflow_execution_id,reason:String(data.handoff?.reason??"").slice(0,500)};
}
export function initHandoffStore(db){
  db.exec(`
    CREATE TABLE IF NOT EXISTS handoff_events(
      idempotency_key TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      workflow_execution_id TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS handoff_outbox(
      idempotency_key TEXT PRIMARY KEY REFERENCES handoff_events(idempotency_key),
      state TEXT NOT NULL CHECK(state IN ('pending','sending','sent','failed')) DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error_code TEXT,
      provider_message_id TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
}
export function recordHandoff(db,record){
  db.exec("BEGIN IMMEDIATE");
  try{
    const prior=db.prepare("SELECT project_id,conversation_id,workflow_execution_id FROM handoff_events WHERE idempotency_key=?").get(record.idempotencyKey);
    if(prior && (prior.project_id!==record.projectId || prior.conversation_id!==record.conversationId || prior.workflow_execution_id!==record.executionId)){
      throw Object.assign(new Error("Idempotency key reused with different handoff"),{status:409});
    }
    const inserted=db.prepare("INSERT OR IGNORE INTO handoff_events(idempotency_key,project_id,conversation_id,workflow_execution_id,reason) VALUES (?,?,?,?,?)")
      .run(record.idempotencyKey,record.projectId,record.conversationId,record.executionId,record.reason);
    if(inserted.changes){
      db.prepare("INSERT INTO handoff_outbox(idempotency_key) VALUES (?)").run(record.idempotencyKey);
    }
    db.exec("COMMIT");
    return {recorded:inserted.changes===1,duplicate:inserted.changes===0};
  }catch(error){db.exec("ROLLBACK");throw error;}
}
