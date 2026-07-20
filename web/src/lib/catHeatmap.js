/** CAT v7 Plane 4 heat → board overlays (final reinforced attention). */

import CatVisionWorker from '../workers/catVisionWorker.js?worker';

const VISION_TUNING_KEY = 'quoridor-vision-tuning-v1';
/** Must match engine `CAT_V7_PLANE4_SCHEMA`. */
export const CAT_V7_PLANE4_SCHEMA = 'cat-v7-plane4-v1';

let wasmCatInitPromise = null;
let wasmCatEngine = null;
let catWorker = null;
let catWorkerRequestId = 1;
let catWorkerReadyPromise = null;
let catWorkerFailed = false;
const catWorkerPending = new Map();
const catSnapshotCache = new Map();
const CAT_SNAPSHOT_CACHE_LIMIT = 16;
const WASM_THREAD_STACK_SIZE = 4 << 20;

export const LMR_AGGRESSION_DEFAULT = -177;

const visionTuning = {
  pathBiasPercent: 0,
  lmrAggressionPercent: LMR_AGGRESSION_DEFAULT,
  generation: 0,
};

function clampPathBiasPercent(value) {
  return 0;
}

function clampLmrAggressionPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return LMR_AGGRESSION_DEFAULT;
  }
  return Math.min(150, Math.max(-500, Math.trunc(n)));
}

function migrateLegacyLmrPercent(saved, fallback = 100) {
  if (saved?.lmrAggressionPercent != null) {
    return clampLmrAggressionPercent(saved.lmrAggressionPercent);
  }
  if (saved?.lmrAggressiveness != null) {
    return clampLmrAggressionPercent(fallback);
  }
  return clampLmrAggressionPercent(fallback);
}

export function getVisionTuning() {
  return { ...visionTuning };
}

export function loadVisionTuningFromStorage() {
  try {
    const raw = localStorage.getItem(VISION_TUNING_KEY);
    if (!raw) {
      return visionTuning;
    }
    const saved = JSON.parse(raw);
    visionTuning.pathBiasPercent = clampPathBiasPercent(saved.pathBiasPercent);
    visionTuning.lmrAggressionPercent = migrateLegacyLmrPercent(saved, LMR_AGGRESSION_DEFAULT);
  } catch {
    // keep defaults
  }
  return visionTuning;
}

export function saveVisionTuningToStorage() {
  try {
    localStorage.setItem(
      VISION_TUNING_KEY,
      JSON.stringify({
        pathBiasPercent: visionTuning.pathBiasPercent,
        lmrAggressionPercent: visionTuning.lmrAggressionPercent,
      }),
    );
  } catch {
    // ignore quota errors
  }
}

/** Apply visualization tuning for the CAT vision worker. Path tilt is currently disabled. */
export function applyVisionTuning(patch = {}, { bumpGeneration = true } = {}) {
  if (patch.pathBiasPercent != null) {
    visionTuning.pathBiasPercent = clampPathBiasPercent(patch.pathBiasPercent);
  }
  if (patch.lmrAggressionPercent != null) {
    visionTuning.lmrAggressionPercent = clampLmrAggressionPercent(patch.lmrAggressionPercent);
  }
  if (bumpGeneration) {
    visionTuning.generation += 1;
  }
  catSnapshotCache.clear();
  saveVisionTuningToStorage();
  void pushVisionConfigToWorker();
  return { ...visionTuning };
}

export function normalizeCatSource(source) {
  return source === 'current' ? 'current' : 'v7';
}

function catMovesKey(algebraicMoves, source = 'v7') {
  const normalizedSource = normalizeCatSource(source);
  return [
    normalizedSource,
    (algebraicMoves ?? []).join('|'),
    `pb${visionTuning.pathBiasPercent}`,
    `la${visionTuning.lmrAggressionPercent}`,
    `g${visionTuning.generation}`,
  ].join('|');
}

/** Reject legacy CAT payloads so they cannot be labeled or cached as v7. */
export function assertCatV7Plane4(data) {
  if (
    !data ||
    data.schema !== CAT_V7_PLANE4_SCHEMA ||
    data.catVersion !== 'v7' ||
    Number(data.plane) !== 4
  ) {
    throw new Error(
      `CAT Vision requires v7 Plane 4 (${CAT_V7_PLANE4_SCHEMA}). Rebuild WASM with npm run build:wasm`,
    );
  }
  if (!Array.isArray(data.squares) || data.squares.length !== 81) {
    throw new Error('CAT v7 Plane 4 snapshot missing 81-square attention array');
  }
  return data;
}

