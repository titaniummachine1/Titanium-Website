/**
 * Browser legality runtime.
 * GitHub Pages: JS board only — the search worker owns the sole WASM instance.
 * Dev native proxy: WASM legality via titanium.exe path is unused; WASM oracle when opted in.
 */

import init from '../wasm/titanium/titanium.js';
import { parseAlgebraic, QuoridorBoard, toAlgebraic } from './gameLogic.js';
import {
  ORACLE_SOURCE,
  createSerializedLegalMovesRunner,
  enumerateTitaniumLegalMoves,
} from './titaniumLegalityCore.js';
import { hasNativeTitaniumLazySmp } from './titaniumRuntime.js';

const JS_BOARD_SOURCE = 'js-board-legality';

let initPromise = null;

async function ensureWasmInit() {
  if (!initPromise) {
    initPromise = init();
  }
  await initPromise;
}

function createJsBoardLegalityRuntime() {
  return {
    source: JS_BOARD_SOURCE,
    getLegalMoves({ historyTokens = [], signal }) {
      if (signal?.aborted) {
        throw new DOMException('Legality request aborted', 'AbortError');
      }
      const board = new QuoridorBoard();
      for (const token of historyTokens) {
        board.takeAction(parseAlgebraic(String(token)));
      }
      return board.validActions().map((action) => toAlgebraic(action));
    },
  };
}

/**
 * @returns {Promise<{ getLegalMoves: Function, source: string }>}
 */
export async function createTitaniumLegalityRuntime() {
  if (!hasNativeTitaniumLazySmp()) {
    return createJsBoardLegalityRuntime();
  }

  await ensureWasmInit();
  const runSerialized = createSerializedLegalMovesRunner();

  return {
    source: ORACLE_SOURCE,
    getLegalMoves({ historyTokens = [], signal }) {
      if (signal?.aborted) {
        throw new DOMException('Legality request aborted', 'AbortError');
      }

      return runSerialized(() => {
        if (signal?.aborted) {
          throw new DOMException('Legality request aborted', 'AbortError');
        }
        return enumerateTitaniumLegalMoves(historyTokens);
      });
    },
  };
}
