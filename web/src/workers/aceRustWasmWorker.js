/**
 * ACE Rust (MoveGen+ / native port) in a Web Worker — compiled to WebAssembly.
 * Streams iterative-deepening progress like Titanium WASM.
 */

import init, { WasmAceEngine } from '../wasm/titanium/titanium.js';

let engine = null;
let initPromise = null;

async function ensureEngine() {
  if (!initPromise) {
    initPromise = init().then(() => {
      engine = new WasmAceEngine();
    });
  }
  await initPromise;
  return engine;
}

function parseProgressJson(jsonStr) {
  try {
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

self.onmessage = async (event) => {
  const { algebraicMoves, timeMs, maxDepth, engineMode } = event.data ?? {};
  try {
    const wasm = await ensureEngine();
    const history = algebraicMoves ?? [];
    const mode = engineMode ?? 'ace-v13-ti';
    let finalMeta = {};

    const onProgress = (jsonStr) => {
      const data = parseProgressJson(jsonStr);
      if (!data) {
        return;
      }
      finalMeta = {
        ...finalMeta,
        ...data,
        stoppedBy: data.engine ?? data.stoppedBy ?? mode,
        mode: data.engine ?? data.stoppedBy ?? mode,
      };
      self.postMessage({
        type: 'info',
        thinking: true,
        ...finalMeta,
      });
    };

    const best = wasm.genmove(
      history.join(' '),
      Math.max(1, timeMs ?? 2000),
      maxDepth ?? 30,
      mode,
      onProgress,
    );
    if (!best || best === '(none)') {
      self.postMessage({ type: 'error', message: 'ACE WASM returned no legal move' });
      return;
    }
    self.postMessage({
      type: 'bestmove',
      algebraicMove: best,
      stoppedBy: finalMeta.stoppedBy ?? mode,
      mode: finalMeta.mode ?? mode,
      nodes: finalMeta.nodes ?? 0,
      searchDepth: finalMeta.searchDepth,
      depthLog: finalMeta.depthLog,
      rootScore: finalMeta.rootScore,
      whiteDist: finalMeta.whiteDist,
      blackDist: finalMeta.blackDist,
      elapsedMs: finalMeta.elapsedMs,
    });
  } catch (err) {
    self.postMessage({
      type: 'error',
      message: err?.message ?? String(err),
    });
  }
};
