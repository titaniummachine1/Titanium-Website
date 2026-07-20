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

let pathBiasPercent = 0;
let lmrAggressionPercent = -177;
let catConfigGeneration = 0;

function clampPathBiasPercent(value) {
  return 0;
}

function clampLmrAggressionPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return -177;
  }
  return Math.min(150, Math.max(-500, Math.trunc(n)));
}

function pathBiasBasisPoints() {
  return clampPathBiasPercent(pathBiasPercent) * 100;
}

function applyVisionConfig(config = {}) {
  if (config.pathBiasPercent != null) {
    pathBiasPercent = clampPathBiasPercent(config.pathBiasPercent);
  }
  if (config.lmrAggressionPercent != null) {
    lmrAggressionPercent = clampLmrAggressionPercent(config.lmrAggressionPercent);
  }
  if (config.generation != null && Number.isFinite(Number(config.generation))) {
    catConfigGeneration = Math.trunc(Number(config.generation));
  }
  if (catEngine && typeof catEngine.set_cat_distance_bias_bp === 'function') {
    catEngine.set_cat_distance_bias_bp(pathBiasBasisPoints());
  }
}

async function ensureInit() {
  if (!initPromise) {
    initPromise = init({ module_or_path: wasmUrl, thread_stack_size: WASM_THREAD_STACK_SIZE }).then(
      () => {
        catEngine = new WasmCatEngine();
        applyVisionConfig({
          pathBiasPercent,
          lmrAggressionPercent,
          generation: catConfigGeneration,
        });
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

async function handleInit(id, config) {
  const started = performance.now();
  applyVisionConfig(config ?? {});
  await ensureInit();
  self.postMessage({
    type: 'ready',
    id,
    initMs: performance.now() - started,
    buildMeta,
    rustIdentity: parseIdentity(),
    pathBiasPercent,
    lmrAggressionPercent,
    generation: catConfigGeneration,
  });
}

async function handleSetConfig(id, config) {
  await ensureInit();
  applyVisionConfig(config ?? {});
  self.postMessage({
    type: 'config',
    id,
    pathBiasPercent,
    lmrAggressionPercent,
    generation: catConfigGeneration,
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
    generation: catConfigGeneration,
    pathBiasPercent,
    data: JSON.parse(json),
  });
}

async function handleSnapshotV7(id, moves) {
  await ensureInit();
  if (!catEngine) {
    throw new Error('WASM build missing WasmCatEngine export - run npm run build:wasm');
  }
  if (typeof catEngine.snapshot_v7 !== 'function') {
    throw new Error('WASM build missing WasmCatEngine.snapshot_v7 - run npm run build:wasm');
  }
  const json = catEngine.snapshot_v7((moves ?? []).join(' '));
  self.postMessage({
    type: 'snapshotV7',
    id,
    generation: catConfigGeneration,
    pathBiasPercent,
    data: JSON.parse(json),
  });
}

async function handleLmrSnapshot(id, moves, timeMs, idDepth) {
  await ensureInit();
  if (!catEngine || typeof catEngine.lmr_snapshot !== 'function') {
    throw new Error('WASM build missing WasmCatEngine.lmr_snapshot - run npm run build:wasm');
  }
  const json = catEngine.lmr_snapshot(
    (moves ?? []).join(' '),
    timeMs >>> 0,
    idDepth >>> 0,
    lmrAggressionPercent,
  );
  self.postMessage({
    type: 'lmr',
    id,
    generation: catConfigGeneration,
    lmrAggressionPercent,
    data: JSON.parse(json),
  });
}

self.onmessage = async (event) => {
  const data = event.data ?? {};
  const id = data.id ?? 0;
  try {
    if (data.op === 'init') {
      await handleInit(id, {
        pathBiasPercent: data.pathBiasPercent,
        lmrAggressionPercent: data.lmrAggressionPercent,
        generation: data.generation,
      });
      return;
    }
    if (data.op === 'setConfig') {
      await handleSetConfig(id, {
        pathBiasPercent: data.pathBiasPercent,
        lmrAggressionPercent: data.lmrAggressionPercent,
        generation: data.generation,
      });
      return;
    }
    if (data.op === 'snapshot') {
      await handleSnapshot(id, data.moves ?? []);
      return;
    }
    if (data.op === 'v7' || data.op === 'snapshotV7') {
      await handleSnapshotV7(id, data.moves ?? []);
      return;
    }
    if (data.op === 'lmr') {
      await handleLmrSnapshot(
        id,
        data.moves ?? [],
        data.timeMs ?? 10_000,
        data.idDepth ?? 8,
      );
      return;
    }
    throw new Error(`Unknown CAT worker op: ${data.op ?? '(missing)'}`);
  } catch (err) {
    self.postMessage({
      type: 'error',
      id,
      generation: catConfigGeneration,
      message: err?.message ?? String(err),
    });
  }
};
