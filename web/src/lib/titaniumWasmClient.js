/**
 * Titanium v16 WebAssembly client.
 *
 * The browser owns one Web Worker per engine seat. That worker hosts one warm
 * Titanium WASM instance; JS does not distribute search work across helper
 * workers. The configured thread count is passed into Titanium as an engine
 * setting.
 */

import TitaniumWasmWorker from '../workers/titaniumWasmWorker.js?worker';
import { parseAlgebraic, toAlgebraic } from './gameLogic.js';
import { resolveMaxNodes, resolveCatLmrCeiling } from './timeControl.js';
import { resolveTitaniumSearchCores } from './titaniumRuntime.js';
import { enrichNodeFields } from './searchNodes.js';
import { setRustIdentityFromWasm } from './wasmBuildInfo.js';

function synthesizeDepthLog(meta, { searchDepth, nodes, pv } = {}) {
  if (meta?.depthLog?.length) {
    return meta.depthLog;
  }
  const depth = searchDepth ?? meta?.searchDepth;
  const nodeCount = nodes ?? meta?.nodes ?? 0;
  const score = meta?.rootScore;
  if (depth == null && nodeCount <= 0 && score == null) {
    return meta?.depthLog;
  }
  return [
    {
      depth: depth ?? 0,
      score: score ?? 0,
      nodes: nodeCount,
      pv: pv ?? meta?.pv ?? '',
    },
  ];
}

export class TitaniumWasmEngineClient {
  constructor(engineConfig) {
    this.config = engineConfig;
    this.threads = resolveTitaniumSearchCores({ cores: engineConfig?.cores });
    this.worker = null;
    this._readyWaiter = null;
    this._workerReadyKey = null;
    this.algebraicMoves = [];
    this.pendingRequest = null;
    this.queuedRequest = null;
    this.workerCrashRetries = 0;
    this._initInFlight = null;
  }

  _workerProfileKey(
    engineMode = this.config?.engineMode ?? 'titanium-v16',
    catLmrCeiling = 800,
    threads = this.threads,
  ) {
    return `${engineMode}@${catLmrCeiling ?? 800}#t${Math.max(1, threads ?? 1)}`;
  }

  workerReady(
    engineMode = this.config?.engineMode ?? 'titanium-v16',
    catLmrCeiling = 800,
    threads = this.threads,
  ) {
    return (
      this.worker != null &&
      this._workerReadyKey === this._workerProfileKey(engineMode, catLmrCeiling, threads)
    );
  }

  ensureWorker() {
    if (this.worker) {
      return;
    }
    this.worker = new TitaniumWasmWorker();
    this.worker.onmessage = (event) => this._onWorkerMessage(event);
    this.worker.onerror = (event) => this._onWorkerError(event);
    this._workerReadyKey = null;
  }

  async initWorkers(
    engineMode = this.config?.engineMode ?? 'titanium-v16',
    { timeoutMs = 60_000, catLmrCeiling = 800, threads = this.threads } = {},
  ) {
    if (this._initInFlight) {
      return this._initInFlight;
    }
    this._initInFlight = this._initWorkerOnce(engineMode, timeoutMs, catLmrCeiling, threads).finally(() => {
      this._initInFlight = null;
    });
    return this._initInFlight;
  }

  async _initWorkerOnce(engineMode, timeoutMs, catLmrCeiling, threads = this.threads) {
    if (this.worker && !this.workerReady(engineMode, catLmrCeiling, threads)) {
      this.terminateWorkers();
    }
    this.ensureWorker();
    if (this.workerReady(engineMode, catLmrCeiling, threads)) {
      return null;
    }
    return Promise.race([
      new Promise((resolve, reject) => {
        this._readyWaiter = { resolve, reject };
        this.worker.postMessage({
          op: 'init',
          engineMode,
          catLmrCeiling,
          threads,
        });
      }),
      new Promise((_, reject) => {
        setTimeout(
          () => reject(new Error('Titanium WASM init timed out loading engine binary')),
          timeoutMs,
        );
      }),
    ]);
  }

  async prewarm(
    engineMode = this.config?.engineMode ?? 'titanium-v16',
    catLmrCeiling = 800,
    threads = this.threads,
  ) {
    if (this.workerReady(engineMode, catLmrCeiling, threads)) {
      return;
    }
    try {
      await this.initWorkers(engineMode, { catLmrCeiling, threads });
    } catch (err) {
      console.warn('Titanium WASM prewarm failed; will retry on first move', err);
    }
  }

