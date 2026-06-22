/**
 * quoridor-zero.ink — remote AlphaZero bot exposed over a stateless REST API.
 *
 * Unlike Ishtar/Ka (WebSocket + UCI session), every move is a self-contained
 * POST carrying the full position, so this behaves like a local engine client:
 * no session sync. See memory/zeroink-api-protocol for the wire format.
 *
 * Move budget is MCTS rollouts (visits), driven by the Rollouts slider — not a
 * time slider. We fire two requests in parallel:
 *   - /api/analysis/policy  (fast): the network's immediate top move + value.
 *     Surfaced as the live best-move ghost + eval while the search runs.
 *   - /api/analysis/search  (visit-bounded): the move actually played
 *     (highest-visit child) plus the refined root value.
 *
 * CORS: quoridor-zero.ink sends no Access-Control-Allow-Origin, so the browser
 * cannot call it cross-origin. In `npm run dev` we go through the Vite proxy
 * (`/zeroink/*`). On static GitHub Pages there is no proxy, so it is unavailable
 * (the fetch fails and we surface a clear error).
 */

import { QuoridorBoard, toAlgebraic } from './gameLogic.js';
import { boardToZeroInkState, zeroInkMoveToAction, zeroInkMoveToAlgebraic } from './zeroInkCodec.js';
import { createAbortError } from './engineAbort.js';
import { clampVisits, isUnlimitedVisits } from './timeControl.js';

const DEFAULT_MODEL = 'resume-188/model_000180';
// zero.ink runs MCTS server-side; it has no "unlimited/time-only" mode.
const ZEROINK_DEFAULT_VISITS = 600;
const ZEROINK_MAX_VISITS = 4000;

/** Same-origin proxied base in dev; direct host otherwise (will CORS-fail on Pages). */
function zeroInkBase() {
  if (import.meta.env?.DEV) {
    return '/zeroink';
  }
  return 'https://quoridor-zero.ink';
}

/** Map the Rollouts budget to a zero.ink MCTS visit count. */
function visitsFromSettings(aiSettings) {
  const raw = aiSettings?.visitsBudget;
  // 0 / unlimited / unset → no time-only mode here, so use a sensible default.
  const budget = !raw || isUnlimitedVisits(raw) ? ZEROINK_DEFAULT_VISITS : clampVisits(raw);
  return Math.max(50, Math.min(ZEROINK_MAX_VISITS, Math.round(budget)));
}

export class ZeroInkEngineClient {
  constructor(engineConfig) {
    this.config = engineConfig;
    this.modelId = engineConfig?.modelId ?? DEFAULT_MODEL;
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
    return fetch(`${zeroInkBase()}${path}`, {
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
    const visits = visitsFromSettings(aiSettings);

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

    // Fast policy preview → live best-move ghost + eval while the search runs.
    this.postJson(
      '/api/analysis/policy',
      { state, modelId: this.modelId },
      abort.signal,
    )
      .then((policy) => {
        if (abort.signal.aborted || !this.busy) return;
        const top = policy?.moves?.[0];
        if (!top) return;
        this.onInfo?.({
          thinking: true,
          mode: 'zeroink',
          pv: zeroInkMoveToAlgebraic(top.move),
          rootWinRate: typeof policy.value === 'number' ? policy.value : undefined,
          visits,
        });
      })
      .catch(() => {
        /* preview is best-effort; the search call carries the real result */
      });

    try {
      const result = await this.postJson(
        '/api/analysis/search',
        {
          state,
          modelId: this.modelId,
          settings: { visits, cpuct: 2.5, batchSize: 16, threads: 4, useDag: true },
        },
        abort.signal,
      );

      const best = result?.moves?.[0];
      if (!best) {
        throw new Error('zero.ink returned no candidate move');
      }
      const action = zeroInkMoveToAction(best.move);

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
        rootWinRate: typeof result.rootValue === 'number' ? result.rootValue : undefined,
        visits: result.totalVisits ?? visits,
        pv: zeroInkMoveToAlgebraic(best.move),
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
