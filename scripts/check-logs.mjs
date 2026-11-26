import { execSync } from "child_process";

const out = execSync("npx kapso logs search --limit 25", {
  encoding: "utf8",
  maxBuffer: 20 * 1024 * 1024
});

const json = JSON.parse(out);
for (const e of json.data.events) {
  if (e.source === "flow_event" || e.source === "whatsapp_message_event") {
    console.log("-----------------------------------------");
    console.log("ID:", e.id, "LEVEL:", e.level, "MSG:", e.message);
    console.log("ATTRS:", e.attributes);
    if (e.payload) console.log("PAYLOAD:", JSON.stringify(e.payload, null, 2));
  }
}
