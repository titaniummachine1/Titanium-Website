import { Direction, WallType, formatCoordinate, transformCoordinate } from './gameLogic.js';

/**
 * Scraped from quoridor-ai.netlify.app (index-xQ3tC4A2.js)
 * Engine configuration, enums, position serialization, and info-line parsing.
 *
 * Original minified names restored for readability:
 *   ai  → StrengthLevel
 *   We  → TimeToMove
 *   rt  → PlayerType
 *   Ai  → Notation
 *   f7  → getEngineList
 *   _7  → buildPositionString
 *   k7  → parseInfoLine
 *   Qe  → EngineStatus
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/** UI strength preset (mostly legacy; Alpha unlocks full engine power). */
const StrengthLevel = {
  Beginner: 0,
  Intermediate: 1,
  Advanced: 2,
  Expert: 3,
  Alpha: 4,
};

/** How long the AI is allowed to think. Maps to visit counts per engine. */
const TimeToMove = {
  Intuition: 0,
  Short: 1,
  Medium: 2,
  Long: 3,
};

/** Who controls each player slot. */
const PlayerType = {
  Human: 'human',
  GorisansonMCTS: 'gorisanson-mcts',
  QuoridorV3: 'quoridor-v3',
  /** Titanium v16 — CAT LMR; embedded pawn LUT (larger wasm, instant cold start). */
  TitaniumV16: 'titanium-v16',
  /** @deprecated remapped to TitaniumV18 — kept for saved games / URLs */
  TitaniumV17: 'titanium-v17',
  /** Titanium v18 — current production (v17 search + latest accepted NNUE weights). */
  TitaniumV18: 'titanium-v18',
  /** Unified ACE v10 — strength slider picks JS / Rust / MoveGen+ / PMC tier */
  AceV10: 'ace-v10',
  /** Unified ACE v13 — strength slider picks JS / Rust / MoveGen+ (no EME) */
  AceV13: 'ace-v13',
  /** @deprecated legacy keys — remapped to AceV13 in normalizePlayerType() */
  AceV7: 'ace-v7',
  AceV7Ti: 'ace-v7-ti',
  AceV8: 'ace-v8',
  AceV8Ti: 'ace-v8-ti',
  AceV8TiPmc: 'ace-v8-ti-pmc',
  AceV8Js: 'ace-v8-js',
  Pavlosdais: 'pavlosdais',
  IshtarV3: 'ishtar-v3-ai',
  IshtarPonder: 'ishtar-ponder',
  KaAI: 'ka-ai',
  /** quoridor-zero.ink AlphaZero bot over REST (CORS-enabled; works on static Pages). */
  ZeroInk: 'zero-ink',
};

/** Coordinate system sent to the remote engine. */
const Notation = {
  Official: 'official', // Ka engine
  Glendenning: 'glendenning', // Ishtar engine (row flipped)
};

const EngineStatus = {
  Idle: 'idle',
  Connecting: 'connecting',
  Pondering: 'pondering',
  Error: 'error',
  Searching: 'searching',
};

// ---------------------------------------------------------------------------
// Engine definitions (remote WebSocket endpoints)
// ---------------------------------------------------------------------------

function getEngineList() {
  return [
    {
      name: 'Ishtar',
      key: PlayerType.IshtarV3,
      tooltip: 'AI developed by Ishtar',
      uri: 'wss://quoridor-ai.com/ishtar-v3',
      visits: {
        [TimeToMove.Intuition]: 2,
        [TimeToMove.Short]: 3200,
        [TimeToMove.Medium]: 200_000,
        [TimeToMove.Long]: 1_000_000,
      },
      notation: Notation.Glendenning,
      settings: {
        display: 'false',
        alternative_action_threshold: '0.1',
        parallelism: {
          [TimeToMove.Intuition]: '1',
          [TimeToMove.Short]: '32',
          [TimeToMove.Medium]: '1024',
          [TimeToMove.Long]: '2048',
        },
      },
    },
    {
      name: 'Ka',
      key: PlayerType.KaAI,
      tooltip: 'AI developed by Ka',
      uri: 'wss://quoridor-ai.com/ka',
      visits: {
        [TimeToMove.Intuition]: 2,
        [TimeToMove.Short]: 3200,
        [TimeToMove.Medium]: 5000,
        [TimeToMove.Long]: 1_000_000,
      },
      notation: Notation.Official,
    },
  ];
}

