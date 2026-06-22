/**
 * quoridor-zero.ink — remote AlphaZero bot exposed over a stateless REST API.
 *
 * Every move is a self-contained POST to the stable `/api/play` endpoint
 * carrying the full position, so this behaves like a local engine client: no
 * session sync. The model is fixed server-side and the server owns the search
 * backend, threads and cpuct — the only knob we send is `visits` (search
 * effort): the player's difficulty (the Time preset) indexes the engine's
 * `visits` map, the same `config.visits[timeToMove]` mechanism the cloud
 * engines use. The server clamps the value to its allowed band.
 *
 * Wire format (POST /api/play, Content-Type: application/json):
 *   Request:  { state: <zero.ink state>, visits }
 *   Response: { move, score, thinkMs, stateAfter }
 *     - move.kind is "pawn" (use target cell) or "wall" (orientation + x,y)
 *     - score is the root eval in [-1, 1] from the side-to-move's perspective
 *     - stateAfter is the full position after the move (incl. winner)
 *   Invalid/finished positions return 400 { error }.
 *
 * The API sends CORS headers (Access-Control-Allow-Origin), so the browser can
 * call it cross-origin directly in every environment — local dev and static
 * GitHub Pages alike. A network/CORS failure surfaces as a clear engine error.
 */

import { QuoridorBoard, toAlgebraic } from './gameLogic.js';
import { boardToZeroInkState, zeroInkMoveToAction, zeroInkMoveToAlgebraic } from './zeroInkCodec.js';
import { createAbortError } from './engineAbort.js';
import { TimeToMove } from './engineConfig.js';

/** Engine host. CORS is enabled server-side, so we call it directly everywhere. */
const ZEROINK_HOST = 'https://quoridor-zero.ink';

export class ZeroInkEngineClient {
  constructor(engineConfig) {
    this.config = engineConfig;
    this.pendingController = null;
    this.queuedRequest = null;
    this.busy = false;
  }

  ponder() {}
  stopPonder() {
    this.setStatus('idle');
  }

  cancelSearch() {
    this.queuedRequest = null;
    if (this.pendingController) {
      this.pendingController.abort();
      this.pendingController = null;
    }
    this.busy = false;
    this.setStatus('idle');
  }

  clearQueuedSearches() {
    this.queuedRequest = null;
  }

  destroy() {
    this.cancelSearch();
  }

  resetConnection() {
    this.destroy();
  }

  makeMoves() {
    this.setStatus('idle');
  }

  requestMove(params) {
    if (this.busy) {
      this.queuedRequest = params;
      return;
    }
    this.startRequest(params);
  }

  drainQueuedRequest() {
    if (!this.queuedRequest) {
      return;
    }
    const next = this.queuedRequest;
    this.queuedRequest = null;
    this.startRequest(next);
  }

  buildBoard(moveHistory) {
    const board = new QuoridorBoard();
    for (const action of moveHistory ?? []) {
      board.takeAction(action);
    }
    return board;
  }

  postJson(path, body, signal) {
    return fetch(`${ZEROINK_HOST}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    }).then(async (response) => {
      if (!response.ok) {
        let detail = `${response.status} ${response.statusText}`;
        try {
          const errBody = await response.json();
          if (errBody?.error) detail = errBody.error;
        } catch {
          /* ignore */
        }
        throw new Error(`zero.ink: ${detail}`);
      }
      return response.json();
    });
  }

  async startRequest(params) {
    const { aiSettings, moveHistory, signal } = params;
    this.busy = true;
    this.setStatus('searching');
    const started = performance.now();

    const board = this.buildBoard(moveHistory);
    const state = boardToZeroInkState(board);
    const timeMode = aiSettings?.timeToMove ?? TimeToMove.Short;
    const visits = this.config?.visits?.[timeMode] ?? this.config?.visits?.[TimeToMove.Short];

    const abort = new AbortController();
    this.pendingController = abort;
    const onExternalAbort = () => abort.abort();
    if (signal) {
      if (signal.aborted) {
        abort.abort();
      } else {
        signal.addEventListener('abort', onExternalAbort, { once: true });
      }
    }

    try {
      const result = await this.postJson(
        '/api/play',
        { state, visits },
        abort.signal,
      );

      const move = result?.move;
      if (!move) {
        throw new Error('zero.ink returned no move');
      }
      const action = zeroInkMoveToAction(move);

      // Safety net: a wrong coordinate mapping would corrupt the game silently.
      if (!board.isValid(action)) {
        throw new Error(
          `zero.ink returned an illegal move (${toAlgebraic(action)}) for this position`,
        );
      }

      const elapsed = performance.now() - started;
      this.finish();
      this.onInfo?.({
        time: elapsed,
        rootWinRate: typeof result.score === 'number' ? result.score : undefined,
        visits,
        pv: zeroInkMoveToAlgebraic(move),
        stoppedBy: 'zeroink',
        mode: 'zeroink',
        progress: 1,
      });
      const outcome = this.onBestMove?.(action);
      if (outcome === 'stale' || outcome === false) {
        this.clearQueuedSearches();
      } else {
        this.drainQueuedRequest();
      }
    } catch (error) {
      const aborted =
        error?.name === 'AbortError' || signal?.aborted || abort.signal.aborted;
      this.finish();
      if (aborted) {
        this.onError?.(createAbortError());
        return;
      }
      this.setStatus('error');
      this.onError?.(error instanceof Error ? error : new Error(String(error)));
      this.drainQueuedRequest();
    } finally {
      if (signal) {
        signal.removeEventListener('abort', onExternalAbort);
      }
    }
  }

  finish() {
    this.pendingController = null;
    this.busy = false;
  }

  setStatus(status) {
    this.onStatus?.(status);
  }
}
