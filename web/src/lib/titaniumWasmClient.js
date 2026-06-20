/**
 * Titanium v15 — WebAssembly build (αβ + grafted search; GitHub Pages / static hosting).
 */

import TitaniumWasmWorker from '../workers/titaniumWasmWorker.js?worker';
import { parseAlgebraic, toAlgebraic } from './gameLogic.js';
import { LOCAL_VISITS_RANGE, resolveMaxNodes } from './timeControl.js';

export class TitaniumWasmEngineClient {
  constructor(engineConfig) {
    this.config = engineConfig;
    this.worker = null;
    this.algebraicMoves = [];
    this.pendingRequest = null;
    this.queuedRequest = null;
    this.workerCrashRetries = 0;
  }

  ensureWorker() {
    if (this.worker) {
      return;
    }
    this.worker = new TitaniumWasmWorker();
    this.worker.onmessage = (event) => {
      const data = event.data;
      const pending = this.pendingRequest;
      if (!pending) {
        return;
      }
      if (data.type === 'error') {
        this.setStatus('error');
        pending.onError?.(new Error(data.message ?? 'WASM worker error'));
        return;
      }
      if (data.type === 'info') {
        const stoppedBy = data.stoppedBy ?? this.config?.engineMode ?? 'titanium-v15';
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
          stoppedBy,
          depthLog: depthLog ?? pending.finalMeta?.depthLog,
          nodes: data.nodes ?? pending.finalMeta?.nodes,
          searchDepth: data.searchDepth ?? pending.finalMeta?.searchDepth,
          rootScore: data.rootScore ?? pending.finalMeta?.rootScore,
          whiteDist: data.whiteDist ?? pending.finalMeta?.whiteDist,
          blackDist: data.blackDist ?? pending.finalMeta?.blackDist,
        };
        const meta = pending.finalMeta;
        pending.onInfo?.({
          thinking: true,
          mode: stoppedBy,
          stoppedBy,
          nodes: meta.nodes,
          searchDepth: meta.searchDepth,
          depthLog: meta.depthLog,
          whiteDist: meta.whiteDist,
          blackDist: meta.blackDist,
          rootScore: meta.rootScore,
          elapsedMs: data.elapsedMs ?? meta.elapsedMs,
          progress:
            meta.searchDepth && pending.timeMs
              ? Math.min(0.99, (data.elapsedMs ?? 0) / pending.timeMs)
              : undefined,
        });
        return;
      }
      if (data.type === 'bestmove') {
        const elapsed = performance.now() - pending.started;
        const meta = pending.finalMeta ?? {};
        this.setStatus('idle');
        this.workerCrashRetries = 0;
        pending.onInfo?.({
          time: elapsed,
          elapsedMs: meta.elapsedMs ?? Math.round(elapsed),
          nodes: meta.nodes ?? data.nodes ?? 0,
          stoppedBy: meta.stoppedBy ?? data.stoppedBy ?? this.config?.engineMode ?? 'titanium-v15',
          mode: meta.mode ?? data.mode ?? this.config?.engineMode ?? 'titanium-v15',
          searchDepth: meta.searchDepth,
          depthLog: meta.depthLog,
          whiteDist: meta.whiteDist,
          blackDist: meta.blackDist,
          rootScore: meta.rootScore,
          simulations: 0,
          progress: 1,
        });
        if (!data.algebraicMove) {
          pending.onError?.(new Error('WASM worker returned no move'));
          return;
        }
        const action = parseAlgebraic(data.algebraicMove);
        this.algebraicMoves.push(data.algebraicMove);
        pending.onBestMove?.(action);
      }
    };
    this.worker.onerror = (event) => {
      const pending = this.pendingRequest;
      this.pendingRequest = null;
      this.worker?.terminate();
      this.worker = null;
      if (pending?.retryParams && this.workerCrashRetries < 1) {
        this.workerCrashRetries += 1;
        this.setStatus('connecting');
        this.startRequest({ ...pending.retryParams, isFreshGame: false });
        return;
      }
      this.setStatus('error');
      const message =
        event?.message ?? (typeof event === 'string' ? event : null) ?? 'Titanium WASM worker crashed';
      const error = new Error(message);
      pending?.onError?.(error);
      this.onError?.(error);
      this.drainQueuedRequest();
    };
  }

  ponder() {}
  stopPonder() {}

  async cancelSearch() {
    this.queuedRequest = null;
    this.pendingRequest = null;
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.setStatus('idle');
  }

  clearQueuedSearches() {
    this.queuedRequest = null;
  }

  destroy() {
    void this.cancelSearch();
    this.algebraicMoves = [];
  }

  resetConnection() {
    this.destroy();
    this.algebraicMoves = [];
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
    const retryParams = { aiSettings, moveHistory, isFreshGame };
    if (isFreshGame) {
      this.algebraicMoves = [];
    } else if (moveHistory?.length) {
      this.algebraicMoves = moveHistory.map(toAlgebraic);
    }

    const timeMs = Math.round((aiSettings?.wallClockSeconds ?? 10) * 1000);
    const maxNodes = resolveMaxNodes(aiSettings?.visitsBudget ?? LOCAL_VISITS_RANGE.default);
    const engineMode = this.config?.engineMode ?? 'titanium-v15';

    this.setStatus('searching');
    const started = performance.now();
    this.ensureWorker();

    this.pendingRequest = {
      started,
      timeMs,
      finalMeta: {},
      retryParams,
      onInfo: (info) => this.onInfo?.(info),
      onBestMove: (action) => {
        this.pendingRequest = null;
        const result = this.onBestMove?.(action);
        if (result === 'stale') {
          this.clearQueuedSearches();
          return;
        }
        if (result === false) {
          this.clearQueuedSearches();
        } else {
          this.drainQueuedRequest();
        }
      },
      onError: (err) => {
        this.pendingRequest = null;
        this.onError?.(err);
        this.drainQueuedRequest();
      },
    };

    this.worker.postMessage({
      algebraicMoves: this.algebraicMoves,
      timeMs,
      maxNodes,
      isFreshGame: Boolean(isFreshGame),
      engineMode,
    });
  }

  setStatus(status) {
    this.onStatus?.(status);
  }
}
