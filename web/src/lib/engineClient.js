/**
 * Browser WebSocket client for remote Ishtar/Ka engines.
 *
 * Explicit per-connection sync state:
 *   connectionEpoch, syncState, appliedPlies, appliedPositionKey,
 *   activeRequestSeq, ordered command queue.
 *
 * Invariant before every `go`:
 *   syncState === SYNCED
 *   appliedPlies === local history length
 *   appliedPositionKey === current canonical position key
 *   command queue drained (no in-flight makemove batch)
 *
 * Remote bestmove does NOT advance appliedPlies — only echoed makemove does.
 */

import {
  AUTH_TOKEN,
  INFO_LINE_RE,
  BESTMOVE_LINE_RE,
  TimeToMove,
  buildPositionString,
  parseInfoLine,
} from './engineConfig.js';

import {
  SyncState,
  positionKeyFromHistory,
  toEngineAlgebraic,
  fromEngineAlgebraic,
} from './remoteSync.js';
import { createAbortError } from './engineAbort.js';

const WS_OPEN = 1;

const CommandKind = {
  HANDSHAKE: 0,
  SETOPTION: 1,
  STOP: 2,
  SYNCPOSITION: 3,
  GO: 4,
};

/** @internal Test-only mock WebSocket registry. */
export const _mockSockets = [];

export class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = MockWebSocket.CONNECTING;
    this.sent = [];
    this._handlers = {};
    _mockSockets.push(this);
  }

  addEventListener(type, fn) {
    this._handlers[type] = fn;
  }

  send(data) {
    if (this.readyState !== MockWebSocket.OPEN) {
      throw new Error('MockWebSocket not open');
    }
    this.sent.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this._handlers.close?.();
  }

  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this._handlers.open?.();
  }

  simulateMessage(data) {
    this._handlers.message?.({ data });
  }
}

export class EngineClient {
  constructor(engineConfig, { webSocketFactory = null } = {}) {
    this.config = engineConfig;
    this._wsFactory = webSocketFactory ?? ((uri) => new WebSocket(uri));

    this.ws = null;
    this.connectionEpoch = 0;
    this.syncState = SyncState.SYNCED;
    this.appliedPlies = 0;
    this.appliedPositionKey = '';
    this.activeRequestSeq = 0;
    this._localHistoryLength = 0;
    this._localPositionKey = '';

    this._commandQueue = [];
    this._queueDraining = false;
    this._pendingMakemoveCount = 0;

    this.sendBuffer = [];
    this.outstandingSearches = 0;
    this.isPondering = false;
    this._goBlocked = false;
    this.lastTimeMode = null;
    this.pendingSearch = null;
    this._lastSearch = null;
    this._reconnectAttempts = 0;
    this._callbackEpoch = 0;

    this.onInfo = null;
    this.onBestMove = null;
    this.onStatus = null;
    this.onError = null;
  }

  destroy() {
    this.stop();
    this.ws?.close();
    this.ws = null;
    this.sendBuffer = [];
    this.outstandingSearches = 0;
    this.pendingSearch = null;
    this._commandQueue = [];
    this._pendingMakemoveCount = 0;
    this.setStatus('idle');
  }

  resetConnection() {
    this.destroy();
    this.connectionEpoch = 0;
    this.syncState = SyncState.SYNCED;
    this.appliedPlies = 0;
    this.appliedPositionKey = '';
    this._goBlocked = false;
  }

  updateLocalExpectations(moveHistory, positionKey) {
    this._localHistoryLength = moveHistory.length;
    this._localPositionKey = positionKey ?? positionKeyFromHistory(moveHistory);
  }

  markDesynced(reason) {
    this.syncState = SyncState.DESYNCED;
    this._goBlocked = true;
    this.activeRequestSeq = 0;
    this.outstandingSearches = 0;
    this.pendingSearch = null;
    if (this.isPondering) {
      this.isPondering = false;
    }
    this._enqueueRaw(CommandKind.STOP, 'stop');
    this.setStatus('error');
    if (reason) {
      this.onError?.(new Error(reason));
    }
  }

