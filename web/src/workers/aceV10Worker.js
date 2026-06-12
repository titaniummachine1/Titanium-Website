/**
 * ACE v10 engine in a Web Worker — extract from quoridor (8).html.
 * Streams iterative-deepening progress (depth log + total nodes) during think.
 */

import engineJs from '../vendor/ace-v10/engine.js?raw';
import { algebraicToAceMove, aceMoveToAlgebraic } from '../lib/aceV8Codec.js';

const bootstrap = new Function(
  'postMessage',
  'performance',
  'algebraicToAceMove',
  'aceMoveToAlgebraic',
  `${engineJs}

  var game = new Quoridor();
  var search = new Search(game);

  function pathDistances() {
    search.refreshDist(0);
    return {
      whiteDist: search.dist0[game.pawn[0]],
      blackDist: search.dist1[game.pawn[1]],
    };
  }

  function loadAlgebraicMoves(moves) {
    game.reset();
    for (var i = 0; i < moves.length; i++) {
      game.makeMove(algebraicToAceMove(moves[i]));
    }
  }

  /** Mirror Search.prototype.think — posts progress after each completed ID depth. */
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
      postMessage({
        type: 'progress',
        depthLog: depthLog.slice(),
        searchDepth: lastDepth,
        nodes: search.nodes,
        rootScore: lastScore,
        mode: 'ace-v10-js',
        stoppedBy: 'ace-v10-js',
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
        depthLog.push({
          depth: d,
          score: sc,
          nodes: search.nodes,
          pv: lastBest ? aceMoveToAlgebraic(lastBest) : '',
        });
        emitProgress();
        if (sc > MATE - 200 || sc < -(MATE - 200)) break;
        if (!full && d >= 9 && stable >= 3 && lastScore > -120 && Date.now() - t0 > timeMs * 0.3) break;
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
      if (Date.now() - t0 > timeMs * (lastScore < -80 ? 0.92 : 0.85)) break;
    }

    if (!lastBest) {
      search.refreshDist(0);
      search.genMoves(0, true);
      lastBest = search.moveBuf[0][0];
    }

    return {
      move: lastBest,
      score: lastScore,
      depth: lastDepth,
      nodes: search.nodes,
      ms: Date.now() - t0,
      depthLog: depthLog,
    };
  }

  self.onmessage = function (ev) {
    var data = ev.data;
    try {
      loadAlgebraicMoves(data.algebraicMoves || []);
      if (game.winner() >= 0) {
        postMessage({ type: 'error', message: 'position already decided' });
        return;
      }

      var timeMs = Math.max(50, Number(data.timeMs) || 4000);
      var maxDepth = Math.min(30, Math.max(1, Number(data.maxDepth) || 30));
      var result = thinkStreaming(timeMs, maxDepth, false);
      var algebraicMove = aceMoveToAlgebraic(result.move);
      var dist = pathDistances();
      postMessage({
        type: 'bestmove',
        algebraicMove: algebraicMove,
        nodes: result.nodes,
        searchDepth: result.depth,
        rootScore: result.score,
        depthLog: result.depthLog,
        stoppedBy: 'ace-v10-js',
        mode: 'ace-v10-js',
        profileName: 'ACE v10 (JS)',
        whiteDist: dist.whiteDist,
        blackDist: dist.blackDist,
        ms: result.ms,
      });
    } catch (err) {
      postMessage({ type: 'error', message: String(err?.message || err) });
    }
  };
`,
);

bootstrap(postMessage, performance, algebraicToAceMove, aceMoveToAlgebraic);
