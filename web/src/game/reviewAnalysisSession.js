import { TitaniumWasmEngineClient } from '../lib/titaniumWasmClient.js';
import { normalizeRootMoveToken } from '../lib/liveBestMove.js';
import { analysisResultToEvalState } from './analysisEngineSession.js';

const MAX_REVIEW_WORKERS = 12;
const REVIEW_JOB_TIMEOUT_GRACE_MS = 15_000;

function clampWorkerCount(value, totalJobs) {
  const n = Math.max(1, Math.round(Number(value) || 1));
  return Math.max(1, Math.min(MAX_REVIEW_WORKERS, totalJobs || 1, n));
}

function splitPv(pv) {
  if (Array.isArray(pv)) {
    return pv.filter(Boolean).map(String);
  }
  if (typeof pv === 'string') {
    return pv.trim().split(/\s+/).filter(Boolean);
  }
  return [];
}

function latestInfoToEval(info, playerToMove) {
  if (!info) {
    return null;
  }
  return analysisResultToEvalState({
    whiteDist: info.whiteDist,
    blackDist: info.blackDist,
    rootScore: info.rootScore,
    playerToMove,
    depth: info.searchDepth,
    pv: splitPv(info.pv).join(' '),
    rootMove: info.rootMove,
    rootMoves: info.rootMoves,
    nodes: info.nodes,
  });
}

function bestMoveFromPosition(position) {
  const evalState = position?.eval;
  if (!evalState) {
    return null;
  }
  if (evalState.rootMove) {
    return normalizeRootMoveToken(evalState.rootMove);
  }
  if (evalState.pv?.[0]) {
    return normalizeRootMoveToken(evalState.pv[0]);
  }
  const roots = Array.isArray(evalState.rootMoves) ? evalState.rootMoves : [];
  const best = [...roots].sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity))[0];
  return best?.move ? normalizeRootMoveToken(best.move) : null;
}

function pct(evalState) {
  return Number.isFinite(evalState?.p1) ? evalState.p1 * 100 : null;
}

export function classifyReviewMoves(positions, moves) {
  return (moves ?? []).map((move, ply) => {
    const before = positions?.[ply];
    const after = positions?.[ply + 1];
    const beforePct = pct(before?.eval);
    const afterPct = pct(after?.eval);
    const played = normalizeRootMoveToken(move);
    const bestMove = bestMoveFromPosition(before);

    if (beforePct == null || afterPct == null) {
      return { ply, move, classification: 'pending', label: '...', bestMove };
    }

    const moverSign = ply % 2 === 0 ? 1 : -1;
    const deltaPct = (afterPct - beforePct) * moverSign;
    let classification = 'excellent';
    let label = 'Excellent';
    if (bestMove && played === bestMove) {
      classification = 'best';
      label = 'Best';
    } else if (deltaPct < -20) {
      classification = 'blunder';
      label = 'Blunder';
    } else if (deltaPct < -10) {
      classification = 'mistake';
      label = 'Mistake';
    } else if (deltaPct < -5) {
      classification = 'inaccuracy';
      label = 'Inacc';
    } else if (deltaPct < -2) {
      classification = 'okay';
      label = 'Okay';
    }

    return {
      ply,
      move,
      classification,
      label,
      deltaPct,
      beforePct,
      afterPct,
      bestMove,
    };
  });
}

export class ReviewAnalysisSession {
  constructor() {
    this.onUpdate = null;
    this.clients = [];
    this.actions = [];
    this.positions = [];
    this.settings = {};
    this.status = 'idle';
    this.paused = false;
    this._token = 0;
    this._queue = [];
    this._running = 0;
    this._workerCount = 0;
    this._lastPublish = 0;
    this._jobTimers = new Map();
  }

  snapshot() {
    const completed = this.positions.filter((p) => p?.status === 'done').length;
    return {
      status: this.status,
      paused: this.paused,
      total: this.positions.length,
      completed,
      running: this._running,
      workerCount: this._workerCount,
      positions: this.positions.map((p) => ({ ...p, eval: p.eval ? { ...p.eval } : null })),
    };
  }

