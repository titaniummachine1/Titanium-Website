/**
 * Titanium v16 in a Web Worker. Rust owns the engine and Lazy SMP threads;
 * JS only starts/stops search and receives progress.
 */

import init, * as titaniumWasm from '../wasm/titanium/titanium.js';
import wasmUrl from '../wasm/titanium/titanium_bg.wasm?url';
import buildMeta from '../wasm/titanium/build-meta.json';

const { WasmEngine } = titaniumWasm;
// v17's expanded search history makes construction/search frames larger than
// the old 4 MiB worker stack. Keep one generous stack for every profile.
const WASM_THREAD_STACK_SIZE = 16 << 20;

let initPromise = null;
let threadPoolPromise = null;
let threadPoolWorkers = 0;
/**
 * One engine at a time. A worker hosts exactly one live WasmEngine instance;
 * switching profile drops the previous one. (Previously this warmed six
 * instances that shared a single rayon pool — the source of the wasm-bindgen
 * "recursive use of an object" aliasing crash.)
 * @type {Map<string, import('../wasm/titanium/titanium.js').WasmEngine>}
 */
const engines = new Map();

function canUseThreads() {
  return (
    self.crossOriginIsolated &&
    typeof SharedArrayBuffer !== 'undefined' &&
    typeof titaniumWasm.initThreadPool === 'function'
  );
}

function threadFallbackReason(requestedThreads) {
  if (requestedThreads <= 1) {
    return null;
  }
  if (typeof titaniumWasm.initThreadPool !== 'function') {
    return 'wasm build has no thread pool export';
  }
  if (!self.crossOriginIsolated) {
    return 'cross-origin isolation is not active';
  }
  if (typeof SharedArrayBuffer === 'undefined') {
    return 'SharedArrayBuffer is unavailable';
  }
  return null;
}

function tierForEngineMode(engineMode, catLmrCeiling) {
  void engineMode;
  if (catLmrCeiling === 500) {
    return 3;
  }
  if (catLmrCeiling === 1000) {
    return 5;
  }
  return 4;
}

function engineCacheKey(engineMode, catLmrCeiling) {
  if (engineMode === 'titanium-v16') {
    return `${engineMode}@${catLmrCeiling ?? 800}`;
  }
  return engineMode;
}

function ensureEngineInstance(engineMode = 'titanium-v16', catLmrCeiling = 800) {
  const key = engineCacheKey(engineMode, catLmrCeiling);
  if (engines.has(key)) {
    return engines.get(key);
  }
  // One engine at a time: free any previously-built instance before allocating
  // a new profile so a worker never holds more than one live WasmEngine.
  for (const [staleKey, engine] of engines) {
    if (staleKey !== key) {
      engine.free?.();
      engines.delete(staleKey);
    }
  }
  const tier = tierForEngineMode(engineMode, catLmrCeiling);
  const engine =
    engineMode === 'titanium-v17' && typeof WasmEngine.new_v17 === 'function'
      ? WasmEngine.new_v17(tier)
      : new WasmEngine(tier);
  engines.set(key, engine);
  return engine;
}

function replaceEngineInstance(engineMode = 'titanium-v16', catLmrCeiling = 800) {
  const key = engineCacheKey(engineMode, catLmrCeiling);
  const stale = engines.get(key);
  stale?.free?.();
  engines.delete(key);
  return ensureEngineInstance(engineMode, catLmrCeiling);
}

async function ensureThreadPool(requestedThreads = 1) {
  await ensureInit();
  const initThreadPool = titaniumWasm.initThreadPool;
  if (typeof initThreadPool !== 'function' || requestedThreads <= 1) {
    return false;
  }
  const workers = Math.max(1, requestedThreads - 1);
  if (threadPoolPromise && threadPoolWorkers === workers) {
    await threadPoolPromise;
    return true;
  }
  if (threadPoolPromise && threadPoolWorkers !== workers) {
    throw new Error('Titanium WASM thread pool size changed; reload the engine worker');
  }
  if (!self.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') {
    // No cross-origin isolation (e.g. GitHub Pages without a COI service
    // worker). Run single-threaded instead of crashing the search.
    return false;
  }
  threadPoolWorkers = workers;
  threadPoolPromise = initThreadPool(workers);
  await threadPoolPromise;
  return true;
}

