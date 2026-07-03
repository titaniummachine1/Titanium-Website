#!/usr/bin/env node
/**
 * Batch match harness: native Titanium engine vs a remote Ishtar/Ka engine.
 *
 *   node ishtar_match.js [options]
 *     --engine NAME      our engine flag (default titanium-v15)
 *     --opp ishtar|ka    remote opponent (default ishtar)
 *     --opp-time MODE    intuition|short|medium|long (default short)
 *     --our-time SEC     fallback/bootstrap seconds if no remote sample yet (default 10)
 *     --ponder-time SEC  ponder during remote think (default 0 in fair mode)
 *     --fair-time        our think = max remote peak (calibrated + this game), not last move (default ON)
 *     --no-fair-time     use fixed --our-time instead
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
 * Ka / Ishtar remote protocol (see site/extracted/ENGINE_PROTOCOL.md):
 *
 *   The remote server is NOT playing a game with you. It is a stateless search
 *   box: whatever position it last saw via makemove/setposition is where `go`
 *   searches. It does not advance after bestmove — you must makemove EVERY ply
 *   (yours AND Ka's) or the next `go` is from the wrong position.
 *
 *   makemove <m1> <m2> ...  — apply moves to server state (ALL moves, incl. Ka's)
 *   go                      — search from current server state; prints bestmove
 *   State is PERSISTENT on one connection until disconnect.
 *   After reconnect: replay full _appliedActions before the next go/notifyMove.
 *
 * DUMP FORMAT (stdout, --dump-games):
 *   GAME e5 e5 d3h ...
 *   RESULT W        (W=P1 wins, B=P2 wins; draws omitted)
 * Same format as titanium match --dump-games so parse_dump_games() handles both.
 */

const { spawn } = require('child_process');
const readline = require('readline');
const path = require('path');
const fs = require('fs');
const { ProgressBoard, MAX_SLOTS } = require('./progress_bars');
const { QuoridorEngineClient, ENGINES } = require('./extracted/engine_client');
const { fairBudgetSec, fairOurThinkSec, FAIR_OUR_THINK_CAP_SEC, recordThink, minThinkSec, remoteMoveTimeoutSec, remoteConnectTimeoutSec, kaQueueAcquireTimeoutSec } = require('./remote_timing');
const { isCompleteGame } = require('./game_validate');
const { normalizeTimeMode, presetDescription } = require('./remote_presets');

function parseArgs(argv) {
  const o = {
    engine: 'titanium-v15',
    opp: 'ishtar',
    oppTime: 'short',
    ourTime: 10,
    ponderTime: 0,
    fairTime: true,
    games: 8,
    concurrency: 2,
    bin: path.resolve(__dirname, '../engine/target/release/titanium.exe'),
    maxPly: 300,
    dumpGames: false,
    saveGames: null,
    sourceTag: 'ishtar-match',
    verbose: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--engine') o.engine = next();
    else if (a === '--opp') o.opp = next();
    else if (a === '--opp-time') o.oppTime = normalizeTimeMode(next());
    else if (a === '--our-time') o.ourTime = Number(next());
    else if (a === '--ponder-time') o.ponderTime = Number(next());
    else if (a === '--games') o.games = Number(next());
    else if (a === '--concurrency') o.concurrency = Number(next());
    else if (a === '--bin') o.bin = next();
    else if (a === '--max-ply') o.maxPly = Number(next());
    else if (a === '--dump-games') o.dumpGames = true;
    else if (a === '--save-games') o.saveGames = next();
    else if (a === '--source-tag') o.sourceTag = next();
    else if (a === '--fair-time') o.fairTime = true;
    else if (a === '--no-fair-time') o.fairTime = false;
    else if (a === '--verbose') o.verbose = true;
  }
  if (o.fairTime && o.ponderTime === 0) o.ponderTime = 0;
  return o;
}

const coord = require('./coordinator_client');

async function persistGame(moves, result, sourceTag, gamesFile, releaseRemote = false, gameId = null) {
  return coord.upsertGame({ moves, result, tag: sourceTag, gamesFile, releaseRemote, gameId });
}

function ourTcLabel(_opts) {
  return '5s';
}

async function loadPriorMatchup(engineA, engineB, tcA, tcB) {
  const j = await coord.lookupMatchup(engineA, engineB, tcA, tcB);
  return { ourW: j.aW, oppW: j.bW };
}

