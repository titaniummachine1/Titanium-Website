/**
 * Site logic tests — live best move, play-now guards, flip labels.
 * Run: node src/tests/siteLogic.test.mjs
 */

import {
  resolveLiveBestMoveKey,
  resolvePlayNowMoveKey,
  canPlayNow,
  pvFirstMoveFromLiveSearch,
} from "../lib/liveBestMove.js";
import {
  formatEngineScore,
  formatScoreForCard,
  ACE_MATE_VALUE,
  TITANIUM_MATE_VALUE,
  RACE_WIN_FLOOR,
  quoridorMovesFromMatePlies,
} from "../lib/engineScore.js";
import { canonicalPositionKeyFromActions } from "../lib/canonicalState.js";
import {
  screenRowLabel,
  screenColumnLabel,
  screenRowIndices,
  screenColIndices,
} from "../lib/screenTransform.js";
import { PlayerType } from "../lib/engineConfig.js";
import {
  encodeFinishedGameWire,
  finishedGamePayload,
  finishedGameSignature,
} from "../lib/trainingSubmit.js";
import {
  allocateWholeGameTime,
  chargeThinkMsForSeat,
  clockLogUsedMs,
  trimThinkLogToPly,
  resolveExpectedMovesLeft,
  WHOLE_GAME_PLAN_MOVES,
  supportsWholeGameTime,
  hasSeatClock,
  defaultPlayerAiSettings,
} from "../lib/timeControl.js";
import { formatGameEndHeadline } from "../lib/gameEndMessage.js";
import {
  conservativeDistanceToWin,
  estimateConservativeGameDistance,
  minimumRemainingPliesFromPv,
  pvTokensFromDepthLog,
  raceDistanceAtPvLeaf,
} from "../lib/gameDistance.js";
import { getAllEngineConfigs } from "../lib/playerRegistry.js";

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) passed++;
  else {
    failed++;
    console.error("  FAIL:", message);
  }
}

function assertEqual(a, b, message) {
  assert(
    a === b,
    `${message}: expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`,
  );
}

console.log("\n[liveBestMove] PV extraction");
assertEqual(
  pvFirstMoveFromLiveSearch({ pv: "e3 e4 d3", depthLog: [] }),
  "e3",
  "string pv first token",
);
assertEqual(
  pvFirstMoveFromLiveSearch({ depthLog: [{ depth: 4, pv: "g3 g4" }] }),
  "g3",
  "depthLog pv first token",
);
assertEqual(
  pvFirstMoveFromLiveSearch({ rootMoves: [{ move: "f5" }] }),
  "f5",
  "rootMoves fallback",
);

assertEqual(
  pvFirstMoveFromLiveSearch(
    { depthLog: [{ depth: 4, pv: "e3 e4" }] },
    {
      validKeySet: new Set(["e3", "d3h"]),
      rootMoves: [
        { move: "d3h", score: 120 },
        { move: "e3", score: 80 },
      ],
    },
  ),
  "d3h",
  "rootMoves wall beats depthLog pawn pv",
);

assertEqual(
  pvFirstMoveFromLiveSearch(
    {
      depthLog: [{ depth: 6, pv: "d3h" }],
      rootMoves: [{ move: "e3", score: 999 }],
    },
    { validKeySet: new Set(["e3", "d3h"]) },
  ),
  "d3h",
  "single-move depth pv beats stale pawn rootMoves",
);

assertEqual(
  pvFirstMoveFromLiveSearch(
    { rootMove: "f5h", depthLog: [{ depth: 4, pv: "e3" }] },
    { validKeySet: new Set(["e3", "f5h"]) },
  ),
  "f5h",
  "explicit rootMove field wins",
);

assertEqual(
  pvFirstMoveFromLiveSearch(
    { depthLog: [{ depth: 4, pv: "z9 z8" }] },
    {
      validKeySet: new Set(["e3", "d3h"]),
      rootMoves: [
        { move: "z9", score: 999 },
        { move: "d3h", score: 50 },
      ],
    },
  ),
  "d3h",
  "skip illegal top root move and take next legal wall",
);