  async recoverFromDesync(ctx) {
    await this._runFullResync(ctx);
  }

  /** Echo one committed ply to the remote search box (including own bestmove). */
  echoCommittedMove(action, positionKey, historyLength) {
    this._localHistoryLength = historyLength;
    this._localPositionKey = positionKey;

    if (this.syncState === SyncState.DESYNCED) {
      return Promise.reject(new Error('remote engine DESYNCED — full resync required'));
    }
    if (this.appliedPlies >= historyLength) {
      return Promise.resolve();
    }
    if (this.appliedPlies !== historyLength - 1) {
      this.markDesynced(
        `partial sync: appliedPlies=${this.appliedPlies} expected=${historyLength - 1}`,
      );
      return Promise.reject(new Error('remote engine partial sync failure'));
    }

    const moveStr = toEngineAlgebraic(action, this.config.notation);
    return this._enqueueMakemove(moveStr).then(() => {
      this.appliedPlies = historyLength;
      this.appliedPositionKey = positionKey;
    });
  }

  /** Legacy batch API — replays from scratch (undo / reconnect / mid-game bind). */
  syncGameState({ moveHistory, gameSnapshot, isFreshGame, positionKey }) {
    const key = positionKey ?? positionKeyFromHistory(moveHistory);
    this.updateLocalExpectations(moveHistory, key);
    return this._runFullResync({ moveHistory, gameSnapshot, isFreshGame, positionKey: key });
  }

  /** Explicit pre-go sync — remote engines only. */
  async ensureSynchronized({
    history,
    positionKey,
    gameSnapshot,
    isFreshGame,
    signal,
  }) {
    if (signal?.aborted) {
      throw createAbortError();
    }
    const moveHistory = history ?? [];
    const key = positionKey ?? positionKeyFromHistory(moveHistory);
    this.updateLocalExpectations(moveHistory, key);

    if (this.syncState === SyncState.DESYNCED) {
      throw new Error('remote engine DESYNCED — full resync required');
    }
    if (
      this.appliedPlies !== moveHistory.length ||
      this.appliedPositionKey !== key
    ) {
      await this._runFullResync({
        moveHistory,
        gameSnapshot,
        isFreshGame: isFreshGame ?? moveHistory.length === 0,
        positionKey: key,
      });
    }
    if (this.syncState !== SyncState.SYNCED) {
      throw new Error(`remote engine not SYNCED (${this.syncState})`);
    }
    if (this._pendingMakemoveCount > 0) {
      throw new Error('remote makemove queue still in flight');
    }
  }

  makeMoves(actions) {
    const key = positionKeyFromHistory(actions);
    this.updateLocalExpectations(actions, key);
    return this._runFullResync({
      moveHistory: actions,
      gameSnapshot: null,
      isFreshGame: actions.length === 0,
      positionKey: key,
    });
  }

  setPosition(gameSnapshot, positionKey = '') {
    this.updateLocalExpectations([], positionKey);
    return this._runFullResync({
      moveHistory: [],
      gameSnapshot,
      isFreshGame: false,
      positionKey,
    });
  }

  go(timeMode) {
    if (timeMode == null) {
      timeMode = TimeToMove.Short;
    }
    this.lastTimeMode = timeMode;
    this._assertGoInvariant();
    const visits = this.config.visits?.[timeMode];
    this.outstandingSearches++;

    if (Number.isFinite(visits)) {
      this._enqueueRaw(CommandKind.SETOPTION, `setoption name visits value ${visits}`);
    }
    this.sendTimeToMoveSettings(timeMode);
    this._enqueueRaw(CommandKind.GO, 'go');
    this.setStatus('searching');
  }

