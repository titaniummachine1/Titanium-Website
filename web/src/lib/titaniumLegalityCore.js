/**
 * Shared Titanium WASM legality enumeration — no platform-specific init.
 *
 * Uses a single WasmEngine instance per call via `legal_moves_current()`.
 * Never creates one engine per move candidate (that exhausted WASM heap at 131+ instances).
 */

import { WasmEngine } from '../wasm/titanium/titanium.js';

export const ORACLE_SOURCE = 'titanium-wasm-legality';
export const INVALID_TITANIUM_POSITION_CODE = 'INVALID_TITANIUM_POSITION';

function invalidPositionError(message, cause) {
  const err = new Error(message, cause ? { cause } : undefined);
  err.code = INVALID_TITANIUM_POSITION_CODE;
  return err;
}

export function enumerateTitaniumLegalMoves(historyTokens) {
  const history = historyTokens.map(String);
  const engine = new WasmEngine(2);
  engine.reset();

  if (history.length > 0) {
    let plies;
    try {
      plies = engine.position(history.join(' '));
    } catch (err) {
      throw invalidPositionError(err?.message ?? 'Titanium position replay failed', err);
    }
    if (plies !== history.length) {
      throw invalidPositionError(
        `Titanium position replay mismatch: expected ${history.length} plies, got ${plies}`,
      );
    }
  }

  const raw = engine.legal_moves_current();
  if (typeof raw !== 'string') {
    throw new Error('legal_moves_current returned non-string');
  }
  return raw.length > 0 ? raw.split(' ') : [];
}

export function assertEnumerationPreservesPosition(historyTokens) {
  enumerateTitaniumLegalMoves(historyTokens);
}

export function createSerializedLegalMovesRunner() {
  let queue = Promise.resolve();

  return function runSerialized(operation) {
    const task = queue.then(operation, operation);
    queue = task.catch(() => {});
    return task;
  };
}
