#!/usr/bin/env node
/**
 * Batch match harness: native Titanium engine vs a remote Ishtar/Ka engine.
 *
 *   node ishtar_match.js [options]
 *     --engine NAME    our engine session flag (default ace-v13-grafted)
 *     --opp ishtar|ka  remote opponent (default ishtar)
 *     --opp-time MODE  intuition|short|medium|long (default short)
 *     --our-time SEC   our engine think seconds/move (default 1)
 *     --games N        total games (default 8)
 *     --concurrency K  games in flight at once (default 4)
 *     --bin PATH       titanium binary (default ../engine/target/release/titanium.exe)
 *     --max-ply N      adjudicate as loss-by-timeout cap (default 300)
 *
 * Color is swapped every game so each opening is played from both sides.
 *
 * CPU note: our engine is time-based, so its think must get a clean core. The
 * opponent is REMOTE (its cluster, not our CPU), so while it computes our core is
 * free — that's why oversubscribing (concurrency > cores) can help here, unlike
 * local-vs-local. But if too many of OUR engines think at once they steal each
 * other's time; keep concurrency near core count unless games are network-bound.
 */

const { spawn } = require('child_process');
const readline = require('readline');
const path = require('path');
const { QuoridorEngineClient, ENGINES } = require('./extracted/engine_client');

function parseArgs(argv) {
  const o = {
    engine: 'ace-v13-grafted',
    opp: 'ishtar',
    oppTime: 'short',
    ourTime: 1,
    games: 8,
    concurrency: 4,
    bin: path.resolve(__dirname, '../engine/target/release/titanium.exe'),
    maxPly: 300,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--engine') o.engine = next();
    else if (a === '--opp') o.opp = next();
    else if (a === '--opp-time') o.oppTime = next();
    else if (a === '--our-time') o.ourTime = Number(next());
    else if (a === '--games') o.games = Number(next());
    else if (a === '--concurrency') o.concurrency = Number(next());
    else if (a === '--bin') o.bin = next();
    else if (a === '--max-ply') o.maxPly = Number(next());
  }
  return o;
}

/** Drive one native engine subprocess over the session stdio protocol. */
class OurEngine {
  constructor(bin, engineFlag) {
    this.proc = spawn(bin, ['session', '--engine', engineFlag], {
      stdio: ['pipe', 'pipe', 'ignore'], // ignore stderr (info json stream)
    });
    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.queue = [];
    this.waiters = [];
    this.rl.on('line', (line) => {
      const w = this.waiters.shift();
      if (w) w(line);
      else this.queue.push(line);
    });
  }
  _readLine() {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    return new Promise((res) => this.waiters.push(res));
  }
  _send(cmd) {
    this.proc.stdin.write(cmd + '\n');
  }
  async _await(prefix) {
    for (;;) {
      const line = await this._readLine();
      if (line.startsWith(prefix)) return line;
    }
  }
  /** Set position to the full move list, then search; returns best move string. */
  async bestMove(moves, seconds) {
    this._send(moves.length ? `position ${moves.join(' ')}` : 'reset');
    await this._await(moves.length ? 'ready' : 'ready');
    this._send(`go ${seconds}`);
    const line = await this._await('bestmove');
    return line.slice('bestmove '.length).trim();
  }
  destroy() {
    try {
      this._send('quit');
    } catch {}
    this.proc.kill();
  }
}

/** Full referee state → the gameState shape `buildPositionString` consumes.
 *  Using setposition before every go() removes all incremental-commit ambiguity
 *  (go() does NOT reliably auto-commit the remote engine's own move). */
function boardToGameState(board, gl) {
  const toCoord = (key) => ({ column: key[0], row: Number(key.slice(1)) });
  const wallsByPlayer = [];
  for (const k of board._horizontalWalls) wallsByPlayer.push([0, toCoord(k), gl.WallType.Horizontal]);
  for (const k of board._verticalWalls) wallsByPlayer.push([0, toCoord(k), gl.WallType.Vertical]);
  return {
    wallsByPlayer,
    playerPositions: [
      board.playerPosition({ playerNum: 1 }),
      board.playerPosition({ playerNum: 2 }),
    ],
    wallsRemaining: [
      board.wallsRemaining({ playerNum: 1 }),
      board.wallsRemaining({ playerNum: 2 }),
    ],
    playerToMove: board.playerToMove(),
  };
}

/** Drive one remote Ishtar/Ka move; resolves a best move (app notation string). */
function ishtarBestMove(client, board, gl, timeMode) {
  return new Promise((resolve, reject) => {
    client.onError = (e) => reject(e);
    client.onBestMove = (action) => resolve(gl.toAlgebraic(action));
    client.setPosition(boardToGameState(board, gl));
    client.go(timeMode);
  });
}

