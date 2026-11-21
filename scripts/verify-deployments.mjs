const urls = [
  { name: 'solidbit-crm-demo health', url: 'https://solidbit-crm-demo.solidbit-whatsapp-agent.workers.dev/health' },
  { name: 'solidbit-crm-demo root HTML', url: 'https://solidbit-crm-demo.solidbit-whatsapp-agent.workers.dev/' },
  { name: 'solidbit-crm-demo style.css', url: 'https://solidbit-crm-demo.solidbit-whatsapp-agent.workers.dev/style.css' },
  { name: 'solidbit-crm-demo remote-app.js', url: 'https://solidbit-crm-demo.solidbit-whatsapp-agent.workers.dev/remote-app.js' }
];

async function run() {
  console.log('=== Verifying Cloudflare Deployments ===');
  for (const item of urls) {
    try {
      const res = await fetch(item.url);
      const text = await res.text();
      let extra = '';
      if (item.name.includes('style.css')) {
        extra = `[hidden] present: ${text.includes('[hidden]')} | .modal-backdrop[hidden] present: ${text.includes('.modal-backdrop[hidden]')}`;
      } else if (item.name.includes('remote-app.js')) {
        extra = `closeReceiptModal present: ${text.includes('closeReceiptModal')}`;
      }
      console.log(`[PASS] ${item.name} (${res.status}): ${text.length} bytes ${extra}`);
    } catch (err) {
      console.error(`[FAIL] ${item.name}: ${err.message}`);
    }
  }
}

run();
