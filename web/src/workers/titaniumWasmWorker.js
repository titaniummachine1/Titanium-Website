/**
 * Titanium v15 in a Web Worker — Rust engine compiled to WebAssembly.
 * Easy + Hard NNUE are embedded in WASM; Medium weights fetched from /weights/*.bin.
 */

import init, {
  WasmEngine,
  install_net_weights,
  net_weight_byte_len,
  wasm_build_identity_json,
} from '../wasm/titanium/titanium.js';
import buildMeta from '../wasm/titanium/build-meta.json';

let initPromise = null;
/** @type {Map<string, import('../wasm/titanium/titanium.js').WasmEngine>} */
const engines = new Map();
let mediumWeightsReady = false;

function tierForEngineMode(engineMode) {
  if (engineMode === 'titanium-v15-frozen') return 0;
  if (engineMode === 'titanium-v15-medium') return 1;
  return 2;
}

function siteBaseUrl() {
  if (typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL) {
    return import.meta.env.BASE_URL;
  }
  return '/';
}

async function ensureInit() {
  if (!initPromise) {
    initPromise = init();
  }
  await initPromise;
}

async function ensureMediumWeights() {
  await ensureInit();
  if (mediumWeightsReady) {
    return;
  }
  const v =
    buildMeta?.weights_medium_sha256 != null
      ? String(buildMeta.weights_medium_sha256).slice(0, 16)
      : String(Date.now());
  const res = await fetch(`${siteBaseUrl()}weights/net_weights_medium.bin?v=${v}`, {
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`failed to fetch weights/net_weights_medium.bin: HTTP ${res.status}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const expected = net_weight_byte_len();
  if (bytes.byteLength !== expected) {
    throw new Error(`weights/net_weights_medium.bin size ${bytes.byteLength} != ${expected}`);
  }
  install_net_weights(1, bytes);
  mediumWeightsReady = true;
}

async function ensureEngine(engineMode = 'titanium-v15') {
  await ensureInit();
  const tier = tierForEngineMode(engineMode);
  if (tier === 1) {
    await ensureMediumWeights();
  }
  if (!engines.has(engineMode)) {
    engines.set(engineMode, new WasmEngine(tier));
  }
  return engines.get(engineMode);
}

function parseProgressJson(jsonStr) {
  try {
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

async function handleInit(engineMode, workerSlot) {
  const t0 = performance.now();
  await ensureEngine(engineMode);
  const initMs = performance.now() - t0;
  let rustIdentity = null;
  try {
    const raw = wasm_build_identity_json();
    rustIdentity = raw ? JSON.parse(raw) : null;
  } catch {
    rustIdentity = null;
  }
  console.log('[titanium-wasm-worker] ready', {
    workerSlot,
    engineMode,
    initMs,
    buildMeta,
    rustIdentity: rustIdentity,
  });
  self.postMessage({
    type: 'ready',
    workerId: workerSlot,
    initMs,
    weightsInInit: engineMode === 'titanium-v15-medium',
    engineMode,
    buildMeta,
    rustIdentity,
  });
}

async function handleSearch(eventData) {
  const {
    algebraicMoves,
    timeMs,
    maxNodes,
    isFreshGame,
    engineMode = 'titanium-v15',
    workerSlot = 0,
    streamProgress = true,
  } = eventData;
  const wasm = await ensureEngine(engineMode);
  if (isFreshGame) {
    wasm.reset();
  }
  const history = algebraicMoves ?? [];
  if (history.length > 0) {
    wasm.position(history.join(' '));
  } else if (isFreshGame) {
    wasm.reset();
  }

  const onProgress = streamProgress
    ? (jsonStr) => {
        const data = parseProgressJson(jsonStr);
        if (!data) {
          return;
        }
        self.postMessage({
          type: 'info',
          thinking: true,
          workerId: workerSlot,
          ...data,
          mode: data.engine ?? data.stoppedBy ?? engineMode,
        });
      }
    : undefined;

  const searchT0 = performance.now();
  const best =
    typeof wasm.go_with_profile === 'function'
      ? wasm.go_with_profile(
          Math.max(1, timeMs ?? 10_000),
          maxNodes ?? 0,
          workerSlot,
          0,
          0,
          onProgress,
        )
      : wasm.go(Math.max(1, timeMs ?? 10_000), maxNodes ?? 0, onProgress);
  const searchWallMs = performance.now() - searchT0;

  if (!best || best === '(none)') {
    self.postMessage({
      type: 'error',
      workerId: workerSlot,
      message: 'WASM engine returned no legal move',
    });
    return;
  }

  const depth =
    typeof wasm.last_search_depth === 'function' ? wasm.last_search_depth() : undefined;
  const nodes =
    typeof wasm.last_search_nodes === 'function' ? Number(wasm.last_search_nodes()) : undefined;
  const stopReason =
    typeof wasm.last_stop_reason === 'function' ? wasm.last_stop_reason() : undefined;

  self.postMessage({
    type: 'bestmove',
    algebraicMove: best,
    workerId: workerSlot,
    depth,
    nodes,
    stopReason,
    searchWallMs,
    stoppedBy: engineMode,
    mode: engineMode,
    nodeSource: 'bestmove_final',
  });
}

self.onmessage = async (event) => {
  const data = event.data ?? {};
  const workerSlot = data.workerSlot ?? data.workerId ?? 0;
  const engineMode = data.engineMode ?? 'titanium-v15';
  try {
    if (data.op === 'init') {
      await handleInit(engineMode, workerSlot);
      return;
    }
    await handleSearch(data);
  } catch (err) {
    const message =
      err?.message ??
      (err instanceof WebAssembly.RuntimeError ? 'WASM runtime error (engine panic)' : String(err));
    self.postMessage({
      type: 'error',
      workerId: workerSlot,
      message,
    });
  }
};
