/** CAT v3 heat → subtle board overlays (never solid black bars on walls). */

import CatVisionWorker from '../workers/catVisionWorker.js?worker';

let wasmCatInitPromise = null;
let catWorker = null;
let catWorkerRequestId = 1;
let catWorkerReadyPromise = null;
let catWorkerFailed = false;
const catWorkerPending = new Map();
const catSnapshotCache = new Map();
const CAT_SNAPSHOT_CACHE_LIMIT = 16;
const WASM_THREAD_STACK_SIZE = 4 << 20;

function catMovesKey(algebraicMoves) {
  return (algebraicMoves ?? []).join('|');
}

function rememberCatSnapshot(key, promise) {
  const entry = { promise, data: null, failed: false };
  catSnapshotCache.set(key, entry);
  promise
    .then((data) => {
      entry.data = data;
      entry.promise = Promise.resolve(data);
      while (catSnapshotCache.size > CAT_SNAPSHOT_CACHE_LIMIT) {
        const oldest = catSnapshotCache.keys().next().value;
        catSnapshotCache.delete(oldest);
      }
      return data;
    })
    .catch(() => {
      entry.failed = true;
      if (catSnapshotCache.get(key) === entry) {
        catSnapshotCache.delete(key);
      }
    });
  return promise;
}

function cachedCatSnapshot(key) {
  const entry = catSnapshotCache.get(key);
  if (!entry) {
    return null;
  }
  if (entry.failed) {
    return null;
  }
  return entry.data ?? entry.promise;
}

function ensureCatWorker() {
  if (catWorkerFailed) {
    throw new Error('CAT vision worker unavailable');
  }
  if (!catWorker) {
    catWorker = new CatVisionWorker();
    catWorker.onmessage = (event) => {
      const data = event.data ?? {};
      const pending = catWorkerPending.get(data.id);
      if (!pending) {
        return;
      }
      catWorkerPending.delete(data.id);
      clearTimeout(pending.timeout);
      if (data.type === 'error') {
        pending.reject(new Error(data.message ?? 'CAT vision worker error'));
      } else {
        pending.resolve(data);
      }
    };
    catWorker.onerror = (event) => {
      catWorkerFailed = true;
      const message = event?.message ?? 'CAT vision worker crashed';
      for (const pending of catWorkerPending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error(message));
      }
      catWorkerPending.clear();
      catWorker?.terminate();
      catWorker = null;
      catWorkerReadyPromise = null;
    };
  }
  return catWorker;
}

function postCatWorkerMessage(op, payload = {}, timeoutMs = 30_000) {
  const worker = ensureCatWorker();
  const id = catWorkerRequestId++;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      catWorkerPending.delete(id);
      reject(new Error(`CAT vision worker ${op} timed out`));
    }, timeoutMs);
    catWorkerPending.set(id, { resolve, reject, timeout });
    worker.postMessage({ id, op, ...payload });
  });
}

async function ensureCatWorkerReady() {
  if (!catWorkerReadyPromise) {
    catWorkerReadyPromise = postCatWorkerMessage('init', {}, 60_000).catch((err) => {
      catWorkerReadyPromise = null;
      throw err;
    });
  }
  return catWorkerReadyPromise;
}

async function fetchCatSnapshotFromWorker(algebraicMoves) {
  await ensureCatWorkerReady();
  const result = await postCatWorkerMessage('snapshot', { moves: algebraicMoves ?? [] }, 30_000);
  return result.data;
}

/** LMR plan via the same warm CAT engine (no server needed — works on Pages). */
export async function fetchLmrFromWorker(algebraicMoves, timeSec = 10, idDepth = 8, maxReduction = 0.5) {
  await ensureCatWorkerReady();
  const result = await postCatWorkerMessage(
    'lmr',
    { moves: algebraicMoves ?? [], timeMs: Math.round(timeSec * 1000), idDepth, maxExtra: maxReduction },
    30_000,
  );
  return result.data;
}

async function fetchCatSnapshotFromWasm(algebraicMoves) {
  if (!wasmCatInitPromise) {
    wasmCatInitPromise = import('../wasm/titanium/titanium.js').then(async (mod) => {
      await mod.default({ thread_stack_size: WASM_THREAD_STACK_SIZE });
      return mod;
    });
  }
  const mod = await wasmCatInitPromise;
  if (typeof mod.cat_snapshot !== 'function') {
    throw new Error('WASM build missing cat_snapshot export — run npm run build:wasm');
  }
  return JSON.parse(mod.cat_snapshot((algebraicMoves ?? []).join(' ')));
}

/** Unreachable sealed square — only case that gets a dark skip overlay. */
export function isSquareSkipped(reachable) {
  return reachable === false;
}

const DEFAULT_COLD_CM = 60;
const DEFAULT_HOT_CM = 160;
// Per-player corridor ceiling: CAT_CORRIDOR_CM + BOTTLENECK_BONUS_CM (engine constants).
const DEFAULT_MAX_CM = 240;

// Fixed normalized position of the hot threshold on the color ramp.
// The caller chooses the scale; boardView uses current-position maxima so the
// strongest visible CAT scores in this position actually pop.

const HOT_ANCHOR_T = 0.55;

function heatColorParts(heat, scale = {}) {
  const t = catHeatT(heat, scale);
  const colorT = Math.pow(t, 0.8);
  const hue = Math.round(58 * (1 - colorT));
  const sat = Math.round(76 + 18 * colorT);
  const light = Math.round(62 - 14 * colorT);
  return { t, hue, sat, light };
}

/**
 * CAT heat -> normalized 0..1 ramp position. The UI can pass `coldCm: 0`
 * to show every positive impact while choosing whether the max is fixed or
 * current-position relative.
 */
