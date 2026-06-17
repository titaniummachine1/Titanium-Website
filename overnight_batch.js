#!/usr/bin/env node
/**
 * Run matchups in parallel — single ProgressBoard (up to 8 bars).
 *
 *   node overnight_batch.js --pool [--slots 7]   continuous pool (default for overnight)
 *   node overnight_batch.js batch.json           one-shot batch (legacy)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const { ProgressBoard } = require('./progress_bars');
const { preload: preloadRemoteTiming } = require('./remote_timing');
const selfMatch = require('./self_match');
const { isCompleteGame } = require('./game_validate');
const { upsertGame, upsertMatchup, ensurePoolCoordinator, claimPairing, releaseRemoteSlot, fetchScoreboard } = require('./coordinator_client');

const BIN = path.resolve(__dirname, '../engine/target/release/titanium.exe');
const REMOTE_WORKER = path.join(__dirname, 'remote_game_worker.js');

let _activeProgress = null;

process.on('SIGINT', () => {
  _activeProgress?.dispose();
  process.exit(130);
});

process.on('SIGTERM', () => {
  _activeProgress?.dispose();
  process.exit(143);
});

function poolLabel(p) {
  return p.display_label || shortLabel(p);
}

function shortLabel(p) {
  const tcA = p.tc_a || '5s';
  const tcB = p.tc_b || tcA;
  if (p.kind === 'remote' && p.engine_b === 'ka') {
    const ka = p.tc_b === 'intuition' ? 'Ka-imm' : `Ka-${p.tc_b}`;
    return `v15@5s vs ${ka}`;
  }
  if (p.engine_a === p.engine_b && p.engine_a === 'titanium-v15') {
    return `v15 self@${tcA}`;
  }
  if (p.engine_b === 'ace-v13-ti-pure' && tcA === '10s') {
    return `v15@10s vs ti-pure`;
  }
  if (p.engine_b === 'titanium-v15-frozen') {
    return `v15@${tcA} vs frozen`;
  }
  if (p.engine_b === 'ace-v13') {
    return `v15@5s vs JS-v13`;
  }
  return `${p.engine_a} vs ${p.engine_b}@${tcB}`;
}

function runRemoteIsolated(p, slot, progress) {
  const label = poolLabel(p);
  progress.setSlotLabel(slot, label);

  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ pairing: p, slot });
    const worker = fork(REMOTE_WORKER, [payload], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {
        ...process.env,
        NO_PROGRESS: '1',
        MATCH_LABEL: label,
      },
    });
    let settled = false;
    let errTail = '';

    worker.stderr?.on('data', (d) => {
      const s = d.toString().trim();
      if (s) errTail = (errTail + '\n' + s).slice(-2000);
    });

    worker.on('message', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      switch (msg.type) {
        case 'start':
          if (msg.matchLabel) progress.setSlotLabel(msg.slot, msg.matchLabel);
          progress.start(msg.slot, 0, msg.maxPly, msg.matchLabel || label);
          break;
        case 'ply':
          progress.ply(msg.slot, msg.ply, msg.maxPly);
          break;
        case 'think':
          progress.thinking(msg.slot, msg.side, msg.budgetSec);
          break;
        case 'reconnect':
          progress.reconnect(msg.slot, msg.attempt);
          break;
        case 'finish':
          progress.finish(msg.slot, { plies: msg.plies, label: msg.label || msg.result || 'done' });
          break;
        case 'idle':
          progress.idle(msg.slot);
          break;
        case 'note':
          progress.note(msg.msg);
          break;
        case 'done':
          settled = true;
          resolve({
            label: msg.label || label,
            plies: msg.plies,
            ourW: msg.ourW,
            oppW: msg.oppW,
            dbId: msg.dbId ?? null,
            skipped: !!msg.skipped,
          });
          break;
        case 'error':
          settled = true;
          reject(new Error(msg.error || 'remote worker failed'));
          break;
        default:
          break;
      }
    });

    worker.on('error', (e) => {
      if (!settled) {
        settled = true;
        reject(e);
      }
    });
    worker.on('exit', (code) => {
      if (!settled && code !== 0) {
        settled = true;
        const detail = errTail ? `\n${errTail}` : '';
        reject(new Error(`remote worker exited ${code} (${label})${detail}`));
      }
    });
  });
}

async function runLocal(p, slot, gl, progress) {
  const timeS = parseFloat(String(p.tc_a).replace(/s$/, '')) || 5;
  const label = poolLabel(p);
  progress.setSlotLabel(slot, label);

  const opts = {
    engineA: p.engine_a,
    engineB: p.engine_b,
    timeA: timeS,
    timeB: timeS,
    ponderTime: timeS,
    maxPly: 300,
    bin: BIN,
    binA: BIN,
    binB: BIN,
    noPonder: false,
    sourceTag: p.source_tag,
  };

  const prior = await selfMatch.loadPriorMatchup(
    opts.engineA, opts.engineB, selfMatch.tcLabel(timeS), selfMatch.tcLabel(timeS),
  );
  let aW = prior.aW;
  let bW = prior.bW;

  const r = await selfMatch.playGame(opts, gl, 0, true, slot, progress);
  const gameResult = { winner: r.winner, plies: r.plies, moves: r.moves, draw: false, aborted: false };
  if (!isCompleteGame(gameResult)) {
    return { label, plies: r.plies, aW, bW, skipped: true };
  }

  if (r.aWins) aW += 1;
  else bW += 1;

  const result = r.winner === 1 ? 'W' : 'B';
  const gameResp = await upsertGame({
    moves: r.moves,
    result,
    tag: opts.sourceTag,
    releaseRemote: !!p.release_remote,
    gameId: p.game_id,
  });
  await upsertMatchup({
    engineA: opts.engineA,
    engineB: opts.engineB,
    aWins: aW,
    bWins: bW,
    tcA: selfMatch.tcLabel(timeS),
    tcB: selfMatch.tcLabel(timeS),
    source: opts.sourceTag,
  });
  return { label, plies: r.plies, aW, bW, dbId: gameResp?.game_id ?? null };
}

async function runOne(p, slot, gl, progress) {
  try {
    if (p.kind === 'remote') {
      return await runRemoteIsolated(p, slot, progress);
    }
    return await runLocal(p, slot, gl, progress);
  } catch (e) {
    progress.idle(slot);
    throw e;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function slotLoop(slot, gl, progress, onGameDone) {
  let lastClaimErr = 0;
  for (;;) {
    let pairing;
    try {
      pairing = await claimPairing();
    } catch (e) {
      const now = Date.now();
      if (now - lastClaimErr > 8000) {
        progress.note(`slot ${slot}: claim failed — ${e.message}`);
        lastClaimErr = now;
      }
      progress.idle(slot);
      await sleep(3000);
      continue;
    }
    progress.setSlotLabel(slot, poolLabel(pairing));
    progress.idle(slot);
    progress.start(slot, 0, 300, poolLabel(pairing));
    try {
      const r = await runOne(pairing, slot, gl, progress);
      if (onGameDone) await onGameDone(r);
    } catch (e) {
      const brief = (e.message || String(e)).split('\n')[0];
      progress.note(`${poolLabel(pairing)}: ${brief}`);
      if (pairing.release_remote || pairing.game_id) {
        await releaseRemoteSlot(pairing.game_id).catch(() => {});
      }
      progress.idle(slot);
    }
  }
}

async function refreshScoreboard(progress, { quiet = false } = {}) {
  try {
    progress.setScoreboard(await fetchScoreboard());
  } catch (e) {
    if (!quiet) {
      progress.note(`scoreboard refresh: ${(e.message || e).split('\n')[0]}`);
    }
  }
}

const ALERT_FILE = path.resolve(__dirname, '../training/data/supervisor_alert.json');

function pollSupervisorAlerts(progress) {
  try {
    if (!fs.existsSync(ALERT_FILE)) return;
    const raw = fs.readFileSync(ALERT_FILE, 'utf8');
    const j = JSON.parse(raw);
    const ts = j.ts || '';
    if (ts && ts === pollSupervisorAlerts._lastTs) return;
    pollSupervisorAlerts._lastTs = ts;
    const lvl = j.level === 'FAIL' ? 'FAIL' : 'WARN';
    progress.note(`[${lvl}] ${j.msg || ''}`.slice(0, 120));
  } catch {
    /* alert file may be mid-write */
  }
}
pollSupervisorAlerts._lastTs = '';