  requestMove({ aiSettings, gameSnapshot, moveHistory, isFreshGame, positionKey, requestSeq }) {
    const timeMode = aiSettings?.timeToMove;
    const key = positionKey ?? positionKeyFromHistory(moveHistory);
    this.updateLocalExpectations(moveHistory, key);
    this.activeRequestSeq = requestSeq ?? 0;
    this._lastSearch = {
      aiSettings,
      gameSnapshot,
      moveHistory,
      isFreshGame,
      timeMode,
      positionKey: key,
      requestSeq,
    };
    this._reconnectAttempts = 0;

    const runSearch = async () => {
      if (this.syncState === SyncState.DESYNCED) {
        await this._runFullResync({
          moveHistory,
          gameSnapshot,
          isFreshGame,
          positionKey: key,
        });
      } else if (
        this.appliedPlies !== moveHistory.length ||
        this.appliedPositionKey !== key
      ) {
        await this._runFullResync({
          moveHistory,
          gameSnapshot,
          isFreshGame,
          positionKey: key,
        });
      }
      this.go(timeMode);
    };

    if (this.ws?.readyState === WS_OPEN) {
      return runSearch().catch((err) => {
        this.markDesynced(err?.message ?? String(err));
        throw err;
      });
    }

    this.pendingSearch = () => {
      runSearch().catch((err) => {
        this.markDesynced(err?.message ?? String(err));
      });
    };
    this.connect();
    return Promise.resolve();
  }

  ponder(timeMode) {
    if (this.outstandingSearches > 0 || this.isPondering || this._goBlocked) {
      return;
    }
    if (timeMode == null) {
      timeMode = this.lastTimeMode ?? TimeToMove.Short;
    }
    this.lastTimeMode = timeMode;
    this.sendTimeToMoveSettings(timeMode);
    this._enqueueRaw(CommandKind.GO, 'go ponder');
    this.isPondering = true;
    this.setStatus('pondering');
  }

  stopPonder() {
    this.stop();
  }

  async cancelSearch() {
    this.pendingSearch = null;
    if (this.isPondering || this.outstandingSearches > 0) {
      this._enqueueRaw(CommandKind.STOP, 'stop');
    }
    this.isPondering = false;
    this.outstandingSearches = 0;
    this.setStatus('idle');
  }

  stop() {
    if (!this.isPondering && this.outstandingSearches === 0) {
      return;
    }
    this._enqueueRaw(CommandKind.STOP, 'stop');
    this.isPondering = false;
    this.outstandingSearches = 0;
    this.setStatus('idle');
  }

  clearQueuedSearches() {
    this.pendingSearch = null;
    this.outstandingSearches = 0;
    this._goBlocked = true;
    this._enqueueRaw(CommandKind.STOP, 'stop');
  }

  connect() {
    if (this.ws) {
      return;
    }

    this.setStatus('connecting');
    const socket = this._wsFactory(this.config.uri);
    this.ws = socket;
    const epoch = this.connectionEpoch;

    socket.addEventListener('open', () => {
      if (this.ws !== socket || epoch !== this.connectionEpoch) {
        return;
      }
      this.onOpen();
    });
    socket.addEventListener('message', (event) => {
      if (this.ws !== socket || epoch !== this.connectionEpoch) {
        return;
      }
      this.onMessage(event.data);
    });
    socket.addEventListener('error', () => {
      if (this.ws === socket && epoch === this.connectionEpoch) {
        this.setStatus('error');
        this.onError?.(new Error('WebSocket connection failed'));
      }
    });
    socket.addEventListener('close', () => {
      if (this.ws !== socket || epoch !== this.connectionEpoch) {
        return;
      }
      const wasSearching = this.outstandingSearches > 0;
      this.ws = null;

      if (wasSearching && this._lastSearch && this._reconnectAttempts < 3) {
        this._reconnectAttempts += 1;
        this.markDesynced('WebSocket closed mid-search — reconnecting');
        this.outstandingSearches = 0;
        this.pendingSearch = () => {
          const ctx = this._lastSearch;
          this.recoverFromDesync({
            moveHistory: ctx.moveHistory,
            gameSnapshot: ctx.gameSnapshot,
            isFreshGame: ctx.isFreshGame,
            positionKey: ctx.positionKey,
          }).then(() => this.go(ctx.timeMode));
        };
        this.connectionEpoch += 1;
        this._callbackEpoch = this.connectionEpoch;
        this.connect();
        return;
      }

      this.setStatus('error');
      if (this.pendingSearch || wasSearching) {
        this.pendingSearch = null;
        this.onError?.(new Error('WebSocket closed before bestmove'));
      }
    });
  }

