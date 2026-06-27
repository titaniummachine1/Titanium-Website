/**
 * Replay user-supplied history; compare official vs Glendenning wire encoding.
 * Run: node site/web/_replay_history.mjs
 */
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scrapedRoot = path.resolve(__dirname, '../scraped');

const {
  QuoridorBoard,
  parseAlgebraic,
  toAlgebraic,
  Direction,
  transformCoordinate,
} = await import(pathToFileURL(path.join(scrapedRoot, 'game_logic_extract.js')).href);

const {
  Notation,
} = await import(pathToFileURL(path.join(scrapedRoot, 'engine_config_extract.js')).href);

function toEngineAlgebraic(action, notation) {
  let normalized = action;
  if ('wallType' in action && notation === Notation.Glendenning) {
    normalized = {
      ...action,
      coordinate: transformCoordinate(action.coordinate, [Direction.Up]),
    };
  }
  return toAlgebraic(normalized);
}

const HISTORY = `e2 e8 e3 e7 e4 e6 d3h c6h f3h e4v d5v a6h h3h e6h b3h g6h c4v f5v a1h h8h a4v h5v g5h b4h e5 e4 e6 f8h e5 d4 e4 d5 d4 d6 d5 c6 d6 b6 d5 a6 d4 a5 e4 a4 e5 a3 e6 a2 f6 b2`.split(/\s+/);

const board = new QuoridorBoard();
let ply = 0;

console.log('Start:', {
  pawns: board._playerPositions.map((c) => toAlgebraic({ coordinate: c })),
  stm: board.playerToMove(),
  walls: board._wallsRemaining,
});

for (const token of HISTORY) {
  ply += 1;
  const action = parseAlgebraic(token);
  const valid = board.isValid(action);
  if (!valid) {
    console.error('\n*** FIRST DIVERGENCE: illegal move ***');
    console.error({ ply, token, stm: board.playerToMove() });
    console.error('pawns:', board._playerPositions.map((c) => toAlgebraic({ coordinate: c })));
    console.error('hWalls:', [...board._horizontalWalls]);
    console.error('vWalls:', [...board._verticalWalls]);
    console.error('wallsRemaining:', board._wallsRemaining);
    process.exit(1);
  }

  const kaWire = toEngineAlgebraic(action, Notation.Official);
  const ishtarWire = toEngineAlgebraic(action, Notation.Glendenning);

  board.takeAction(action);

  if (ply <= 5 || ply % 10 === 0 || ply === HISTORY.length) {
    const snap = {
      currentState: {
        playerToMove: board.playerToMove(),
        playerPositions: board._playerPositions.map((c) => ({ ...c })),
        wallsRemaining: [...board._wallsRemaining],
        wallsByPlayer: [],
      },
    };
    // rebuild wallsByPlayer naive from sets — not tracked in scraped board alone
    console.log(`ply ${ply} ${token} -> Ka:${kaWire} Ishtar:${ishtarWire} stm:${board.playerToMove()} pawns:${board._playerPositions.map((c) => toAlgebraic({ coordinate: c })).join(' ')} walls:${board._wallsRemaining.join('/')}`);
  }
}

console.log('\nFull history legal under reference QuoridorBoard.');
console.log('Final:', {
  ply,
  stm: board.playerToMove(),
  pawns: board._playerPositions.map((c) => toAlgebraic({ coordinate: c })),
  hWalls: [...board._horizontalWalls].sort(),
  vWalls: [...board._verticalWalls].sort(),
  wallsRemaining: board._wallsRemaining,
  terminal: board.terminal(),
});
