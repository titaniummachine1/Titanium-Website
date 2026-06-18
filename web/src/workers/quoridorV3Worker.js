/**
 * Quoridor v3 αβ engine in a Web Worker — vendored from quoridor.html.
 * Streams iterative-deepening progress during think.
 */

import engineJs from '../vendor/quoridor-v3/engine.js?raw';
import { algebraicToV3Move, v3MoveToAlgebraic } from '../lib/quoridorV3Codec.js';

const bootstrap = new Function(
  'postMessage',
  'performance',
  'algebraicToV3Move',
  'v3MoveToAlgebraic',
  `${engineJs}

  var game = new Quoridor();
  var search = new Search(game);

  function pathDistances() {
    search.refreshDist(0);
    var d0 = search.dist0[game.pawn[0]];
    var d1 = search.dist1[game.pawn[1]];
    return { whiteDist: d0, blackDist: d1 };
  }

  function loadAlgebraicMoves(moves) {
    game.reset();
    for (var i = 0; i < moves.length; i++) {
      game.makeMove(algebraicToV3Move(moves[i]));
    }
  }

  function thinkStreaming(timeMs, maxDepth, full) {
    var t0 = Date.now();
    search.deadline = t0 + timeMs;
    search.nodes = 0;
    search.rootBest = 0;
    search.rootScore = 0;
    var g = search.g;
    var sp0 = g.pawn[0], sp1 = g.pawn[1], sw0 = g.wl[0], sw1 = g.wl[1], sturn = g.turn;
    var slo = g.hashLo, shi = g.hashHi, shist = g.histLen, slwp = g.lastWallPly, sstamp = g.wallStamp;
    var shw = g.hw.slice(), svw = g.vw.slice(), sblocked = g.blocked.slice();
    var lastBest = 0, lastScore = 0, lastDepth = 0, stable = 0;
    var depthLog = [];
    maxDepth = maxDepth || 30;

    function emitProgress() {
      var dist = pathDistances();
      var pv = lastBest ? v3MoveToAlgebraic(lastBest) : '';
      postMessage({
        type: 'progress',
        depthLog: depthLog.slice(),
        searchDepth: lastDepth,
        nodes: search.nodes,
        rootScore: lastScore,
        mode: 'minimax',
        stoppedBy: 'minimax',
        whiteDist: dist.whiteDist,
        blackDist: dist.blackDist,
      });
    }

    for (var d = 1; d <= maxDepth; d++) {
      try {
        var sc;
        if (d >= 4 && lastScore > -2000 && lastScore < 2000) {
          var lo = lastScore - 75, hi = lastScore + 75;
          for (;;) {
            sc = search.ab(d, lo, hi, 0, true, 0);
            if (sc <= lo) lo = -Infinity;
            else if (sc >= hi) hi = Infinity;
            else break;
          }
        } else {
          sc = search.ab(d, -Infinity, Infinity, 0, true, 0);
        }
        stable = (search.rootBest === lastBest) ? stable + 1 : 0;
        lastBest = search.rootBest;
        lastScore = sc;
        lastDepth = d;
        var elapsedMs = Date.now() - t0;
        var pvMove = lastBest ? v3MoveToAlgebraic(lastBest) : '';
        depthLog.push({
          depth: d,
          score: lastScore,
          nodes: search.nodes,
          elapsedMs: elapsedMs,
          marginalNodes: search.nodes - (depthLog.length ? depthLog[depthLog.length - 1].nodes : 0),
          pv: pvMove,
        });
        emitProgress();
        if (sc > MATE - 200 || sc < -(MATE - 200)) break;
        if (!full && d >= 6 && stable >= 2 && Date.now() - t0 > timeMs * 0.1) break;
      } catch (err) {
        if (err === 'time') {
          g.pawn[0] = sp0; g.pawn[1] = sp1; g.wl[0] = sw0; g.wl[1] = sw1; g.turn = sturn;
          g.hw.set(shw); g.vw.set(svw); g.blocked.set(sblocked);
          g.hashLo = slo; g.hashHi = shi; g.histLen = shist; g.lastWallPly = slwp; g.wallStamp = sstamp;
          search.cachedStamp = -1;
          break;
        }
        throw err;
      }
      if (Date.now() - t0 > timeMs * 0.6) break;
    }

    if (!lastBest) {
      search.refreshDist(0);
      search.genMoves(0, true);
      lastBest = search.moveBuf[0][0];
    }

    var dist = pathDistances();
    return {
      move: lastBest,
      score: lastScore,
      depth: lastDepth,
      nodes: search.nodes,
      ms: Date.now() - t0,
      depthLog: depthLog,
      whiteDist: dist.whiteDist,
      blackDist: dist.blackDist,
    };
  }

  return { loadAlgebraicMoves, thinkStreaming };
`,
);

const v3 = bootstrap(postMessage, performance, algebraicToV3Move, v3MoveToAlgebraic);

self.onmessage = (ev) => {
  const data = ev.data;
  try {
    v3.loadAlgebraicMoves(data.algebraicMoves || []);
    const timeMs = Math.max(50, Number(data.timeMs) || 1500);
    const maxDepth = Math.min(30, Math.max(3, Number(data.maxDepth) || 30));
    const result = v3.thinkStreaming(timeMs, maxDepth, false);
    const algebraicMove = v3MoveToAlgebraic(result.move);
    self.postMessage({
      type: 'bestmove',
      algebraicMove,
      nodes: result.nodes,
      searchDepth: result.depth,
      rootScore: result.score,
      depthLog: result.depthLog,
      stoppedBy: 'minimax',
      mode: 'minimax',
      profileName: 'Quoridor v3 αβ',
      whiteDist: result.whiteDist,
      blackDist: result.blackDist,
      ms: result.ms,
    });
  } catch (err) {
    postMessage({ type: 'error', message: String(err?.message || err) });
  }
};