  send(command) {
    this._enqueueRaw(CommandKind.SETOPTION, command);
  }

  onOpen() {
    const epoch = this.connectionEpoch;
    this._callbackEpoch = epoch;
    this.ws.send(JSON.stringify({ token: AUTH_TOKEN, version: '0.0.0' }));
    this.sendStaticSettings();

    if (this.lastTimeMode != null) {
      this.sendTimeToMoveSettings(this.lastTimeMode);
    }

    for (const command of this.sendBuffer) {
      if (this.ws?.readyState === WS_OPEN) {
        this.ws.send(command);
      }
    }
    this.sendBuffer = [];
    this.setStatus('idle');

    if (this.pendingSearch) {
      const runSearch = this.pendingSearch;
      this.pendingSearch = null;
      runSearch();
    }
  }

  onMessage(rawMessage) {
    if (this._callbackEpoch !== this.connectionEpoch) {
      return;
    }

    const isBenignLog =
      /\bWARN\b/i.test(rawMessage) ||
      /already-known hash/i.test(rawMessage) ||
      /tensorflow/i.test(rawMessage);
    if (/log Error/i.test(rawMessage) && !isBenignLog) {
      this.setStatus('error');
      this.onError?.(new Error(rawMessage));
      return;
    }

    const infoMatch = INFO_LINE_RE.exec(rawMessage);
    if (infoMatch) {
      const info = parseInfoLine(infoMatch[1]);
      if (info.pv && typeof info.pv === 'string') {
        info.pv = info.pv.split(' ').map((move) => fromEngineAlgebraic(move, this.config.notation));
      }
      if (info.p1 !== undefined) {
        info.winChance = info.p1;
      } else if (info.score !== undefined) {
        info.winChance = info.score;
        info.p1 = info.score;
      }
      const visits = info.visits ?? info.nodes;
      this.onInfo?.({
        ...info,
        thinking: true,
        simulations: visits,
        nodes: visits,
        searchDepth: info.depth ?? info.searchDepth,
        rootWinRate: info.winChance ?? info.p1 ?? info.score,
        connectionEpoch: this.connectionEpoch,
        requestSeq: this.activeRequestSeq,
      });
      return;
    }

    const bestMoveMatch = BESTMOVE_LINE_RE.exec(rawMessage);
    if (!bestMoveMatch) {
      return;
    }

    this.outstandingSearches = Math.max(0, this.outstandingSearches - 1);
    this._reconnectAttempts = 0;
    this.setStatus('idle');

    const moveText = bestMoveMatch[1].trim().split(/\s+/)[0];
    if (!moveText) {
      return;
    }

    const action = fromEngineAlgebraic(moveText, this.config.notation);
    this.onBestMove?.(action, bestMoveMatch[1], {
      connectionEpoch: this.connectionEpoch,
      requestSeq: this.activeRequestSeq,
    });
  }

  sendStaticSettings() {
    if (!this.config.settings) {
      return;
    }
    for (const [name, value] of Object.entries(this.config.settings)) {
      if (typeof value === 'string') {
        this._enqueueRaw(CommandKind.SETOPTION, `setoption name ${name} value ${value}`);
      }
    }
  }

  sendTimeToMoveSettings(timeMode) {
    if (!this.config.settings || timeMode == null) {
      return;
    }
    for (const [name, value] of Object.entries(this.config.settings)) {
      if (typeof value !== 'string') {
        const optionValue = value[timeMode];
        if (optionValue != null) {
          this._enqueueRaw(CommandKind.SETOPTION, `setoption name ${name} value ${optionValue}`);
        }
      }
    }
  }

