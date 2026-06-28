/**
 * Titanium v15 — WebAssembly build (αβ + grafted search; GitHub Pages / static hosting).
 * Production uses one Web Worker with WasmEngine (native Lazy SMP is dev-only via proxy).
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
    this.cores = resolveTitaniumSearchCores({ cores: engineConfig?.cores });
    /** @type {Worker[]} */
    this.workers = [];
    /** @type {Map<number, { resolve: Function, reject: Function }>} */
    this._readyWaiters = new Map();
    this._workerReady = new Set();
    this._workerReadyKeys = new Map();
    this.algebraicMoves = [];
    this.pendingRequest = null;
    this.queuedRequest = null;
    this.workerCrashRetries = 0;
    /** @type {Promise<unknown> | null} */
    this._initInFlight = null;
  }

  _workerProfileKey(engineMode = this.config?.engineMode ?? 'titanium-v15', catLmrCeiling = 800) {
    return `${engineMode}@${catLmrCeiling ?? 800}`;
  }

  workersReady(engineMode = this.config?.engineMode ?? 'titanium-v15', catLmrCeiling = 800) {
    const profileKey = this._workerProfileKey(engineMode, catLmrCeiling);
    if (this.cores <= 0 || this._workerReady.size < this.cores) {
      return false;
    }
    for (let workerId = 0; workerId < this.cores; workerId++) {
      if (this._workerReadyKeys.get(workerId) !== profileKey) {
        return false;
      }
    }
    return true;
  }

  ensureWorkers() {
    const n = this.cores;
    while (this.workers.length < n) {
      const workerId = this.workers.length;
      const worker = new TitaniumWasmWorker();
      worker.onmessage = (event) => this._onWorkerMessage(workerId, event);
      worker.onerror = (event) => this._onWorkerError(workerId, event);
      this.workers.push(worker);
      this._workerReady.delete(workerId);
      this._workerReadyKeys.delete(workerId);
    }
    while (this.workers.length > n) {
      const workerId = this.workers.length - 1;
      const w = this.workers.pop();
      w?.terminate();
      this._workerReady.delete(workerId);
      this._workerReadyKeys.delete(workerId);
    }
  }

  /** Initialize WASM in each worker sequentially (avoids parallel cold-start traps on Pages). */
  async initWorkers(
    engineMode = this.config?.engineMode ?? 'titanium-v15',
    { timeoutMs = 60_000, catLmrCeiling = 800 } = {},
  ) {
    if (this._initInFlight) {
      return this._initInFlight;
    }
    this._initInFlight = this._initWorkersOnce(engineMode, timeoutMs, catLmrCeiling).finally(() => {
      this._initInFlight = null;
    });
    return this._initInFlight;
  }

  async _initWorkersOnce(engineMode, timeoutMs, catLmrCeiling) {
    this.ensureWorkers();
    const profileKey = this._workerProfileKey(engineMode, catLmrCeiling);
    const payloads = [];
    for (let workerId = 0; workerId < this.cores; workerId++) {
      if (this._workerReady.has(workerId) && this._workerReadyKeys.get(workerId) === profileKey) {
        continue;
      }
      const data = await Promise.race([
        new Promise((resolve, reject) => {
          this._readyWaiters.set(workerId, { resolve, reject });
          this.workers[workerId].postMessage({
            op: 'init',
            engineMode,
            catLmrCeiling,
            workerSlot: workerId,
          });
        }),
        new Promise((_, reject) => {
          setTimeout(
            () => reject(new Error('Titanium WASM init timed out loading engine binary')),
            timeoutMs,
          );
        }),
      ]);
      payloads.push(data);
    }
    return payloads;
  }

  /** Load WASM in workers before the first move (avoids empty info cards during cold init). */
  async prewarm(engineMode = this.config?.engineMode ?? 'titanium-v15', catLmrCeiling = 800) {
    if (this.workersReady(engineMode, catLmrCeiling)) {
      return;
    }
    try {
      await this.initWorkers(engineMode, { catLmrCeiling });
    } catch (err) {
      console.warn('Titanium WASM prewarm failed; will retry on first move', err);
    }
  }

  _resolveReady(workerId, data) {
    this._workerReady.add(workerId);
    this._workerReadyKeys.set(
      workerId,
      this._workerProfileKey(data.engineMode ?? this.config?.engineMode, data.catLmrCeiling ?? 800),
    );
    const waiter = this._readyWaiters.get(workerId);
    if (waiter) {
      this._readyWaiters.delete(workerId);
      waiter.resolve(data);
    }
  }

  _rejectReady(workerId, err) {
    this._workerReady.delete(workerId);
    this._workerReadyKeys.delete(workerId);
    const waiter = this._readyWaiters.get(workerId);
    if (waiter) {
      this._readyWaiters.delete(workerId);
      waiter.reject(err);
    }
  }

  _onWorkerMessage(slotIndex, event) {
    const data = event.data;
    const workerId = data.workerId ?? slotIndex;

    if (data.type === 'ready') {
      if (data.rustIdentity) {
        setRustIdentityFromWasm(JSON.stringify(data.rustIdentity));
      }
      this._resolveReady(workerId, data);
      return;
    }

    if (data.type === 'error') {
      const initWaiter = this._readyWaiters.get(workerId);
      if (initWaiter) {
        this._rejectReady(workerId, new Error(data.message ?? 'WASM worker error'));
        return;
      }

      const pending = this.pendingRequest;
      if (!pending) {
        return;
      }
      if (workerId === 0) {
        this.setStatus('error');
        pending.onError?.(new Error(data.message ?? 'WASM worker error'));
      }
      pending.errors ??= new Set();
      pending.errors.add(workerId);
      this._maybeFinishSearch(pending);
      return;
    }

    const pending = this.pendingRequest;
    if (!pending) {
      return;
    }

    if (data.type === 'info') {
      if (workerId !== 0) {
        return;
      }
      pending.lastInfoNodes = data.nodes ?? pending.lastInfoNodes;
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
        pv: data.pv ?? pending.finalMeta?.pv,
        rootMoves: data.rootMoves?.length ? data.rootMoves : pending.finalMeta?.rootMoves,
        rootMove: data.rootMove ?? pending.finalMeta?.rootMove,
      };
      const meta = pending.finalMeta;
      const settledNodes = this._aggregateNodes(pending);
      const aggNodes = settledNodes > 0 ? settledNodes : this._liveAggregateNodes(pending, data.nodes);
      const estimatedTotalNodes = settledNodes <= 0 && aggNodes > 0 && this.cores > 1;
      const nodeFields = enrichNodeFields({
        ...meta,
        totalNodesAcrossWorkers: aggNodes > 0 ? aggNodes : undefined,
      });
      pending.onInfo?.({
        thinking: true,
        mode: stoppedBy,
        stoppedBy,
        nodes: nodeFields.nodes,
        totalNodes: nodeFields.totalNodes,
        selectedWorkerNodes: nodeFields.selectedWorkerNodes,
        totalNodesAcrossWorkers: nodeFields.totalNodesAcrossWorkers,
        mainThreadNodes: nodeFields.mainThreadNodes,
        helperNodes: nodeFields.helperNodes,
        nodeSource: estimatedTotalNodes ? 'live_worker_estimate' : nodeFields.nodeSource,
        estimatedTotalNodes,
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
      pending.results ??= new Map();
      pending.results.set(workerId, data);
      if (workerId === 0) {
        pending.finalMeta = {
          ...(pending.finalMeta ?? {}),
          depthLog: data.depthLog?.length ? data.depthLog : pending.finalMeta?.depthLog,
          searchDepth: data.searchDepth ?? data.depth ?? pending.finalMeta?.searchDepth,
          rootScore: data.rootScore ?? pending.finalMeta?.rootScore,
          whiteDist: data.whiteDist ?? pending.finalMeta?.whiteDist,
          blackDist: data.blackDist ?? pending.finalMeta?.blackDist,
          nodes: data.nodes ?? pending.finalMeta?.nodes,
          elapsedMs: data.elapsedMs ?? pending.finalMeta?.elapsedMs,
          pv: data.pv ?? pending.finalMeta?.pv,
        };
      }
      this._maybeFinishSearch(pending);
    }
  }

  _aggregateNodes(pending) {
    let total = 0;
    if (pending.results) {
      for (const r of pending.results.values()) {
        total += Number(r.nodes ?? 0);
      }
    }
    if (pending.finalMeta?.nodes != null && total === 0) {
      return pending.finalMeta.nodes;
    }
    return total;
  }

  _liveAggregateNodes(pending, authoritativeNodes) {
    const settled = this._aggregateNodes(pending);
    if (settled > 0) {
      return settled;
    }
    const nodes = Number(authoritativeNodes ?? pending.finalMeta?.nodes) || 0;
    if (nodes <= 0) {
      return 0;
    }
    return nodes * Math.max(1, this.cores);
  }

  _maybeFinishSearch(pending) {
    const need = this.cores;
    const worker0 = pending.results?.get(0);
    const worker0Failed = pending.errors?.has(0);

    if (worker0Failed && (pending.results?.size ?? 0) === 0) {
      return;
    }

    if (!worker0 && !worker0Failed) {
      return;
    }

    if (worker0Failed) {
      this.setStatus('error');
      pending.onError?.(new Error('Authoritative worker 0 failed'));
      return;
    }

    if (!worker0) {
      return;
    }

    const helpersExpected = need - 1;
    const helpersSettled =
      helpersExpected === 0 ||
      [...pending.results.keys()].filter((id) => id !== 0).length +
        [...(pending.errors ?? [])].filter((id) => id !== 0).length >=
        helpersExpected ||
      // Single-worker WASM: never block the game on helper copies that are not running.
      need === 1;

    if (!helpersSettled) {
      return;
    }

    let searchDepth = worker0.depth ?? pending.finalMeta?.searchDepth;
    for (const [id, r] of pending.results) {
      if (id === 0) continue;
      if (
        r.algebraicMove === worker0.algebraicMove &&
        r.depth != null &&
        (searchDepth == null || r.depth > searchDepth)
      ) {
        searchDepth = r.depth;
      }
    }

    const totalNodes = this._aggregateNodes(pending);
    const nodeFields = enrichNodeFields({
      ...(pending.finalMeta ?? {}),
      nodes: worker0.nodes,
      totalNodesAcrossWorkers: totalNodes > 0 ? totalNodes : undefined,
    });
    const selectedWorkerNodes = worker0.nodes ?? nodeFields.selectedWorkerNodes ?? 0;
    const elapsed = performance.now() - pending.started;
    const meta = pending.finalMeta ?? {};
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
      selectedWorkerNodes,
      totalNodes: nodeFields.totalNodes,
      totalNodesAcrossWorkers: nodeFields.totalNodesAcrossWorkers,
      mainThreadNodes: nodeFields.mainThreadNodes,
      helperNodes: nodeFields.helperNodes,
      nodeSource: nodeFields.nodeSource ?? 'bestmove_aggregate',
      estimatedTotalNodes: false,
      stoppedBy: meta.stoppedBy ?? worker0.stoppedBy ?? this.config?.engineMode ?? 'titanium-v15',
      mode: meta.mode ?? worker0.mode ?? this.config?.engineMode ?? 'titanium-v15',
      searchDepth,
      depthLog,
      whiteDist: meta.whiteDist,
      blackDist: meta.blackDist,
      rootScore: meta.rootScore,
      simulations: 0,
      progress: 1,
    });

    if (!worker0.algebraicMove) {
      pending.onError?.(new Error('WASM worker returned no move'));
      return;
    }

    const action = parseAlgebraic(worker0.algebraicMove);
    this.algebraicMoves.push(worker0.algebraicMove);
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

  _onWorkerError(slotIndex, event) {
    const initWaiter = this._readyWaiters.get(slotIndex);
    if (initWaiter) {
      const message =
        event?.message ?? (typeof event === 'string' ? event : null) ?? 'Titanium WASM worker crashed';
      this._rejectReady(slotIndex, new Error(message));
      return;
    }

    const pending = this.pendingRequest;
    if (!pending) {
      return;
    }
    if (slotIndex === 0) {
      this.pendingRequest = null;
      this.terminateWorkers();
      if (pending.retryParams && this.workerCrashRetries < 1) {
        this.workerCrashRetries += 1;
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
    } else {
      pending.errors ??= new Set();
      pending.errors.add(slotIndex);
      this._maybeFinishSearch(pending);
    }
  }

  terminateWorkers() {
    for (const w of this.workers) {
      w.terminate();
    }
    this.workers = [];
    this._workerReady.clear();
    this._workerReadyKeys.clear();
    this._initInFlight = null;
    for (const [, waiter] of this._readyWaiters) {
      waiter.reject(new Error('Worker terminated'));
    }
    this._readyWaiters.clear();
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
    this.startRequest(next);
  }

  async startRequest({ aiSettings, moveHistory, isFreshGame }) {
    const retryParams = { aiSettings, moveHistory, isFreshGame };
    if (isFreshGame) {
      this.algebraicMoves = [];
    } else if (moveHistory?.length) {
      this.algebraicMoves = moveHistory.map(toAlgebraic);
    }

    this.cores = resolveTitaniumSearchCores(aiSettings);

    const timeMs = Math.round((aiSettings?.wallClockSeconds ?? 10) * 1000);
    const maxNodes = resolveMaxNodes(aiSettings?.visitsBudget ?? 0);
    const engineMode = this.config?.engineMode ?? 'titanium-v15';
    const catLmrCeiling =
      engineMode === 'titanium-v16' ? resolveCatLmrCeiling(aiSettings) : 800;

    if (this.pendingRequest) {
      throw new Error('Titanium WASM search already in flight');
    }

    this.ensureWorkers();
    const needsInit = !this.workersReady(engineMode, catLmrCeiling);
    if (needsInit) {
      this.setStatus('connecting');
    }

    const started = performance.now();
    const pending = {
      started,
      initMs: 0,
      timeMs,
      finalMeta: {},
      results: new Map(),
      errors: new Set(),
      retryParams,
      lastInfoNodes: null,
      onInfo: (info) => this.onInfo?.(info),
      onBestMove: (action) => {
        const result = this.onBestMove?.(action);
        return result;
      },
      onError: (err) => {
        this.pendingRequest = null;
        this.onError?.(err);
        this.drainQueuedRequest();
      },
    };
    this.pendingRequest = pending;

    const readyStart = performance.now();
    try {
      await this.initWorkers(engineMode, { catLmrCeiling });
    } catch (err) {
      this.pendingRequest = null;
      this.setStatus('error');
      throw err;
    }
    pending.initMs = performance.now() - readyStart;
    this.setStatus('searching');

    for (let workerId = 0; workerId < this.cores; workerId++) {
      this.workers[workerId].postMessage({
        op: 'search',
        algebraicMoves: this.algebraicMoves,
        timeMs,
        maxNodes,
        isFreshGame: Boolean(isFreshGame),
        engineMode,
        catLmrCeiling,
        workerSlot: workerId,
        streamProgress: true,
      });
    }
  }

  setStatus(status) {
    this.onStatus?.(status);
  }
}
