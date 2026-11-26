import { execSync } from "child_process";

const out = execSync("npx kapso logs search --query 7ddc6537-2b56-41cf-a356-1d3c5e62d707", {
  encoding: "utf8",
  maxBuffer: 20 * 1024 * 1024
});

const json = JSON.parse(out);
for (const e of json.data.events) {
  console.log("-----------------------------------------");
  console.log("ID:", e.id, "LEVEL:", e.level, "MSG:", e.message);
  console.log("ATTRS:", e.attributes);
  if (e.payload) console.log("PAYLOAD:", JSON.stringify(e.payload, null, 2));
}