function runningElo(ourW, oppW) {
  const n = ourW + oppW;
  if (!n) return { elo: null, se: null };
  const p = ourW / n;
  if (p <= 0 || p >= 1) return { elo: p >= 1 ? Infinity : -Infinity, se: 0 };
  return {
    elo: -400 * Math.log10((1 - p) / p),
    se: Math.sqrt((p * (1 - p)) / n) * 196,
  };
}

async function updateMatchup(opts, ourW, oppW, logFn) {
  try {
    const entry = await coord.upsertMatchup({
      engineA: opts.engine,
      engineB: opts.opp,
      aWins: ourW,
      bWins: oppW,
      tcA: ourTcLabel(opts),
      tcB: opts.oppTime,
      gamesFile: opts.saveGames,
      source: opts.sourceTag || `${opts.engine}-vs-${opts.opp}-${opts.oppTime}`,
    });
    if (entry.elo_a_vs_b != null && logFn) {
      logFn(`Elo diff (A vs B): ${entry.elo_a_vs_b}`);
    }
  } catch (e) {
    if (logFn) logFn(`matchup upsert failed: ${e.message}`);
    throw e;
  }
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
    try { this.rl?.close(); } catch {}
    try { this.proc?.kill(); } catch {}
  }
}

// ── Remote engine (Ka / Ishtar) ───────────────────────────────────────────────
// Ka/Ishtar do not "play" a game — they search the position you last sent via
// makemove. We keep _appliedActions as source of truth and echo every ply to
// the server (both sides). On WS drop, reconnect + replay full history.
const MAX_MOVE_RETRIES = 5;
const MAX_GAME_REMOTE_RETRIES = 12;
const RETRY_DELAY_MS = 3000;
const RETRY_MIN_AFTER_FAIL_MS = 8000;
/** Reconnect if Ka WS idle longer than this (NAT / server session expiry). */
const REMOTE_WS_MAX_IDLE_MS = 45_000;

function isRemoteTransient(err) {
  return /timeout|stall|closed|failed|error|websocket|connect/i.test(String(err?.message || err));
}

async function withRemoteRetry(remote, progress, slot, opts, moves, label, fn) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_GAME_REMOTE_RETRIES; attempt++) {
    if (attempt > 0) {
      remote._onRetry(attempt);
      statusLog(opts, `${label}: reconnect #${attempt} at ply ${moves.length}`);
      const waitMs = Math.max(RETRY_MIN_AFTER_FAIL_MS, RETRY_DELAY_MS * Math.min(attempt, 6));
      await new Promise((r) => setTimeout(r, waitMs));
    }
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isRemoteTransient(e)) throw e;
      try { remote.client?.destroy(); } catch {}
      remote._connected = false;
    }
  }
  throw lastErr;
}

function emptyBoardState() {
  return {
    playerToMove: 1,
    moveNumber: 1,
    wallsRemaining: [10, 10],
    playerPositions: [{ column: 'e', row: 2 }, { column: 'e', row: 8 }],
    wallsByPlayer: [],
  };
}

class RemoteEngine {
  constructor(opp, timeMode, progress, slot, exactVisits = null) {
    this.timeMode = timeMode;
    this.opp = opp;
    this.progress = progress;
    this.slot = slot;
    this.exactVisits = exactVisits;
    this._pending = null;
    this._error = null;
    this._connected = false;
    this._appliedActions = [];  // full game history for reconnect replay
    this._wireActivityMs = Date.now();
    this._makeClient();
  }

  _touchWireActivity() {
    this._wireActivityMs = Date.now();
  }

  _connectionStale(maxIdleMs = REMOTE_WS_MAX_IDLE_MS) {
    if (this.client?.isConnectionStale?.(maxIdleMs)) {
      return true;
    }
    if (this.client?.ws?.readyState !== 1 /* OPEN */) {
      return true;
    }
    return Date.now() - this._wireActivityMs > maxIdleMs;
  }

  _makeClient() {
    if (this.client) this.client.destroy();
    const client = new QuoridorEngineClient(ENGINES[this.opp]);
    client.onBestMove = (action, raw) => {
      this._touchWireActivity();
      const cb = this._pending; this._pending = null;
      if (cb) cb({ action, raw });
    };
    client.onError = (e) => {
      this._error = e;
      const cb = this._pending; this._pending = null;
      if (cb) cb({ error: e });
    };
    client.onRawMessage = () => this._touchWireActivity();
    this.client = client;
  }