assertEqual(
  pvFirstMoveFromLiveSearch({ depthLog: [{ depth: 4, pv: "pv f3h e2" }] }),
  "f3h",
  "depthLog strips pv prefix",
);

console.log("\n[liveBestMove] identity checks");
const baseState = {
  aiThinking: true,
  winner: null,
  isDraw: false,
  thinkingSeatIndex: 0,
  playerToMove: 1,
  settings: { players: [PlayerType.TitaniumV16, PlayerType.Human] },
  actions: [],
  validActions: [{ coordinate: { column: "e", row: 3 } }],
  searchGeneration: 7,
  liveSearch: {
    seatIndex: 0,
    playerType: PlayerType.TitaniumV16,
    requestSeq: 7,
    positionKey: canonicalPositionKeyFromActions([]),
    pv: "e3",
  },
};

assertEqual(resolveLiveBestMoveKey(baseState), "e3", "valid live pv");
assertEqual(
  resolveLiveBestMoveKey({
    ...baseState,
    liveSearch: { ...baseState.liveSearch, requestSeq: 6 },
  }),
  null,
  "stale generation rejected",
);
assertEqual(
  resolveLiveBestMoveKey({
    ...baseState,
    liveSearch: { ...baseState.liveSearch, pv: "z9" },
  }),
  null,
  "illegal pv rejected",
);
assert(canPlayNow(baseState), "canPlayNow when live pv legal");

console.log("\n[liveBestMove] resolvePlayNowMoveKey is less strict");
assertEqual(
  resolvePlayNowMoveKey({
    ...baseState,
    liveSearch: { ...baseState.liveSearch, requestSeq: 6 },
  }),
  "e3",
  "play-now accepts mismatched requestSeq",
);
assertEqual(
  resolveLiveBestMoveKey({
    ...baseState,
    liveSearch: { ...baseState.liveSearch, requestSeq: 6 },
  }),
  null,
  "highlight still rejects stale generation",
);
assertEqual(
  resolvePlayNowMoveKey({
    ...baseState,
    liveSearch: null,
    searchInfoBySeat: {
      0: { seatIndex: 0, rootMove: "e3", rootMoves: [{ move: "e3", score: 10 }] },
    },
    activeSearchInfo: {
      seatIndex: 0,
      rootMove: "e3",
      rootMoves: [{ move: "e3", score: 10 }],
    },
  }),
  "e3",
  "play-now uses searchInfoBySeat when liveSearch empty",
);
assertEqual(
  resolvePlayNowMoveKey({
    aiThinking: true,
    thinkingSeatIndex: 0,
    winner: null,
    isDraw: false,
    settings: baseState.settings,
    actions: [],
    validActions: baseState.validActions,
    liveSearch: null,
  }),
  null,
  "play-now null when no telemetry yet",
);

console.log("\n[mate] Quoridor moves from engine plies (AceV13 parity)");
assertEqual(quoridorMovesFromMatePlies(1), 1, "mate in 1 ply = 1 move");
assertEqual(quoridorMovesFromMatePlies(2), 2, "mate in 2 plies = 2 moves");
assertEqual(quoridorMovesFromMatePlies(4), 4, "mate in 4 plies = 4 moves");
assertEqual(
  formatScoreForCard(ACE_MATE_VALUE - 4),
  "Win in 4",
  "true mate score (MATE-4 plies) shows Win in 4",
);
assertEqual(
  formatScoreForCard(ACE_MATE_VALUE - 1),
  "Win in 1",
  "mate in 1 ply displays Win in 1",
);
assertEqual(
  formatScoreForCard(TITANIUM_MATE_VALUE - 5),
  "Win in 5",
  "titanium mate win (MATE-5 plies) shows Win in 5",
);
assertEqual(
  formatScoreForCard(-(32_000 - 10)),
  "Lose in 10",
  "race-proof loss shows Lose in N",
);
assertEqual(
  formatEngineScore(31_975),
  "+M25",
  "race-proof win 31975 shows +M25",
);

