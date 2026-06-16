#!/usr/bin/env node
/**
 * Isolated Ka/Ishtar game worker — own process so WebSocket I/O cannot block local games.
 * Ka is stateless search: parent harness (ishtar_match.js) makemoves every ply + replays on reconnect.
 * Progress events sent to parent via IPC.
 */
'use strict';

const path = require('path');
const remoteMatch = require('./ishtar_match');
const { isCompleteGame } = require('./game_validate');
const { releaseRemoteSlot } = require('./coordinator_client');

const BIN = path.resolve(__dirname, '../engine/target/release/titanium.exe');

function ipcProgress(slot) {
  const send = (msg) => {
    if (typeof process.send === 'function') process.send(msg);
  };
  return {
    setSlotLabel() {},
    start(s, gameIdx, maxPly, matchLabel = '') {
      send({ type: 'start', slot: s, maxPly, matchLabel });
    },
    ply(s, ply, maxPly) {
      send({ type: 'ply', slot: s, ply, maxPly });
    },
    thinking(s, side, budgetSec) {
      send({ type: 'think', slot: s, side, budgetSec });
    },
    reconnect(s, attempt) {
      send({ type: 'reconnect', slot: s, attempt });
    },
    finish(s, data) {
      send({ type: 'finish', slot: s, ...data });
    },
    idle(s) {
      send({ type: 'idle', slot: s });
    },
    note(msg) {
      send({ type: 'note', slot, msg: String(msg) });
    },
  };
}

let workerGameId = null;

async function main() {
  const payload = JSON.parse(process.argv[2]);
  const { pairing: p, slot } = payload;
  workerGameId = p.game_id;
  const label = `${p.engine_a} vs ${p.engine_b}@${p.tc_b}`;

  const opts = {
    engine: p.engine_a,
    opp: p.engine_b,
    oppTime: p.tc_b,
    fairTime: true,
    ponderTime: 0,
    ourTime: 10,
    maxPly: 300,
    bin: BIN,
    saveGames: null,
    sourceTag: p.source_tag,
  };

  const gl = await import('./web/src/lib/gameLogic.js');
  const progress = ipcProgress(slot);

  const prior = await remoteMatch.loadPriorMatchup(
    opts.engine, opts.opp, remoteMatch.ourTcLabel(opts), opts.oppTime,
  );
  let ourW = prior.ourW;
  let oppW = prior.oppW;

  const r = await remoteMatch.playGame(opts, gl, 0, true, slot, progress);

  if (!isCompleteGame(r)) {
    progress.finish(slot, { plies: r.plies, label: 'incomplete skip' });
    await releaseRemoteSlot(workerGameId).catch(() => {});
    process.send?.({ type: 'done', slot, label, plies: r.plies, ourW, oppW, skipped: true });
    return;
  }

  if (r.draw) {
    progress.finish(slot, { plies: r.plies, label: 'draw skipped' });
    await releaseRemoteSlot(workerGameId).catch(() => {});
    process.send?.({ type: 'done', slot, label, plies: r.plies, ourW, oppW });
    return;
  }
  if (r.ourWin) ourW += 1;
  else oppW += 1;

  const result = r.winner === 1 ? 'W' : 'B';
  const gameResp = await remoteMatch.persistGame(
    r.moves, result, opts.sourceTag, null, true, workerGameId,
  );
  await remoteMatch.updateMatchup(opts, ourW, oppW, () => {});

  process.send?.({
    type: 'done',
    slot,
    label,
    plies: r.plies,
    ourW,
    oppW,
    dbId: gameResp?.game_id ?? null,
  });
  process.exit(0);
}

main().catch(async (e) => {
  await releaseRemoteSlot(workerGameId).catch(() => {});
  const shortMsg = e.message || String(e);
  const fullMsg = e.stack || shortMsg;
  process.send?.({ type: 'error', error: shortMsg });  // one-liner for parent's progress bar
  process.stderr.write(`remote_game_worker FATAL: ${fullMsg}\n`);
  process.exit(1);
});
