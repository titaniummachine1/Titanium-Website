const { chromium } = require('playwright');
(async () => {
  const url = process.argv[2] || 'http://localhost:4173/bench.html';
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('console', (msg) => console.log('[console]', msg.text()));
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);
  const probe = await page.evaluate(() => ({
    href: location.href,
    crossOriginIsolated,
    hasSAB: typeof SharedArrayBuffer !== 'undefined',
    sw: !!navigator.serviceWorker?.controller,
  }));
  console.log(JSON.stringify(probe, null, 2));
  await browser.close();
})();
