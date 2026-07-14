/**
 * Gorisanson MCTS in a Web Worker — vanilla vendor logic only (read-only ai.js).
 */

import gameJs from '../vendor/gorisanson/game.js?raw';
import aiJs from '../vendor/gorisanson/ai.js?raw';

const PAWN_ROWS = 9;
const WALL_ROWS = 8;

function parseAlgebraic(move) {
  const coordinate = {
    column: move[0],
    row: Number.parseInt(move[1], 10),
  };
  if (move.length > 2) {
    return {
      coordinate,
      wallType: move[2] === 'h' ? 'h' : 'v',
    };
  }
  return { coordinate };
}

function toAlgebraic(action) {
  const base = `${action.coordinate.column}${action.coordinate.row}`;
  return action.wallType ? `${base}${action.wallType}` : base;
}

function actionToGorisansonMove(action) {
  const col = action.coordinate.column.charCodeAt(0) - 97;
  if (action.wallType === 'h') {
    const row = WALL_ROWS - action.coordinate.row;
    return [null, [row, col], null];
  }
  if (action.wallType === 'v') {
    const row = WALL_ROWS - action.coordinate.row;
    return [null, null, [row, col]];
  }
  const row = PAWN_ROWS - action.coordinate.row;
  return [[row, col], null, null];
}

function gorisansonMoveToAction(move) {
  const [pawn, horiz, vert] = move;
  if (pawn) {
    const [row, col] = pawn;
    return {
      coordinate: { column: String.fromCharCode(97 + col), row: PAWN_ROWS - row },
    };
  }
  if (horiz) {
    const [row, col] = horiz;
    return {
      coordinate: { column: String.fromCharCode(97 + col), row: WALL_ROWS - row },
      wallType: 'h',
    };
  }
  if (vert) {
    const [row, col] = vert;
    return {
      coordinate: { column: String.fromCharCode(97 + col), row: WALL_ROWS - row },
      wallType: 'v',
    };
  }
  throw new Error('Invalid move tuple from gorisanson engine');
}