  async _replayAppliedMoves() {
    if (this._appliedActions.length > 0) {
      this.client.makeMoves(this._appliedActions);
    }
  }

  /** Fresh WS + full makemove replay — use after queue wait or stale socket. */
  async refreshConnection(reason = 'refresh') {
    try { this.client?.destroy(); } catch {}
    this._connected = false;
    this._makeClient();
    await this.connect();
    await this._replayAppliedMoves();
    if (process.env.NO_PROGRESS === '1') {
      const tag = process.env.MATCH_LABEL || `${this.opp}@${this.timeMode}`;
      process.stderr.write(`[${tag}] Ka WS refresh (${reason}) ply ${this._appliedActions.length}\n`);
    }
  }

  /** Connect and wait until ready; rejects after connectTimeoutSec if TCP hangs. */
  connect(connectTimeoutSec = remoteConnectTimeoutSec(this.opp, this.timeMode)) {
    return new Promise((res, rej) => {
      let connTimer = setTimeout(() => {
        this.client.onStatus = null;
        rej(new Error(`remote connect timeout after ${connectTimeoutSec}s`));
      }, connectTimeoutSec * 1000);

      const onStatus = (s) => {
        if (s === 'idle') {
          this._touchWireActivity();
          clearTimeout(connTimer);
          connTimer = null;
          this._connected = true;
          this.client.onStatus = null;
          if (this._appliedActions.length === 0) {
            this.client.setPosition(emptyBoardState());
          }
          res();
        } else if (s === 'error') {
          clearTimeout(connTimer);
          connTimer = null;
          rej(new Error('Remote WS failed'));
        }
      };
      this.client.onStatus = onStatus;
      this.client.connect();
    });
  }

  async _ensureConnected(connectTimeoutSec = remoteConnectTimeoutSec(this.opp, this.timeMode), { forceFresh = false } = {}) {
    const stale = this._connectionStale();
    if (!forceFresh && !stale && this.client?.ws?.readyState === 1 /* OPEN */) {
      return;
    }
    if (stale || forceFresh) {
      try { this.client?.destroy(); } catch {}
      this._connected = false;
    }
    this._makeClient();
    await this.connect(connectTimeoutSec);
    await this._replayAppliedMoves();
  }

  /** Before Ka `go` — always new socket after queue wait; otherwise refresh if idle. */
  async prepareForSearch({ afterQueue = false } = {}) {
    if (afterQueue || this._connectionStale(30_000)) {
      this._onRetry(afterQueue ? 1 : 0);
      await this.refreshConnection(afterQueue ? 'post-queue' : 'stale-idle');
      return;
    }
    await this._ensureConnected();
  }

  _onRetry(attempt) {
    if (this.progress && this.slot != null) {
      this.progress.reconnect(this.slot, attempt);
    }
  }

