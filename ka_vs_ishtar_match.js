#!/usr/bin/env node
/**
 * Direct remote-vs-remote match: Ka plays Ishtar (or any Ka/Ishtar tier pair)
 * with no local Titanium engine involved. Reuses the exact same battle-tested
 * `RemoteEngine` wrapper (retry/reconnect/notation bridge) that
 * `ishtar_match.js` uses for Titanium-vs-remote matches — here both sides are
 * remote instead of one side being local.
 *
 *   node ka_vs_ishtar_match.js [options]
 *     --a ka|ishtar      side A engine (default ka)
 *     --a-time MODE      intuition|short|medium|long (default short)
 *     --b ka|ishtar      side B engine (default ishtar)
 *     --b-time MODE      intuition|short|medium|long (default short)
 *     --games N          total games (default 3)
 *     --max-ply N        ply cap (default 200)
 *     --out PATH         JSON output file (default ka_vs_ishtar_games.json)
 *
 * Output: JSON array of { moves: [...], winner: 1|2|0, aSide: 1|2 } written
 * to --out, plus GAME/RESULT dump lines on stdout (same format as
 * ishtar_match.js --dump-games) for reuse with existing parsers.
 */

const fs = require('fs');
const path = require('path');
const { RemoteEngine } = require('./ishtar_match.js');
const { isCompleteGame } = require('./game_validate');
const { normalizeTimeMode } = require('./remote_presets');

/**
 * Forced sacred-center trunk (engine/src/titanium/opening_book.rs
 * SACRED_CENTER_LINE) — already known-good, so injected directly via
 * notifyMove instead of burning real search time on it. This matters most
 * for slow tiers (Ishtar medium/long): 3 of these 6 plies are Ishtar's turn.
 */
const SACRED_TRUNK = ['e2', 'e8', 'e3', 'e7', 'e4', 'e6'];

function parseArgs(argv) {
  const o = {
    a: 'ka',
    aTime: 'short',
    b: 'ishtar',
    bTime: 'short',
    games: 3,
    maxPly: 200,
    out: path.resolve(__dirname, 'ka_vs_ishtar_games.json'),
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--a') o.a = next();
    else if (arg === '--a-time') o.aTime = normalizeTimeMode(next());
    else if (arg === '--b') o.b = next();
    else if (arg === '--b-time') o.bTime = normalizeTimeMode(next());
    else if (arg === '--games') o.games = Number(next());
    else if (arg === '--max-ply') o.maxPly = Number(next());
    else if (arg === '--out') o.out = path.resolve(next());
  }
  return o;
}

async function playOneGame(gl, opts, gameIdx) {
  const { QuoridorBoard } = gl;
  const board = new QuoridorBoard();
  const engineA = new RemoteEngine(opts.a, opts.aTime, null, null);
  const engineB = new RemoteEngine(opts.b, opts.bTime, null, null);
  // A is always P1 (moves first) in this harness; alternate assignment across
  // games at the caller level if a balanced sample is wanted.
  const moves = [];
  let winner = 0;

  try {
    for (let ply = 0; ply < opts.maxPly; ply++) {
      const term = board.terminal();
      if (term.isTerminal) {
        winner = term.playerNum;
        break;
      }
      const aToMove = board.playerToMove() === 1;
      const mover = aToMove ? engineA : engineB;
      const other = aToMove ? engineB : engineA;
      const label = aToMove ? `${opts.a}@${opts.aTime}` : `${opts.b}@${opts.bTime}`;

      let mv;
      if (ply < SACRED_TRUNK.length) {
        // Known-good trunk — inject directly, no real search burned on it.
        mv = SACRED_TRUNK[ply];
        process.stderr.write(`[game ${gameIdx}] ply ${ply + 1}: sacred trunk, injecting ${mv} (no search)\n`);
      } else {
        process.stderr.write(`[game ${gameIdx}] ply ${ply + 1}: ${label} thinking...\n`);
        const res = await mover.bestMove(gl, 180);
        mv = res.move;
        process.stderr.write(`[game ${gameIdx}] ply ${ply + 1}: ${label} played ${mv} (${res.thinkSec.toFixed(1)}s)\n`);
      }

      if (!mv) {
        winner = aToMove ? 2 : 1;
        break;
      }
      if (!board.isValid(mv)) {
        process.stderr.write(`[game ${gameIdx}] illegal move "${mv}" by ${label} at ply ${ply}\n`);
        winner = aToMove ? 2 : 1;
        break;
      }

      // Tell BOTH remote sessions the move happened (server never auto-advances).
      await engineA.notifyMove(gl, mv);
      await engineB.notifyMove(gl, mv);

      board.takeAction(mv);
      moves.push(mv);
    }
  } finally {
    engineA.destroy();
    engineB.destroy();
  }

  const result = {
    gameIdx,
    winner,
    incomplete: winner === 0,
    plies: moves.length,
    moves,
    aborted: false,
  };
  result.complete = isCompleteGame(result);
  return result;
}

async function main() {
  const opts = parseArgs(process.argv);
  const gl = await import('./web/src/lib/gameLogic.js');
  process.stderr.write(
    `Match: ${opts.a}@${opts.aTime} (P1) vs ${opts.b}@${opts.bTime} (P2), ${opts.games} games, max ${opts.maxPly} plies\n`,
  );

  const results = [];
  for (let i = 0; i < opts.games; i++) {
    const r = await playOneGame(gl, opts, i);
    results.push(r);
    if (r.complete) {
      console.log(`GAME ${r.moves.join(' ')}`);
      if (r.winner === 1) console.log('RESULT W');
      else if (r.winner === 2) console.log('RESULT B');
    }
    process.stderr.write(
      `[game ${i}] done: winner=${r.winner === 1 ? opts.a : r.winner === 2 ? opts.b : 'none'} plies=${r.plies} complete=${r.complete}\n`,
    );
  }

  fs.writeFileSync(opts.out, JSON.stringify(results, null, 2));
  process.stderr.write(`Wrote ${results.length} games to ${opts.out}\n`);
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`FATAL: ${e.stack || e}\n`);
    process.exit(1);
  });
}

module.exports = { playOneGame };