console.log("\n[legality] user midgame line replays legally");
import { QuoridorBoard, parseAlgebraic } from "../lib/gameLogic.js";
import { GameSession } from "../game/gameSession.js";
const userLine =
  "e2 e8 e3 e7 e4 e6 d3h e6h f3h c6h h3h e4v b3h d6 a4v a6h c5v g6h e5 d5 e6 d4 f6 h5v a2h c4 f5 b4 g5 b5 c2h b6 h5 g4h g5 a6 f5 a5 f4 a4 g4 a3 h4".split(
    /\s+/,
  );
const midBoard = new QuoridorBoard();
for (const token of userLine) {
  const action = parseAlgebraic(token);
  assert(midBoard.isValid(action), `user line legal at ${token}`);
  midBoard.takeAction(action);
}
assertEqual(
  midBoard.validActions().length,
  78,
  "user midgame legal move count",
);

console.log("\n[legality] 62-ply line ends with Black win on g1");
const winLine =
  "e2 e8 e3 e7 e4 e6 d3h e6h f3h c6h h3h e4v b3h d6 a4v a6h c5v g6h e5 d5 e6 d4 f6 h5v a2h c4 f5 b4 g4h h7h f4 b5 g4 f7h h4 b6 i4 a6 i5 a5 i6 a4 i7 a3 h7 b3 c2h c3 g7 d3 e2h e3 f7 d7h e7 f3 d7 g3 c7 g2 c8 g1".split(
    /\s+/,
  );
const winSession = new GameSession();
for (const token of winLine) {
  assert(
    winSession.applyAction(parseAlgebraic(token)),
    `62-ply applies ${token}`,
  );
}
assertEqual(winSession.winner, 2, "Black wins on g1");
assertEqual(
  winSession.getSnapshot().validActions.length,
  0,
  "no legal moves after win",
);

console.log("\n[clock] time forfeit ends the game");
const clockSession = new GameSession();
assert(clockSession.forfeitOnTime(1), "white flag awards black the win");
assertEqual(clockSession.winner, 2, "opponent wins on time");
assertEqual(clockSession.endReason, "time", "time forfeit records end reason");
assertEqual(
  clockSession.getSnapshot().validActions.length,
  0,
  "terminal after flag",
);
assert(clockSession.clearTimeForfeit(), "settings can clear a time-only result");
assertEqual(clockSession.winner, null, "clearing time forfeit resumes current board");
assertEqual(clockSession.endReason, null, "clearing time forfeit clears reason");
assertEqual(
  clockSession.getSnapshot().validActions.length > 0,
  true,
  "moves are legal again after replacing the clock",
);

console.log("\n[clock] undo returns completed move time");
const clockLog = [
  { ply: 1, thinkMs: 1200 },
  { ply: 2, thinkMs: 900 },
  { ply: 3, thinkMs: 700 },
];
const trimmedClockLog = trimThinkLogToPly(clockLog, 1);
assertEqual(trimmedClockLog.length, 1, "undo removes later clock entries");
assertEqual(clockLogUsedMs(trimmedClockLog, 0), 1200, "white gets ply 3 time back");
assertEqual(clockLogUsedMs(trimmedClockLog, 1), 0, "black gets ply 2 time back");

console.log("\n[training] finished game payload");
const trainingPayload = finishedGamePayload({
  actions: winLine.map(parseAlgebraic),
  winner: 2,
  players: [PlayerType.Human, PlayerType.TitaniumV16],
  playerAiSettings: [null, { threads: 2 }],
  engineLabels: ["Human", "Titanium v16 live"],
});
assertEqual(trainingPayload.result, -1, "black win maps to result -1");
assertEqual(trainingPayload.winner, "black", "black win text");
assertEqual(trainingPayload.moves.at(-1), "g1", "moves are algebraic");
assert(
  finishedGameSignature(trainingPayload).startsWith("-1|e2 e8"),
  "signature includes result and line",
);
const trainingWire = encodeFinishedGameWire(trainingPayload);
assert(
  trainingWire.startsWith("TI-GAME-1\n"),
  "wire uses text protocol header",
);
assert(trainingWire.includes("result=-1\n"), "wire includes numeric verdict");
assert(
  trainingWire.includes(`moves=${winLine.join(" ")}\n`),
  "wire includes move list",
);
assert(!trainingWire.includes("{"), "wire is not JSON");