  start(actions, settings = {}, seedPositions = []) {
    this.stop({ destroyClients: true, publish: false });
    this.actions = [...(actions ?? [])];
    this.settings = { ...settings };
    const total = this.actions.length + 1;
    this.positions = Array.from({ length: total }, (_, index) => {
      const seeded = seedPositions?.[index];
      if (seeded?.eval) {
        return { ...seeded, status: 'done', eval: { ...seeded.eval } };
      }
      return { index, status: 'pending', eval: null, error: null, depth: null, nodes: null, attempts: 0 };
    });
    this._queue = this.positions
      .filter((p) => p.status !== 'done')
      .map((p) => p.index);
    this._workerCount = clampWorkerCount(settings?.cores, this._queue.length || total);
    this.clients = Array.from({ length: this._workerCount }, () =>
      new TitaniumWasmEngineClient({ engineMode: 'titanium-v16', cores: 1 }),
    );
    this.status = this._queue.length ? 'running' : 'complete';
    this.paused = false;
    this._running = 0;
    this._token += 1;
    const token = this._token;
    this._publish(true);
    for (let i = 0; i < this.clients.length; i += 1) {
      this._runWorker(i, token);
    }
  }

  pause() {
    if (this.status !== 'running') {
      return;
    }
    this.paused = true;
    this.status = 'paused';
    this._token += 1;
    this._clearAllJobTimers();
    for (const position of this.positions) {
      if (position.status === 'running') {
        position.status = 'pending';
        this._queue.unshift(position.index);
      }
    }
    this._running = 0;
    for (const client of this.clients) {
      void client.cancelSearch();
    }
    this._publish(true);
  }

  resume() {
    if (this.status !== 'paused') {
      return;
    }
    this.paused = false;
    this.status = this._queue.length ? 'running' : 'complete';
    this._token += 1;
    const token = this._token;
    this._publish(true);
    for (let i = 0; i < this.clients.length; i += 1) {
      this._runWorker(i, token);
    }
  }

  togglePaused() {
    if (this.status === 'paused') {
      this.resume();
    } else {
      this.pause();
    }
  }

  stop({ destroyClients = false, publish = true } = {}) {
    this._token += 1;
    this.paused = false;
    this.status = 'idle';
    this._queue = [];
    this._running = 0;
    this._clearAllJobTimers();
    for (const client of this.clients) {
      void client.cancelSearch();
      if (destroyClients) {
        client.destroy();
      }
    }
    if (destroyClients) {
      this.clients = [];
    }
    if (publish) {
      this._publish(true);
    }
  }

  destroy() {
    this.stop({ destroyClients: true, publish: false });
  }

  _nextJob() {
    while (this._queue.length) {
      const index = this._queue.shift();
      if (this.positions[index]?.status === 'pending') {
        return index;
      }
    }
    return null;
  }

  _runWorker(workerIndex, token) {
    if (token !== this._token || this.paused || this.status !== 'running') {
      return;
    }
    const client = this.clients[workerIndex];
    const index = this._nextJob();
    if (!client || index == null) {
      this._finishIfIdle(token);
      return;
    }

    const position = this.positions[index];
    const actions = this.actions.slice(0, index);
    const playerToMove = index % 2 === 0 ? 1 : 2;
    const wallClockSeconds = Math.max(0.1, Number(this.settings.wallClockSeconds) || 5);
    let latestInfo = null;

    position.status = 'running';
    position.error = null;
    position.workerIndex = workerIndex;
    position.attempts = (position.attempts ?? 0) + 1;
    this._running += 1;
    this._publish();
    this._armJobTimer(workerIndex, token, index, wallClockSeconds);

    client.onInfo = (info) => {
      if (token !== this._token || this.positions[index]?.status !== 'running') {
        return;
      }
      latestInfo = { ...(latestInfo ?? {}), ...info };
      const evalState = latestInfoToEval(latestInfo, playerToMove);
      this.positions[index] = {
        ...this.positions[index],
        depth: latestInfo.searchDepth ?? this.positions[index].depth ?? null,
        nodes: latestInfo.nodes ?? this.positions[index].nodes ?? null,
        liveEval: evalState,
      };
      this._publish();
    };
    client.onBestMove = () => {
      this._completeJob(workerIndex, token, index, latestInfo, playerToMove, null);
      return false;
    };
    client.onError = (err) => {
      this._completeJob(workerIndex, token, index, latestInfo, playerToMove, err);
    };
    client.requestMove({
      aiSettings: {
        wallClockSeconds,
        cores: 1,
        titaniumNet: this.settings.titaniumNet ?? 'hard',
        visitsBudget: 0,
      },
      moveHistory: actions,
      isFreshGame: index === 0,
    });
  }