  _resolveReady(data) {
    this._workerReadyKey = this._workerProfileKey(
      data.engineMode ?? this.config?.engineMode,
      data.catLmrCeiling ?? 800,
      data.threads ?? this.threads,
    );
    if (this._readyWaiter) {
      const waiter = this._readyWaiter;
      this._readyWaiter = null;
      waiter.resolve(data);
    }
  }

  _rejectReady(err) {
    this._workerReadyKey = null;
    if (this._readyWaiter) {
      const waiter = this._readyWaiter;
      this._readyWaiter = null;
      waiter.reject(err);
    }
  }

  _mergeInfo(data) {
    const stoppedBy = data.stoppedBy ?? this.config?.engineMode ?? 'titanium-v16';
    let depthLog = data.depthLog;
    if ((!depthLog || depthLog.length === 0) && data.searchDepth != null && data.rootScore != null) {
      depthLog = [
        {
          depth: data.searchDepth,
          score: data.rootScore,
          nodes: data.nodes ?? 0,
          pv: data.pv ?? '',
        },
      ];
    }
    return {
      stoppedBy,
      depthLog,
      nodes: data.nodes,
      totalNodes: data.totalNodes,
      totalNodesAcrossWorkers: data.totalNodesAcrossWorkers,
      mainThreadNodes: data.mainThreadNodes,
      helperNodes: data.helperNodes,
      helperStarts: data.helperStarts,
      helperStartsTotal: data.helperStartsTotal,
      requestedThreads: data.requestedThreads,
      effectiveThreads: data.effectiveThreads,
      threaded: data.threaded,
      searchDepth: data.searchDepth,
      rootScore: data.rootScore,
      whiteDist: data.whiteDist,
      blackDist: data.blackDist,
      pv: data.pv,
      rootMoves: data.rootMoves,
      rootMove: data.rootMove,
      elapsedMs: data.elapsedMs,
    };
  }

  _onWorkerMessage(event) {
    const data = event.data;

    if (data.type === 'ready') {
      if (data.rustIdentity) {
        setRustIdentityFromWasm(JSON.stringify(data.rustIdentity));
      }
      this._resolveReady(data);
      return;
    }

    if (data.type === 'error') {
      const error = new Error(data.message ?? 'WASM worker error');
      if (data.stack) {
        error.stack = data.stack;
      }
      if (this._readyWaiter) {
        this._rejectReady(error);
        return;
      }
      const pending = this.pendingRequest;
      if (!pending) {
        return;
      }
      this.pendingRequest = null;
      this.setStatus('error');
      pending.onError?.(error);
      return;
    }

    const pending = this.pendingRequest;
    if (!pending) {
      return;
    }

    if (data.type === 'info') {
      pending.finalMeta = {
        ...(pending.finalMeta ?? {}),
        ...this._mergeInfo(data),
      };
      const meta = pending.finalMeta;
      const nodeFields = enrichNodeFields(meta);
      pending.onInfo?.({
        thinking: true,
        mode: meta.stoppedBy,
        stoppedBy: meta.stoppedBy,
        nodes: nodeFields.nodes,
        totalNodes: nodeFields.totalNodes,
        selectedWorkerNodes: nodeFields.selectedWorkerNodes,
        totalNodesAcrossWorkers: nodeFields.totalNodesAcrossWorkers,
        mainThreadNodes: nodeFields.mainThreadNodes,
        helperNodes: nodeFields.helperNodes,
        helperStarts: meta.helperStarts,
        helperStartsTotal: meta.helperStartsTotal,
        requestedThreads: meta.requestedThreads,
        effectiveThreads: meta.effectiveThreads,
        threaded: meta.threaded,
        nodeSource: nodeFields.nodeSource,
        estimatedTotalNodes: false,
        searchDepth: meta.searchDepth,
        depthLog: meta.depthLog,
        whiteDist: meta.whiteDist,
        blackDist: meta.blackDist,
        rootScore: meta.rootScore,
        pv: data.pv ?? meta.pv,
        rootMoves: data.rootMoves?.length ? data.rootMoves : meta.rootMoves,
        rootMove: data.rootMove ?? meta.rootMove,
        elapsedMs: data.elapsedMs ?? meta.elapsedMs,
        progress:
          meta.searchDepth && pending.timeMs
            ? Math.min(0.99, (data.elapsedMs ?? 0) / pending.timeMs)
            : undefined,
      });
      return;
    }

    if (data.type === 'bestmove') {
      pending.finalMeta = {
        ...(pending.finalMeta ?? {}),
        ...this._mergeInfo(data),
        depthLog: data.depthLog?.length ? data.depthLog : pending.finalMeta?.depthLog,
        searchDepth: data.searchDepth ?? data.depth ?? pending.finalMeta?.searchDepth,
        rootScore: data.rootScore ?? pending.finalMeta?.rootScore,
        whiteDist: data.whiteDist ?? pending.finalMeta?.whiteDist,
        blackDist: data.blackDist ?? pending.finalMeta?.blackDist,
        nodes: data.nodes ?? pending.finalMeta?.nodes,
        totalNodes: data.totalNodes ?? pending.finalMeta?.totalNodes,
        totalNodesAcrossWorkers:
          data.totalNodesAcrossWorkers ?? pending.finalMeta?.totalNodesAcrossWorkers,
        mainThreadNodes: data.mainThreadNodes ?? pending.finalMeta?.mainThreadNodes,
        helperNodes: data.helperNodes ?? pending.finalMeta?.helperNodes,
        helperStarts: data.helperStarts ?? pending.finalMeta?.helperStarts,
        helperStartsTotal: data.helperStartsTotal ?? pending.finalMeta?.helperStartsTotal,
        requestedThreads: data.requestedThreads ?? pending.finalMeta?.requestedThreads,
        effectiveThreads: data.effectiveThreads ?? pending.finalMeta?.effectiveThreads,
        threaded: data.threaded ?? pending.finalMeta?.threaded,
        elapsedMs: data.elapsedMs ?? pending.finalMeta?.elapsedMs,
        pv: data.pv ?? pending.finalMeta?.pv,
      };
      this._finishSearch(pending, data);
    }
  }

