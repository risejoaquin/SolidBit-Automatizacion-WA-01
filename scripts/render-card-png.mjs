import puppeteer from 'puppeteer-core';
import fs from 'fs';

async function main() {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 800, height: 500, deviceScaleFactor: 2 });
  const svg = fs.readFileSync('web/qa/tarjeta-destino-demo.svg', 'utf8');
  await page.setContent(`<!DOCTYPE html><html><body style="margin:0;padding:0;background:transparent;">${svg}</body></html>`);
  const svgEl = await page.$('svg');
  await svgEl.screenshot({ path: 'web/qa/tarjeta-destino-demo.png', omitBackground: true });
  await browser.close();
  console.log('PNG generated successfully. Size:', fs.statSync('web/qa/tarjeta-destino-demo.png').size);
}

main().catch(err => {
  console.error('Error rendering PNG:', err);
  process.exit(1);
});
