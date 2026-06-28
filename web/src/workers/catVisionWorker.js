/**
 * Dedicated CAT vision worker.
 *
 * Keeps the latest Titanium WASM module warm for heatmap snapshots without
 * sharing a search worker or blocking the UI thread.
 */

import init, { cat_snapshot, wasm_build_identity_json } from '../wasm/titanium/titanium.js';
import wasmUrl from '../wasm/titanium/titanium_bg.wasm?url';
import buildMeta from '../wasm/titanium/build-meta.json';

let initPromise = null;

async function ensureInit() {
  if (!initPromise) {
    initPromise = init({ module_or_path: wasmUrl });
  }
  await initPromise;
}

function parseIdentity() {
  if (typeof wasm_build_identity_json !== 'function') {
    return buildMeta;
  }
  try {
    return JSON.parse(wasm_build_identity_json());
  } catch {
    return buildMeta;
  }
}

async function handleInit(id) {
  const started = performance.now();
  await ensureInit();
  self.postMessage({
    type: 'ready',
    id,
    initMs: performance.now() - started,
    buildMeta,
    rustIdentity: parseIdentity(),
  });
}

async function handleSnapshot(id, moves) {
  await ensureInit();
  if (typeof cat_snapshot !== 'function') {
    throw new Error('WASM build missing cat_snapshot export - run npm run build:wasm');
  }
  const json = cat_snapshot((moves ?? []).join(' '));
  self.postMessage({
    type: 'snapshot',
    id,
    data: JSON.parse(json),
  });
}

self.onmessage = async (event) => {
  const data = event.data ?? {};
  const id = data.id ?? 0;
  try {
    if (data.op === 'init') {
      await handleInit(id);
      return;
    }
    if (data.op === 'snapshot') {
      await handleSnapshot(id, data.moves ?? []);
      return;
    }
    throw new Error(`Unknown CAT worker op: ${data.op ?? '(missing)'}`);
  } catch (err) {
    self.postMessage({
      type: 'error',
      id,
      message: err?.message ?? String(err),
    });
  }
};
