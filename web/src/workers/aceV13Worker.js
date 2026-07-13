/**
 * ACE v13 engine in a Web Worker — extract from ACEV13.html (pure JS; no WASM).
 * Streams iterative-deepening progress (depth log + total nodes) during think.
 */

import engineJs from '../vendor/ace-v13/engine.js?raw';
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

  function thinkStreaming(timeMs, maxDepth, full) {
    var t0 = Date.now();
    search.deadline = t0 + timeMs;
    search.nodes = 0;
    search.rootBest = -1;
    search.rootScore = 0;
    var lastBest = -1, lastScore = 0, lastDepth = 0, stable = 0;
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
        mode: 'ace-v13-js',
        stoppedBy: 'ace-v13-js',
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
        var pv = lastBest >= 0 ? aceMoveToAlgebraic(lastBest) : '';
        depthLog.push({
          depth: d,
          score: lastScore,
          nodes: search.nodes,
          elapsedMs: elapsedMs,
          marginalNodes: search.nodes - (depthLog.length ? depthLog[depthLog.length - 1].nodes : 0),
          pv: pv,
        });
        emitProgress();
        if (sc > 100000 - 200 || sc < -(100000 - 200)) break;
        if (!full && d >= 9 && stable >= 3 && lastScore > -120 && Date.now() - t0 > timeMs * 0.3) break;
      } catch (e) {
        if (e !== 'time') throw e;
        break;
      }
      if (Date.now() - t0 > timeMs * (lastScore < -80 ? 0.92 : 0.85)) break;
    }

    if (lastBest < 0) {
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

  return { loadAlgebraicMoves, thinkStreaming, isTerminal: function () { return game.winner() >= 0; } };
`,
);

const ace = bootstrap(postMessage, performance, algebraicToAceMove, aceMoveToAlgebraic);

function workerErrorMessage(event) {
  const parts = [];
  if (event?.message) parts.push(event.message);
  if (event?.filename) parts.push(`at ${event.filename}:${event.lineno ?? '?'}`);
  if (event?.error?.stack) parts.push(event.error.stack);
  return parts.join(' | ') || 'ACE v13 JS worker crashed';
}

self.addEventListener('error', (event) => {
  self.postMessage({ type: 'error', message: workerErrorMessage(event) });
});

self.addEventListener('unhandledrejection', (event) => {
  const reason = event?.reason;
  const message =
    reason?.stack ?? reason?.message ?? (reason != null ? String(reason) : 'unhandled rejection');
  self.postMessage({ type: 'error', message });
});

self.onmessage = (ev) => {
  const data = ev.data;
  try {
    ace.loadAlgebraicMoves(data.algebraicMoves || []);
    if (ace.isTerminal()) {
      postMessage({ type: 'error', message: 'position already decided' });
      return;
    }

    const timeMs = Math.max(50, Number(data.timeMs) || 4000);
    const maxDepth = Math.min(30, Math.max(1, Number(data.maxDepth) || 30));
    postMessage({ type: 'search-started' });
    const result = ace.thinkStreaming(timeMs, maxDepth, false);
    const algebraicMove = aceMoveToAlgebraic(result.move);

    postMessage({
      type: 'bestmove',
      algebraicMove,
      nodes: result.nodes,
      searchDepth: result.depth,
      rootScore: result.score,
      depthLog: result.depthLog,
      stoppedBy: 'ace-v13-js',
      mode: 'ace-v13-js',
      profileName: 'ACE v13 (JS)',
      whiteDist: result.whiteDist,
      blackDist: result.blackDist,
      ms: result.ms,
    });
  } catch (err) {
    const message =
      err?.stack ?? err?.message ?? (err != null ? String(err) : 'ACE v13 think failed');
    postMessage({ type: 'error', message });
  }
};