async function runPool(slots) {
  if (!fs.existsSync(BIN)) {
    throw new Error(`engine binary missing: ${BIN} — run: cargo build --release -p titanium`);
  }
  if (!fs.existsSync(REMOTE_WORKER)) {
    throw new Error(`remote worker missing: ${REMOTE_WORKER}`);
  }

  const poolStatus = await ensurePoolCoordinator();
  preloadRemoteTiming();

  const gl = await import('./web/src/lib/gameLogic.js');
  const progress = new ProgressBoard({
    slots,
    title: 'ACTIVE GAMES',
    continuous: true,
  });
  _activeProgress = progress;
  progress.beginPool();

  await refreshScoreboard(progress);
  pollSupervisorAlerts(progress);

  const scoreboardTimer = setInterval(() => {
    refreshScoreboard(progress, { quiet: true }).catch(() => {});
    pollSupervisorAlerts(progress);
  }, 10_000);
  let coordinatorMisses = 0;
  const coordinatorTimer = setInterval(() => {
    ensurePoolCoordinator()
      .then(() => {
        coordinatorMisses = 0;
      })
      .catch((e) => {
        coordinatorMisses += 1;
        progress.note(`coordinator heartbeat failed ${coordinatorMisses}/3: ${(e.message || e).split('\n')[0]}`);
        if (coordinatorMisses >= 3) {
          progress.dispose();
          process.stderr.write('POOL_FATAL coordinator heartbeat lost; exiting pool so supervisor can clean up\n');
          process.exit(2);
        }
      });
  }, 15_000);

  const onGameDone = async (r) => {
    await refreshScoreboard(progress);
    if (r.skipped) {
      process.stdout.write(`POOL_SKIP plies=${r.plies}\n`);
      return;
    }
    const dbPart = r.dbId != null ? ` db_id=${r.dbId}` : '';
    process.stdout.write(`POOL_DONE${dbPart} plies=${r.plies}\n`);
  };

  try {
    await Promise.all(Array.from({ length: slots }, (_, slot) => slotLoop(slot, gl, progress, onGameDone)));
  } finally {
    clearInterval(scoreboardTimer);
    clearInterval(coordinatorTimer);
  }
  progress.dispose();
  _activeProgress = null;
}

