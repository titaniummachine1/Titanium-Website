/**
 * Titanium — Rust engine via dev-server session proxy (warm TT per seat).
 * Falls back to one-shot `genmove` for MCTS.
 */

import { parseAlgebraic, toAlgebraic } from './gameLogic.js';
import { resolveOnBestMoveResult } from './onBestMoveResult.js';
import {
  cancelActiveSearchRequest,
  createAbortError,
  isAbortError,
} from './engineAbort.js';
import { LOCAL_VISITS_RANGE, clampVisits, uctFromStrengthLevel, resolveCores } from './timeControl.js';
import { enrichNodeFields } from './searchNodes.js';

const SESSION_URL = '/api/titanium/session';
const GENMOVE_URL = '/api/titanium/genmove';

function formatEngineHttpError(data, status) {
  if (data?.error == null) {
    return `HTTP ${status}`;
  }
  if (typeof data.error === 'string') {
    return data.error;
  }
  try {
    return JSON.stringify(data.error);
  } catch {
    return String(data.error);
  }
}

const AB_ENGINE_MODES = new Set([
  'minimax',
  'titanium-v16',
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
  'ace-v13',
  'ace-v13-ti',
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
    /** @type {{ requestId: number, abortController: AbortController } | null} */
    this._activeSearch = null;
    this._requestCounter = 0;
    this.appliedPlies = 0;
    this._syncChain = Promise.resolve();
  }

  async cancelSearch() {
    this.queuedRequest = null;
    const active = this._activeSearch;
    this._activeSearch = null;
    this.pendingRequest = null;
    // Await server stop so this seat's session chain is free before the next ply.
    try {
      await this.sessionOp({ op: 'stop' });
    } catch {
      /* fetch may already be aborted */
    }
    cancelActiveSearchRequest(active);
    this.setStatus('idle');
  }

  clearQueuedSearches() {
    this.queuedRequest = null;
  }

  destroy() {
    void this.cancelSearch();
    this.sessionOp({ op: 'destroy' }).catch(() => {});
  }

  resetConnection() {
    void this.cancelSearch();
    this.appliedPlies = 0;
    this.sessionOp({ op: 'reset' }).catch(() => {});
  }

  /**
   * Abort any search and replay the full position onto the native session.
   * @param {{ moveHistory?: unknown[], isFreshGame?: boolean, level?: number }} [opts]
   * level 0: soft cancel + forceFull position
   * level 1: reset session + forceFull position
   * level 2: destroy session + forceFull position (last resort)
   */
  async recoverFromDesync({ moveHistory, isFreshGame, level = 0 } = {}) {
    const escalate = Math.max(0, Math.min(2, Number(level) || 0));
    await this.cancelSearch();
    if (escalate >= 2) {
      try {
        await this.sessionOp({ op: 'destroy' });
      } catch {
        /* session may already be gone */
      }
    } else if (escalate >= 1) {
      try {
        await this.sessionOp({ op: 'reset' });
      } catch {
        /* ignore */
      }
    }
    const history =
      isFreshGame || !moveHistory?.length
        ? []
        : moveHistory.map((action) => toAlgebraic(action));
    this.appliedPlies = 0;
    await this.enqueueSync(() =>
      this.syncMovesToSession(history, { forceFull: true }),
    );
    this.setStatus('idle');
  }

  /** Echo one committed ply onto the warm native session (incremental makemove). */
  echoCommittedMove(action, positionKey, historyLength, moveHistory = null) {
    void positionKey;
    const history = moveHistory?.length
      ? moveHistory.map((a) => toAlgebraic(a))
      : null;
    if (history && history.length !== historyLength) {
      return Promise.reject(new Error('echoCommittedMove history length mismatch'));
    }
    if (this.appliedPlies >= historyLength) {
      return Promise.resolve();
    }
    if (this.appliedPlies !== historyLength - 1) {
      if (!history) {
        return Promise.reject(new Error('native titanium partial sync requires full history'));
      }
      return this.enqueueSync(() =>
        this.syncMovesToSession(history, {
          incremental: true,
          forceFull: history.length === 0,
        }),
      );
    }
    const move = toAlgebraic(action);
    return this.enqueueSync(async () => {
      await this.sessionOp({ op: 'makemove', move, cores: 1 });
      this.appliedPlies = historyLength;
    });
  }

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

  isActiveSearch(searchCtx) {
    if (!searchCtx) {
      return false;
    }
    return (
      this._activeSearch?.requestId === searchCtx.requestId &&
      this._activeSearch?.abortController === searchCtx.abortController
    );
  }

  async sessionOp(body, { stream = false, signal } = {}) {
    if (signal?.aborted) {
      throw createAbortError();
    }
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
      throw new Error(formatEngineHttpError(data, res.status));
    }
    return res;
  }

  enqueueSync(fn) {
    this._syncChain = this._syncChain.then(fn).catch((err) => {
      if (!isAbortError(err)) {
        this.appliedPlies = 0;
      }
      throw err;
    });
    return this._syncChain;
  }

  async syncMovesToSession(
    algebraicMoves,
    { incremental = false, forceFull = false, signal, cores = 1 } = {},
  ) {
    if (signal?.aborted) {
      throw createAbortError();
    }

    const moves = algebraicMoves ?? [];
    if (!forceFull && !incremental && moves.length === 0 && this.appliedPlies === 0) {
      return;
    }

    if (forceFull || !incremental || moves.length < this.appliedPlies) {
      await this.sessionOp({ op: 'position', moves, cores }, { signal });
      this.appliedPlies = moves.length;
      return;
    }

    const delta = moves.slice(this.appliedPlies);
    if (delta.length === 0) {
      return;
    }

    for (const move of delta) {
      if (signal?.aborted) {
        throw createAbortError();
      }
      await this.sessionOp({ op: 'makemove', move, cores }, { signal });
    }
    this.appliedPlies = moves.length;
  }

  startRequest({ aiSettings, moveHistory, isFreshGame, onSearchStart }) {
    const history =
      isFreshGame || !moveHistory?.length
        ? []
        : moveHistory.map((action) => toAlgebraic(action));

    const useEngineTm =
      aiSettings?.useEngineTimeManagement === true ||
      (aiSettings?.wholeGameRemainingSeconds != null &&
        aiSettings?.wholeGameTime !== false);
    const remainingSec = useEngineTm
      ? Math.max(
          0.05,
          Number(aiSettings?.wholeGameRemainingSeconds) || 0.05,
        )
      : null;
    // Per-move / non-TM: website wall slice. Whole-game TM: do not send a
    // site-sliced movetime as the primary budget — native `go rem` owns it.
    const timeSec = useEngineTm
      ? remainingSec
      : Math.max(0.5, Number(aiSettings?.wallClockSeconds) || 10);
    const maxBudget = clampVisits(aiSettings?.visitsBudget ?? LOCAL_VISITS_RANGE.default);
    const uct = uctFromStrengthLevel(aiSettings?.strengthLevel);
    const cores = resolveCores(aiSettings);
    const configured = this.config?.engineMode;
    const engineMode =
      configured === 'minimax' ||
      configured === 'titanium-v16' ||
      isAlphaBetaEngineMode(configured)
        ? configured
        : 'mcts';

    const abortController = new AbortController();
    const signal = abortController.signal;
    const requestId = ++this._requestCounter;

    if (signal.aborted) {
      return;
    }

    this.setStatus('searching');
    const started = performance.now();
    this.pendingRequest = { started, timeSec, requestId, abortController, signal };
    this._activeSearch = { requestId, abortController };

    const searchCtx = {
      requestId,
      abortController,
      signal,
      timeSec,
      remainingSec,
      useEngineTm,
      maxBudget,
      uct,
      engineMode,
      cores,
      started,
      isAlphaBeta: engineMode !== 'mcts' && isAlphaBetaEngineMode(engineMode),
      onSearchStart,
      searchStarted: false,
    };

    if (engineMode !== 'mcts') {
      this.startSessionGenmove(history, searchCtx);
    } else {
      this.startOneShotGenmove(history, searchCtx);
    }
  }

  startSessionGenmove(history, searchCtx) {
    const { signal, engineMode, isAlphaBeta } = searchCtx;

    if (signal.aborted) {
      this.handleSearchFailure(createAbortError(), searchCtx);
      return;
    }

    this.onInfo?.({
      thinking: true,
      mode: engineMode,
      stoppedBy: engineMode,
      nodes: 0,
      simulations: 0,
    });

    this.enqueueSync(() =>
      this.syncMovesToSession(history, {
        incremental: true,
        forceFull: history.length === 0,
        signal: searchCtx.signal,
        cores: searchCtx.cores,
      }),
    )
      .then(() => {
        if (signal.aborted || !this.isActiveSearch(searchCtx)) {
          throw createAbortError();
        }
        if (!searchCtx.searchStarted) {
          searchCtx.searchStarted = true;
          searchCtx.onSearchStart?.();
        }
        const goBody = searchCtx.useEngineTm
          ? {
              op: 'go',
              goMode: 'rem',
              useEngineTimeManagement: true,
              remainingSec: searchCtx.remainingSec,
              timeSec: searchCtx.remainingSec,
              maxNodes: searchCtx.maxBudget,
              cores: searchCtx.cores,
            }
          : {
              op: 'go',
              timeSec: searchCtx.timeSec,
              maxNodes: searchCtx.maxBudget,
              cores: searchCtx.cores,
            };
        return this.sessionOp(goBody, { stream: true, signal });
      })
      .then(async (res) => {
        if (signal.aborted || !this.isActiveSearch(searchCtx)) {
          throw createAbortError();
        }
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(formatEngineHttpError(data, res.status));
        }
        return this.consumeSearchStream(res, searchCtx);
      })
      .catch((err) => this.handleSearchFailure(err, searchCtx));
  }

  startOneShotGenmove(history, searchCtx) {
    const { signal, engineMode, isAlphaBeta } = searchCtx;

    if (signal.aborted) {
      this.handleSearchFailure(createAbortError(), searchCtx);
      return;
    }

    if (isAlphaBeta) {
      this.onInfo?.({
        thinking: true,
        mode: engineMode,
        stoppedBy: engineMode,
        nodes: 0,
        simulations: 0,
      });
    }

    if (!searchCtx.searchStarted) {
      searchCtx.searchStarted = true;
      searchCtx.onSearchStart?.();
    }

    fetch(GENMOVE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        moves: history,
        timeSec: searchCtx.timeSec,
        maxSimulations: searchCtx.maxBudget,
        maxNodes: searchCtx.maxBudget,
        uct: searchCtx.uct,
        engine: engineMode,
        cores: searchCtx.cores ?? 1,
        stream: true,
      }),
      signal,
    })
      .then(async (res) => {
        if (signal.aborted || !this.isActiveSearch(searchCtx)) {
          throw createAbortError();
        }
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(formatEngineHttpError(data, res.status));
        }
        return this.consumeSearchStream(res, searchCtx);
      })
      .catch((err) => this.handleSearchFailure(err, searchCtx));
  }

  async consumeSearchStream(res, searchCtx) {
    const { signal, timeSec, engineMode, started, isAlphaBeta } = searchCtx;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalMeta = {
      stoppedBy: engineMode,
      simulations: 0,
      nodes: 0,
    };

    while (true) {
      if (signal.aborted || !this.isActiveSearch(searchCtx)) {
        throw createAbortError();
      }

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

          finalMeta = {
            ...finalMeta,
            ...data,
            stoppedBy,
            depthLog: depthLog ?? finalMeta.depthLog,
            searchDepth: data.searchDepth ?? finalMeta.searchDepth,
            rootScore: data.rootScore ?? finalMeta.rootScore,
            whiteDist: data.whiteDist ?? finalMeta.whiteDist,
            blackDist: data.blackDist ?? finalMeta.blackDist,
            rootMoves: data.rootMoves?.length ? data.rootMoves : finalMeta.rootMoves,
            ...enrichNodeFields({ ...finalMeta, ...data, depthLog: depthLog ?? finalMeta.depthLog }),
          };

          const isMinimax = isAlphaBetaEngineMode(stoppedBy);
          this.onInfo?.({
            thinking: true,
            mode: stoppedBy,
            stoppedBy,
            simulations: isMinimax ? 0 : data.simulations,
            nodes: finalMeta.nodes,
            totalNodes: finalMeta.totalNodes,
            totalNodesAcrossWorkers: finalMeta.totalNodesAcrossWorkers,
            mainThreadNodes: finalMeta.mainThreadNodes,
            helperNodes: finalMeta.helperNodes,
            selectedWorkerNodes: finalMeta.selectedWorkerNodes,
            nodeSource: finalMeta.nodeSource,
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
          throw new Error(formatEngineHttpError(data, res.status));
        }

        if (data.type === 'bestmove') {
          if (signal.aborted || !this.isActiveSearch(searchCtx)) {
            throw createAbortError();
          }

          const elapsed = performance.now() - started;
          this.clearActiveSearchIfCurrent(searchCtx);
          this.setStatus('idle');

          const stoppedBy = finalMeta.stoppedBy ?? data.stoppedBy ?? engineMode;
          const isAbFinal = isAlphaBetaEngineMode(stoppedBy);
          const finalNodes = enrichNodeFields(finalMeta);
          this.onInfo?.({
            time: elapsed,
            elapsedMs: finalMeta.elapsedMs ?? Math.round(elapsed),
            stoppedBy,
            simulations: isAbFinal ? 0 : (finalMeta.simulations ?? 0),
            nodes: finalNodes.nodes,
            totalNodes: finalNodes.totalNodes,
            totalNodesAcrossWorkers: finalNodes.totalNodesAcrossWorkers,
            mainThreadNodes: finalNodes.mainThreadNodes,
            helperNodes: finalNodes.helperNodes,
            selectedWorkerNodes: finalNodes.selectedWorkerNodes,
            nodeSource: finalNodes.nodeSource,
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

  clearActiveSearchIfCurrent(searchCtx) {
    if (this.isActiveSearch(searchCtx)) {
      this.pendingRequest = null;
      this._activeSearch = null;
    }
  }

  handleSearchFailure(err, searchCtx) {
    const signal = searchCtx?.signal;
    const aborted = isAbortError(err, signal);

    if (searchCtx && this.isActiveSearch(searchCtx)) {
      this.pendingRequest = null;
      this._activeSearch = null;
    } else if (!searchCtx) {
      this.pendingRequest = null;
      this._activeSearch = null;
    }

    if (aborted) {
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
