/**
 * ACE Rust (MoveGen+ / native port) in a Web Worker — compiled to WebAssembly.
 * Streams iterative-deepening progress like Titanium WASM.
 */

import init, * as titaniumWasm from '../wasm/titanium/titanium.js';

const WASM_THREAD_STACK_SIZE = 4 << 20;
let engine = null;
let initPromise = null;

async function ensureEngine() {
  if (!initPromise) {
    initPromise = init({ thread_stack_size: WASM_THREAD_STACK_SIZE }).then(() => {
      if (typeof titaniumWasm.WasmAceEngine !== 'function') {
        throw new Error(
          'ACE Rust WASM artifact is unavailable in this build; use ACE v13 JS or rebuild with WasmAceEngine export',
        );
      }
      engine = new titaniumWasm.WasmAceEngine();
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

function mergeDepthLogs(existing, incoming) {
  const byDepth = new Map((existing ?? []).map((entry) => [entry.depth, entry]));
  for (const entry of incoming ?? []) {
    byDepth.set(entry.depth, entry);
  }
  return [...byDepth.values()].sort((a, b) => a.depth - b.depth);
}

self.onmessage = async (event) => {
  const { seq, algebraicMoves, timeMs, maxDepth, engineMode } = event.data ?? {};
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
        depthLog: mergeDepthLogs(finalMeta.depthLog, data.depthLog),
      };
      self.postMessage({
        type: 'info',
        seq,
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
      self.postMessage({ type: 'error', seq, message: 'ACE WASM returned no legal move' });
      return;
    }
    self.postMessage({
      type: 'bestmove',
      seq,
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
    const panic = typeof titaniumWasm.last_panic === 'function' ? titaniumWasm.last_panic() : '';
    const base = err?.message ?? String(err);
    const message = panic && !base.includes(panic) ? `${base} | ${panic}` : base;
    self.postMessage({ type: 'error', seq, message });
  }
};
