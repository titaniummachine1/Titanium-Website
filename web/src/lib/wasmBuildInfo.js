/**
 * WASM build identity — shown in debug panel and logged at worker ready.
 */

import buildMeta from '../wasm/titanium/build-meta.json';

let rustIdentity = null;

export function localBuildMeta() {
  return buildMeta;
}

export async function fetchDeployedBuildMeta(baseUrl) {
  const root = baseUrl ?? import.meta.env.BASE_URL ?? '/';
  const url = `${root}wasm/build-meta.json?ts=${Date.now()}`;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) {
      return null;
    }
    return await res.json();
  } catch {
    return null;
  }
}

export function parseRustIdentity(jsonStr) {
  try {
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

export function setRustIdentityFromWasm(wasmBuildIdentityJson) {
  rustIdentity = parseRustIdentity(wasmBuildIdentityJson);
  return rustIdentity;
}

export function mergedBuildIdentity() {
  return {
    ...buildMeta,
    rust: rustIdentity,
  };
}

export function formatBuildIdentityLines(identity = mergedBuildIdentity()) {
  const lines = [
    `engine: ${identity.engine_version ?? 'titanium-v16'}`,
    `commit: ${identity.git_commit ?? 'unknown'}`,
    `built: ${identity.build_timestamp ?? 'unknown'}`,
    `wasm sha256: ${identity.wasm_sha256 ?? 'unknown'}`,
    `wasm bytes: ${identity.wasm_bytes ?? '?'}`,
    `features: ${identity.features ?? 'wasm,embed-tables'}`,
    `weights live: ${identity.weights_live_sha256 ?? '?'}`,
  ];
  if (identity.rust) {
    lines.push(`rust identity: ${JSON.stringify(identity.rust)}`);
  }
  return lines;
}

export function logBuildIdentity(prefix = '[titanium-wasm]') {
  const lines = formatBuildIdentityLines();
  console.group(`${prefix} build identity`);
  for (const line of lines) {
    console.log(line);
  }
  console.groupEnd();
}

export function renderWasmDebugPanel(container) {
  if (!container) {
    return;
  }
  if (!import.meta.env.DEV) {
    container.innerHTML = '';
    return;
  }
  const id = mergedBuildIdentity();
  container.innerHTML =
    '<details class="wasm-debug-panel" open>' +
    '<summary>Titanium WASM build</summary>' +
    '<pre class="wasm-debug-panel__body">' +
    formatBuildIdentityLines(id)
      .map((l) => l.replace(/</g, '&lt;'))
      .join('\n') +
    '</pre>' +
  '</details>';
}
