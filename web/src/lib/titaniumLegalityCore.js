/**
 * Shared Titanium WASM legality enumeration — no platform-specific init.
 */

import { WasmEngine } from '../wasm/titanium/titanium.js';
import { QuoridorBoard, parseAlgebraic } from './gameLogic.js';
import { legalMovesFromBoard } from './canonicalState.js';

export const ORACLE_SOURCE = 'titanium-wasm-legality';
export const INVALID_TITANIUM_POSITION_CODE = 'INVALID_TITANIUM_POSITION';

function invalidPositionError(message, cause) {
  const err = new Error(message, cause ? { cause } : undefined);
  err.code = INVALID_TITANIUM_POSITION_CODE;
  return err;
}

function canonicalCandidatesFromHistory(historyTokens) {
  const board = new QuoridorBoard();
  for (const token of historyTokens) {
    board.takeAction(parseAlgebraic(String(token)));
  }
  return legalMovesFromBoard(board);
}

function titaniumAcceptsMove(historyTokens, move) {
  // Fresh engine per candidate — never reuse one board across make_move probes.
  const engine = new WasmEngine(0);
  engine.reset();
  const history = historyTokens.map(String);
  if (history.length > 0) {
    try {
      const plies = engine.position(history.join(' '));
      if (plies !== history.length) {
        return false;
      }
    } catch {
      return false;
    }
  }
  try {
    return engine.make_move(String(move));
  } catch {
    return false;
  }
}

function replayHistoryPlies(history) {
  const engine = new WasmEngine(0);
  engine.reset();
  if (history.length === 0) {
    return { engine, plies: 0 };
  }
  const plies = engine.position(history.join(' '));
  return { engine, plies };
}

/** Ensure WASM position replay is unchanged after filtering all canonical candidates. */
export function assertEnumerationPreservesPosition(historyTokens) {
  const history = historyTokens.map(String);
  const { plies: pliesBefore } = replayHistoryPlies(history);
  if (history.length > 0 && pliesBefore !== history.length) {
    throw invalidPositionError(
      `Titanium position replay mismatch: expected ${history.length} plies, got ${pliesBefore}`,
    );
  }

  enumerateTitaniumLegalMoves(history);

  const { plies: pliesAfter } = replayHistoryPlies(history);
  if (pliesAfter !== pliesBefore) {
    throw new Error(
      `enumeration mutated position: plies before ${pliesBefore} after ${pliesAfter}`,
    );
  }
}

export function enumerateTitaniumLegalMoves(historyTokens) {
  const history = historyTokens.map(String);
  if (history.length > 0) {
    const probe = new WasmEngine(false);
    probe.reset();
    try {
      const plies = probe.position(history.join(' '));
      if (plies !== history.length) {
        throw invalidPositionError(
          `Titanium position replay mismatch: expected ${history.length} plies, got ${plies}`,
        );
      }
    } catch (err) {
      if (err?.code === INVALID_TITANIUM_POSITION_CODE) {
        throw err;
      }
      throw invalidPositionError(
        err?.message ?? 'Titanium position replay failed',
        err,
      );
    }
  }

  const candidates = canonicalCandidatesFromHistory(history);
  const confirmed = [];
  for (const move of candidates) {
    if (titaniumAcceptsMove(history, move)) {
      confirmed.push(move);
    }
  }
  return confirmed;
}

export function createSerializedLegalMovesRunner() {
  let queue = Promise.resolve();

  return function runSerialized(operation) {
    const task = queue.then(operation, operation);
    queue = task.catch(() => {});
    return task;
  };
}
