#!/usr/bin/env node
/**
 * Batch match harness: native Titanium engine vs a remote Ishtar/Ka engine.
 *
 *   node ishtar_match.js [options]
 *     --engine NAME      our engine flag (default titanium-v14)
 *     --opp ishtar|ka    remote opponent (default ishtar)
 *     --opp-time MODE    intuition|short|medium|long (default short)
 *     --our-time SEC     our engine think seconds/move (default 2)
 *     --ponder-time SEC  seconds to ponder during opponent's think (default 10)
 *     --games N          total games (default 8)
 *     --concurrency K    games in flight at once (default 2)
 *     --bin PATH         titanium binary
 *     --max-ply N        ply cap (default 300)
 *     --dump-games       GAME/RESULT to stdout; progress/summary to stderr
 *
 * PONDERING: While the remote engine thinks (~12s for Ka short), we run our
 * engine on the expected continuation (predicted from the PV of our last move).
 * If Ka plays the predicted move → instant deep reply; otherwise → think fresh.
 * Bonus: the pondered positions are emitted as extra eval-batch inputs for training.
 *
 * Ka server protocol (uci_engine.py):
 *   makemove <m1> <m2> ...  — apply moves to server state (ALL moves, incl. Ka's)
 *   setoption name visits value N
 *   go                      — search from current state; prints bestmove
 *   State is PERSISTENT across moves on the same connection.
 *   After bestmove, state is NOT auto-advanced — must send makemove for Ka's move too.
 *
 * DUMP FORMAT (stdout, --dump-games):
 *   GAME e5 e5 d3h ...
 *   RESULT W        (W=P1 wins, B=P2 wins; draws omitted)
 * Same format as titanium match --dump-games so parse_dump_games() handles both.
 */

const { spawn } = require('child_process');
const readline = require('readline');
const path = require('path');
const { QuoridorEngineClient, ENGINES } = require('./extracted/engine_client');

function parseArgs(argv) {
  const o = {
    engine: 'titanium-v14',
    opp: 'ishtar',
    oppTime: 'short',
    ourTime: 2,
    ponderTime: 10,
    games: 8,
    concurrency: 2,
    bin: path.resolve(__dirname, '../engine/target/release/titanium.exe'),
    maxPly: 300,
    dumpGames: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--engine') o.engine = next();
    else if (a === '--opp') o.opp = next();
    else if (a === '--opp-time') o.oppTime = next();
    else if (a === '--our-time') o.ourTime = Number(next());
    else if (a === '--ponder-time') o.ponderTime = Number(next());
    else if (a === '--games') o.games = Number(next());
    else if (a === '--concurrency') o.concurrency = Number(next());
    else if (a === '--bin') o.bin = next();
    else if (a === '--max-ply') o.maxPly = Number(next());
    else if (a === '--dump-games') o.dumpGames = true;
  }
  return o;
}

// ── Our local engine ──────────────────────────────────────────────────────────

class OurEngine {
  constructor(bin, engineFlag) {
    this.proc = spawn(bin, ['session', '--engine', engineFlag], {
      stdio: ['pipe', 'pipe', 'pipe'],  // capture stderr for PV extraction
    });
    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.stderrLines = [];
    this.proc.stderr.on('data', (d) => {
      for (const ln of d.toString().split('\n')) {
        if (ln.trim()) this.stderrLines.push(ln.trim());
      }
    });
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
  _send(cmd) { this.proc.stdin.write(cmd + '\n'); }
  async _await(prefix) {
    for (;;) { const l = await this._readLine(); if (l.startsWith(prefix)) return l; }
  }

  /** Search from the given move history; return { move, pvOpponentReply }.
   *  pvOpponentReply is the engine's predicted next move (from PV), useful for
   *  pondering — null if PV is too short.
   */
  async bestMove(moves, seconds) {
    this.stderrLines = [];
    this._send(moves.length ? `position ${moves.join(' ')}` : 'reset');
    await this._await('ready');
    this._send(`go ${seconds}`);
    const line = await this._await('bestmove');
    const mv = line.slice('bestmove '.length).trim();

    // Extract PV from last info json on stderr to get predicted opponent reply.
    let pvOpponentReply = null;
    for (let i = this.stderrLines.length - 1; i >= 0; i--) {
      const m = this.stderrLines[i].match(/"depthLog":\[(.*)\]/);
      if (m) {
        // Find last entry's pv field
        const pvM = [...this.stderrLines[i].matchAll(/"pv":"([^"]+)"/g)].pop();
        if (pvM) {
          const pvTokens = pvM[1].split(' ').filter(Boolean);
          // pvTokens[0] = our move, pvTokens[1] = opponent's expected reply
          if (pvTokens.length >= 2) pvOpponentReply = pvTokens[1];
        }
        break;
      }
    }
    return { move: mv, pvOpponentReply };
  }

  destroy() {
    try { this._send('quit'); } catch {}
    this.proc.kill();
  }
}

// ── Remote engine (Ka / Ishtar) ───────────────────────────────────────────────
// Ka keeps state persistent on ONE connection. After each `go` + `bestmove`,
// state is NOT auto-advanced — we must send `makemove <Ka_move>` explicitly.
// uci_engine.py: makemove applies moves sequentially to self.state.

class RemoteEngine {
  constructor(opp, timeMode) {
    this.timeMode = timeMode;
    this.opp = opp;
    this._pending = null;
    this._error = null;
    this._connected = false;
    this._makeClient();
  }

