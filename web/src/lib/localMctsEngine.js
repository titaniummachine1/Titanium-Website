/**
 * Gorisanson MCTS in a Web Worker. Titanium uses titaniumRustClient.js (Rust).
 */

import GorisansonWorker from '../workers/gorisansonWorker.js?worker';
import { parseAlgebraic, toAlgebraic } from './gameLogic.js';
import { resolveOnBestMoveResult } from './onBestMoveResult.js';
import { LOCAL_VISITS_RANGE, resolveMaxNodes, uctFromStrengthLevel } from './timeControl.js';
import { fetchCatSnapshot } from './catHeatmap.js';
import { buildCatMoveWeights, isGorisansonCatPolicy } from './gorisansonCatPolicy.js';

export class LocalMctsEngineClient {
  constructor(engineConfig, { resolveUct, WorkerClass = GorisansonWorker } = {}) {
    this.config = engineConfig;
    this.WorkerClass = WorkerClass;
    this.resolveUct = resolveUct ?? (() => engineConfig.uctConst ?? 0.2);
    this.worker = null;
    this.algebraicMoves = [];
    this.isPondering = false;
    this.pendingRequest = null;
    this.queuedRequest = null;
    this._workerReady = false;
    this._readyWaiter = null;
    this._initPromise = null;
  }

  _bindWorkerHandlers() {
    if (!this.worker || this.worker._gorisansonHandlersBound) {
      return;
    }
    this.worker._gorisansonHandlersBound = true;

    this.worker.onmessage = (event) => {
      const data = event.data;
      if (data?.type === 'ready') {
        this._workerReady = true;
        if (this._readyWaiter) {
          const waiter = this._readyWaiter;
          this._readyWaiter = null;
          waiter.resolve();
        }
        return;
      }

      const pending = this.pendingRequest;
      if (!pending) {
        return;
      }

      if (data.type === 'search-started') {
        this._markSearchStarted(pending);
        return;
      }

      if (data.type === 'progress' || data.type === 'depth') {
        this._markSearchStarted(pending);
        pending.onProgress?.(data);
        return;
      }
      if (data.type === 'error') {
        this.setStatus('error');
        pending.onError?.(new Error(data.message ?? 'Worker error'));
        return;
      }
      if (data.type === 'bestmove') {
        this._markSearchStarted(pending);
        const elapsed =
          pending.started == null ? 0 : performance.now() - pending.started;
        this.setStatus('idle');
        pending.onInfo?.({
          time: elapsed,
          simulations: data.simulations,
          stoppedBy: data.stoppedBy,
          searchDepth: data.searchDepth,
          depthLog: data.depthLog,
          nodes: data.nodes,
          rootScore: data.rootScore,
          rootWinRate: data.rootWinRate,
          rootMoves: data.rootMoves,
          whiteDist: data.whiteDist,
          blackDist: data.blackDist,
          lmrReSearches: data.lmrReSearches,
          aspirationFails: data.aspirationFails,
          profileName: data.profileName,
          progress: 1,
        });
        if (!data.algebraicMove) {
          pending.onError?.(new Error('Worker returned no algebraic move'));
          return;
        }
        const action = parseAlgebraic(data.algebraicMove);
        pending.onBestMove?.(action);
      }
    };

    this.worker.onerror = (event) => {
      this._workerReady = false;
      if (this._readyWaiter) {
        const waiter = this._readyWaiter;
        this._readyWaiter = null;
        waiter.reject(
          new Error(event?.message ?? 'Gorisanson worker init failed'),
        );
      }
      const pending = this.pendingRequest;
      this.pendingRequest = null;
      this.setStatus('error');
      const message =
        event?.message
        ?? (typeof event === 'string' ? event : null)
        ?? 'Gorisanson worker crashed (see browser console)';
      const error = new Error(message);
      pending?.onError?.(error);
      this.onError?.(error);
      this.drainQueuedRequest();
    };
  }

  _markSearchStarted(pending) {
    if (!pending || pending.started != null) {
      return;
    }
    pending.started = performance.now();
    pending.onSearchStart?.();
  }

  ensureWorker() {
    if (this.worker) {
      this._bindWorkerHandlers();
      return;
    }

    this.worker = new this.WorkerClass();
    this._bindWorkerHandlers();
  }

  async initWorkers() {
    if (this._workerReady && this.worker) {
      return;
    }
    this.ensureWorker();
    if (this._workerReady) {
      return;
    }
    if (this._initPromise) {
      return this._initPromise;
    }
    this._initPromise = new Promise((resolve, reject) => {
      this._readyWaiter = { resolve, reject };
      this.worker.postMessage({ op: 'init' });
    })
      .catch((err) => {
        this._workerReady = false;
        throw err;
      })
      .finally(() => {
        this._initPromise = null;
        this._readyWaiter = null;
      });
    return this._initPromise;
  }

