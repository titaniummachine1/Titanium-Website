/**
 * Headless browser benchmark via Playwright (production worker path).
 *
 *   node scripts/run-browser-bench.mjs
 *   node scripts/run-browser-bench.mjs --url http://localhost:4173/bench.html
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function parseArgs(argv) {
  const out = {
    url: 'http://localhost:5173/bench.html?auto=1&timeSec=10&runs=1&net=easy&threadsMulti=8',
    timeoutMs: 180_000,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url' && argv[i + 1]) out.url = argv[++i];
    else if (a === '--timeout' && argv[i + 1]) out.timeoutMs = Number(argv[++i]);
  }
  return out;
}

const runner = `
const { chromium } = require('playwright');
(async () => {
  const url = process.env.BENCH_URL;
  const timeoutMs = Number(process.env.BENCH_TIMEOUT_MS || 180000);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('console', (msg) => console.log('[browser]', msg.text()));
  await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs });
  try {
    await page.waitForFunction(() => window.__BENCH_DONE__ === true, null, { timeout: timeoutMs });
  } catch (err) {
    const probe = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      done: window.__BENCH_DONE__ === true,
      error: window.__BENCH_ERROR__ ?? null,
      status: document.getElementById('status')?.textContent?.slice(0, 4000) ?? null,
      runtime: {
        crossOriginIsolated: typeof crossOriginIsolated === 'undefined' ? null : crossOriginIsolated,
        hasSharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
        serviceWorkerController: !!navigator.serviceWorker?.controller,
      },
    }));
    console.error(JSON.stringify({ timeout: true, probe }, null, 2));
    throw err;
  }
  const err = await page.evaluate(() => window.__BENCH_ERROR__ ?? null);
  const results = await page.evaluate(() => window.__BENCH_RESULTS__ ?? null);
  await browser.close();
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(JSON.stringify(results, null, 2));
})();
`;

const args = parseArgs(process.argv);
const env = {
  ...process.env,
  BENCH_URL: args.url,
  BENCH_TIMEOUT_MS: String(args.timeoutMs),
};
const tmpRoot = path.join(webDir, '.tmp');
mkdirSync(tmpRoot, { recursive: true });
const runnerDir = mkdtempSync(path.join(tmpRoot, 'browser-bench-'));
const runnerPath = path.join(runnerDir, 'runner.cjs');
writeFileSync(runnerPath, runner);

const run = spawnSync(process.execPath, [runnerPath], {
  cwd: webDir,
  env,
  stdio: 'inherit',
});
rmSync(runnerDir, { recursive: true, force: true });
if (run.error) {
  console.error(run.error);
  process.exit(1);
}
if (run.signal) {
  console.error(`browser bench terminated by signal ${run.signal}`);
  process.exit(1);
}
process.exit(run.status ?? 1);