  _makeClient() {
    if (this.client) this.client.destroy();
    const client = new QuoridorEngineClient(ENGINES[this.opp]);
    client.onBestMove = (action, raw) => {
      const cb = this._pending; this._pending = null;
      if (cb) cb({ action, raw });
    };
    client.onError = (e) => {
      this._error = e;
      const cb = this._pending; this._pending = null;
      if (cb) cb(null);
    };
    this.client = client;
  }

  /** Connect and wait until ready (one-time per game). */
  connect() {
    return new Promise((res, rej) => {
      const onStatus = (s) => {
        if (s === 'idle') { this._connected = true; this.client.onStatus = null; res(); }
        else if (s === 'error') { rej(new Error('Remote WS failed')); }
      };
      this.client.onStatus = onStatus;
      this.client.connect();
    });
  }

  /** Reconnect if the connection dropped (Ka may close after idle time). */
  _ensureConnected() {
    if (this.client.ws && this.client.ws.readyState === 1 /* OPEN */) return;
    this._makeClient();
    return this.connect();
  }

  /** Tell Ka/Ishtar that `mv` was played (advances server state). */
  async notifyMove(gl, mv) {
    await this._ensureConnected();
    this.client.makeMoves([gl.parseAlgebraic(mv)]);
  }

  /** Ask Ka/Ishtar for its move (from current server state). Returns algebraic or throws. */
  bestMove(gl) {
    return new Promise(async (res, rej) => {
      await this._ensureConnected();
      this._error = null;
      this._pending = ({ action, raw }) => {
        if (!action) { rej(this._error || new Error('no bestmove')); return; }
        res(gl.toAlgebraic(action));
      };
      this.client.go(this.timeMode);
    });
  }