  async prewarm() {
    try {
      await this.initWorkers();
    } catch (err) {
      console.warn('Gorisanson prewarm failed; will retry on first move', err);
    }
  }

  /**
   * Future: node-cap-only MCTS on predicted opponent reply (no wall clock).
   * @see docs/video/09-pondering-prep.md
   */
  ponder() {
    this.isPondering = false;
  }

  stopPonder() {
    if (!this.isPondering) {
      return;
    }
    this.worker?.terminate();
    this.worker = null;
    this.isPondering = false;
    this.setStatus('idle');
  }

  cancelSearch() {
    this.queuedRequest = null;
    this.pendingRequest = null;
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this._workerReady = false;
    this._initPromise = null;
    this.setStatus('idle');
  }

  clearQueuedSearches() {
    this.queuedRequest = null;
  }

  destroy() {
    this.cancelSearch();
    this.algebraicMoves = [];
  }

  resetConnection() {
    this.destroy();
    this.algebraicMoves = [];
  }

  /** Echo one committed ply for session bookkeeping (Gorisanson replays on search). */
  echoCommittedMove(action, positionKey, historyLength, moveHistory = null) {
    void positionKey;
    const history = moveHistory?.length
      ? moveHistory.map((a) => toAlgebraic(a))
      : null;
    if (history && history.length === historyLength) {
      this.algebraicMoves = [...history];
      return Promise.resolve();
    }
    const alg = toAlgebraic(action);
    if (this.algebraicMoves.length === historyLength - 1) {
      this.algebraicMoves.push(alg);
    }
    return Promise.resolve();
  }

  requestMove(params) {
    if (this.pendingRequest) {
      this.queuedRequest = params;
      return;
    }
    void this.startRequest(params);
  }

  drainQueuedRequest() {
    if (!this.queuedRequest) {
      return;
    }
    const next = this.queuedRequest;
    this.queuedRequest = null;
    void this.startRequest(next);
  }

  async startRequest({ aiSettings, moveHistory, isFreshGame, onSearchStart }) {
    if (isFreshGame) {
      this.algebraicMoves = [];
    } else if (moveHistory?.length) {
      this.algebraicMoves = moveHistory.map(toAlgebraic);
    }

    const timeMs = Math.round((aiSettings?.wallClockSeconds ?? 3) * 1000);
    const maxSimulations = resolveMaxNodes(aiSettings?.visitsBudget ?? LOCAL_VISITS_RANGE.default);
    const uctConst = this.resolveUct(aiSettings);

    this.ensureWorker();
    if (!this._workerReady) {
      this.setStatus('connecting');
    }
    try {
      await this.initWorkers();
    } catch (err) {
      this.setStatus('error');
      throw err;
    }

    let catMoveWeights = null;
    if (isGorisansonCatPolicy(aiSettings?.gorisansonNet)) {
      try {
        const snap = await fetchCatSnapshot(this.algebraicMoves);
        catMoveWeights = buildCatMoveWeights(this.algebraicMoves, snap);
      } catch (err) {
        console.warn('Gorisanson CAT policy unavailable; using vanilla MCTS', err);
      }
    }

    this.setStatus('searching');
    this.pendingRequest = {
      started: null,
      onSearchStart,
      onProgress: (data) => {
        if (data.type === 'depth') {
          this.onInfo?.({
            thinking: true,
            searchDepth: data.depth,
            nodes: data.nodes,
            depthLog: [{ depth: data.depth, score: data.score, nodes: data.nodes }],
          });
          return;
        }
        this.onInfo?.({
          thinking: true,
          progress: data.value,
          simulations: data.simulations,
          nodes: data.simulations,
          rootWinRate: data.rootWinRate,
          rootMoves: data.rootMoves,
          whiteDist: data.whiteDist,
          blackDist: data.blackDist,
          depthLog: data.depthLog,
          pv: data.pv,
        });
      },
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

    const payload = {
      algebraicMoves: this.algebraicMoves,
      timeMs,
      maxSimulations,
      uctConst,
      catMoveWeights,
    };
    this.worker.postMessage(payload);
  }

  setStatus(status) {
    this.onStatus?.(status);
  }
}

export class GorisansonEngineClient extends LocalMctsEngineClient {
  constructor(engineConfig) {
    super(engineConfig, {
      resolveUct: () => engineConfig.uctConst ?? 0.2,
    });
  }
}

export { TitaniumEngineClient } from './titaniumRustClient.js';