  /**
   * Tell the remote server a ply happened. Required after OUR moves and after
   * Ka's bestmove — the server does not auto-advance on bestmove.
   */
  async notifyMove(gl, mv) {
    const action = gl.parseAlgebraic(mv);
    let lastErr;
    for (let attempt = 0; attempt <= MAX_MOVE_RETRIES; attempt++) {
      if (attempt > 0) {
        this._onRetry(attempt);
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
      try {
        await this._ensureConnected();
        this.client.makeMoves([action]);
        this._appliedActions.push(action);
        return;
      } catch (e) {
        lastErr = e;
        try { this.client?.destroy(); } catch {}
        this._connected = false;
      }
    }
    throw lastErr;
  }

  async bestMove(gl, searchTimeoutSec = 120, onSearchStart = null) {
    let lastErr;
    for (let attempt = 0; attempt <= MAX_MOVE_RETRIES; attempt++) {
      if (attempt > 0) {
        this._onRetry(attempt);
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
      try {
        return await this._bestMoveOnce(gl, searchTimeoutSec, onSearchStart);
      } catch (e) {
        lastErr = e;
        const isConnErr = /timeout|stall|closed|failed|error|websocket/i.test(String(e.message));
        if (!isConnErr || attempt >= MAX_MOVE_RETRIES) break;
        try { this.client?.destroy(); } catch {}
        this._connected = false;
      }
    }
    throw lastErr;
  }

  /** Connect + replay history, then search. Outer timer = connect + search + small slack. */
  _bestMoveOnce(gl, searchTimeoutSec, onSearchStart = null) {
    const connectSec = remoteConnectTimeoutSec(this.opp, this.timeMode);
    const outerSec = connectSec + searchTimeoutSec + 3;

    return new Promise((res, rej) => {
      let settled = false;
      let searchTimer = null;
      let outerTimer = null;

      const finish = (fn) => {
        if (settled) return;
        settled = true;
        if (searchTimer) clearTimeout(searchTimer);
        if (outerTimer) clearTimeout(outerTimer);
        if (this.client) {
          this.client.onRawMessage = null;
        }
        this._pending = null;
        fn();
      };

      outerTimer = setTimeout(() => {
        finish(() => {
          try { this.client?.abortSearch(); } catch {}
          try { this.client?.destroy(); } catch {}
          this._makeClient();
          rej(new Error(`remote move timeout (${outerSec}s connect+search)`));
        });
      }, Math.max(3000, outerSec * 1000));

      this._ensureConnected(connectSec).then(() => {
        if (settled) return;
        if (onSearchStart) onSearchStart();
        this._error = null;
        const t0 = Date.now();

        searchTimer = setTimeout(() => {
          finish(() => {
            try { this.client?.abortSearch(); } catch {}
            try { this.client?.destroy(); } catch {}
            this._makeClient();
            rej(new Error(`remote think timeout (${searchTimeoutSec}s)`));
          });
        }, Math.max(1000, searchTimeoutSec * 1000));

        this._pending = (result) => {
          if (!result || result.error) {
            finish(() => rej(this._error || result?.error || new Error('remote engine returned no bestmove')));
            return;
          }
          const { action } = result;
          const thinkSec = Math.max(0.1, (Date.now() - t0) / 1000);
          finish(() => res({ move: gl.toAlgebraic(action), thinkSec }));
        };
        try {
          if (this.exactVisits != null) {
            this.client.goExact(this.exactVisits, this.timeMode);
          } else {
            this.client.go(this.timeMode);
          }
        } catch (e) {
          finish(() => rej(e));
        }
      }).catch((e) => {
        finish(() => rej(e));
      });
    });
  }

  destroy() {
    this._pending = null;
    if (this.client) this.client.destroy();
  }
}

// ── Game loop ─────────────────────────────────────────────────────────────────

function vlog(opts, gameIdx, msg) {
  if (opts.verbose) process.stderr.write(`game ${gameIdx}: ${msg}\n`);
}

function statusLog(opts, msg) {
  if (process.env.NO_PROGRESS === '1') {
    const tag = process.env.MATCH_LABEL || `${opts.engine} vs ${opts.opp}@${opts.oppTime}`;
    process.stderr.write(`[${tag}] ${msg}\n`);
  }
}

async function playGame(opts, gl, gameIdx, ourIsP1, slot, progress) {
  const { QuoridorBoard } = gl;
  const board = new QuoridorBoard();
  const our = new OurEngine(opts.bin, opts.engine);
  const timingMode = opts.timingMode || opts.oppTime;
  const remote = new RemoteEngine(opts.opp, timingMode, progress, slot, opts.oppVisits ?? null);

  const matchLabel = opts.matchLabel || process.env.MATCH_LABEL || '';
  progress.start(slot, gameIdx, opts.maxPly, matchLabel);

  // Lazy connect — first remote op opens WS (avoids idle drop before ply 1).

  const moves = [];
  let winner = 0;
  let savedPonderMove = null;
  let predictedKaMove = null;
  // Fair time: our budget tracks Ka peak but capped (default 15s) — remote display uses full fairBudgetSec.
  let gameMaxRemoteSec = 0;
  let ourThinkSec = opts.fairTime
    ? fairOurThinkSec(opts.opp, timingMode, 0)
    : opts.ourTime;
  if (opts.fairTime) {
    vlog(opts, gameIdx,
      `fair budget ${ourThinkSec.toFixed(1)}s (cap ${FAIR_OUR_THINK_CAP_SEC}s for ${opts.opp}@${timingMode})`,
    );
  }

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
          vlog(opts, gameIdx, `our turn — go ${ourThinkSec.toFixed(1)}s`);
          progress.thinking(slot, 'us', ourThinkSec);
          const res = await our.bestMove(moves, ourThinkSec);
          mv = res.move;
          predictedKaMove = res.pvOpponentReply;
        }
        savedPonderMove = null;

        if (!mv || mv === '(none)') { winner = ourIsP1 ? 2 : 1; break; }

        // Tell remote engine about our move (advances its state).
        await withRemoteRetry(
          remote, progress, slot, opts, moves, 'notify our move',
          () => remote.notifyMove(gl, mv),
        );

      } else {
        // Remote engine's turn.
        // Start pondering CONCURRENTLY with Ka's search if we have a prediction.
        let ponderEngine = null;
        let ponderPromise = null;

        if (predictedKaMove && opts.ponderTime > 0) {
          const ponderMoves = [...moves, predictedKaMove];
          ponderEngine = new OurEngine(opts.bin, opts.engine);
          ponderPromise = ponderEngine.bestMove(ponderMoves, opts.ponderTime);
        }

        const remoteBudget = opts.fairTime
          ? fairBudgetSec(opts.opp, timingMode, gameMaxRemoteSec)
          : opts.ourTime;
        const remoteTimeout = remoteMoveTimeoutSec(opts.opp, timingMode);
        statusLog(opts, `${opts.opp}@${opts.oppTime} search (budget ~${remoteBudget.toFixed(0)}s, timeout ${remoteTimeout}s)`);

        const gameId = opts.gameId || process.env.GAME_ID || 'unknown';
        const runRemoteSearch = async () => {
          if (opts.opp === 'ka') {
            progress.thinking(slot, 'ka-queue', 30);
            const queueTimeout = kaQueueAcquireTimeoutSec(timingMode);
            await coord.acquireKaSearch(opts.oppTime, gameId, queueTimeout);
          }
          await remote.prepareForSearch({ afterQueue: opts.opp === 'ka' });
          try {
            return await remote.bestMove(gl, remoteTimeout, () => {
              progress.thinking(slot, opts.opp, remoteBudget);
            });
          } finally {
            if (opts.opp === 'ka') {
              await coord.releaseKaSearch(opts.oppTime, gameId).catch(() => {});
            }
          }
        };

        const remoteRes = await withRemoteRetry(
          remote, progress, slot, opts, moves, `${opts.opp}@${opts.oppTime} search`,
          runRemoteSearch,
        );
        mv = remoteRes.move;
        if (remoteRes.thinkSec >= minThinkSec(opts.opp, timingMode)) {
          gameMaxRemoteSec = Math.max(gameMaxRemoteSec, remoteRes.thinkSec);
        }
        recordThink(opts.opp, timingMode, remoteRes.thinkSec);
        ourThinkSec = opts.fairTime
          ? fairOurThinkSec(opts.opp, timingMode, gameMaxRemoteSec)
          : opts.ourTime;
        vlog(opts, gameIdx,
          `${opts.opp}@${opts.oppTime} thought ${remoteRes.thinkSec.toFixed(1)}s` +
          ` (game peak ${gameMaxRemoteSec.toFixed(1)}s) → our go ${ourThinkSec.toFixed(1)}s`,
        );

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
        await withRemoteRetry(
          remote, progress, slot, opts, moves, 'notify Ka move',
          () => remote.notifyMove(gl, mv),
        );

        if (!mv) { winner = ourIsP1 ? 1 : 2; break; }
      }

