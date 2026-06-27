/**
 * Headless browser benchmark via Playwright (production worker path).
 *
 *   node scripts/run-browser-bench.mjs
 *   node scripts/run-browser-bench.mjs --url http://localhost:4173/bench.html
 */

import { spawnSync } from 'node:child_process';
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
  await page.waitForFunction(() => window.__BENCH_DONE__ === true, null, { timeout: timeoutMs });
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

const install = spawnSync('npm', ['exec', '--yes', 'playwright@1.49.1', '--', 'install', 'chromium'], {
  cwd: webDir,
  stdio: 'inherit',
  shell: true,
});
if (install.status !== 0) {
  process.exit(install.status ?? 1);
}

const run = spawnSync('npm', ['exec', '--yes', 'playwright@1.49.1', '--', 'node', '-e', runner], {
  cwd: webDir,
  env,
  stdio: 'inherit',
  shell: true,
});
process.exit(run.status ?? 0);