async function ensureInit() {
  if (!initPromise) {
    initPromise = init({ module_or_path: wasmUrl, thread_stack_size: WASM_THREAD_STACK_SIZE });
  }
  await initPromise;
}

async function ensureEngine(engineMode = 'titanium-v16', catLmrCeiling = 800, threads = 1) {
  await ensureInit();
  const engine = ensureEngineInstance(engineMode, catLmrCeiling);
  await ensureThreadPool(threads);
  return engine;
}

function parseProgressJson(jsonStr) {
  try {
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

async function handleInit(engineMode, catLmrCeiling, threads = 1) {
  const t0 = performance.now();
  await ensureInit();
  ensureEngineInstance(engineMode, catLmrCeiling);
  const threaded = await ensureThreadPool(threads);
  const effectiveThreads = threaded ? Math.max(1, threads) : 1;
  const fallbackReason = threadFallbackReason(threads);
  const initMs = performance.now() - t0;
  const rustIdentity = buildMeta;
  console.log('[titanium-wasm-worker] ready', {
    engineMode,
    catLmrCeiling,
    threads,
    effectiveThreads,
    threaded,
    fallbackReason,
    initMs,
    buildMeta,
    rustIdentity: rustIdentity,
  });
  self.postMessage({
    type: 'ready',
    initMs,
    weightsInInit: false,
    engineMode,
    catLmrCeiling,
    threads,
    requestedThreads: threads,
    effectiveThreads,
    threaded,
    fallbackReason,
    buildMeta,
    rustIdentity,
  });
}

async function handleSearch(eventData) {
  const {
    seq,
    algebraicMoves,
    timeMs,
    maxNodes,
    maxDepth,
    isFreshGame,
    engineMode = 'titanium-v16',
    catLmrCeiling = 800,
    threads = 1,
    streamProgress = true,
  } = eventData;
  // Threads only run under cross-origin isolation (SharedArrayBuffer + rayon
  // pool). Without it, force single-thread so the search never reaches for an
  // uninitialized pool.
  const canThread = canUseThreads();
  let effectiveThreads = canThread ? Math.max(1, threads) : 1;
  let fallbackReason = threadFallbackReason(threads);
  let wasm = await ensureEngine(engineMode, catLmrCeiling, effectiveThreads);
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
    streamProgress
      ? (jsonStr) => {
          const data = parseProgressJson(jsonStr);
          if (!data) {
            return;
          }
          lastProgress = data;
          self.postMessage({
            type: 'info',
            seq,
            thinking: true,
            ...data,
            mode: data.engine ?? data.stoppedBy ?? engineMode,
            requestedThreads: threads,
            effectiveThreads,
            threaded: effectiveThreads > 1,
            fallbackReason,
          });
        }
      : undefined;

  const movetime = Math.max(1, timeMs ?? 10_000);
  const cap = maxNodes ?? 0;
  const depthCap = maxDepth ?? 0; // <=0 means "no explicit cap" to the wasm engine

  function runSearch(engine, requestedThreads = effectiveThreads) {
    if (typeof engine.go_threads_json === 'function') {
      const json = engine.go_threads_json(movetime, cap, depthCap, requestedThreads, onProgress);
      const data = JSON.parse(json);
      if (Array.isArray(data.progress) && typeof onProgress === 'function') {
        for (const progress of data.progress) {
          onProgress(JSON.stringify(progress));
        }
      }
      return {
        best: data.move,
        depth: data.depth,
        nodes: Number(data.nodes ?? 0),
        stopReason: data.stopReason,
        usedJsonApi: true,
      };
    }
    if (typeof engine.go_threads === 'function') {
      return {
        best: engine.go_threads(movetime, cap, depthCap, requestedThreads, onProgress),
        usedJsonApi: false,
      };
    }
    return {
      best: engine.go(movetime, cap, depthCap, onProgress),
      usedJsonApi: false,
    };
  }

  self.postMessage({ type: 'search-started', seq });
  const searchT0 = performance.now();
  let searchResult;
  const helperStartsBefore =
    typeof titaniumWasm.helper_starts === 'function' ? titaniumWasm.helper_starts() : 0;
  try {
    searchResult = runSearch(wasm);
  } catch (firstErr) {
    const msg = firstErr?.message ?? String(firstErr);
    const isTrap =
      firstErr instanceof WebAssembly.RuntimeError || /unreachable|panic/i.test(msg);
    const isAliasing = /recursive use of an object|unsafe aliasing/i.test(msg);
    // Single-threaded retry on a trap or a wasm-bindgen aliasing error: same
    // engine, threads=1. This removes the multi-thread path that triggers the
    // aliasing crash without swapping in a different engine.
    if (!isTrap && !isAliasing) {
      throw firstErr;
    }
    wasm = replaceEngineInstance(engineMode, catLmrCeiling);
    if (isFreshGame) {
      wasm.reset();
    } else if (history.length > 0) {
      wasm.position(history.join(' '));
    }
    effectiveThreads = 1;
    fallbackReason = `threaded search retry: ${msg}`;
    searchResult = runSearch(wasm, 1);
  }
  const best = searchResult.best;
  const searchWallMs = performance.now() - searchT0;
  const helperStartsTotal =
    typeof titaniumWasm.helper_starts === 'function' ? titaniumWasm.helper_starts() : 0;
  const helperStarts =
    helperStartsTotal >= helperStartsBefore ? helperStartsTotal - helperStartsBefore : helperStartsTotal;

  if (!best || best === '(none)') {
    self.postMessage({
      type: 'error',
      seq,
      message: 'WASM engine returned no legal move',
    });
    return;
  }

  const depth =
    searchResult.depth ??
    (typeof wasm.last_search_depth === 'function' ? wasm.last_search_depth() : undefined) ??
    lastProgress?.searchDepth;
  const nodes =
    searchResult.nodes ??
    (typeof wasm.last_search_nodes === 'function' ? Number(wasm.last_search_nodes()) : undefined) ??
    lastProgress?.nodes;
  const stopReason =
    searchResult.stopReason ??
    (typeof wasm.last_stop_reason === 'function' ? wasm.last_stop_reason() : undefined);

  self.postMessage({
    type: 'bestmove',
    seq,
    algebraicMove: best,
    depth,
    nodes,
    helperStarts,
    helperStartsTotal,
    requestedThreads: threads,
    effectiveThreads,
    threaded: effectiveThreads > 1,
    fallbackReason,
    stopReason,
    searchWallMs,
    stoppedBy: engineMode,
    mode: engineMode,
    catLmrCeiling: engineMode === 'titanium-v16' ? catLmrCeiling : undefined,
    nodeSource: 'bestmove_final',
    totalNodes: lastProgress?.totalNodes,
    totalNodesAcrossWorkers: lastProgress?.totalNodesAcrossWorkers,
    mainThreadNodes: lastProgress?.mainThreadNodes,
    helperNodes: lastProgress?.helperNodes,
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
  const engineMode = data.engineMode ?? 'titanium-v16';
  const catLmrCeiling = data.catLmrCeiling ?? 800;
  try {
    if (data.op === 'init') {
      await handleInit(engineMode, catLmrCeiling, data.threads ?? 1);
      return;
    }
    await handleSearch(data);
  } catch (err) {
    const baseMessage =
      err?.message ??
      (err instanceof WebAssembly.RuntimeError ? 'WASM runtime error (engine panic)' : String(err));
    const panic =
      typeof titaniumWasm.last_panic === 'function' ? titaniumWasm.last_panic() : '';
    const history = Array.isArray(data.algebraicMoves) ? data.algebraicMoves : [];
    const position = history.length ? history.join(' ') : '(start)';
    const details = [
      `engine=${engineMode}`,
      `commit=${buildMeta.git_commit ?? 'unknown'}`,
      `wasm=${String(buildMeta.wasm_sha256 ?? 'unknown').slice(0, 16)}`,
      `threads=${data.threads ?? 1}`,
      `timeMs=${data.timeMs ?? 'unset'}`,
      `maxNodes=${data.maxNodes ?? 'unset'}`,
      `maxDepth=${data.maxDepth ?? 'unset'}`,
      `cat=${catLmrCeiling}`,
      `position="${position}"`,
    ];
    if (panic) {
      details.push(`panic="${panic}"`);
    }
    const message = `${baseMessage} | ${details.join(' | ')}`;
    self.postMessage({
      type: 'error',
      seq: data.seq,
      message,
      stack: err?.stack ?? null,
      diagnostics: {
        engineMode,
        buildMeta,
        requestedThreads: data.threads ?? 1,
        timeMs: data.timeMs,
        maxNodes: data.maxNodes,
        maxDepth: data.maxDepth,
        catLmrCeiling,
        position,
        panic,
      },
    });
  }
};