      if (!board.isValid(mv)) {
        statusLog(opts, `illegal move "${mv}" by ${ourTurn ? 'OUR' : 'OPP'} at ply ${ply}`);
        progress.note(`game ${gameIdx}: illegal move "${mv}" by ${ourTurn ? 'OUR' : 'OPP'} at ply ${ply}`);
        winner = ourTurn ? (ourIsP1 ? 2 : 1) : (ourIsP1 ? 1 : 2);
        break;
      }
      board.takeAction(mv);
      moves.push(mv);
      progress.ply(slot, moves.length, opts.maxPly);
      if (process.env.NO_PROGRESS === '1' && moves.length % 10 === 0) {
        statusLog(opts, `ply ${moves.length}/${opts.maxPly}`);
      }
    }
  } finally {
    our.destroy();
    remote.destroy();
  }

  const ourWin = winner !== 0 && (winner === 1) === ourIsP1;
  progress.finish(slot, {
    plies: moves.length,
    label: ourWin ? 'we win' : `${opts.opp} wins`,
  });
  const result = {
    gameIdx,
    winner,
    ourWin,
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

  const progress = new ProgressBoard({
    slots: Math.min(opts.concurrency, MAX_SLOTS),
    title: `${opts.engine} vs ${opts.opp}@${opts.oppTime}`,
  });
  const log = opts.dumpGames
    ? (...args) => progress.note(args.join(' '))
    : (...args) => progress.note(args.join(' '));

  log(
    `match: OUR=${opts.engine} vs ${opts.opp}@${opts.oppTime}` +
    (opts.fairTime
      ? `  [matched think time vs remote peak]`
      : `  OUR=${opts.ourTime}s fixed`) +
    `  ${opts.games} games, concurrency ${opts.concurrency}`,
  );
  statusLog(opts, 'starting');
  log('Elo ladder: training/data/STATUS.txt');

  if (opts.saveGames) log(`saving games -> ${opts.saveGames}`);

  const prior = await loadPriorMatchup(opts.engine, opts.opp, ourTcLabel(opts), opts.oppTime);
  let ourW = prior.ourW, oppW = prior.oppW;
  let sessionOur = 0, sessionOpp = 0;
  let done = 0;
  const started = Date.now();
  let next = 0;

  async function worker(workerId) {
    const slot = workerId;
    for (;;) {
      const idx = next++;
      if (idx >= opts.games) {
        progress.idle(slot);
        return;
      }
      const ourIsP1 = idx % 2 === 0;
      let r;
      try {
        r = await playGame(opts, gl, idx, ourIsP1, slot, progress);
      } catch (e) {
        progress.note(`game ${idx} error: ${e.message}`);
        progress.idle(slot);
        continue;
      }

      if (!isCompleteGame(r)) {
        progress.note(`game ${idx}: skip incomplete (${r.plies} plies)`);
        continue;
      }
      if (r.ourWin) { ourW++; sessionOur++; }
      else { oppW++; sessionOpp++; }
      done++;

      if (opts.dumpGames) {
        process.stdout.write(`GAME ${r.moves.join(' ')}\nRESULT ${r.winner === 1 ? 'W' : 'B'}\n`);
      }
      if (opts.saveGames || opts.sourceTag) {
        await persistGame(
          r.moves,
          r.winner === 1 ? 'W' : 'B',
          opts.sourceTag,
          opts.saveGames,
        );
      }
      await updateMatchup(opts, ourW, oppW, (msg) => log(msg));

      const { elo, se } = runningElo(ourW, oppW);
      const secs = ((Date.now() - started) / 1000).toFixed(0);
      const eloS = elo != null && Number.isFinite(elo)
        ? `  ~${elo >= 0 ? '+' : ''}${elo.toFixed(0)} diff (±${se.toFixed(0)}%)`
        : '';
      log(
        `  [${done} this run, ${ourW + oppW} total] OUR ${ourW} - ${oppW} ${opts.opp}@${opts.oppTime}` +
        `  (session ${sessionOur}-${sessionOpp})${eloS}  ${r.plies} plies  ${secs}s`,
      );
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, (_, i) => worker(i)));
  progress.dispose();

  const n = ourW + oppW || 1;
  const p = ourW / n;
  const se = Math.sqrt((p * (1 - p)) / n);
  const elo = p > 0 && p < 1 ? -400 * Math.log10((1 - p) / p) : (p >= 1 ? Infinity : -Infinity);
  log('=== MATCH RESULT ===');
  log(`OUR=${opts.engine}@5s vs ${presetDescription(opts.opp, opts.oppTime)}`);
  log(`This run: OUR ${sessionOur} | OPP ${sessionOpp}`);
  log(`Cumulative: OUR ${ourW} | OPP ${oppW}  (${n} games)`);
  log(`score ${ourW}/${n} = ${(p * 100).toFixed(1)}% (+-${(se * 196).toFixed(1)}%) ~${elo >= 0 ? '+' : ''}${elo.toFixed(0)} Elo diff`);
  log('Updated: training/data/STATUS.txt (global ladder)');
  process.stderr.write(
    `MATCH_SUMMARY OUR=${ourW} OPP=${oppW} DRAWS=0 SCORE=${ourW}/${n} ELO=${Number.isFinite(elo) ? elo.toFixed(0) : elo}\n`,
  );
}

if (require.main === module) {
  main().catch((e) => {
    const tag = process.env.MATCH_LABEL || 'match';
    process.stderr.write(`[${tag}] FATAL: ${e.stack || e}\n`);
    process.exit(1);
  });
}

module.exports = {
  playGame,
  persistGame,
  loadPriorMatchup,
  updateMatchup,
  ourTcLabel,
  runningElo,
  isCompleteGame,
  RemoteEngine,
};
