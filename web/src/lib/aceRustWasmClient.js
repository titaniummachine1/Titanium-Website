/** ACE Rust tiers (MoveGen+, native port) — WebAssembly worker client for static hosting. */

import AceRustWasmWorker from '../workers/aceRustWasmWorker.js?worker';
import { parseAlgebraic, toAlgebraic } from './gameLogic.js';
import { resolveOnBestMoveResult } from './onBestMoveResult.js';
import { ACE_WALL_CLOCK_DEFAULT } from './timeControl.js';

export class AceRustWasmEngineClient {
  constructor(engineConfig) {
    this.config = engineConfig;
    this.worker = null;
    this.algebraicMoves = [];
    this.pendingRequest = null;
    this.queuedRequest = null;
    this._requestSeq = 0;
  }

  ensureWorker() {
    if (this.worker) {
      return;
    }
    this.worker = new AceRustWasmWorker();
    this.worker.onmessage = (event) => {
      const data = event.data;
      const pending = this.pendingRequest;
      if (!pending || (data.seq != null && data.seq !== pending.seq)) {
        return;
      }
      if (data.type === 'error') {
        this.setStatus('error');
        pending.onError?.(new Error(data.message ?? 'ACE WASM worker error'));
        return;
      }
      if (data.type === 'info') {
        const mode = data.mode ?? data.stoppedBy ?? this.config.engineMode ?? 'ace-v13-ti';
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
              pv: data.pv ?? '',
            },
          ];
        }
        pending.finalMeta = {
          ...(pending.finalMeta ?? {}),
          ...data,
          stoppedBy: mode,
          mode,
          depthLog: depthLog ?? pending.finalMeta?.depthLog,
          nodes: data.nodes ?? pending.finalMeta?.nodes,
          searchDepth: data.searchDepth ?? pending.finalMeta?.searchDepth,
          rootScore: data.rootScore ?? pending.finalMeta?.rootScore,
          whiteDist: data.whiteDist ?? pending.finalMeta?.whiteDist,
          blackDist: data.blackDist ?? pending.finalMeta?.blackDist,
          elapsedMs: data.elapsedMs ?? pending.finalMeta?.elapsedMs,
        };
        const meta = pending.finalMeta;
        pending.onInfo?.({
          thinking: true,
          mode,
          stoppedBy: mode,
          nodes: meta.nodes,
          searchDepth: meta.searchDepth,
          depthLog: meta.depthLog,
          whiteDist: meta.whiteDist,
          blackDist: meta.blackDist,
          rootScore: meta.rootScore,
          elapsedMs: meta.elapsedMs,
          simulations: 0,
        });
        return;
      }
      if (data.type === 'bestmove') {
        const elapsed = performance.now() - pending.started;
        const meta = pending.finalMeta ?? {};
        this.setStatus('idle');
        pending.onInfo?.({
          time: elapsed,
          elapsedMs: meta.elapsedMs ?? data.elapsedMs ?? Math.round(elapsed),
          nodes: meta.nodes ?? data.nodes ?? 0,
          stoppedBy: meta.stoppedBy ?? data.stoppedBy ?? this.config.engineMode ?? 'ace-v13-ti',
          mode: meta.mode ?? data.mode ?? this.config.engineMode ?? 'ace-v13-ti',
          searchDepth: meta.searchDepth ?? data.searchDepth,
          depthLog: meta.depthLog ?? data.depthLog,
          rootScore: meta.rootScore ?? data.rootScore,
          whiteDist: meta.whiteDist ?? data.whiteDist,
          blackDist: meta.blackDist ?? data.blackDist,
          simulations: 0,
          progress: 1,
        });
        if (!data.algebraicMove) {
          pending.onError?.(new Error('ACE WASM worker returned no move'));
          return;
        }
        const action = parseAlgebraic(data.algebraicMove);
        this.algebraicMoves.push(data.algebraicMove);
        this.pendingRequest = null;
        resolveOnBestMoveResult(this, pending.onBestMove?.(action));
      }
    };
    this.worker.onerror = (event) => {
      const pending = this.pendingRequest;
      this.pendingRequest = null;
      this.setStatus('error');
      const parts = [];
      if (event?.message) parts.push(event.message);
      if (event?.filename) parts.push(`at ${event.filename}:${event.lineno ?? '?'}`);
      if (event?.error?.stack) parts.push(event.error.stack);
      const message = parts.join(' | ') || 'ACE WASM worker crashed';
      const error = new Error(message);
      pending?.onError?.(error);
      this.onError?.(error);
      this.drainQueuedRequest();
    };
  }

  ponder() {}
  stopPonder() {
    this.setStatus('idle');
  }

  // Soft cancel: drops the pending/queued request but leaves the worker (and
  // its warm WASM instance) alive. Any in-flight search finishes in the
  // background and its result is dropped by the seq check above, so it can
  // never be misattributed to a later request. Used for undo / analysis
  // jumps / replay loads.
  cancelSearch() {
    this.queuedRequest = null;
    this.pendingRequest = null;
    this.setStatus('idle');
  }

  clearQueuedSearches() {
    this.queuedRequest = null;
  }

  // Hard teardown: actually kills the worker. Only for when the engine
  // instance itself is being discarded (seat destroyed / engine config
  // switched).
  destroy() {
    this.queuedRequest = null;
    this.pendingRequest = null;
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.setStatus('idle');
    this.algebraicMoves = [];
  }

  resetConnection() {
    this.cancelSearch();
    this.algebraicMoves = [];
  }

  /** Kill the worker and reset move history to the current game position. */
  async recoverFromDesync({ moveHistory, isFreshGame } = {}) {
    this.queuedRequest = null;
    this.pendingRequest = null;
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.algebraicMoves =
      isFreshGame || !moveHistory?.length
        ? []
        : moveHistory.map((action) =>
            typeof action === 'string' ? action : toAlgebraic(action),
          );
    this.setStatus('idle');
  }

  makeMoves(actions) {
    for (const action of actions) {
      const alg = toAlgebraic(action);
      if (this.algebraicMoves[this.algebraicMoves.length - 1] !== alg) {
        this.algebraicMoves.push(alg);
      }
    }
    this.setStatus('idle');
  }

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

  startRequest({ aiSettings, moveHistory, isFreshGame }) {
    if (isFreshGame) {
      this.algebraicMoves = [];
    } else if (moveHistory?.length) {
      this.algebraicMoves = moveHistory.map(toAlgebraic);
    }

    const timeMs = Math.round((aiSettings?.wallClockSeconds ?? ACE_WALL_CLOCK_DEFAULT) * 1000);

    this.setStatus('searching');
    const started = performance.now();
    this.ensureWorker();

    const seq = ++this._requestSeq;
    this.pendingRequest = {
      seq,
      started,
      finalMeta: {},
      onInfo: (info) => this.onInfo?.(info),
      onBestMove: (action) => {
        this.pendingRequest = null;
        resolveOnBestMoveResult(this, this.onBestMove?.(action));
      },
      onError: (err) => {
        this.pendingRequest = null;
        this.onError?.(err);
        this.drainQueuedRequest();
      },
    };

    this.worker.postMessage({
      seq,
      algebraicMoves: this.algebraicMoves,
      timeMs,
      maxDepth: 30,
      engineMode: this.config.engineMode ?? 'ace-v13-ti',
    });
  }

  setStatus(status) {
    this.onStatus?.(status);
  }
}
