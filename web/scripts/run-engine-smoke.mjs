/**
 * Headless Playwright smoke: each Titanium engine must play a move within deadline.
 *
 *   npm run test:engine-smoke
 *   node scripts/run-engine-smoke.mjs --url http://localhost:5173/smoke.html
 *   node scripts/run-engine-smoke.mjs --deadline-ms 8000 --engines titanium-v17
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function parseArgs(argv) {
  const out = {
    url: null,
    baseUrl: process.env.SMOKE_BASE_URL ?? 'http://localhost:5173',
    engines: process.env.SMOKE_ENGINES ?? 'titanium-v16,titanium-v17',
    deadlineMs: Number(process.env.SMOKE_DEADLINE_MS ?? 3000),
    timeoutMs: Number(process.env.SMOKE_TIMEOUT_MS ?? 120_000),
    startDev: process.env.SMOKE_START_DEV === '1',
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url' && argv[i + 1]) out.url = argv[++i];
    else if (a === '--base-url' && argv[i + 1]) out.baseUrl = argv[++i];
    else if (a === '--engines' && argv[i + 1]) out.engines = argv[++i];
    else if (a === '--deadline-ms' && argv[i + 1]) out.deadlineMs = Number(argv[++i]);
    else if (a === '--timeout-ms' && argv[i + 1]) out.timeoutMs = Number(argv[++i]);
    else if (a === '--start-dev') out.startDev = true;
  }
  if (!out.url) {
    const qs = new URLSearchParams({
      auto: '1',
      engines: out.engines,
      deadlineMs: String(out.deadlineMs),
    });
    out.url = `${out.baseUrl.replace(/\/$/, '')}/smoke.html?${qs}`;
  }
  return out;
}

async function fetchOk(url, timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function startDevServer() {
  const child = spawn('npm', ['run', 'dev'], {
    cwd: webDir,
    stdio: 'inherit',
    shell: true,
    detached: false,
  });
  return child;
}

async function waitForServer(baseUrl, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await fetchOk(baseUrl)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

const runner = `
const { chromium } = require('playwright');
async function gotoWithCoi(page, url, timeoutMs) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  let isolated = await page.evaluate(() => typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated === true);
  if (!isolated) {
    await page.waitForTimeout(1500);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForFunction(
      () => typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated === true,
      null,
      { timeout: timeoutMs },
    );
  }
}
(async () => {
  const url = process.env.SMOKE_URL;
  const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS || 120000);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('console', (msg) => console.log('[browser]', msg.text()));
  page.on('pageerror', (err) => console.error('[pageerror]', err?.message ?? err));
  await gotoWithCoi(page, url, timeoutMs);
  try {
    await page.waitForFunction(() => window.__SMOKE_DONE__ === true, null, { timeout: timeoutMs });
  } catch (err) {
    const probe = await page.evaluate(() => ({
      url: location.href,
      done: window.__SMOKE_DONE__ === true,
      error: window.__SMOKE_ERROR__ ?? null,
      results: window.__SMOKE_RESULTS__ ?? null,
      status: document.getElementById('status')?.textContent?.slice(0, 4000) ?? null,
      runtime: {
        crossOriginIsolated: typeof crossOriginIsolated === 'undefined' ? null : crossOriginIsolated,
        hasSharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
      },
    }));
    console.error(JSON.stringify({ timeout: true, probe }, null, 2));
    throw err;
  }
  const err = await page.evaluate(() => window.__SMOKE_ERROR__ ?? null);
  const results = await page.evaluate(() => window.__SMOKE_RESULTS__ ?? null);
  await browser.close();
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(JSON.stringify(results, null, 2));
})();
`;

const args = parseArgs(process.argv);
let devChild = null;

if (!(await fetchOk(args.baseUrl))) {
  if (!args.startDev) {
    console.error(
      `Dev server not reachable at ${args.baseUrl}. Start it first:\n` +
        `  cd site/web && npm run dev\n` +
        `Or rerun with --start-dev`,
    );
    process.exit(1);
  }
  console.log(`[engine-smoke] starting vite at ${args.baseUrl}`);
  devChild = startDevServer();
  const ready = await waitForServer(args.baseUrl, 60_000);
  if (!ready) {
    devChild?.kill();
    console.error(`[engine-smoke] vite did not become ready at ${args.baseUrl}`);
    process.exit(1);
  }
}

const env = {
  ...process.env,
  SMOKE_URL: args.url,
  SMOKE_TIMEOUT_MS: String(args.timeoutMs),
};
const tmpRoot = path.join(webDir, '.tmp');
mkdirSync(tmpRoot, { recursive: true });
const runnerDir = mkdtempSync(path.join(tmpRoot, 'engine-smoke-'));
const runnerPath = path.join(runnerDir, 'runner.cjs');
writeFileSync(runnerPath, runner);

console.log(`[engine-smoke] ${args.url}`);

const run = spawnSync(process.execPath, [runnerPath], {
  cwd: webDir,
  env,
  stdio: 'inherit',
});

rmSync(runnerDir, { recursive: true, force: true });
if (devChild) {
  devChild.kill();
}

if (run.error) {
  console.error(run.error);
  process.exit(1);
}
if (run.signal) {
  console.error(`engine smoke terminated by signal ${run.signal}`);
  process.exit(1);
}
process.exit(run.status ?? 1);