console.log("\n[liveBestMove] last committed move not highlighted");
assertEqual(
  resolveLiveBestMoveKey({
    ...baseState,
    actions: [{ coordinate: { column: "e", row: 2 } }],
    liveSearch: null,
  }),
  null,
  "no highlight without live search",
);

console.log("\n[screenTransform] flip label order");
assertEqual(screenRowLabel(0, 9, false), "9", "normal top row label");
assertEqual(screenRowLabel(0, 9, true), "1", "flipped top row label");
assertEqual(screenColumnLabel(0, false), "a", "normal left col");
assertEqual(screenColumnLabel(0, true), "i", "flipped left col");

const normalRows = screenRowIndices(9, false);
const flippedRows = screenRowIndices(9, true);
assertEqual(normalRows[0], 0, "normal starts at p=0");
assertEqual(flippedRows[0], 16, "flipped starts at bottom screen row");
assertEqual(screenColIndices(9, true)[0], 16, "flipped reverses columns");

console.log("\n[searchNodes] Lazy SMP totals");
import { resolveDisplayNodes, enrichNodeFields } from "../lib/searchNodes.js";
assertEqual(
  resolveDisplayNodes({
    nodes: 67397,
    totalNodes: 284214,
    mainThreadNodes: 67397,
    helperNodes: [65581, 75857, 75379],
  }),
  284214,
  "prefers totalNodes over main-thread nodes",
);
assertEqual(
  resolveDisplayNodes({
    nodes: 67397,
    mainThreadNodes: 67397,
    helperNodes: [65581, 75857, 75379],
  }),
  284214,
  "sums main + helpers when totalNodes missing",
);
assertEqual(
  enrichNodeFields({
    nodes: 67397,
    totalNodes: 284214,
    mainThreadNodes: 67397,
    helperNodes: [65581, 75857, 75379],
  }).nodes,
  284214,
  "enrichNodeFields exposes aggregate nodes",
);

console.log("\n[timeControl] whole-game clock allocation");
assertEqual(WHOLE_GAME_PLAN_MOVES, 30, "baseline plan is 30 own moves");
assertEqual(
  resolveExpectedMovesLeft({ ownMovesPlayed: 0, distanceToWin: 8 }),
  30,
  "opening uses 30-move baseline when race distance is shorter",
);
assertEqual(
  resolveExpectedMovesLeft({ ownMovesPlayed: 20, distanceToWin: 8 }),
  10,
  "midgame tail is 30 minus plies played",
);
assertEqual(
  resolveExpectedMovesLeft({ ownMovesPlayed: 25, distanceToWin: 14 }),
  14,
  "race distance raises horizon above depleted plan tail",
);
const openingClock = allocateWholeGameTime({
  totalMs: 600_000,
  usedMs: 0,
  ownMovesPlayed: 0,
  distanceToWin: 8,
});
assert(
  openingClock.moveBudgetMs < 34_000,
  "10-minute opening budget keeps handoff reserve",
);
assertEqual(
  openingClock.expectedMovesLeft,
  30,
  "opening spreads over 30 moves",
);
const minuteClock = allocateWholeGameTime({
  totalMs: 60_000,
  usedMs: 0,
  ownMovesPlayed: 0,
  distanceToWin: 8,
});
assertEqual(
  minuteClock.expectedMovesLeft,
  30,
  "1-minute games also plan 30 moves",
);
assert(
  minuteClock.moveBudgetMs < 2_700,
  "1-minute opening move budget stays modest at 30-move spread",
);

