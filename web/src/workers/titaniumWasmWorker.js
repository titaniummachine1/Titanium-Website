/**
 * Titanium v15 in a Web Worker — Rust engine compiled to WebAssembly.
 * Supports live NNUE (`titanium-v15`) and frozen baseline (`titanium-v15-frozen`).
 */

import init, { WasmEngine } from '../wasm/titanium/titanium.js';

let initPromise = null;
/** @type {Map<string, import('../wasm/titanium/titanium.js').WasmEngine>} */
const engines = new Map();

async function ensureInit() {
  if (!initPromise) {
    initPromise = init();
  }
  await initPromise;
}

async function ensureEngine(engineMode = 'titanium-v15') {
  await ensureInit();
  if (!engines.has(engineMode)) {
    const frozen = engineMode === 'titanium-v15-frozen';
    engines.set(engineMode, new WasmEngine(frozen));
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

self.onmessage = async (event) => {
  const { algebraicMoves, timeMs, maxNodes, isFreshGame, engineMode = 'titanium-v15' } =
    event.data ?? {};
  try {
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

    const onProgress = (jsonStr) => {
      const data = parseProgressJson(jsonStr);
      if (!data) {
        return;
      }
      self.postMessage({
        type: 'info',
        thinking: true,
        ...data,
        mode: data.engine ?? data.stoppedBy ?? engineMode,
      });
    };

    const best = wasm.go(Math.max(1, timeMs ?? 10_000), maxNodes ?? 0, onProgress);
    if (!best || best === '(none)') {
      self.postMessage({ type: 'error', message: 'WASM engine returned no legal move' });
      return;
    }
    self.postMessage({
      type: 'bestmove',
      algebraicMove: best,
      stoppedBy: engineMode,
      mode: engineMode,
    });
  } catch (err) {
    self.postMessage({
      type: 'error',
      message: err?.message ?? String(err),
    });
  }
};
