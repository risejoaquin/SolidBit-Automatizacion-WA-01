import { readFileSync } from "fs";

const env = {};
readFileSync(".env.local", "utf8").split("\n").forEach(l => {
  const i = l.indexOf("=");
  if (i > 0) env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^['"]|['"]$/g, "");
});

const businessId = env.CRM_BUSINESS_ID || "1c2238f8-863a-4e33-8b5b-5b5e4683e190";
const orderId = "6d09ab26-dcc3-4b68-ae56-258cdb39f982";
const conversationId = "36b722cd-c3d7-472c-ad93-2d7f0b92a6ff";
const mediaUrl = "https://app.kapso.ai/rails/active_storage/blobs/redirect/eyJfcmFpbHMiOnsiZGF0YSI6ImMzZGVmMmQyLWE5ZjctNGEzMC05OGZmLTUzYTlhNGUwMzNmNCIsInB1ciI6ImJsb2JfaWQifX0=--dbe1e153ec66850bda8b8aedaca2610ae2a07653/image_f816e15263f6.jpeg";

async function run() {
  console.log("1. Downloading receipt from Kapso active storage...");
  const imgRes = await fetch(mediaUrl);
  if (!imgRes.ok) {
    throw new Error(`Failed to download image: ${imgRes.status}`);
  }
  const buffer = await imgRes.arrayBuffer();
  console.log(`Downloaded image: ${buffer.byteLength} bytes`);

  const storagePath = `receipts/${businessId}/MB-6D09AB-receipt.jpeg`;
  console.log(`2. Uploading to Supabase Storage: payment-receipts / ${storagePath}`);

  const uploadRes = await fetch(`${env.SUPABASE_URL}/storage/v1/object/payment-receipts/${storagePath}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "image/jpeg",
      "x-upsert": "true"
    },
    body: buffer
  });

  console.log(`Upload status: ${uploadRes.status}`);
  if (!uploadRes.ok) {
    const errText = await uploadRes.text();
    console.error("Upload error:", errText);
  }

  console.log("3. Inserting record into crm_payment_receipts...");
  const insertRes = await fetch(`${env.SUPABASE_URL}/rest/v1/crm_payment_receipts`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
      "Content-Type": "application/json",
      "Prefer": "return=representation"
    },
    body: JSON.stringify({
      business_id: businessId,
      order_id: orderId,
      conversation_id: conversationId,
      storage_path: storagePath,
      file_name: "image_f816e15263f6.jpeg",
      file_size: buffer.byteLength,
      mime_type: "image/jpeg",
      status: "pending_validation",
      metadata: {
        payment_method: "transfer",
        customer_phone: "5216221556241",
        source: "kapso_inbound_media"
      }
    })
  });

  console.log(`Insert status: ${insertRes.status}`);
  const inserted = await insertRes.json();
  console.log("Inserted receipt:", inserted);
}

run().catch(console.error);