const lowClock = allocateWholeGameTime({
  totalMs: 600_000,
  usedMs: 590_000,
  ownMovesPlayed: 22,
  distanceToWin: 6,
});
assertEqual(
  lowClock.expectedMovesLeft,
  8,
  "low clock still spreads over planned tail moves",
);
assert(
  lowClock.moveBudgetMs < 1_000,
  "last ten seconds spends under one second per move",
);
assert(lowClock.handoffReserveMs >= 50, "worker handoff always has a reserve");

assertEqual(
  chargeThinkMsForSeat({
    wallThinkMs: 8000,
    moveBudgetMs: 1500,
    handoffMs: 50,
    usesWholeGameClock: true,
  }),
  8000,
  "whole-game bank deducts full wall time, not move budget",
);
assertEqual(
  chargeThinkMsForSeat({
    wallThinkMs: 8000,
    moveBudgetMs: 1500,
    handoffMs: 50,
    usesWholeGameClock: false,
  }),
  1550,
  "per-move mode still caps charge to budget plus handoff",
);

const flaggedClock = allocateWholeGameTime({
  totalMs: 600_000,
  usedMs: 600_000,
  ownMovesPlayed: 22,
});
assertEqual(
  flaggedClock.moveBudgetMs,
  0,
  "expired clock allocates no search time",
);
assert(
  supportsWholeGameTime(PlayerType.TitaniumV17, getAllEngineConfigs()),
  "Titanium supports whole-game allocation",
);
assert(
  supportsWholeGameTime(PlayerType.AceV13, getAllEngineConfigs()),
  "ACE v13 supports whole-game allocation",
);

console.log("\n[clock] remote engines are not on whole-game clock");
const engineConfigs = getAllEngineConfigs();
const kaSettings = defaultPlayerAiSettings(PlayerType.KaAI, engineConfigs);
const zeroInkSettings = defaultPlayerAiSettings(
  PlayerType.ZeroInk,
  engineConfigs,
);
assert(
  !hasSeatClock(PlayerType.KaAI, engineConfigs, kaSettings),
  "Ka has no seat clock",
);
assert(
  !hasSeatClock(PlayerType.ZeroInk, engineConfigs, zeroInkSettings),
  "zero.ink has no seat clock",
);
assert(
  !supportsWholeGameTime(PlayerType.KaAI, engineConfigs),
  "Ka does not use whole-game time",
);
assert(
  supportsWholeGameTime(PlayerType.GorisansonMCTS, engineConfigs),
  "Gorisanson uses whole-game time via MCTS main line",
);

console.log("\n[gameEnd] descriptive headlines");
assertEqual(
  formatGameEndHeadline({ winner: 1, endReason: "time" }),
  "White wins on time",
  "time win headline",
);
assertEqual(
  formatGameEndHeadline({
    gameHalted: true,
    engineErrors: { 1: "worker crashed" },
  }),
  "Game halted — Black engine error",
  "engine halt headline",
);