async function ensureCoordinator() {
  await ensurePoolCoordinator();
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--pool') {
    const slotsIdx = args.indexOf('--slots');
    const slots = slotsIdx >= 0 ? parseInt(args[slotsIdx + 1], 10) : 7;
    return runPool(Number.isFinite(slots) && slots > 0 ? slots : 7);
  }

  const configPath = args[0];
  if (!configPath) {
    process.stderr.write('usage: node site/overnight_batch.js --pool [--slots 7]\n');
    process.stderr.write('       node site/overnight_batch.js <batch.json>\n');
    process.exit(1);
  }

  await ensureCoordinator();

  preloadRemoteTiming();

  const config = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
  const pairings = config.pairings || [];
  if (!pairings.length) {
    process.stderr.write('batch config has no pairings\n');
    process.exit(1);
  }

  const gl = await import('./web/src/lib/gameLogic.js');
  const progress = new ProgressBoard({
    slots: pairings.length,
    title: `overnight batch #${config.batch_id || '?'}`,
  });

  const localN = pairings.filter((p) => p.kind === 'local').length;
  const log = (...args) => progress.note(args.join(' '));
  log(
    `${pairings.length} parallel matchups (ponder on, ${localN * 2} local titanium.exe + remote in own process)`,
  );

  const outcomes = await Promise.allSettled(
    pairings.map((p, slot) => runOne(p, slot, gl, progress)),
  );

  const results = [];
  const errors = [];
  for (let i = 0; i < outcomes.length; i++) {
    const o = outcomes[i];
    if (o.status === 'fulfilled') {
      results.push(o.value);
    } else {
      errors.push(`${shortLabel(pairings[i])}: ${o.reason?.message || o.reason}`);
    }
  }

  progress.dispose();
  for (const r of results) {
    process.stderr.write(`BATCH_DONE ${r.label} plies=${r.plies}\n`);
  }
  if (errors.length) {
    process.stderr.write(`BATCH_WARN ${errors.join('; ')}\n`);
  }
  if (results.length === 0) {
    throw new Error(errors.join('; ') || 'all matchups failed');
  }
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`overnight_batch FATAL: ${e.stack || e}\n`);
    process.exit(1);
  });
}
