/** ACE v13 (JS HTML extract) — Web Worker client. */

import AceV13Worker from '../workers/aceV13Worker.js?worker';
import { parseAlgebraic, toAlgebraic } from './gameLogic.js';
import { resolveOnBestMoveResult } from './onBestMoveResult.js';
import { ACE_WALL_CLOCK_DEFAULT } from './timeControl.js';

export class AceV13JsEngineClient {
  constructor(engineConfig, { WorkerClass = AceV13Worker } = {}) {
    this.config = engineConfig;
    this.WorkerClass = WorkerClass;
    this.worker = null;
    this.algebraicMoves = [];
    this.pendingRequest = null;
    this.queuedRequest = null;
  }

  ensureWorker() {
    if (this.worker) {
      return;
    }
    this.worker = new this.WorkerClass();
    this.worker.onmessage = (event) => {
      const data = event.data;
      const pending = this.pendingRequest;
      if (!pending) {
        return;
      }
      if (data.type === 'error') {
        this.setStatus('error');
        pending.onError?.(new Error(data.message ?? 'ACE v13 worker error'));
        return;
      }
      if (data.type === 'progress') {
        pending.onInfo?.({
          thinking: true,
          mode: data.mode ?? 'ace-v13-js',
          stoppedBy: data.stoppedBy ?? 'ace-v13-js',
          searchDepth: data.searchDepth,
          nodes: data.nodes,
          depthLog: data.depthLog,
          rootScore: data.rootScore,
          whiteDist: data.whiteDist,
          blackDist: data.blackDist,
          simulations: 0,
        });
        return;
      }
      if (data.type === 'bestmove') {
        const elapsed = performance.now() - pending.started;
        this.setStatus('idle');
        pending.onInfo?.({
          time: elapsed,
          elapsedMs: data.ms ?? Math.round(elapsed),
          nodes: data.nodes,
          stoppedBy: data.stoppedBy ?? 'ace-v13-js',
          mode: data.mode ?? 'ace-v13-js',
          searchDepth: data.searchDepth,
          depthLog: data.depthLog,
          rootScore: data.rootScore,
          whiteDist: data.whiteDist,
          blackDist: data.blackDist,
          profileName: data.profileName ?? 'ACE v13 (JS)',
          simulations: 0,
          progress: 1,
        });
        if (!data.algebraicMove) {
          pending.onError?.(new Error('ACE v13 worker returned no move'));
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
      const message =
        event?.message ?? (typeof event === 'string' ? event : null) ?? 'ACE v13 worker crashed';
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
    if (isFreshGame) {
      this.algebraicMoves = [];
    } else if (moveHistory?.length) {
      this.algebraicMoves = moveHistory.map(toAlgebraic);
    }

    const timeMs = Math.round((aiSettings?.wallClockSeconds ?? ACE_WALL_CLOCK_DEFAULT) * 1000);

    this.setStatus('searching');
    const started = performance.now();
    this.ensureWorker();

    this.pendingRequest = {
      started,
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
      algebraicMoves: this.algebraicMoves,
      timeMs,
      maxDepth: 30,
    });
  }

  setStatus(status) {
    this.onStatus?.(status);
  }
}