console.log("\n[gameDistance] conservative race distance for clock");
const openingBoard = new QuoridorBoard();
assertEqual(
  conservativeDistanceToWin(openingBoard),
  8,
  "opening race distance is min(white, black) = 8",
);
for (const token of ["e2", "e8", "e3", "e7"]) {
  openingBoard.takeAction(parseAlgebraic(token));
}
assertEqual(
  conservativeDistanceToWin(openingBoard),
  6,
  "trunk shortens both races to 6",
);
const depthLog = [
  {
    depth: 12,
    pv: "e4 e6 e5",
    score: 120,
  },
];
assertEqual(
  pvTokensFromDepthLog(depthLog).join(" "),
  "e4 e6 e5",
  "depth-log PV tokens strip leading pv label",
);
const withPv = estimateConservativeGameDistance({
  board: openingBoard,
  actions: ["e2", "e8", "e3", "e7"],
  depthLog,
});
const pvFloor = minimumRemainingPliesFromPv(["e2", "e8", "e3", "e7"], depthLog);
assertEqual(withPv, pvFloor, "PV floor is main-line plies plus leaf min race");
const leafRace = raceDistanceAtPvLeaf(["e2", "e8", "e3", "e7"], depthLog);
assertEqual(pvFloor, 3 + leafRace, "PV floor is pv length plus leaf min race");
assertEqual(
  minimumRemainingPliesFromPv(
    ["e2", "e8", "e3", "e7"],
    [{ depth: 1, pv: "z9 z8" }],
  ),
  null,
  "illegal PV replay yields no floor",
);
assertEqual(
  15 + 3,
  18,
  "example: 15 pv plies + leaf race 3 => 18 minimum plies",
);
const withEngine = estimateConservativeGameDistance({
  board: openingBoard,
  actions: ["e2", "e8", "e3", "e7"],
  whiteDist: 4,
  blackDist: 9,
});
assertEqual(withEngine, 4, "engine refresh_dist min race is used");
const conservativeHorizon = resolveExpectedMovesLeft({
  ownMovesPlayed: 28,
  distanceToWin: withEngine,
});
assertEqual(
  conservativeHorizon,
  4,
  "shorter race distance raises horizon above depleted plan tail",
);

console.log("\n[notation] wallz prefix walls and move-history paste");
import {
  tokenizeAlgebraicNotation,
  decodeReplayCode,
  normalizeReplayToken,
} from "../lib/replayCode.js";
import { toAlgebraic } from "../lib/gameLogic.js";

assertEqual(
  tokenizeAlgebraicNotation("e2 ve4 e8").join(" "),
  "e2 e4v e8",
  "ve4 prefix wall tokenizes to e4v",
);
assertEqual(
  tokenizeAlgebraicNotation("e2 v e4 e8").join(" "),
  "e2 e4v e8",
  "split v e4 wall",
);
assertEqual(
  tokenizeAlgebraicNotation("1. e2 e8\n2. e3 hd3").join(" "),
  "e2 e8 e3 d3h",
  "numbered wallz lines",
);
assertEqual(
  toAlgebraic(parseAlgebraic(normalizeReplayToken("ve4"))),
  "e4v",
  "wallz prefix normalizes before parseAlgebraic",
);
assertEqual(
  toAlgebraic(parseAlgebraic(normalizeReplayToken("hd3"))),
  "d3h",
  "wallz prefix normalizes before parseAlgebraic",
);
const decoded = decodeReplayCode("e2 ve4 hd3 e8");
assertEqual(decoded.algebraic.join(" "), "e2 e4v d3h e8", "decodeReplayCode normalizes walls");

console.log("\n[copy-logs] crash reason in bug report");
import { formatLogsText } from "../ui/gameControls.js";
import {
  formatEngineFailureMessage,
  formatEngineStatusBlock,
  engineFailureBackoffMs,
} from "../lib/engineFailureReport.js";
const crashErr = new Error("WASM runtime error (engine panic) | commit=dd4a94d");
crashErr.diagnostics = {
  panic: "index out of bounds: the len is 9 but the index is 12",
  buildMeta: { git_commit: "dd4a94d", wasm_sha256: "c2e2f05de166e66d" },
};
const crashMsg = formatEngineFailureMessage(crashErr);
assert(
  crashMsg.includes('panic="index out of bounds'),
  "failure formatter keeps Rust panic",
);
const logsText = formatLogsText({
  board: new QuoridorBoard(),
  actions: [],
  settings: {
    players: ["titanium-v17", "titanium-v16"],
    rotateBoard: false,
  },
  gameHalted: true,
  engineErrors: {
    0: crashMsg,
  },
  engineStatus: { 0: "error", 1: "idle" },
  moveThinkLog: [
    {
      ply: 7,
      engine: "Titanium v17",
      error: crashMsg,
      stoppedBy: "error",
    },
  ],
  lastCompletedThinkBySeat: [null, null],
});
assert(logsText.includes("GAME HALTED"), "copy-logs shows halt banner");
assert(logsText.includes("index out of bounds"), "copy-logs includes panic text");
assert(logsText.includes("=== WASM build ==="), "copy-logs includes wasm build block");
assert(
  formatEngineStatusBlock({
    gameHalted: true,
    engineErrors: { 1: "worker died" },
    settings: { players: ["human", "titanium-v16"] },
    engineStatus: { 1: "error" },
  }).some((line) => line.includes("worker died")),
  "status block surfaces seat error",
);

