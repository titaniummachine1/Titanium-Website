/**
 * Warm Titanium engine session dedicated to Analysis/Review mode.
 *
 * Unlike per-seat play engines, this session never "plays" a move -- it only
 * evaluates the current position and republishes the score. It reuses one
 * TitaniumWasmEngineClient (one warm WASM worker, one transposition table)
 * across the whole Analysis/Review session: every position change calls
 * cancelSearch() (soft cancel, keeps the worker + TT alive) then re-requests
 * a search on the new position, exactly the pattern the client's own
 * cancelSearch() doc comment describes for "undo / analysis jumps / replay
 * loads".
 */

import { TitaniumWasmEngineClient } from '../lib/titaniumWasmClient.js';
import { toAlgebraic } from '../lib/gameLogic.js';

export class AnalysisEngineSession {
  constructor() {
    this.client = new TitaniumWasmEngineClient({ engineMode: 'titanium-v16' });
    this.client.onInfo = (info) => this._handleResult(info, { final: false });
    this.client.onBestMove = () => {
      // Analysis never plays moves. If a search finishes anyway (time cap,
      // proof, worker hiccup), immediately start the same position again so
      // the eval bar has one predictable rule: active means searching.
      this._restartCurrentPositionSoon();
    };
    this.client.onError = (err) => {
      this.lastError = err?.message ?? String(err);
      this.onUpdate?.(null, this.lastError);
      this._restartCurrentPositionSoon(600);
    };

    this.active = false;
    this.onUpdate = null; // (result, error) => void
    this._requestGen = 0;
    this.lastError = null;
    this._hasPublished = false;
    this._lastActions = [];
    this._lastEngineSettings = null;
    this._restartTimer = null;
  }

  isActive() {
    return this.active;
  }

  start() {
    if (this.active) {
      return;
    }
    this.active = true;
    this.client.prewarm?.('titanium-v16', 800, this.client.threads);
  }

  /** Soft stop: cancels any in-flight search but keeps the warm worker/TT alive. */
  stop() {
    if (!this.active) {
      return;
    }
    this.active = false;
    this._requestGen += 1;
    if (this._restartTimer != null) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
    void this.client.cancelSearch();
  }

  /** Hard teardown -- only on full app/session disposal. */
  destroy() {
    this.active = false;
    this.client.destroy();
  }

  /**
   * Push a new position and (re)start evaluation.
   * @param {Array} actions - engine action objects (same shape as session.actions)
   * @param {{ wallClockSeconds: number, cores: number, catLmrCeiling?: number }} engineSettings
   */
  setPosition(actions, engineSettings) {
    if (!this.active) {
      return;
    }
    if (this._restartTimer != null) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
    // Root score is negamax-style (relative to whoever is on move), not
    // always "White's perspective" -- remember whose turn this position is
    // so _handleResult/analysisResultToEvalState can flip the sign correctly.
    this._playerToMove = (actions.length % 2 === 0) ? 1 : 2;
    this._lastActions = [...actions];
    this._lastEngineSettings = { ...(engineSettings ?? {}) };
    this.client.threads = Math.max(1, Math.round(engineSettings?.cores ?? this.client.threads ?? 1));
    const gen = ++this._requestGen;
    void this.client.cancelSearch().then(() => {
      if (gen !== this._requestGen || !this.active) {
        return;
      }
      // Analysis/Review runs continuously by default: a very large time
      // budget so the search only ever stops because it proved a forced
      // result (the engine's own early-exit on proven win/loss), not
      // because of a wall-clock cutoff. "unlimited: false" lets a user cap
      // it to a specific number of seconds per position instead.
      const wallClockSeconds = engineSettings?.unlimited !== false
        ? 86_400
        : (engineSettings?.wallClockSeconds ?? 3);
      this.client.requestMove({
        aiSettings: {
          wallClockSeconds,
          cores: this.client.threads,
          titaniumNet: engineSettings?.titaniumNet ?? 'hard',
          visitsBudget: 0,
        },
        moveHistory: actions,
        isFreshGame: actions.length === 0,
      });
    });
  }

  _restartCurrentPositionSoon(delayMs = 250) {
    if (!this.active || this._restartTimer != null || !this._lastActions) {
      return;
    }
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      if (!this.active) {
        return;
      }
      this.setPosition(this._lastActions, this._lastEngineSettings);
    }, delayMs);
  }

  _handleResult(info, { final }) {
    if (!this.active) {
      return;
    }
    // Skip placeholder "just started" ticks (no depth, no nodes yet) once we
    // already have a real result on screen -- otherwise the eval bar flashes
    // back to a bogus 0.00 on every position change before the real number
    // streams in a moment later.
    const hasProgress = (info.searchDepth ?? 0) > 0 || (info.nodes ?? 0) > 0;
    if (!hasProgress && this._hasPublished) {
      return;
    }
    if (hasProgress) {
      this._hasPublished = true;
    }
    this.onUpdate?.(
      {
        whiteDist: info.whiteDist,
        blackDist: info.blackDist,
        rootScore: info.rootScore,
        playerToMove: this._playerToMove,
        depth: info.searchDepth,
        pv: info.pv,
        rootMove: info.rootMove,
        rootMoves: info.rootMoves,
        nodes: info.nodes,
        final,
      },
      null,
    );
  }
}

/**
 * Convert an engine result into eval-bar state: p1 (White's fill share,
 * 0..1) and margin/rootScore for display. Prefers the real engine score
 * (sigmoid-mapped, matching how the score is actually computed) over the
 * coarse distance margin, which is only a fallback before the first result.
 * rootScore is negamax-style (relative to the side to move), so it's
 * flipped to White's perspective using the position's playerToMove.
 */
export function analysisResultToEvalState(result) {
  if (!result) {
    return null;
  }
  const hasDist = Number.isFinite(result.whiteDist) && Number.isFinite(result.blackDist);
  const margin = hasDist ? result.blackDist - result.whiteDist : 0;
  const hasScore = Number.isFinite(Number(result.rootScore));

  let p1;
  let whiteScore = null;
  if (hasScore) {
    const sideScore = Number(result.rootScore);
    whiteScore = result.playerToMove === 2 ? -sideScore : sideScore;
    p1 = 1 / (1 + Math.exp(-whiteScore / 350));
  } else if (hasDist) {
    p1 = 0.5 + margin * 0.07;
  } else {
    return null;
  }
  p1 = Math.max(0.05, Math.min(0.95, p1));

  return {
    p1,
    margin,
    whiteDist: result.whiteDist,
    blackDist: result.blackDist,
    // Always White's perspective, matching p1 above -- the raw engine score
    // is negamax-style (relative to the side to move).
    rootScore: whiteScore,
    playerToMove: result.playerToMove,
    depth: result.depth ?? null,
    pv: result.pv ? result.pv.split(' ').filter(Boolean) : [],
    rootMove: result.rootMove ?? null,
    rootMoves: Array.isArray(result.rootMoves) ? [...result.rootMoves] : [],
  };
}

export function actionsToAlgebraic(actions) {
  return actions.map((a) => toAlgebraic(a));
}
