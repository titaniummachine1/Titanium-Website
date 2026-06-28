/**
 * Titanium v15/v16 in a Web Worker — Rust engine compiled to WebAssembly.
 * Tiers 0–2 = v15 NNUE (easy/medium/hard); tiers 3–5 = v16 CAT LMR ceilings.
 */

import init, { WasmEngine } from '../wasm/titanium/titanium.js';
import wasmUrl from '../wasm/titanium/titanium_bg.wasm?url';
import buildMeta from '../wasm/titanium/build-meta.json';

let initPromise = null;
/** @type {Map<string, import('../wasm/titanium/titanium.js').WasmEngine>} */
const engines = new Map();

function tierForEngineMode(engineMode, catLmrCeiling) {
  if (engineMode === 'titanium-v15-frozen') {
    return 0;
  }
  if (engineMode === 'titanium-v15-medium') {
    return 1;
  }
  if (engineMode === 'titanium-v16') {
    if (catLmrCeiling === 500) {
      return 3;
    }
    if (catLmrCeiling === 1000) {
      return 5;
    }
    return 4;
  }
  return 2;
}

function engineCacheKey(engineMode, catLmrCeiling) {
  if (engineMode === 'titanium-v16') {
    return `${engineMode}@${catLmrCeiling ?? 800}`;
  }
  return engineMode;
}

async function ensureInit() {
  if (!initPromise) {
    initPromise = init({ module_or_path: wasmUrl });
  }
  await initPromise;
}

async function ensureEngine(engineMode = 'titanium-v15', catLmrCeiling = 800) {
  await ensureInit();
  const key = engineCacheKey(engineMode, catLmrCeiling);
  if (!engines.has(key)) {
    const tier = tierForEngineMode(engineMode, catLmrCeiling);
    engines.set(key, new WasmEngine(tier));
  }
  return engines.get(key);
}

function parseProgressJson(jsonStr) {
  try {
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

async function handleInit(engineMode, workerSlot, catLmrCeiling) {
  const t0 = performance.now();
  await ensureEngine(engineMode, catLmrCeiling);
  const initMs = performance.now() - t0;
  const rustIdentity = buildMeta;
  console.log('[titanium-wasm-worker] ready', {
    workerSlot,
    engineMode,
    catLmrCeiling,
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
    catLmrCeiling,
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
    catLmrCeiling = 800,
    workerSlot = 0,
    streamProgress = true,
  } = eventData;
  const wasm = await ensureEngine(engineMode, catLmrCeiling);
  if (isFreshGame) {
    wasm.reset();
  }
  const history = algebraicMoves ?? [];
  if (history.length > 0) {
    wasm.position(history.join(' '));
  } else if (isFreshGame) {
    wasm.reset();
  }

  let lastProgress = null;
  const onProgress =
    streamProgress && workerSlot === 0
      ? (jsonStr) => {
          const data = parseProgressJson(jsonStr);
          if (!data) {
            return;
          }
          lastProgress = data;
          self.postMessage({
            type: 'info',
            thinking: true,
            workerId: workerSlot,
            ...data,
            mode: data.engine ?? data.stoppedBy ?? engineMode,
          });
        }
      : undefined;

  const movetime = Math.max(1, timeMs ?? 10_000);
  const cap = maxNodes ?? 0;

  function runSearch(engine) {
    if (workerSlot === 0) {
      return engine.go(movetime, cap, onProgress);
    }
    if (typeof engine.go_with_profile === 'function') {
      return engine.go_with_profile(movetime, cap, workerSlot, 0, 0, onProgress);
    }
    return engine.go(movetime, cap, onProgress);
  }

  const searchT0 = performance.now();
  let best;
  try {
    best = runSearch(wasm);
  } catch (firstErr) {
    const msg = firstErr?.message ?? String(firstErr);
    const isTrap =
      firstErr instanceof WebAssembly.RuntimeError || /unreachable|panic/i.test(msg);
    if (!isTrap || engineMode === 'titanium-v15-frozen') {
      throw firstErr;
    }
    const fallback = await ensureEngine('titanium-v15-frozen');
    if (isFreshGame) {
      fallback.reset();
    } else if (history.length > 0) {
      fallback.position(history.join(' '));
    }
    best = runSearch(fallback);
  }
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
    (typeof wasm.last_search_depth === 'function' ? wasm.last_search_depth() : undefined) ??
    lastProgress?.searchDepth;
  const nodes =
    (typeof wasm.last_search_nodes === 'function' ? Number(wasm.last_search_nodes()) : undefined) ??
    lastProgress?.nodes;
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
    catLmrCeiling: engineMode === 'titanium-v16' ? catLmrCeiling : undefined,
    nodeSource: 'bestmove_final',
    searchDepth: lastProgress?.searchDepth,
    rootScore: lastProgress?.rootScore,
    whiteDist: lastProgress?.whiteDist,
    blackDist: lastProgress?.blackDist,
    depthLog: lastProgress?.depthLog,
    elapsedMs: lastProgress?.elapsedMs,
    pv: lastProgress?.depthLog?.length
      ? lastProgress.depthLog[lastProgress.depthLog.length - 1]?.pv
      : undefined,
  });
}

self.onmessage = async (event) => {
  const data = event.data ?? {};
  const workerSlot = data.workerSlot ?? data.workerId ?? 0;
  const engineMode = data.engineMode ?? 'titanium-v15';
  const catLmrCeiling = data.catLmrCeiling ?? 800;
  try {
    if (data.op === 'init') {
      await handleInit(engineMode, workerSlot, catLmrCeiling);
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
