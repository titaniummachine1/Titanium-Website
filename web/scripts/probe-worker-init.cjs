const { chromium } = require('playwright');
(async () => {
  const workerUrl = process.argv[2];
  const base = process.argv[3] || 'http://localhost:4173';
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('console', (msg) => console.log('[console]', msg.text()));
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));
  await page.goto(`${base}/bench.html`, { waitUntil: 'domcontentloaded' });
  const result = await page.evaluate(async (url) => {
    return new Promise((resolve) => {
      const worker = new Worker(url, { type: 'module' });
      const timer = setTimeout(() => resolve({ ok: false, error: 'timeout' }), 30000);
      worker.onmessage = (event) => {
        clearTimeout(timer);
        resolve({ ok: true, data: event.data });
      };
      worker.onerror = (event) => {
        clearTimeout(timer);
        resolve({ ok: false, error: event.message || String(event) });
      };
      worker.postMessage({ op: 'init', engineMode: 'titanium-v16', catLmrCeiling: 800, threads: 1 });
    });
  }, workerUrl);
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
})();