/** Validate and preserve the payload shape selected by the caller. */
export function normalizeCatSnapshot(data, source = 'v7') {
  const normalizedSource = normalizeCatSource(source);
  if (normalizedSource === 'v7') {
    return assertCatV7Plane4(data);
  }
  if (!data || !Array.isArray(data.squares) || data.squares.length !== 81) {
    throw new Error('Current CAT snapshot missing 81-square production corridor array');
  }
  return data;
}

async function pushVisionConfigToWorker() {
  if (!catWorker || catWorkerFailed) {
    return;
  }
  try {
    await ensureCatWorkerReady();
    await postCatWorkerMessage(
      'setConfig',
      {
        pathBiasPercent: visionTuning.pathBiasPercent,
        lmrAggressionPercent: visionTuning.lmrAggressionPercent,
        generation: visionTuning.generation,
      },
      10_000,
    );
  } catch {
    // worker will pick up config on next init
  }
}

function isStaleWorkerResponse(data, requestGeneration) {
  return data?.generation != null && data.generation !== requestGeneration;
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
  const requestGeneration = visionTuning.generation;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      catWorkerPending.delete(id);
      reject(new Error(`CAT vision worker ${op} timed out`));
    }, timeoutMs);
    catWorkerPending.set(id, {
      resolve: (data) => {
        if (isStaleWorkerResponse(data, requestGeneration)) {
          reject(new Error('CAT vision worker response stale (config changed)'));
          return;
        }
        resolve(data);
      },
      reject,
      timeout,
    });
    worker.postMessage({
      id,
      op,
      pathBiasPercent: visionTuning.pathBiasPercent,
      lmrAggressionPercent: visionTuning.lmrAggressionPercent,
      generation: visionTuning.generation,
      ...payload,
    });
  });
}

async function ensureCatWorkerReady() {
  if (!catWorkerReadyPromise) {
    catWorkerReadyPromise = postCatWorkerMessage(
      'init',
      {
        pathBiasPercent: visionTuning.pathBiasPercent,
        lmrAggressionPercent: visionTuning.lmrAggressionPercent,
        generation: visionTuning.generation,
      },
      60_000,
    ).catch((err) => {
      catWorkerReadyPromise = null;
      throw err;
    });
  }
  return catWorkerReadyPromise;
}

async function fetchCatSnapshotFromWorker(algebraicMoves, source = 'v7') {
  await ensureCatWorkerReady();
  const normalizedSource = normalizeCatSource(source);
  const op = normalizedSource === 'v7' ? 'snapshotV7' : 'snapshot';
  const result = await postCatWorkerMessage(op, { moves: algebraicMoves ?? [] }, 30_000);
  return normalizeCatSnapshot(result.data, normalizedSource);
}

/** LMR plan via the same warm CAT engine (no server needed — works on Pages). */
export async function fetchLmrFromWorker(algebraicMoves, timeSec = 10, idDepth = 8) {
  await ensureCatWorkerReady();
  const result = await postCatWorkerMessage(
    'lmr',
    {
      moves: algebraicMoves ?? [],
      timeMs: Math.round(timeSec * 1000),
      idDepth,
    },
    30_000,
  );
  return result.data;
}

