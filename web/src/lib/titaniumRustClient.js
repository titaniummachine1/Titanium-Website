/**

 * Titanium — Rust engine via dev-server session proxy (warm TT per seat).

 * Falls back to one-shot `genmove` for non-minimax engine modes.

 */



import { parseAlgebraic, toAlgebraic } from './gameLogic.js';
import { resolveOnBestMoveResult } from './onBestMoveResult.js';

import { LOCAL_VISITS_RANGE, clampVisits, uctFromStrengthLevel } from './timeControl.js';



const SESSION_URL = '/api/titanium/session';

const GENMOVE_URL = '/api/titanium/genmove';

const AB_ENGINE_MODES = new Set([
  'minimax',
  'ace',
  'ace-v8-js',
  'ace-v8',
  'ace-ti',
  'ace-v8-ti',
  'ace-v8-ti-pmc',
  'ace-cat',
  'ace-v10-js',
  'ace-v10',
  'ace-v10-ti',
  'ace-v10-ti-pmc',
]);

function isAlphaBetaEngineMode(mode) {
  return AB_ENGINE_MODES.has(mode);
}



export class TitaniumEngineClient {

  constructor(engineConfig, { seatId = 'seat-0' } = {}) {

    this.config = engineConfig;

    this.seatId = seatId;

    this.pendingRequest = null;

    this.queuedRequest = null;

    this.abortController = null;

    /** Plies applied to the server-side session board. */

    this.appliedPlies = 0;

    /** Serialize position sync vs search so makemove/position never races `go`. */

    this._syncChain = Promise.resolve();

  }



  cancelSearch() {

    this.queuedRequest = null;

    this.abortController?.abort();

    this.abortController = null;

    this.pendingRequest = null;

    this.setStatus('idle');

  }



  clearQueuedSearches() {

    this.queuedRequest = null;

  }



  destroy() {

    this.cancelSearch();

    this.sessionOp({ op: 'destroy' }).catch(() => {});

  }



  resetConnection() {

    this.cancelSearch();

    this.appliedPlies = 0;

    this.sessionOp({ op: 'reset' }).catch(() => {});

  }



  /** Stateless genmove — position is replayed on each think; no incremental session sync. */
  makeMoves() {
    return Promise.resolve();
  }



  ponder() {}



  stopPonder() {}



  requestMove(params) {

    if (this.pendingRequest) {

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



  async sessionOp(body, { stream = false, signal } = {}) {

    const res = await fetch(SESSION_URL, {

      method: 'POST',

      headers: {

        'Content-Type': 'application/json',

        Accept: stream ? 'text/event-stream' : 'application/json',

      },

      body: JSON.stringify({ seatId: this.seatId, engine: this.config?.engineMode, ...body }),

      signal,

    });

    if (!res.ok && !stream) {

      const data = await res.json().catch(() => ({}));

      throw new Error(data.error ?? `HTTP ${res.status}`);

    }

    return res;

  }



  enqueueSync(fn) {

    this._syncChain = this._syncChain.then(fn).catch((err) => {

      this.appliedPlies = 0;

      throw err;

    });

    return this._syncChain;

  }



  /**

   * @param {string[]} algebraicMoves

   * @param {{ incremental?: boolean, forceFull?: boolean }} [opts]

   */

  async syncMovesToSession(algebraicMoves, { incremental = false, forceFull = false } = {}) {

    const moves = algebraicMoves ?? [];

    if (!forceFull && !incremental && moves.length === 0 && this.appliedPlies === 0) {

      return;

    }

    // Full replay before search — never trust appliedPlies alone (session respawn / race).

    if (forceFull || !incremental || moves.length < this.appliedPlies) {

      await this.sessionOp({ op: 'position', moves });

      this.appliedPlies = moves.length;

      return;

    }



    const delta = moves.slice(this.appliedPlies);

    if (delta.length === 0) {

      return;

    }

    for (const move of delta) {

      await this.sessionOp({ op: 'makemove', move });

    }

    this.appliedPlies = moves.length;

  }



  startRequest({ aiSettings, moveHistory, isFreshGame }) {

    const history =

      isFreshGame || !moveHistory?.length

        ? []

        : moveHistory.map((action) => toAlgebraic(action));



    const timeSec = Number(aiSettings?.wallClockSeconds) || 10;

    const maxBudget = clampVisits(

      aiSettings?.visitsBudget ?? LOCAL_VISITS_RANGE.default,

    );

    const uct = uctFromStrengthLevel(aiSettings?.strengthLevel);

    const configured = this.config?.engineMode;
    const engineMode =
      configured === 'minimax' || isAlphaBetaEngineMode(configured)
        ? configured
        : 'mcts';



    this.setStatus('searching');

    const started = performance.now();

    this.pendingRequest = { started, timeSec };

    this.abortController = new AbortController();



    if (engineMode !== 'mcts') {
      // Warm per-seat session — TT/killers/history persist between plies.
      this.startSessionGenmove(history, { timeSec, maxBudget, uct, engineMode, started });
    } else {
      // Stateless CLI genmove — full move list each think; engine owns board internally.
      this.startOneShotGenmove(history, { timeSec, maxBudget, uct, engineMode, started });
    }
  }



  /** Warm path — one long-lived engine process per seat, analysis carries between plies. */
  startSessionGenmove(history, { timeSec, maxBudget, engineMode, started }) {
    this.onInfo?.({
      thinking: true,
      mode: engineMode,
      stoppedBy: engineMode,
      nodes: 0,
      simulations: 0,
    });
    this.enqueueSync(() => this.syncMovesToSession(history, { forceFull: true }))
      .then(() =>
        this.sessionOp(
          { op: 'go', timeSec, maxNodes: maxBudget },
          { stream: true, signal: this.abortController.signal },
        ),
      )
      .then(async (res) => {
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error ?? `HTTP ${res.status}`);
        }
        return this.consumeSearchStream(res, { timeSec, engineMode, started, isAlphaBeta: true });
      })
      .catch((err) => this.handleSearchFailure(err));
  }



