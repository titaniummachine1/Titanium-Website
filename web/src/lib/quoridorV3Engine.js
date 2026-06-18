/**
 * Quoridor v3 (JS αβ) — Web Worker client.
 */

import QuoridorV3Worker from '../workers/quoridorV3Worker.js?worker';
import { parseAlgebraic, toAlgebraic } from './gameLogic.js';
import {
  maxDepthFromVisitsBudget,
  QUORIDOR_V3_WALL_CLOCK_DEFAULT,
} from './timeControl.js';

export class QuoridorV3EngineClient {
  constructor(engineConfig, { WorkerClass = QuoridorV3Worker } = {}) {
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
        pending.onError?.(new Error(data.message ?? 'Worker error'));
        return;
      }
      if (data.type === 'progress') {
        pending.onInfo?.({
          thinking: true,
          mode: data.mode ?? 'minimax',
          stoppedBy: data.stoppedBy ?? 'minimax',
          searchDepth: data.searchDepth,
          nodes: data.nodes,
          depthLog: data.depthLog,
          rootScore: data.rootScore,
          whiteDist: data.whiteDist,
          blackDist: data.blackDist,
        });
        return;
      }
      if (data.type === 'bestmove') {
        const elapsed = performance.now() - pending.started;
        this.setStatus('idle');
        pending.onInfo?.({
          time: elapsed,
          nodes: data.nodes,
          stoppedBy: data.stoppedBy ?? 'minimax',
          searchDepth: data.searchDepth,
          depthLog: data.depthLog,
          rootScore: data.rootScore,
          whiteDist: data.whiteDist,
          blackDist: data.blackDist,
          profileName: data.profileName,
          mode: 'minimax',
          progress: 1,
        });
        if (!data.algebraicMove) {
          pending.onError?.(new Error('Worker returned no algebraic move'));
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
      this.setStatus('error');
      const message =
        event?.message ?? (typeof event === 'string' ? event : null) ?? 'Quoridor v3 worker crashed';
      const error = new Error(message);
      pending?.onError?.(error);
      this.onError?.(error);
      this.drainQueuedRequest();
    };
  }

  ponder() {
    // v3 HTML engine supports ponder via worker glue; not wired here yet.
  }

  stopPonder() {
    this.setStatus('idle');
  }

  cancelSearch() {
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
    this.cancelSearch();
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
    const format = toAlgebraic;
    if (isFreshGame) {
      this.algebraicMoves = [];
    } else if (moveHistory?.length) {
      this.algebraicMoves = moveHistory.map(format);
    }

    const timeMs = Math.round(
      (aiSettings?.wallClockSeconds ?? QUORIDOR_V3_WALL_CLOCK_DEFAULT) * 1000,
    );
    const maxDepth = maxDepthFromVisitsBudget(aiSettings?.visitsBudget);

    this.setStatus('searching');
    const started = performance.now();
    this.ensureWorker();

    this.pendingRequest = {
      started,
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
      maxDepth,
    });
  }

  setStatus(status) {
    this.onStatus?.(status);
  }
}