  destroy() { if (this.client) this.client.destroy(); }
}

// ── Game loop ─────────────────────────────────────────────────────────────────

async function playGame(opts, gl, gameIdx, ourIsP1) {
  const { QuoridorBoard } = gl;
  const board = new QuoridorBoard();
  const our = new OurEngine(opts.bin, opts.engine);
  const remote = new RemoteEngine(opts.opp, opts.oppTime);

  // Connect and init Ka/Ishtar server state (sends newgame equivalent via fresh connect).
  await remote.connect();

  const moves = [];
  let winner = 0;
  let savedPonderMove = null;   // pre-computed our response to predicted Ka move
  let predictedKaMove = null;   // what we predicted Ka would play

  try {
    for (let ply = 0; ply < opts.maxPly; ply++) {
      const term = board.terminal();
      if (term.isTerminal) { winner = term.playerNum; break; }

      const p1ToMove = board.playerToMove() === 1;
      const ourTurn = p1ToMove === ourIsP1;

      let mv;

      if (ourTurn) {
        // Use pondered result if Ka played exactly what we predicted.
        if (savedPonderMove !== null && moves[moves.length - 1] === predictedKaMove) {
          mv = savedPonderMove;
        } else {
          const res = await our.bestMove(moves, opts.ourTime);
          mv = res.move;
          // Save PV for next ponder prediction.
          predictedKaMove = res.pvOpponentReply;
        }
        savedPonderMove = null;

        if (!mv || mv === '(none)') { winner = ourIsP1 ? 2 : 1; break; }

        // Tell remote engine about our move (advances its state).
        await remote.notifyMove(gl, mv);

      } else {
        // Remote engine's turn.
        // Start pondering CONCURRENTLY with Ka's search if we have a prediction.
        let ponderEngine = null;
        let ponderPromise = null;

        if (predictedKaMove && opts.ponderTime > 0) {
          // Predict Ka plays predictedKaMove; ponder our response to that.
          const ponderMoves = [...moves, predictedKaMove];
          ponderEngine = new OurEngine(opts.bin, opts.engine);
          ponderPromise = ponderEngine.bestMove(ponderMoves, opts.ponderTime);
        }

        // Ka searches from its current state (all previous moves already applied).
        mv = await remote.bestMove(gl);

        // Collect ponder result.
        if (ponderPromise) {
          const ponderRes = await ponderPromise;
          ponderEngine.destroy();
          ponderEngine = null;
          if (mv === predictedKaMove) {
            // Perfect prediction — use the deep ponder result on our next turn.
            savedPonderMove = ponderRes.move;
          }
        }

        // Tell remote engine it played mv (advances its state so next go is correct).
        await remote.notifyMove(gl, mv);

        if (!mv) { winner = ourIsP1 ? 1 : 2; break; }
      }

      if (!board.isValid(mv)) {
        process.stderr.write(`game ${gameIdx}: illegal move "${mv}" by ${ourTurn ? 'OUR' : 'OPP'} at ply ${ply}\n`);
        winner = ourTurn ? (ourIsP1 ? 2 : 1) : (ourIsP1 ? 1 : 2);
        break;
      }
      board.takeAction(mv);
      moves.push(mv);
    }
  } finally {
    our.destroy();
    remote.destroy();
  }

  if (winner === 0) {
    const d1 = gl.shortestDistanceToGoal(board, 1);
    const d2 = gl.shortestDistanceToGoal(board, 2);
    winner = d1 < d2 ? 1 : d2 < d1 ? 2 : 0;
  }
  const ourWin = winner !== 0 && (winner === 1) === ourIsP1;
  return { gameIdx, winner, ourWin, draw: winner === 0, plies: moves.length, moves };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv);
  const gl = await import('./web/src/lib/gameLogic.js');

  const log = opts.dumpGames
    ? (...args) => process.stderr.write(args.join(' ') + '\n')
    : (...args) => console.log(...args);

  log(
    `match: OUR=${opts.engine} (${opts.ourTime}s, ponder ${opts.ponderTime}s) vs ${opts.opp} (${opts.oppTime}), ` +
      `${opts.games} games, concurrency ${opts.concurrency}`,
  );

  let ourW = 0, oppW = 0, draws = 0, done = 0;
  const started = Date.now();
  let next = 0;

  async function worker() {
    for (;;) {
      const idx = next++;
      if (idx >= opts.games) return;
      const ourIsP1 = idx % 2 === 0;
      let r;
      try {
        r = await playGame(opts, gl, idx, ourIsP1);
      } catch (e) {
        process.stderr.write(`game ${idx} error: ${e.message}\n`);
        continue;
      }

      if (r.draw) draws++;
      else if (r.ourWin) ourW++;
      else oppW++;
      done++;

      if (opts.dumpGames && !r.draw) {
        process.stdout.write(`GAME ${r.moves.join(' ')}\nRESULT ${r.winner === 1 ? 'W' : 'B'}\n`);
      }

      const score = ourW + 0.5 * draws;
      const secs = ((Date.now() - started) / 1000).toFixed(0);
      log(
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
  log('=== MATCH RESULT ===');
  log(`OUR=${opts.engine} vs ${opts.opp} ${opts.oppTime}`);
  log(`OUR ${ourW} | OPP ${oppW} | draws ${draws}`);
  log(`score ${score.toFixed(1)}/${n} = ${(p * 100).toFixed(1)}% (+-${(se * 196).toFixed(1)}%) ~${elo >= 0 ? '+' : ''}${elo.toFixed(0)} Elo`);
  process.stderr.write(`MATCH_SUMMARY OUR=${ourW} OPP=${oppW} DRAWS=${draws} SCORE=${score.toFixed(1)}/${n} ELO=${elo.toFixed(0)}\n`);
}

main().catch((e) => {
  process.stderr.write(e.stack + '\n');
  process.exit(1);
});
