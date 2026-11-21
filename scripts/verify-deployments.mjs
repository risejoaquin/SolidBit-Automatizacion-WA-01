const urls = [
  { name: 'solidbit-crm-demo health', url: 'https://solidbit-crm-demo.solidbit-whatsapp-agent.workers.dev/health' },
  { name: 'solidbit-kapso-webhook-demo health', url: 'https://solidbit-kapso-webhook-demo.solidbit-whatsapp-agent.workers.dev/health' },
  { name: 'solidbit-crm-notifier-demo health', url: 'https://solidbit-crm-notifier-demo.solidbit-whatsapp-agent.workers.dev/health' },
  { name: 'crm-kapso-app (production intact)', url: 'https://crm-kapso-app.solidbit-whatsapp-agent.workers.dev/health' },
  { name: 'crm-kapso-webhook (production intact)', url: 'https://crm-kapso-webhook.solidbit-whatsapp-agent.workers.dev/health' },
  { name: 'solidbit-crm-demo root HTML', url: 'https://solidbit-crm-demo.solidbit-whatsapp-agent.workers.dev/' },
  { name: 'solidbit-crm-demo brand logo', url: 'https://solidbit-crm-demo.solidbit-whatsapp-agent.workers.dev/brand/solidbit-logo.svg' },
  { name: 'solidbit-crm-demo brand isotype', url: 'https://solidbit-crm-demo.solidbit-whatsapp-agent.workers.dev/brand/solidbit-isotype-gray.svg' }
];

async function run() {
  console.log('=== Verifying Cloudflare Deployments ===');
  for (const item of urls) {
    try {
      const res = await fetch(item.url);
      const contentType = res.headers.get('content-type') || '';
      let snippet = '';
      if (contentType.includes('json')) {
        const json = await res.json();
        snippet = JSON.stringify(json);
      } else {
        const text = await res.text();
        snippet = `${contentType} (${text.length} bytes)`;
      }
      console.log(`[PASS] ${item.name} (${res.status}): ${snippet}`);
    } catch (err) {
      console.error(`[FAIL] ${item.name}: ${err.message}`);
    }
  }
}

run();
