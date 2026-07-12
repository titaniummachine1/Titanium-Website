/**
 * Playwright helpers for COOP/COEP + service-worker reload pages.
 */

export async function waitForCrossOriginIsolated(page, timeoutMs = 30_000) {
  await page.waitForFunction(
    () => typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated === true,
    null,
    { timeout: timeoutMs },
  );
}

export async function gotoWithCoi(page, url, { timeoutMs = 60_000 } = {}) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  const isolated = await page.evaluate(
    () => typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated === true,
  );
  if (!isolated) {
    // coi-serviceworker.js reloads once after registration; give it a second pass.
    await page.waitForTimeout(1500);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await waitForCrossOriginIsolated(page, timeoutMs);
  }
}

export async function readRuntimeProbe(page) {
  return page.evaluate(() => ({
    url: location.href,
    crossOriginIsolated: typeof crossOriginIsolated === 'undefined' ? null : crossOriginIsolated,
    hasSharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    serviceWorkerController: Boolean(navigator.serviceWorker?.controller),
  }));
}