  _completeJob(workerIndex, token, index, latestInfo, playerToMove, err) {
    if (token !== this._token) {
      return;
    }
    this._clearJobTimer(index);
    const evalState = latestInfoToEval(latestInfo, playerToMove);
    if (!evalState) {
      this._retryJob(workerIndex, token, index, err ?? new Error('No eval returned'));
      return;
    }
    this.positions[index] = {
      ...this.positions[index],
      status: 'done',
      eval: evalState,
      liveEval: null,
      error: null,
      depth: evalState?.depth ?? this.positions[index]?.depth ?? null,
      nodes: latestInfo?.nodes ?? this.positions[index]?.nodes ?? null,
      workerIndex: null,
    };
    this._running = Math.max(0, this._running - 1);
    this._publish(true);
    queueMicrotask(() => this._runWorker(workerIndex, token));
  }

  _retryJob(workerIndex, token, index, err, { replaceClient = false } = {}) {
    if (token !== this._token) {
      return;
    }
    this._clearJobTimer(index);
    const message = err?.message ?? String(err ?? 'Review search failed');
    const attempts = this.positions[index]?.attempts ?? 0;
    if (replaceClient || attempts > 1) {
      this._replaceClient(workerIndex);
    } else {
      void this.clients[workerIndex]?.cancelSearch();
    }
    this.positions[index] = {
      ...this.positions[index],
      status: 'pending',
      error: message,
      liveEval: null,
      workerIndex: null,
    };
    this._running = Math.max(0, this._running - 1);
    if (!this._queue.includes(index)) {
      this._queue.unshift(index);
    }
    this.status = this.paused ? 'paused' : 'running';
    this._publish(true);
    if (!this.paused) {
      const retryDelayMs = Math.min(5_000, Math.max(250, attempts * 750));
      setTimeout(() => this._runWorker(workerIndex, token), retryDelayMs);
    }
  }

  _replaceClient(workerIndex) {
    const old = this.clients[workerIndex];
    old?.destroy?.();
    this.clients[workerIndex] = new TitaniumWasmEngineClient({ engineMode: 'titanium-v16', cores: 1 });
  }

  _armJobTimer(workerIndex, token, index, wallClockSeconds) {
    this._clearJobTimer(index);
    const timeoutMs = Math.max(
      30_000,
      Math.round(wallClockSeconds * 1000) + REVIEW_JOB_TIMEOUT_GRACE_MS,
    );
    const timer = setTimeout(() => {
      const position = this.positions[index];
      if (
        token !== this._token ||
        this.paused ||
        position?.status !== 'running' ||
        position.workerIndex !== workerIndex
      ) {
        return;
      }
      this._retryJob(
        workerIndex,
        token,
        index,
        new Error(`Review search timed out at ply ${index}`),
        { replaceClient: true },
      );
    }, timeoutMs);
    this._jobTimers.set(index, timer);
  }

  _clearJobTimer(index) {
    const timer = this._jobTimers.get(index);
    if (timer != null) {
      clearTimeout(timer);
      this._jobTimers.delete(index);
    }
  }

  _clearAllJobTimers() {
    for (const timer of this._jobTimers.values()) {
      clearTimeout(timer);
    }
    this._jobTimers.clear();
  }

  _finishIfIdle(token) {
    if (token !== this._token || this.paused || this._running > 0 || this._queue.length > 0) {
      return;
    }
    const unfinished = this.positions.filter((p) => p?.status !== 'done');
    if (unfinished.length > 0) {
      for (const position of unfinished) {
        position.status = 'pending';
        position.workerIndex = null;
        if (!this._queue.includes(position.index)) {
          this._queue.push(position.index);
        }
      }
      this.status = 'running';
      this._publish(true);
      for (let i = 0; i < this.clients.length; i += 1) {
        this._runWorker(i, token);
      }
      return;
    }
    this.status = 'complete';
    this._publish(true);
  }

  _publish(force = false) {
    const now = performance.now();
    if (!force && now - this._lastPublish < 120) {
      return;
    }
    this._lastPublish = now;
    this.onUpdate?.(this.snapshot());
  }
}