assertEqual(engineFailureBackoffMs(1), 250, "retry backoff attempt 1");
assertEqual(engineFailureBackoffMs(3), 1000, "retry backoff attempt 3");
assertEqual(engineFailureBackoffMs(10), 30_000, "retry backoff capped at 30s");

console.log("\n[eval] placeholder rootScore must not mask depth score");
import {
  resolveDisplayScore,
  mergeThinkSnapshots,
  hasCompletedSearchIteration,
  retainedEvalForPosition,
} from "../lib/searchTelemetry.js";

assertEqual(
  resolveDisplayScore({
    rootScore: 0,
    depthLog: [{ depth: 10, score: 524, nodes: 1000, pv: "g3h" }],
  }),
  524,
  "depth log beats bootstrap rootScore 0",
);
const merged = mergeThinkSnapshots(
  {
    depthLog: [{ depth: 10, score: 524, nodes: 50000, pv: "g3h" }],
    rootScore: 524,
    score: 524,
    nodes: 50000,
  },
  {
    rootScore: 0,
    depthLog: [],
    nodes: 0,
  },
);
assertEqual(merged.rootScore, 524, "incoming bootstrap 0 does not erase prior eval");
assertEqual(
  resolveDisplayScore({ rootScore: 0, depth: 0 }),
  null,
  "bootstrap zero is unavailable before completed depth",
);
assertEqual(
  formatEngineScore(resolveDisplayScore({ rootScore: 0, depth: 0 }), { unavailable: true }),
  "…",
  "unavailable eval uses ellipsis",
);
assertEqual(
  resolveDisplayScore({ rootScore: 0, depth: 1 }),
  0,
  "zero after completed depth is genuine",
);
assertEqual(formatEngineScore(0), "0.00", "genuine zero formats as 0.00");
assertEqual(
  formatScoreForCard(RACE_WIN_FLOOR, { rootScoreText: "proven race win" }),
  "Proven win",
  "semantic proven race win uses card label",
);
assertEqual(
  formatScoreForCard(-RACE_WIN_FLOOR, { rootScoreText: "proven race loss" }),
  "Proven loss",
  "semantic proven race loss uses card label",
);
assertEqual(formatScoreForCard(RACE_WIN_FLOOR), "Proven win", "bound fallback is proven win");
assertEqual(formatScoreForCard(-RACE_WIN_FLOOR), "Proven loss", "bound fallback is proven loss");
assertEqual(formatScoreForCard(32_000 - 25), "Win in 25", "exact race DTM remains intact");
assertEqual(formatEngineScore(125), "+1.25", "ordinary cp remains intact");
assertEqual(
  mergeThinkSnapshots(
    { depthLog: [{ depth: 4, score: 700 }], rootScore: 700, score: 700 },
    { rootScore: 0, depth: 0, cancelled: true },
  ).rootScore,
  700,
  "cancelled pre-depth snapshot retains prior eval",
);
assertEqual(
  retainedEvalForPosition({
    positionKey: "new",
    previousKey: "old",
    previousScore: 700,
    incoming: { rootScore: 0, depth: 0 },
  }),
  null,
  "position change clears retained eval",
);
assert(
  hasCompletedSearchIteration({ depthLog: [{ depth: 1, score: 0 }] }),
  "depth log records completed zero iteration",
);

console.log("\n════════════════════════════════");
console.log(
  `TOTAL: ${passed + failed} tests — passed ${passed}, failed ${failed}`,
);
if (failed > 0) process.exit(1);