  _finishSearch(pending, bestmove) {
    const meta = pending.finalMeta ?? {};
    const searchDepth = bestmove.depth ?? meta.searchDepth;
    const nodeFields = enrichNodeFields(meta);
    const elapsed = performance.now() - pending.started;
    const depthLog = synthesizeDepthLog(meta, {
      searchDepth,
      nodes: nodeFields.nodes,
      pv: meta.pv,
    });

    this.setStatus('idle');
    this.workerCrashRetries = 0;

    pending.onInfo?.({
      time: elapsed,
      elapsedMs: meta.elapsedMs ?? Math.round(elapsed),
      nodes: nodeFields.nodes,
      selectedWorkerNodes: nodeFields.selectedWorkerNodes,
      totalNodes: nodeFields.totalNodes,
      totalNodesAcrossWorkers: nodeFields.totalNodesAcrossWorkers,
      mainThreadNodes: nodeFields.mainThreadNodes,
      helperNodes: nodeFields.helperNodes,
      helperStarts: meta.helperStarts,
      helperStartsTotal: meta.helperStartsTotal,
      requestedThreads: meta.requestedThreads,
      effectiveThreads: meta.effectiveThreads,
      threaded: meta.threaded,
      nodeSource: nodeFields.nodeSource ?? 'engine_total',
      estimatedTotalNodes: false,
      stoppedBy: meta.stoppedBy ?? bestmove.stoppedBy ?? this.config?.engineMode ?? 'titanium-v16',
      mode: meta.mode ?? bestmove.mode ?? this.config?.engineMode ?? 'titanium-v16',
      searchDepth,
      depthLog,
      whiteDist: meta.whiteDist,
      blackDist: meta.blackDist,
      rootScore: meta.rootScore,
      simulations: 0,
      progress: 1,
    });

    if (!bestmove.algebraicMove) {
      pending.onError?.(new Error('WASM worker returned no move'));
      return;
    }

    const action = parseAlgebraic(bestmove.algebraicMove);
    this.algebraicMoves.push(bestmove.algebraicMove);
    this.pendingRequest = null;
    const result = pending.onBestMove?.(action);
    if (result === 'stale') {
      this.clearQueuedSearches();
      return;
    }
    if (result === false) {
      this.clearQueuedSearches();
    } else {
      this.drainQueuedRequest();
    }
  }