/** Analysis-only ponder engine (same server, different options). */
const ishtarPonderEngine = {
  name: 'Ishtar Ponder',
  key: PlayerType.IshtarPonder,
  tooltip: 'AI developed by Ishtar',
  uri: 'wss://quoridor-ai.com/ishtar-v3',
  displayEval: true,
  visits: {
    [TimeToMove.Intuition]: 0,
    [TimeToMove.Short]: 0,
    [TimeToMove.Medium]: 0,
    [TimeToMove.Long]: 0,
  },
  notation: Notation.Glendenning,
  settings: {
    display: 'false',
    multipv: '10',
    parallelism: '4096',
  },
};

// ---------------------------------------------------------------------------
// Wire protocol helpers
// ---------------------------------------------------------------------------

const AUTH_TOKEN = 'rbt_token_*';
const INFO_LINE_RE = /^info (.*)/;
const BESTMOVE_LINE_RE = /^bestmove (.*)/;

/**
 * Serialize game state for `setposition` command.
 *
 * Format: `{hWalls} / {vWalls} / {pawns} / {wallsLeft} / {playerToMove}`
 * Example: `d2h /  / e2 e10 / 10 10 / 1`
 */
function buildPositionString(game, notation) {
  const flipIfGlendenning = (coordinate) =>
    notation === Notation.Glendenning
      ? transformCoordinate(coordinate, [Direction.Up])
      : coordinate;

  const formatWalls = (wallType) =>
    game.currentState.wallsByPlayer
      .filter(([, , type]) => type === wallType)
      .map(([, coordinate]) => formatCoordinate(flipIfGlendenning(coordinate)))
      .join('');

  const horizontal = formatWalls(WallType.Horizontal);
  const vertical = formatWalls(WallType.Vertical);
  const pawns = game.currentState.playerPositions
    .map((coordinate) => formatCoordinate(flipIfGlendenning(coordinate)))
    .join(' ');
  const wallsRemaining = game.currentState.wallsRemaining.join(' ');
  const playerToMove = game.currentState.playerToMove;

  return `${horizontal} / ${vertical} / ${pawns} / ${wallsRemaining} / ${playerToMove}`;
}

/** Parse `info multipv 1 score 0.995 visits 1 pv e2 e3` into an object. */
function parseInfoLine(line) {
  const tokens = line.split(' ');
  const result = {};

  const parsers = {
    depth: readNumberField,
    movesleft: readNumberField,
    multipv: readNumberField,
    playertomove: readNumberField,
    score: readNumberField,
    time: readNumberField,
    visits: readNumberField,
    visitspct: readNumberField,
    pv: readRestOfLine,
  };

  for (let index = 0; index < tokens.length; index++) {
    const parser = parsers[tokens[index]];
    if (parser) {
      index += parser(tokens, index + 1, result);
    }
  }

  return result;
}

function readNumberField(tokens, index, result) {
  result[tokens[index - 1]] = Number(tokens[index]);
  return 1;
}

function readRestOfLine(tokens, index, result) {
  result[tokens[index - 1]] = tokens.slice(index).join(' ');
  return tokens.length - index;
}

export {
  StrengthLevel,
  TimeToMove,
  PlayerType,
  Notation,
  EngineStatus,
  getEngineList,
  ishtarPonderEngine,
  AUTH_TOKEN,
  INFO_LINE_RE,
  BESTMOVE_LINE_RE,
  buildPositionString,
  parseInfoLine,
};