const bootstrap = new Function(
  'postMessage',
  'performance',
  `${gameJs}\n${aiJs}\n
  function chooseOpeningPawnMove(game) {
    if (game.turn >= 2) {
      return null;
    }
    const nextPosition = AI.chooseShortestPathNextPawnPosition(game);
    const pawnMoveTuple = nextPosition.getDisplacementPawnMoveTupleFrom(game.pawnOfTurn.position);
    if (pawnMoveTuple[1] === 0) {
      return [[nextPosition.row, nextPosition.col], null, null];
    }
    return null;
  }

  function fallbackMove(game) {
    const nextPosition = AI.chooseShortestPathNextPawnPosition(game);
    const pawnMoveTuple = nextPosition.getDisplacementPawnMoveTupleFrom(game.pawnOfTurn.position);
    if (pawnMoveTuple[1] === 0) {
      return [[nextPosition.row, nextPosition.col], null, null];
    }
    const valids = game.getArrOfValidNextPositionTuples();
    if (valids.length > 0) {
      return [[valids[0][0], valids[0][1]], null, null];
    }
    const walls = game.getArrOfProbableValidNoBlockNextHorizontalWallPositions();
    if (walls.length > 0) {
      return [null, walls[0], null];
    }
    const verts = game.getArrOfProbableValidNoBlockNextVerticalWallPositions();
    if (verts.length > 0) {
      return [null, null, verts[0]];
    }
    return null;
  }

  function pickBestMoveFromTree(mcts, game) {
    if (mcts.root.children.length > 0) {
      const best = mcts.selectBestMove();
      if (best && best.move) {
        return best.move;
      }
    }
    return fallbackMove(game);
  }

  function findImmediateWinMove(game) {
    const valids = game.getArrOfValidNextPositionTuples();
    for (const [row, col] of valids) {
      const trial = Game.clone(game);
      trial.doMove([[row, col], null, null], true);
      if (trial.winner !== null) {
        return [[row, col], null, null];
      }
    }
    return null;
  }

  function stmOneStepFromGoal(game) {
    const next = AI.chooseShortestPathNextPawnPosition(game);
    const goalRow = game.pawnOfTurn === game.pawn1 ? 8 : 0;
    return next.row === goalRow;
  }

  function bestRootChild(mcts) {
    if (!mcts.root.children.length) {
      return null;
    }
    return mcts.root.maxSimsChild;
  }

  function moveToAlgebraicSafe(move) {
    if (!move) {
      return null;
    }
    try {
      return toAlgebraic(gorisansonMoveToAction(move));
    } catch {
      return null;
    }
  }

  function nodeDepthFromRoot(node) {
    let depth = 0;
    let current = node;
    while (current && current.parent) {
      depth += 1;
      current = current.parent;
    }
    return depth;
  }

  function patchGorisansonRolloutTelemetry() {
    if (MonteCarloTreeSearch.__rolloutTelemetryPatched) {
      return;
    }
    MonteCarloTreeSearch.__rolloutTelemetryPatched = true;

    const origDoMove = Game.prototype.doMove;
    Game.prototype.doMove = function(move, flag) {
      const tracker = Game.__rolloutTracker;
      if (tracker && tracker._currentRolloutPlies != null) {
        tracker._currentRolloutPlies += 1;
      }
      return origDoMove.call(this, move, flag);
    };

    const origMovePawn = Game.prototype.movePawn;
    Game.prototype.movePawn = function(row, col) {
      const tracker = Game.__rolloutTracker;
      if (tracker && tracker._currentRolloutPlies != null) {
        tracker._currentRolloutPlies += 1;
      }
      return origMovePawn.call(this, row, col);
    };

    const origRollout = MonteCarloTreeSearch.prototype.rollout;
    MonteCarloTreeSearch.prototype.rollout = function(node) {
      if (!this._remainingPliesStats) {
        this._remainingPliesStats = { sum: 0, count: 0 };
      }
      const depthAtNode = nodeDepthFromRoot(node);
      const prevTracker = Game.__rolloutTracker;
      Game.__rolloutTracker = this;
      this._currentRolloutPlies = 0;
      try {
        origRollout.call(this, node);
      } finally {
        Game.__rolloutTracker = prevTracker;
        const rolloutPlies = this._currentRolloutPlies ?? 0;
        this._currentRolloutPlies = null;
        if (rolloutPlies > 0) {
          const totalRemaining = depthAtNode + rolloutPlies;
          this._remainingPliesStats.sum += totalRemaining;
          this._remainingPliesStats.count += 1;
        }
      }
    };
  }

  patchGorisansonRolloutTelemetry();

  let globalCatMoveWeights = null;

  function weightedChoice(items, weightFn) {
    if (!items?.length) {
      return null;
    }
    let total = 0;
    const weights = items.map((item) => {
      const w = Math.max(1, weightFn(item));
      total += w;
      return w;
    });
    let r = Math.random() * total;
    for (let i = 0; i < items.length; i++) {
      r -= weights[i];
      if (r <= 0) {
        return items[i];
      }
    }
    return items[items.length - 1];
  }

  function catWeightForMove(move) {
    if (!globalCatMoveWeights || !move) {
      return 1;
    }
    const alg = moveToAlgebraicSafe(move);
    if (!alg) {
      return 1;
    }
    const w = globalCatMoveWeights[alg];
    return w > 0 ? w : 1;
  }

  function patchGorisansonCatPolicy() {
    if (MonteCarloTreeSearch.__catPolicyPatched) {
      return;
    }
    MonteCarloTreeSearch.__catPolicyPatched = true;
    const origSearch = MonteCarloTreeSearch.prototype.search;
    MonteCarloTreeSearch.prototype.search = function(numOfSimulations) {
      if (!globalCatMoveWeights) {
        return origSearch.call(this, numOfSimulations);
      }
      const origRC = randomChoice;
      randomChoice = function(arr) {
        if (!globalCatMoveWeights || !arr?.length) {
          return origRC(arr);
        }
        if (arr[0]?.move != null) {
          return weightedChoice(arr, (node) => catWeightForMove(node.move));
        }
        return origRC(arr);
      };
      try {
        return origSearch.call(this, numOfSimulations);
      } finally {
        randomChoice = origRC;
      }
    };
  }

  patchGorisansonCatPolicy();

  function mctsMainLinePv(mcts, game, maxPlies) {
    const moves = [];
    let node = mcts.root;
    const simGame = Game.clone(game);
    for (let i = 0; i < (maxPlies || 48); i++) {
      if (!node?.children?.length) {
        break;
      }
      const best = node.maxSimsChild;
      if (!best?.move) {
        break;
      }
      const algebraic = moveToAlgebraicSafe(best.move);
      if (!algebraic) {
        break;
      }
      moves.push(algebraic);
      simGame.doMove(best.move, true);
      if (simGame.winner !== null) {
        break;
      }
      node = best;
    }
    return moves.join(' ');
  }

  function mctsSimulationRemainingPlies(mcts) {
    const stats = mcts._remainingPliesStats;
    if (stats && stats.count > 0) {
      return Math.max(1, Math.round(stats.sum / stats.count));
    }
    let termDepthSum = 0;
    let termWeight = 0;
    function walk(node, depth) {
      if (node.isTerminal && node.numSims > 0) {
        termDepthSum += depth * node.numSims;
        termWeight += node.numSims;
      }
      for (const child of node.children) {
        if (child?.move) {
          walk(child, depth + 1);
        }
      }
    }
    walk(mcts.root, 0);
    if (termWeight > 0) {
      return Math.max(1, Math.round(termDepthSum / termWeight));
    }
    return null;
  }

  function gorisansonSearchTelemetry(mcts, game, simulations) {
    const pv = mctsMainLinePv(mcts, game);
    const remainingPlies = mctsSimulationRemainingPlies(mcts);
    const snap = snapshotMctsRoot(mcts);
    const bestWr = snap.rootWinRate;
    if (remainingPlies == null && !pv) {
      return [];
    }
    return [{
      depth: remainingPlies ?? (pv ? pv.trim().split(/\s+/).length : 1),
      nodes: simulations,
      score: bestWr != null ? Math.round(bestWr * 100) : null,
      pv,
      remainingPlies,
    }];
  }

  function snapshotMctsRoot(mcts) {
    const children = mcts.root.children;
    if (!children.length) {
      return { rootWinRate: null, rootMoves: [] };
    }
    const sorted = [...children]
      .filter((child) => child?.move)
      .sort((a, b) => b.numSims - a.numSims);
    if (!sorted.length) {
      return { rootWinRate: null, rootMoves: [] };
    }
    const best = sorted[0];
    const rootMoves = sorted
      .slice(0, 6)
      .map((child) => {
        const algebraic = moveToAlgebraicSafe(child.move);
        if (!algebraic) {
          return null;
        }
        const wr = child.numSims > 0 ? child.numWins / child.numSims : 0;
        return {
          move: algebraic,
          winRate: wr,
          score: Math.round(wr * 100),
          visits: child.numSims,
        };
      })
      .filter(Boolean);
    const bestWr = best.numSims > 0 ? best.numWins / best.numSims : null;
    return { rootWinRate: bestWr, rootMoves };
  }

  function pathDistances(game) {
    try {
      const d0 = AI.get2DArrayPrevAndNextAndDistanceToGoalFor(game.pawn0, game);
      const d1 = AI.get2DArrayPrevAndNextAndDistanceToGoalFor(game.pawn1, game);
      return { whiteDist: d0[2], blackDist: d1[2] };
    } catch {
      return { whiteDist: null, blackDist: null };
    }
  }

  function shouldStopGorisansonSearch(mcts, game, simulations) {
    if (simulations < 100) {
      return false;
    }
    if (stmOneStepFromGoal(game)) {
      return true;
    }
    const best = bestRootChild(mcts);
    if (!best || best.numSims < 100) {
      return false;
    }
    const wr = best.numSims > 0 ? best.numWins / best.numSims : 0;
    if (best.numSims >= 300 && wr >= 0.98) {
      return true;
    }
    if (best.numSims >= 150 && wr >= 0.99) {
      return true;
    }
    if (mcts.root.children.length === 1 && best.numSims >= 500 && wr >= 0.95) {
      return true;
    }
    return false;
  }

  function searchForTime(game, uctConst, timeMs, maxSimulations, catMoveWeights) {
    globalCatMoveWeights = catMoveWeights ?? null;
    try {
    const opening = chooseOpeningPawnMove(game);
    if (opening) {
      return { move: opening, simulations: 0, stoppedBy: 'opening' };
    }

    const immediateWin = findImmediateWinMove(game);
    if (immediateWin) {
      return { move: immediateWin, simulations: 0, stoppedBy: 'win-in-1' };
    }

    const mcts = new MonteCarloTreeSearch(game, uctConst);
    const started = performance.now();
    const deadline = started + timeMs;
    const batchSize = 50;
    let simulations = 0;
    let tick = 0;
    const simCap =
      Number.isFinite(maxSimulations) && maxSimulations > 0 ? maxSimulations : Infinity;

    while (performance.now() < deadline && simulations < simCap) {
      const remainingMs = deadline - performance.now();
      const remainingSims = simCap - simulations;
      const batch = Math.min(remainingMs < 250 ? 1 : batchSize, remainingSims);
      if (batch <= 0) {
        break;
      }

      mcts.search(batch);
      simulations += batch;
      tick += 1;

      if (shouldStopGorisansonSearch(mcts, game, simulations)) {
        break;
      }

      if (tick % 3 === 0) {
        const elapsed = performance.now() - started;
        const snap = snapshotMctsRoot(mcts);
        const dist = pathDistances(game);
        const pv = mctsMainLinePv(mcts, game);
        const depthLog = gorisansonSearchTelemetry(mcts, game, simulations);
        postMessage({
          type: 'progress',
          value: Math.min(0.99, elapsed / timeMs),
          simulations,
          ...snap,
          ...dist,
          pv,
          depthLog,
        });
      }
    }

    const stoppedBy = shouldStopGorisansonSearch(mcts, game, simulations)
      ? 'forced'
      : simulations >= simCap
        ? 'visits'
        : 'time';
    const move = pickBestMoveFromTree(mcts, game);
    if (!move) {
      throw new Error('no legal move');
    }
    const snap = snapshotMctsRoot(mcts);
    const dist = pathDistances(game);
    const pv = mctsMainLinePv(mcts, game);
    const depthLog = gorisansonSearchTelemetry(mcts, game, simulations);
    return {
      move,
      simulations,
      stoppedBy,
      ...snap,
      ...dist,
      pv,
      depthLog,
    };
    } finally {
      globalCatMoveWeights = null;
    }
  }

  return { Game, AI, searchForTime };
  `,
);

