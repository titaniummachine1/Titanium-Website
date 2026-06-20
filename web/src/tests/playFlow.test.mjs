/**
 * Ka play path: mock WebSocket + WASM legality oracle + session commit.
 * Run: node src/tests/playFlow.test.mjs
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { GameSession } from '../game/gameSession.js';
import {
  EngineClient,
  MockWebSocket,
  _mockSockets,
} from '../lib/engineClient.js';
import { requestEngineMove } from '../engines/requestEngineMove.js';
import { getEngineEntryForPlayer } from '../engines/engineRegistry.js';
import {
  PlayerType,
  StrengthLevel,
  TimeToMove,
  getEngineList,
} from '../lib/engineConfig.js';
import { TitaniumLegalityOracle } from '../lib/titaniumLegalityOracle.js';
import { createTitaniumLegalityRuntime } from '../lib/titaniumLegalityRuntime.node.js';
import { validateMoveLegality } from '../lib/validateMoveLegality.js';
import { toAlgebraic } from '../lib/gameLogic.js';
import { canonicalPositionKeyFromBoard } from '../lib/canonicalState.js';
import { wasmModulePath } from '../lib/titaniumLegalityRuntime.node.js';

const wasmAvailable = existsSync(wasmModulePath());

let passed = 0;
let failed = 0;

function ok(condition, message) {
  if (condition) {
    passed += 1;
  } else {
    failed += 1;
    console.error('  FAIL:', message);
  }
}

function assertEqual(actual, expected, label) {
  ok(actual === expected, `${label}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
}

function flush(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function kaConfig() {
  return getEngineList().find((entry) => entry.key === PlayerType.KaAI);
}

function kaAiSettings() {
  return {
    strengthLevel: StrengthLevel.Alpha,
    timeToMove: TimeToMove.Intuition,
  };
}

async function openKaClient() {
  _mockSockets.length = 0;
  const client = new EngineClient(kaConfig(), {
    webSocketFactory: (uri) => new MockWebSocket(uri),
  });
  client.connect();
  await flush(0);
  const ws = _mockSockets[0];
  ws.simulateOpen();
  await flush(10);
  return { client, ws };
}

console.log('\n[playFlow] legality oracle prewarm');
{
  const oracle = new TitaniumLegalityOracle({ createRuntime: createTitaniumLegalityRuntime });
  await oracle.ensureReady();
  const start = await oracle.legalMoves({ historyTokens: [], positionKey: 'start' });
  ok(start.status === 'available', `oracle available (wasm=${wasmAvailable})`);
  ok(start.moves.has('e2'), 'oracle accepts e2 at start');
}

console.log('\n[playFlow] Ka bestmove e2 passes legality gate and commits');
{
  const session = new GameSession();
  const oracle = new TitaniumLegalityOracle({ createRuntime: createTitaniumLegalityRuntime });
  await oracle.ensureReady();

  const { client, ws } = await openKaClient();
  const aiSettings = kaAiSettings();
  const engineEntry = getEngineEntryForPlayer(PlayerType.KaAI, aiSettings);
  const positionKey = canonicalPositionKeyFromBoard(session.board);

  let committed = null;
  client.onBestMove = (action) => {
    committed = action;
  };

  await requestEngineMove({
    engineEntry,
    controller: client,
    request: {
      history: session.actions,
      aiSettings,
      gameSnapshot: session.getEngineSnapshot(),
      isFreshGame: true,
      positionKey,
      requestSeq: 1,
      gameGeneration: 0,
      signal: undefined,
    },
  });

  ok(ws.sent.some((line) => line === 'go'), 'Ka received go');
  ws.simulateMessage('bestmove e2');
  await flush(20);

  ok(committed != null, 'Ka bestmove callback fired');
  const moveKey = toAlgebraic(committed);
  assertEqual(moveKey, 'e2', 'Ka suggested e2');

  const legal = session.getSnapshot().validActions.map((mv) => toAlgebraic(mv));
  const legality = await validateMoveLegality({
    move: moveKey,
    canonicalLegalMoves: legal,
    titaniumOracle: oracle,
    historyTokens: [],
    positionKey,
  });
  ok(legality.ok, `legality gate ok (${legality.reason ?? 'accepted'})`);

  session.applyAction(committed);
  assertEqual(session.actions.length, 1, 'session has one ply');
  assertEqual(toAlgebraic(session.actions[0]), 'e2', 'session records e2');
  assertEqual(session.playerToMove, 2, 'Black to move after e2');
}

console.log('\n[playFlow] after human e2 Ka replies e8');
{
  const session = new GameSession();
  const oracle = new TitaniumLegalityOracle({ createRuntime: createTitaniumLegalityRuntime });
  await oracle.ensureReady();

  const e2 = session.getSnapshot().validActions.find((mv) => toAlgebraic(mv) === 'e2');
  session.applyAction(e2);

  const { client, ws } = await openKaClient();
  const aiSettings = kaAiSettings();
  const engineEntry = getEngineEntryForPlayer(PlayerType.KaAI, aiSettings);
  const positionKey = canonicalPositionKeyFromBoard(session.board);

  let committed = null;
  client.onBestMove = (action) => {
    committed = action;
  };

  await client.echoCommittedMove(e2, positionKey, session.actions.length);
  await flush(10);

  await requestEngineMove({
    engineEntry,
    controller: client,
    request: {
      history: session.actions,
      aiSettings,
      gameSnapshot: session.getEngineSnapshot(),
      isFreshGame: false,
      positionKey,
      requestSeq: 2,
      gameGeneration: 0,
    },
  });

  ws.simulateMessage('bestmove e8');
  await flush(40);

  ok(committed != null, 'Ka black bestmove received');
  const moveKey = toAlgebraic(committed);
  assertEqual(moveKey, 'e8', 'Ka played e8');

  const legality = await validateMoveLegality({
    move: moveKey,
    canonicalLegalMoves: session.getSnapshot().validActions.map((mv) => toAlgebraic(mv)),
    titaniumOracle: oracle,
    historyTokens: session.actions.map((a) => toAlgebraic(a)),
    positionKey,
  });
  ok(legality.ok, `after e2 legality ok (${legality.reason ?? 'accepted'})`);

  session.applyAction(committed);
  assertEqual(session.actions.length, 2, 'two plies recorded');
}

console.log('\n════════════════════════════════');
console.log(`TOTAL: ${passed + failed} — passed ${passed}, failed ${failed}`);
if (failed > 0) {
  process.exit(1);
}