  setStatus(status) {
    this.onStatus?.(status);
  }

  _assertGoInvariant() {
    if (this.syncState !== SyncState.SYNCED) {
      throw new Error(`go blocked: syncState=${this.syncState}`);
    }
    if (this._goBlocked) {
      throw new Error('go blocked after desync');
    }
    if (this.appliedPlies !== this._localHistoryLength) {
      throw new Error(
        `go blocked: appliedPlies=${this.appliedPlies} history=${this._localHistoryLength}`,
      );
    }
    if (this.appliedPositionKey !== this._localPositionKey) {
      throw new Error('go blocked: appliedPositionKey mismatch');
    }
    if (this._pendingMakemoveCount > 0) {
      throw new Error('go blocked: makemove queue in flight');
    }
  }

  _enqueueRaw(kind, command) {
    return new Promise((resolve, reject) => {
      this._commandQueue.push({ kind, command, resolve, reject, epoch: this.connectionEpoch });
      this._drainQueue();
    });
  }

  _enqueueMakemove(moveStr) {
    return new Promise((resolve, reject) => {
      this._pendingMakemoveCount += 1;
      this._commandQueue.push({
        kind: CommandKind.SYNCPOSITION,
        command: `makemove ${moveStr}`,
        resolve: () => {
          this._pendingMakemoveCount = Math.max(0, this._pendingMakemoveCount - 1);
          resolve();
        },
        reject: (err) => {
          this._pendingMakemoveCount = Math.max(0, this._pendingMakemoveCount - 1);
          reject(err);
        },
        epoch: this.connectionEpoch,
      });
      this._drainQueue();
    });
  }

  async _drainQueue() {
    if (this._queueDraining) {
      return;
    }
    this._queueDraining = true;
    while (this._commandQueue.length > 0) {
      const job = this._commandQueue[0];
      if (job.epoch !== this.connectionEpoch) {
        job.reject?.(new Error('stale connection epoch'));
        this._commandQueue.shift();
        continue;
      }
      try {
        this._transmit(job.command);
        job.resolve?.();
      } catch (err) {
        job.reject?.(err);
        this.markDesynced(err?.message ?? 'command queue failure');
        break;
      }
      this._commandQueue.shift();
    }
    this._queueDraining = false;
  }

  _transmit(command) {
    if (this.ws?.readyState === WS_OPEN) {
      this.ws.send(command);
      return;
    }
    this.sendBuffer.push(command);
    this.connect();
  }

  async _runFullResync({ moveHistory, gameSnapshot, isFreshGame, positionKey }) {
    await this._enqueueRaw(CommandKind.STOP, 'stop');

    if (isFreshGame && moveHistory.length === 0) {
      this.appliedPlies = 0;
      this.appliedPositionKey = positionKey ?? '';
      this.syncState = SyncState.SYNCED;
      this._goBlocked = false;
      return;
    }

    if (moveHistory.length === 0 && gameSnapshot) {
      const position = buildPositionString(gameSnapshot, this.config.notation);
      await this._enqueueRaw(CommandKind.SYNCPOSITION, `setposition ${position}`);
    } else if (moveHistory.length > 0) {
      for (let i = 0; i < moveHistory.length; i += 1) {
        const moveStr = toEngineAlgebraic(moveHistory[i], this.config.notation);
        await this._enqueueMakemove(moveStr);
      }
    } else if (gameSnapshot) {
      const position = buildPositionString(gameSnapshot, this.config.notation);
      await this._enqueueRaw(CommandKind.SYNCPOSITION, `setposition ${position}`);
    }

    this.appliedPlies = moveHistory.length;
    this.appliedPositionKey = positionKey ?? positionKeyFromHistory(moveHistory);
    this.syncState = SyncState.SYNCED;
    this._goBlocked = false;
  }
}

export { SyncState, positionKeyFromHistory };
