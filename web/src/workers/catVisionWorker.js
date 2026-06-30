/**
 * Dedicated CAT vision worker.
 *
 * Keeps the latest Titanium WASM module warm for heatmap snapshots without
 * sharing a search worker or blocking the UI thread.
 */

import init, { WasmCatEngine, wasm_build_identity_json } from '../wasm/titanium/titanium.js';
import wasmUrl from '../wasm/titanium/titanium_bg.wasm?url';
import buildMeta from '../wasm/titanium/build-meta.json';

const WASM_THREAD_STACK_SIZE = 4 << 20;
let initPromise = null;
let catEngine = null;

async function ensureInit() {
  if (!initPromise) {
    initPromise = init({ module_or_path: wasmUrl, thread_stack_size: WASM_THREAD_STACK_SIZE }).then(
      () => {
        // Warm, single-purpose CAT instance: holds the board across plies and
        // applies only the new move, so the overlay never replays the whole game.
        // No thread pool (initThreadPool is never called here) — pure single-thread.
        catEngine = new WasmCatEngine();
      },
    );
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
  if (!catEngine) {
    throw new Error('WASM build missing WasmCatEngine export - run npm run build:wasm');
  }
  const json = catEngine.snapshot((moves ?? []).join(' '));
  self.postMessage({
    type: 'snapshot',
    id,
    data: JSON.parse(json),
  });
}

async function handleLmrSnapshot(id, moves, timeMs, idDepth, maxExtra) {
  await ensureInit();
  if (!catEngine || typeof catEngine.lmr_snapshot !== 'function') {
    throw new Error('WASM build missing WasmCatEngine.lmr_snapshot - run npm run build:wasm');
  }
  const json = catEngine.lmr_snapshot((moves ?? []).join(' '), timeMs >>> 0, idDepth >>> 0, maxExtra);
  self.postMessage({ type: 'lmr', id, data: JSON.parse(json) });
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
    if (data.op === 'lmr') {
      await handleLmrSnapshot(
        id,
        data.moves ?? [],
        data.timeMs ?? 10_000,
        data.idDepth ?? 8,
        data.maxExtra ?? 0.5,
      );
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