const { Game, AI, searchForTime } = bootstrap(
  (msg) => {
    if (typeof msg === 'number') {
      self.postMessage({ type: 'progress', value: msg });
    }
  },
  performance,
);

self.onmessage = (event) => {
  const { algebraicMoves = [], simulations, timeMs, maxSimulations, uctConst, catMoveWeights } = event.data;
  const game = new Game(true);
  for (const move of algebraicMoves) {
    game.doMove(actionToGorisansonMove(parseAlgebraic(move)), true);
  }

  if (game.winner !== null) {
    self.postMessage({ type: 'error', message: 'terminal position' });
    return;
  }

  if (Number.isFinite(timeMs) && timeMs > 0) {
    try {
      const result = searchForTime(game, uctConst ?? 0.2, timeMs, maxSimulations, catMoveWeights);
      self.postMessage({
        type: 'bestmove',
        move: result.move,
        algebraicMove: toAlgebraic(gorisansonMoveToAction(result.move)),
        simulations: result.simulations,
        stoppedBy: result.stoppedBy,
        rootWinRate: result.rootWinRate,
        rootMoves: result.rootMoves,
        whiteDist: result.whiteDist,
        blackDist: result.blackDist,
        depthLog: result.depthLog,
        pv: result.pv,
        timeMs,
      });
    } catch (err) {
      const message = err?.stack ?? err?.message ?? String(err);
      self.postMessage({ type: 'error', message });
    }
    return;
  }

  const ai = new AI(simulations, uctConst, false, true);
  const move = ai.chooseNextMove(game);
  self.postMessage({
    type: 'bestmove',
    move,
    algebraicMove: toAlgebraic(gorisansonMoveToAction(move)),
    simulations,
  });
};