async function fetchCatSnapshotFromWasm(algebraicMoves, source = 'v7') {
  if (!wasmCatInitPromise) {
    wasmCatInitPromise = import('../wasm/titanium/titanium.js').then(async (mod) => {
      await mod.default({ thread_stack_size: WASM_THREAD_STACK_SIZE });
      if (typeof mod.WasmCatEngine !== 'function') {
        throw new Error('WASM build missing WasmCatEngine — run npm run build:wasm');
      }
      wasmCatEngine = new mod.WasmCatEngine();
      return mod;
    });
  }
  await wasmCatInitPromise;
  const normalizedSource = normalizeCatSource(source);
  const method =
    normalizedSource === 'v7' ? 'snapshot_v7' : 'snapshot';
  if (!wasmCatEngine || typeof wasmCatEngine[method] !== 'function') {
    throw new Error(`WASM build missing WasmCatEngine.${method} — run npm run build:wasm`);
  }
  return normalizeCatSnapshot(
    JSON.parse(wasmCatEngine[method]((algebraicMoves ?? []).join(' '))),
    normalizedSource,
  );
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
// The caller supplies the value scale; v7 square attention uses a fixed u8 scale.

const HOT_ANCHOR_T = 0.55;

function heatColorParts(heat, scale = {}) {
  const t = catHeatT(heat, scale);
  const colorT = Math.pow(t, 0.8);
  const hue = Math.round(58 * (1 - colorT));
  const sat = Math.round(76 + 18 * colorT);
  const light = Math.round(62 - 14 * colorT);
  return { t, hue, sat, light };
}

function resolveCatHeatScale(scale = {}) {
  const isU8 = scale.valueScale === 'u8';
  const cold = isU8
    ? (scale.cold ?? 1)
    : (scale.cold ?? scale.coldCm ?? DEFAULT_COLD_CM);
  const hot = isU8
    ? (scale.hot ?? 178)
    : (scale.hot ?? scale.hotCm ?? DEFAULT_HOT_CM);
  const max = isU8
    ? (scale.max ?? 255)
    : (scale.max ?? scale.maxCm ?? DEFAULT_MAX_CM);
  return {
    cold: Number(cold) || 0,
    hot: Math.max(Number(hot) || 0, (Number(cold) || 0) + 1),
    max: Math.max(Number(max) || 0, (Number(hot) || 0) + 1),
  };
}

/** CAT heat -> normalized 0..1 ramp position for any CAT value scale. */
export function catHeatT(heat, scale = {}) {
  const { cold, hot, max } = resolveCatHeatScale(scale);
  const value = Number(heat);
  if (!Number.isFinite(value) || value < cold) {
    return 0;
  }
  if (value >= hot) {
    return HOT_ANCHOR_T + (1 - HOT_ANCHOR_T) * Math.min(1, (value - hot) / (max - hot));
  }
  return HOT_ANCHOR_T * ((value - cold) / (hot - cold));
}

/** CAT heat -> color. Positive heat can be rendered faintly; callers choose the scale. */
export function catSquareOverlay(heat, reachable, scale = {}) {
  if (isSquareSkipped(reachable)) {
    return null;
  }
  const value = Number(heat);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  const { cold } = resolveCatHeatScale(scale);
  if (value < cold) {
    return null;
  }
  const { t, hue, sat, light } = heatColorParts(value, scale);
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
  const value = Number(heat);
  if (!Number.isFinite(value) || value <= 0) {
    return {
      fill: 'rgba(120, 115, 105, 0.18)',
      glow: 'rgba(120, 115, 105, 0.08)',
    };
  }
  const { cold } = resolveCatHeatScale(scale);
  if (value < cold) {
    return {
      fill: 'rgba(120, 115, 105, 0.18)',
      glow: 'rgba(120, 115, 105, 0.08)',
    };
  }
  const { t, hue, sat, light } = heatColorParts(value, scale);
  const fillAlpha = Math.min(0.76, 0.08 + 0.66 * Math.pow(t, 0.95));
  const glowAlpha = Math.min(0.48, 0.035 + 0.4 * Math.pow(t, 1.05));
  return {
    fill: `hsla(${hue}, ${sat}%, ${light}%, ${fillAlpha.toFixed(2)})`,
    glow: `hsla(${hue}, ${sat}%, ${light}%, ${glowAlpha.toFixed(2)})`,
  };
}

/**
 * @param {string[]} algebraicMoves
 * @param {{source?: 'current'|'v7'}} options
 */
export async function fetchCatSnapshot(algebraicMoves, { source = 'v7' } = {}) {
  const normalizedSource = normalizeCatSource(source);
  const key = catMovesKey(algebraicMoves, normalizedSource);
  const cached = cachedCatSnapshot(key);
  if (cached) {
    return cached;
  }

  try {
    return await rememberCatSnapshot(
      key,
      fetchCatSnapshotFromWorker(algebraicMoves, normalizedSource),
    );
  } catch (workerErr) {
    try {
      return await rememberCatSnapshot(
        key,
        fetchCatSnapshotFromWasm(algebraicMoves, normalizedSource),
      );
    } catch (wasmErr) {
      const method = normalizedSource === 'v7' ? 'snapshot_v7' : 'snapshot';
      const message = [
        `CAT Vision needs WasmCatEngine.${method} for ${normalizedSource} source.`,
        'Run `npm run build:wasm` from site/web.',
        `Worker: ${workerErr?.message ?? workerErr}`,
        `WASM: ${wasmErr?.message ?? wasmErr}`,
      ].join(' ');
      throw new Error(message);
    }
  }
}

/**
 * Warm the dedicated CAT vision worker and optionally precompute this position.
 * Fire-and-forget callers should catch/log; foreground callers use fetchCatSnapshot.
 *
 * @param {string[]} algebraicMoves
 * @param {{source?: 'current'|'v7'}} options
 */
export async function prewarmCatSnapshot(algebraicMoves = [], { source = 'v7' } = {}) {
  const normalizedSource = normalizeCatSource(source);
  const key = catMovesKey(algebraicMoves, normalizedSource);
  const cached = cachedCatSnapshot(key);
  if (cached) {
    await cached;
    return;
  }
  try {
    await rememberCatSnapshot(
      key,
      fetchCatSnapshotFromWorker(algebraicMoves, normalizedSource),
    );
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

loadVisionTuningFromStorage();