  _onWorkerError(event) {
    if (this._readyWaiter) {
      const message =
        event?.message ?? (typeof event === 'string' ? event : null) ?? 'Titanium WASM worker crashed';
      this._rejectReady(new Error(message));
      return;
    }

    const pending = this.pendingRequest;
    if (!pending) {
      return;
    }
    this.pendingRequest = null;
    this.terminateWorkers();
    if (pending.retryParams && this.workerCrashRetries < 1) {
      this.workerCrashRetries += 1;
      // The threaded search crashed (rayon/SharedArrayBuffer OOM on weaker
      // devices). Degrade to single-thread for the rest of the session and
      // retry — multithreading stays "if possible", never a hard crash.
      this._degradeToSingleThread = true;
      this.setStatus('connecting');
      this.startRequest({ ...pending.retryParams, isFreshGame: false });
      return;
    }
    this.setStatus('error');
    const message =
      event?.message ?? (typeof event === 'string' ? event : null) ?? 'Titanium WASM worker crashed';
    const error = new Error(message);
    pending.onError?.(error);
    this.onError?.(error);
    this.drainQueuedRequest();
  }

  terminateWorkers() {
    this.worker?.terminate();
    this.worker = null;
    this._workerReadyKey = null;
    this._initInFlight = null;
    if (this._readyWaiter) {
      const waiter = this._readyWaiter;
      this._readyWaiter = null;
      waiter.reject(new Error('Worker terminated'));
    }
  }

  ponder() {}
  stopPonder() {}

  async cancelSearch() {
    this.queuedRequest = null;
    this.pendingRequest = null;
    this.terminateWorkers();
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
    void this.startRequest(params).catch((err) => {
      if (this.pendingRequest) {
        return;
      }
      this.onError?.(err);
      this.drainQueuedRequest();
    });
  }

  drainQueuedRequest() {
    if (!this.queuedRequest) {
      return;
    }
    const next = this.queuedRequest;
    this.queuedRequest = null;
    void this.startRequest(next);
  }

  async startRequest({ aiSettings, moveHistory, isFreshGame }) {
    const retryParams = { aiSettings, moveHistory, isFreshGame };
    if (isFreshGame) {
      this.algebraicMoves = [];
    } else if (moveHistory?.length) {
      this.algebraicMoves = moveHistory.map(toAlgebraic);
    }

    // Multithreading if possible: a prior threaded crash (weaker device /
    // SharedArrayBuffer limits) sticks the session to single-thread.
    this.threads = this._degradeToSingleThread ? 1 : resolveTitaniumSearchCores(aiSettings);

    const timeMs = Math.round((aiSettings?.wallClockSeconds ?? 10) * 1000);
    const maxNodes = resolveMaxNodes(aiSettings?.visitsBudget ?? 0);
    const engineMode = this.config?.engineMode ?? 'titanium-v16';
    const catLmrCeiling =
      engineMode === 'titanium-v16' ? resolveCatLmrCeiling(aiSettings) : 800;

    if (this.pendingRequest) {
      throw new Error('Titanium WASM search already in flight');
    }

    this.ensureWorker();
    const needsInit = !this.workerReady(engineMode, catLmrCeiling, this.threads);
    if (needsInit) {
      this.setStatus('connecting');
    }

    const started = performance.now();
    const pending = {
      started,
      initMs: 0,
      timeMs,
      finalMeta: {},
      retryParams,
      onInfo: (info) => this.onInfo?.(info),
      onBestMove: (action) => this.onBestMove?.(action),
      onError: (err) => {
        this.pendingRequest = null;
        this.onError?.(err);
        this.drainQueuedRequest();
      },
    };
    this.pendingRequest = pending;

    const readyStart = performance.now();
    try {
      await this.initWorkers(engineMode, { catLmrCeiling, threads: this.threads });
    } catch (err) {
      this.pendingRequest = null;
      this.setStatus('error');
      throw err;
    }
    pending.initMs = performance.now() - readyStart;
    this.setStatus('searching');

    this.worker.postMessage({
      op: 'search',
      algebraicMoves: this.algebraicMoves,
      timeMs,
      maxNodes,
      isFreshGame: Boolean(isFreshGame),
      engineMode,
      catLmrCeiling,
      threads: this.threads,
      streamProgress: true,
    });
  }

  setStatus(status) {
    this.onStatus?.(status);
  }
}