async function playGame(opts, gl, gameIdx, ourIsP1) {
  const { QuoridorBoard } = gl;
  const board = new QuoridorBoard();
  const our = new OurEngine(opts.bin, opts.engine);
  const client = new QuoridorEngineClient(ENGINES[opts.opp]);
  if (process.env.DEBUG_WS) {
    client.onRawMessage = (m) => console.error(`[ws ${gameIdx}] << ${m}`);
    const origSend = client.send.bind(client);
    client.send = (cmd) => {
      console.error(`[ws ${gameIdx}] >> ${cmd}`);
      return origSend(cmd);
    };
  }
  client.connect();

  const moves = [];
  let winner = 0;

  try {
    for (let ply = 0; ply < opts.maxPly; ply++) {
      const term = board.terminal();
      if (term.isTerminal) {
        winner = term.playerNum;
        break;
      }
      const p1ToMove = board.playerToMove() === 1;
      const ourTurn = p1ToMove === ourIsP1;

      let mv;
      if (ourTurn) {
        mv = await our.bestMove(moves, opts.ourTime);
        if (!mv || mv === '(none)') {
          winner = ourIsP1 ? 2 : 1;
          break;
        }
      } else {
        mv = await ishtarBestMove(client, board, gl, opts.oppTime);
        if (!mv) {
          winner = ourIsP1 ? 1 : 2;
          break;
        }
      }

      if (!board.isValid(mv)) {
        // An illegal move = that side forfeits; surfaces protocol/notation bugs.
        console.error(`game ${gameIdx}: illegal move "${mv}" by ${ourTurn ? 'OUR' : 'OPP'} at ply ${ply}`);
        winner = ourTurn ? (ourIsP1 ? 2 : 1) : (ourIsP1 ? 1 : 2);
        break;
      }
      board.takeAction(mv);
      moves.push(mv);
    }
  } finally {
    our.destroy();
    client.destroy();
  }

  if (winner === 0) {
    // ply cap — adjudicate by shortest distance (closer pawn wins).
    const d1 = gl.shortestDistanceToGoal(board, 1);
    const d2 = gl.shortestDistanceToGoal(board, 2);
    winner = d1 < d2 ? 1 : d2 < d1 ? 2 : 0;
  }
  const ourWin = winner !== 0 && (winner === 1) === ourIsP1;
  return { gameIdx, winner, ourWin, draw: winner === 0, plies: moves.length };
}

async function main() {
  const opts = parseArgs(process.argv);
  const gl = await import('./web/src/lib/gameLogic.js');
  console.log(
    `match: OUR=${opts.engine} (${opts.ourTime}s) vs ${opts.opp} (${opts.oppTime}), ` +
      `${opts.games} games, concurrency ${opts.concurrency}`,
  );

  let ourW = 0, oppW = 0, draws = 0, done = 0;
  const started = Date.now();
  let next = 0;

  async function worker() {
    for (;;) {
      const idx = next++;
      if (idx >= opts.games) return;
      const ourIsP1 = idx % 2 === 0; // swap colors each game
      let r;
      try {
        r = await playGame(opts, gl, idx, ourIsP1);
      } catch (e) {
        console.error(`game ${idx} error: ${e.message}`);
        continue;
      }
      if (r.draw) draws++;
      else if (r.ourWin) ourW++;
      else oppW++;
      done++;
      const score = ourW + 0.5 * draws;
      const secs = ((Date.now() - started) / 1000).toFixed(0);
      console.log(
        `  [${done}/${opts.games}] OUR ${ourW} - ${oppW} ${opts.opp}  (${draws} draws)  ` +
          `score ${score.toFixed(1)}/${done}  ${r.plies} plies  ${secs}s`,
      );
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, worker));

  const n = done || 1;
  const score = ourW + 0.5 * draws;
  const p = score / n;
  const se = Math.sqrt((p * (1 - p)) / n);
  const elo = p > 0 && p < 1 ? -400 * Math.log10((1 - p) / p) : (p >= 1 ? Infinity : -Infinity);
  console.log('=== ISHTAR MATCH RESULT ===');
  console.log(`OUR=${opts.engine} vs ${opts.opp} ${opts.oppTime}`);
  console.log(`OUR ${ourW} | ${opts.opp} ${oppW} | draws ${draws}`);
  console.log(`score ${score.toFixed(1)}/${n} = ${(p * 100).toFixed(1)}% (±${(se * 196).toFixed(1)}%) → ~${elo >= 0 ? '+' : ''}${elo.toFixed(0)} Elo`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