export function catHeatT(heat, scale = {}) {
  const coldCm = scale.coldCm ?? DEFAULT_COLD_CM;
  const hotCm = Math.max(scale.hotCm ?? DEFAULT_HOT_CM, coldCm + 1);
  const maxCm = Math.max(scale.maxCm ?? DEFAULT_MAX_CM, hotCm + 1);
  if (!Number.isFinite(heat) || heat < coldCm) {
    return 0;
  }
  if (heat >= hotCm) {
    return HOT_ANCHOR_T + (1 - HOT_ANCHOR_T) * Math.min(1, (heat - hotCm) / (maxCm - hotCm));
  }
  return HOT_ANCHOR_T * ((heat - coldCm) / (hotCm - coldCm));
}

/** CAT heat -> color. Positive heat can be rendered faintly; callers choose the scale. */
export function catSquareOverlay(heat, reachable, scale = {}) {
  if (isSquareSkipped(reachable)) {
    return null;
  }
  if (!Number.isFinite(heat) || heat <= 0) {
    return null;
  }
  const coldCm = scale.coldCm ?? DEFAULT_COLD_CM;
  if (heat < coldCm) {
    return null;
  }
  const { t, hue, sat, light } = heatColorParts(heat, scale);
  // Yellow (55°) → orange → red (0°); alpha ramps so even the coolest warm
  // square reads against the background instead of vanishing into it.
  const alpha = Math.min(0.7, 0.1 + 0.58 * Math.pow(t, 0.9));
  return {
    fill: `hsla(${hue}, ${sat}%, ${light}%, ${alpha.toFixed(2)})`,
    opacity: 1,
  };
}

/** Fill/glow for wall hints. Low positive scores stay faint; hot walls pop. */
export function catWallOverlay(heat, scale = {}) {
  if (!Number.isFinite(heat) || heat <= 0) {
    return {
      fill: 'rgba(120, 115, 105, 0.18)',
      glow: 'rgba(120, 115, 105, 0.08)',
    };
  }
  const coldCm = scale.coldCm ?? DEFAULT_COLD_CM;
  if (heat < coldCm) {
    return {
      fill: 'rgba(120, 115, 105, 0.18)',
      glow: 'rgba(120, 115, 105, 0.08)',
    };
  }
  const { t, hue, sat, light } = heatColorParts(heat, scale);
  const fillAlpha = Math.min(0.76, 0.08 + 0.66 * Math.pow(t, 0.95));
  const glowAlpha = Math.min(0.48, 0.035 + 0.4 * Math.pow(t, 1.05));
  return {
    fill: `hsla(${hue}, ${sat}%, ${light}%, ${fillAlpha.toFixed(2)})`,
    glow: `hsla(${hue}, ${sat}%, ${light}%, ${glowAlpha.toFixed(2)})`,
  };
}

/**
 * @param {string[]} algebraicMoves
 */
export async function fetchCatSnapshot(algebraicMoves) {
  const key = catMovesKey(algebraicMoves);
  const cached = cachedCatSnapshot(key);
  if (cached) {
    return cached;
  }

  try {
    return await rememberCatSnapshot(key, fetchCatSnapshotFromWorker(algebraicMoves));
  } catch (workerErr) {
    try {
      return await rememberCatSnapshot(key, fetchCatSnapshotFromWasm(algebraicMoves));
    } catch (wasmErr) {
    // Dev fallback: the Vite proxy shells out to the native binary. It is useful
    // when wasm failed to initialize, but it is much slower than the in-process
    // wasm call because it pays process startup on each request.
      const res = await fetch('/api/titanium/cat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ moves: algebraicMoves }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error ?? `CAT request failed (${res.status})`);
      }
      catSnapshotCache.set(key, { data, promise: Promise.resolve(data) });
      return data;
    }
  }
}

/**
 * Warm the dedicated CAT vision worker and optionally precompute this position.
 * Fire-and-forget callers should catch/log; foreground callers use fetchCatSnapshot.
 *
 * @param {string[]} algebraicMoves
 */
export async function prewarmCatSnapshot(algebraicMoves = []) {
  const key = catMovesKey(algebraicMoves);
  const cached = cachedCatSnapshot(key);
  if (cached) {
    await cached;
    return;
  }
  try {
    await rememberCatSnapshot(key, fetchCatSnapshotFromWorker(algebraicMoves));
  } catch (err) {
    console.warn('CAT vision worker prewarm failed; foreground request will retry/fallback', err);
  }
}

/**
 * @param {Array<{alg: string, heat: number, directHeat?: number, search?: boolean, attention?: boolean, skip?: boolean, pruned?: boolean}>} walls
 * @returns {Map<string, {heat: number, directHeat: number, search: boolean, attention: boolean, skip: boolean}>}
 */
export function indexCatWalls(walls) {
  const map = new Map();
  for (const entry of walls ?? []) {
    if (!entry?.alg) {
      continue;
    }
    const skip = entry.skip ?? entry.pruned ?? false;
    const search = entry.search ?? !skip;
    map.set(entry.alg, {
      heat: entry.heat ?? 0,
      directHeat: entry.directHeat ?? entry.heat ?? 0,
      search,
      attention: entry.attention ?? search,
      skip,
    });
  }
  return map;
}

/**
 * Board-renderer row/col 0..8 → Rust CAT square index.
 *
 * The renderer stores row 0 at the top of the screen. Rust core stores row 0
 * at White's home rank (`1`), so raw CAT square arrays need a vertical flip.
 */
export function catSquareIndex(engineRow, engineCol) {
  return (8 - engineRow) * 9 + engineCol;
}