  startOneShotGenmove(history, { timeSec, maxBudget, uct, engineMode, started }) {
    const isAlphaBeta = isAlphaBetaEngineMode(engineMode);

    if (isAlphaBeta) {

      this.onInfo?.({

        thinking: true,

        mode: engineMode,

        stoppedBy: engineMode,

        nodes: 0,

        simulations: 0,

      });

    }



    fetch(GENMOVE_URL, {

      method: 'POST',

      headers: {

        'Content-Type': 'application/json',

        Accept: 'text/event-stream',

      },

      body: JSON.stringify({

        moves: history,

        timeSec,

        maxSimulations: maxBudget,

        maxNodes: maxBudget,

        uct,

        engine: engineMode,

        stream: true,

      }),

      signal: this.abortController.signal,

    })

      .then(async (res) => {

        if (!res.ok) {

          const data = await res.json().catch(() => ({}));

          throw new Error(data.error ?? `HTTP ${res.status}`);

        }

        return this.consumeSearchStream(res, { timeSec, engineMode, started, isAlphaBeta });

      })

      .catch((err) => this.handleSearchFailure(err));

  }



  /** Parse the SSE search stream — shared by one-shot genmove and warm session `go`. */
  async consumeSearchStream(res, { timeSec, engineMode, started, isAlphaBeta }) {

        const reader = res.body.getReader();

        const decoder = new TextDecoder();

        let buffer = '';

        let finalMeta = {

          stoppedBy: engineMode,

          simulations: 0,

          nodes: 0,

        };



        while (true) {

          const { done, value } = await reader.read();

          if (done) {

            break;

          }

          buffer += decoder.decode(value, { stream: true });

          const parts = buffer.split('\n\n');

          buffer = parts.pop() ?? '';



          for (const part of parts) {

            const line = part.split('\n').find((l) => l.startsWith('data: '));

            if (!line) {

              continue;

            }

            const data = JSON.parse(line.slice(6));



            if (data.type === 'progress') {

              if (isAlphaBeta) {

                continue;

              }

              this.onInfo?.({

                thinking: true,

                mode: 'mcts',

                stoppedBy: 'time',

                simulations: data.simulations,

                progress: Math.min(0.99, data.elapsedMs / (timeSec * 1000)),

                rootWinRate: data.winRate,

              });

              continue;

            }



            if (data.type === 'info') {

              const stoppedBy = data.stoppedBy ?? engineMode;

              let depthLog = data.depthLog;
              if (
                (!depthLog || depthLog.length === 0) &&
                data.searchDepth != null &&
                data.rootScore != null
              ) {
                depthLog = [
                  {
                    depth: data.searchDepth,
                    score: data.rootScore,
                    nodes: data.nodes ?? 0,
                  },
                ];
              }

              // rollout-stats lines carry no depthLog/nodes — never let them
              // blank out the accumulated search meta.
              finalMeta = {
                ...finalMeta,
                ...data,
                stoppedBy,
                depthLog: depthLog ?? finalMeta.depthLog,
                nodes: data.nodes ?? finalMeta.nodes,
                searchDepth: data.searchDepth ?? finalMeta.searchDepth,
                rootScore: data.rootScore ?? finalMeta.rootScore,
                whiteDist: data.whiteDist ?? finalMeta.whiteDist,
                blackDist: data.blackDist ?? finalMeta.blackDist,
                rootMoves: data.rootMoves ?? finalMeta.rootMoves,
              };

              const isMinimax = isAlphaBetaEngineMode(stoppedBy);

              this.onInfo?.({

                thinking: true,

                mode: stoppedBy,

                stoppedBy,

                simulations: isMinimax ? 0 : data.simulations,

                nodes: finalMeta.nodes,

                searchDepth: finalMeta.searchDepth,

                depthLog: finalMeta.depthLog,

                whiteDist: finalMeta.whiteDist,

                blackDist: finalMeta.blackDist,

                rootScore: finalMeta.rootScore,

                progress: isMinimax && finalMeta.searchDepth
                  ? Math.min(0.99, (data.elapsedMs ?? 0) / (timeSec * 1000))
                  : undefined,

                rootWinRate: isMinimax ? null : data.rootWinRate,

                rootMoves: finalMeta.rootMoves,

                lmrProfile: data.lmrProfile,

                lmrReSearches: data.lmrReSearches,

                elapsedMs: data.elapsedMs,

                rolloutVerdict: finalMeta.rolloutVerdict,

                rolloutVisits: finalMeta.rolloutVisits,

                rolloutWins: finalMeta.rolloutWins,

              });

              continue;

            }



            if (data.type === 'error') {

              throw new Error(data.error);

            }



            if (data.type === 'bestmove') {

              const elapsed = performance.now() - started;

              this.pendingRequest = null;

              this.abortController = null;

              this.setStatus('idle');

              const stoppedBy = finalMeta.stoppedBy ?? data.stoppedBy ?? engineMode;
              const isAbFinal = isAlphaBetaEngineMode(stoppedBy);

              this.onInfo?.({

                time: elapsed,

                elapsedMs: finalMeta.elapsedMs ?? Math.round(elapsed),

                stoppedBy,

                simulations: isAbFinal ? 0 : (finalMeta.simulations ?? 0),

                nodes: finalMeta.nodes ?? 0,

                searchDepth: finalMeta.searchDepth,

                depthLog: finalMeta.depthLog,

                whiteDist: finalMeta.whiteDist,

                blackDist: finalMeta.blackDist,

                rootScore: finalMeta.rootScore,

                rootWinRate: isAbFinal ? null : finalMeta.rootWinRate,

                rootMoves: finalMeta.rootMoves,

                lmrProfile: finalMeta.lmrProfile,

                lmrReSearches: finalMeta.lmrReSearches,

                rolloutVerdict: finalMeta.rolloutVerdict,

                rolloutVisits: finalMeta.rolloutVisits,

                rolloutWins: finalMeta.rolloutWins,

                progress: 1,

              });

              const action = parseAlgebraic(data.algebraic);

              resolveOnBestMoveResult(this, this.onBestMove?.(action));

              return;

            }

          }

        }



        throw new Error('stream ended without bestmove');

  }



  handleSearchFailure(err) {

    this.pendingRequest = null;

    this.abortController = null;

    if (err.name === 'AbortError') {

      this.setStatus('idle');

      this.drainQueuedRequest();

      return;

    }

    this.setStatus('error');

    const message =

      err?.message === 'Failed to fetch'

        ? 'Cannot reach dev server (/api/titanium) — run npm run dev and ensure engine is built'

        : err?.message ?? String(err);

    this.onError?.(new Error(message));

    this.drainQueuedRequest();

  }



  setStatus(status) {

    this.onStatus?.(status);

  }

}


