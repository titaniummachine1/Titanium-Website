import {
  QuoridorBoard,
  WallType,
  toAlgebraic,
  isWallAction,
  formatCoordinate,
  bothPlayersReachGoals,
} from '../lib/gameLogic.js';

import { PlayerType } from '../lib/engineConfig.js';

function sameAction(a, b) {
  if (!a || !b) {
    return false;
  }
  try {
    return toAlgebraic(a) === toAlgebraic(b);
  } catch {
    return false;
  }
}

export class GameSession {
  constructor() {
    this.reset();
    this.listeners = new Set();
  }

  reset() {
    this.board = new QuoridorBoard();
    this.actions = [];
    this.wallsByPlayer = [];
    this.winner = null;
    this.isDraw = false;
    this.positionKeys = [this.board.positionKey()];
    this.lastAction = null;
    this.historyIndex = null;
    this.futureActions = [];
  }

  /** 1 = White, 2 = Black — mirrors `getSnapshot().playerToMove`. */
  get playerToMove() {
    return this.board.playerToMove();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify() {
    for (const listener of this.listeners) {
      listener(this.getSnapshot());
    }
  }

  getSnapshot() {
    return {
      board: this.board,
      actions: [...this.actions],
      wallsByPlayer: [...this.wallsByPlayer],
      winner: this.winner,
      isDraw: this.isDraw,
      lastAction: this.lastAction,
      playerToMove: this.board.playerToMove(),
      playerPositions: this.board._playerPositions.map((coordinate) => ({ ...coordinate })),
      wallsRemaining: this.board._wallsRemaining.map((count) => count),
      validActions:
        this.winner !== null || this.isDraw ? [] : this.board.validActions(),
      isTerminal: this.winner !== null || this.isDraw,
      canRedo: this.futureActions.length > 0,
      futureActions: this.futureActions.map((action) => structuredClone(action)),
    };
  }

  getEngineSnapshot() {
    return {
      currentState: {
        playerToMove: this.board.playerToMove(),
        playerPositions: this.board._playerPositions.map((coordinate) => ({ ...coordinate })),
        wallsRemaining: this.board._wallsRemaining.map((count) => count),
        wallsByPlayer: [...this.wallsByPlayer],
      },
    };
  }

  canInteract(playerTypes, playerIndex) {
    if (this.winner != null || this.isDraw) {
      return false;
    }
    return playerTypes[playerIndex] === PlayerType.Human;
  }

  isHumanTurn(playerTypes) {
    const playerIndex = this.board.playerToMove() - 1;
    return this.canInteract(playerTypes, playerIndex);
  }

  getCurrentPlayerType(playerTypes) {
    return playerTypes[this.board.playerToMove() - 1];
  }

  applyAction(action) {
    if (this.winner != null || this.isDraw) {
      return false;
    }

    if (!this.board.isValid(action)) {
      return false;
    }

    if (isWallAction(action)) {
      const trial = new QuoridorBoard();
      for (const prior of this.actions) {
        trial.takeAction(prior);
      }
      trial.takeAction(action);
      if (!bothPlayersReachGoals(trial)) {
        return false;
      }
    }

    const actingPlayer = this.board.playerToMove();

    this.board.takeAction(action);
    this.actions.push(structuredClone(action));
    this.lastAction = structuredClone(action);
    const nextFuture = this.futureActions[this.futureActions.length - 1];
    if (sameAction(action, nextFuture)) {
      this.futureActions.pop();
    } else if (!this._skipClearFuture) {
      this.futureActions = [];
    }
    this._skipClearFuture = false;

    if (isWallAction(action)) {
      this.wallsByPlayer.push([
        actingPlayer,
        { ...action.coordinate },
        action.wallType,
      ]);
    }

    const terminal = this.board.terminal();
    if (terminal.isTerminal) {
      this.winner = terminal.playerNum;
    } else {
      this.recordPositionKey();
    }

    this.notify();
    return true;
  }

  recordPositionKey() {
    const key = this.board.positionKey();
    this.positionKeys.push(key);
    if (this.positionKeys.filter((k) => k === key).length >= 3) {
      this.isDraw = true;
    }
  }

  undo() {
    if (this.actions.length === 0) {
      return false;
    }

    const removed = this.actions[this.actions.length - 1];
    this.futureActions.push(structuredClone(removed));
    this.rebuildFromActions(this.actions.slice(0, -1), { preserveFuture: true });
    this.notify();
    return true;
  }

  redo() {
    if (this.futureActions.length === 0) {
      return false;
    }

    const action = this.futureActions.pop();
    this._skipClearFuture = true;
    const ok = this.applyAction(action);
    if (!ok) {
      this._skipClearFuture = false;
      this.futureActions.push(action);
    }
    return ok;
  }

  /** End a game because `playerNum` ran out of time. */
  forfeitOnTime(playerNum) {
    if (this.winner != null || this.isDraw || (playerNum !== 1 && playerNum !== 2)) {
      return false;
    }
    this.winner = playerNum === 1 ? 2 : 1;
    this.lastAction = null;
    this.notify();
    return true;
  }

  lineActions() {
    return [
      ...this.actions.map((action) => structuredClone(action)),
      ...this.futureActions.slice().reverse().map((action) => structuredClone(action)),
    ];
  }

  jumpToPly(ply) {
    const line = this.lineActions();
    const nextPly = Math.max(0, Math.min(Number(ply) || 0, line.length));
    if (nextPly === this.actions.length) {
      return false;
    }
    const current = line.slice(0, nextPly);
    const future = line.slice(nextPly).reverse().map((action) => structuredClone(action));
    this.rebuildFromActions(current, { preserveFuture: false });
    this.futureActions = future;
    this.notify();
    return true;
  }

  rebuildFromActions(actions, { preserveFuture = false } = {}) {
    const savedFuture = preserveFuture
      ? this.futureActions.map((action) => structuredClone(action))
      : null;
    this.board = new QuoridorBoard();
    this.actions = [];
    this.wallsByPlayer = [];
    this.winner = null;
    this.isDraw = false;
    this.positionKeys = [this.board.positionKey()];
    this.lastAction = null;
    this.futureActions = preserveFuture ? savedFuture : [];

    for (const action of actions) {
      if (!this.board.isValid(action)) {
        throw new Error(
          `illegal move ${toAlgebraic(action)} at ply ${this.actions.length + 1}`,
        );
      }
      if (isWallAction(action)) {
        const trial = new QuoridorBoard();
        for (const prior of this.actions) {
          trial.takeAction(prior);
        }
        trial.takeAction(action);
        if (!bothPlayersReachGoals(trial)) {
          throw new Error(
            `wall ${toAlgebraic(action)} at ply ${this.actions.length + 1} blocks all paths to goal`,
          );
        }
      }
      const actingPlayer = this.board.playerToMove();
      this.board.takeAction(action);
      this.actions.push(structuredClone(action));
      this.lastAction = structuredClone(action);

      if (isWallAction(action)) {
        this.wallsByPlayer.push([
          actingPlayer,
          { ...action.coordinate },
          action.wallType,
        ]);
      }

      const terminal = this.board.terminal();
      if (terminal.isTerminal) {
        this.winner = terminal.playerNum;
        break;
      }
      this.recordPositionKey();
    }
  }

  getWallOwner(coordinate, wallType) {
    const key = `${formatCoordinate(coordinate)}${wallType === WallType.Horizontal ? 'h' : 'v'}`;
    for (const [playerNum, coord, type] of this.wallsByPlayer) {
      const entryKey = `${formatCoordinate(coord)}${type === WallType.Horizontal ? 'h' : 'v'}`;
      if (entryKey === key) {
        return playerNum;
      }
    }
    return 0;
  }

  actionToLabel(action) {
    return toAlgebraic(action);
  }
}
