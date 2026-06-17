/**
 * WebSocket client for quoridor-ai.com engines (scraped/reconstructed from
 * https://quoridor-ai.netlify.app bundle, class mT).
 *
 * The AI runs server-side — this is only the protocol bridge.
 *
 * IMPORTANT: Ka/Ishtar are not game opponents on the wire. They search whatever
 * board state you last set with makemove/setposition. bestmove does NOT commit
 * that move on the server — callers must makemove every ply (both sides).
 * See site/extracted/ENGINE_PROTOCOL.md § "Not a game server".
 */

const Direction = { Up: 'up', Down: 'down', Left: 'left', Right: 'right' };
const WallType = { Vertical: 'v', Horizontal: 'h' };
const Notation = { Official: 'official', Glendenning: 'glendenning' };

const ENGINES = {
  ishtar: {
    name: 'Ishtar',
    uri: 'wss://quoridor-ai.com/ishtar-v3',
    notation: Notation.Glendenning,
    visits: { intuition: 2, short: 3200, medium: 200000, long: 1000000 },
    settings: {
      display: 'false',
      alternative_action_threshold: '0.1',
      parallelism: { intuition: '1', short: '32', medium: '1024', long: '2048' },
    },
  },
  ka: {
    name: 'Ka',
    uri: 'wss://quoridor-ai.com/ka',
    notation: Notation.Official,
    // Alpha strength = full visit table below (no strength setoption on wire).
    visits: { intuition: 1, short: 1000, medium: 5000, long: 20000 },
  },
};

const INFO_RE = /^info (.*)/;
const BESTMOVE_RE = /^bestmove (.*)/;

function columnToIndex(column) {
  return column.charCodeAt(0) - 96;
}

function indexToColumn(index) {
  return String.fromCharCode(index + 96);
}

function parseCoordinate(text) {
  return { column: text[0], row: parseInt(text[1], 10) };
}

function formatCoordinate({ column, row }) {
  return `${column}${row}`;
}

function stepCoordinate(coordinate, direction) {
  switch (direction) {
    case Direction.Up:
      return { row: coordinate.row + 1, column: coordinate.column };
    case Direction.Down:
      return { row: coordinate.row - 1, column: coordinate.column };
    case Direction.Left:
      return { row: coordinate.row, column: indexToColumn(columnToIndex(coordinate.column) - 1) };
    case Direction.Right:
      return { row: coordinate.row, column: indexToColumn(columnToIndex(coordinate.column) + 1) };
    default:
      throw new Error(`Unknown direction: ${direction}`);
  }
}

function transformCoordinate(coordinate, directions) {
  return directions.reduce((current, direction) => stepCoordinate(current, direction), coordinate);
}

function parseAlgebraic(move) {
  const coordinate = parseCoordinate(move.slice(0, 2));
  if (move.length > 2) {
    return {
      wallType: move[2] === 'h' ? WallType.Horizontal : WallType.Vertical,
      coordinate,
    };
  }
  return { coordinate };
}

function isWallAction(action) {
  return 'wallType' in action;
}

function toAlgebraic(action, notation) {
  let coordinate = action.coordinate;
  if (isWallAction(action) && notation === Notation.Glendenning) {
    coordinate = transformCoordinate(coordinate, [Direction.Up]);
  }
  const text = formatCoordinate(coordinate);
  if (isWallAction(action)) {
    return `${text}${action.wallType === WallType.Horizontal ? 'h' : 'v'}`;
  }
  return text;
}

function fromAlgebraic(move, notation) {
  const action = parseAlgebraic(move);
  if (isWallAction(action) && notation === Notation.Glendenning) {
    action.coordinate = transformCoordinate(action.coordinate, [Direction.Down]);
  }
  return action;
}

function buildPositionString(gameState, notation) {
  const flip = (coordinate) =>
    notation === Notation.Glendenning
      ? transformCoordinate(coordinate, [Direction.Up])
      : coordinate;

  const horizontalWalls = gameState.wallsByPlayer
    .filter(([, , wallType]) => wallType === WallType.Horizontal)
    .map(([, coordinate]) => formatCoordinate(flip(coordinate)))
    .join('');

  const verticalWalls = gameState.wallsByPlayer
    .filter(([, , wallType]) => wallType === WallType.Vertical)
    .map(([, coordinate]) => formatCoordinate(flip(coordinate)))
    .join('');

  const pawns = gameState.playerPositions.map((coordinate) => formatCoordinate(flip(coordinate))).join(' ');
  const wallsRemaining = gameState.wallsRemaining.join(' ');
  const playerToMove = gameState.playerToMove;

  return `${horizontalWalls} / ${verticalWalls} / ${pawns} / ${wallsRemaining} / ${playerToMove}`;
}

function parseInfoLine(line) {
  const tokens = line.split(' ');
  const result = {};
  const parsers = {
    depth: readNumber,
    movesleft: readNumber,
    multipv: readNumber,
    playertomove: readNumber,
    score: readNumber,
    time: readNumber,
    visits: readNumber,
    visitspct: readNumber,
    pv: readRest,
  };

  for (let index = 0; index < tokens.length; index++) {
    const parser = parsers[tokens[index]];
    if (parser) {
      index += parser(tokens, index + 1, result);
    }
  }

  return result;
}

function readNumber(tokens, index, result) {
  result[tokens[index - 1]] = Number(tokens[index]);
  return 1;
}

function readRest(tokens, index, result) {
  result[tokens[index - 1]] = tokens.slice(index).join(' ');
  return tokens.length - index;
}

class QuoridorEngineClient {
  constructor(engineConfig = ENGINES.ishtar) {
    this.config = engineConfig;
    this.ws = null;
    this.sendBuffer = [];
    this.outstandingSearches = 0;
    this.isPondering = false;
    this._lastActivityMs = 0;
    this.onInfo = null;
    this.onBestMove = null;
    this.onStatus = null;
    this.onError = null;
  }

  _touchActivity() {
    this._lastActivityMs = Date.now();
  }

  lastActivityMs() {
    return this._lastActivityMs;
  }

  isConnectionStale(maxIdleMs = 45_000) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return true;
    }
    if (!this._lastActivityMs) {
      return false;
    }
    return Date.now() - this._lastActivityMs > maxIdleMs;
  }

  connect() {
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) {
      return;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }

    this.setStatus('connecting');
    const ws = new WebSocket(this.config.uri);
    this.ws = ws;

    ws.addEventListener('open', () => this.onOpen());
    ws.addEventListener('message', (event) => this.onMessage(event.data));
    ws.addEventListener('error', () => {
      if (this.ws === ws) {
        this.setStatus('error');
        this.onError?.(new Error('WebSocket error'));
      }
    });
    ws.addEventListener('close', () => {
      if (this.ws === ws) {
        this.setStatus('error');
        this.ws = null;
        this.outstandingSearches = 0;
        this.isPondering = false;
        this.onError?.(new Error('WebSocket closed'));
      }
    });
  }

  destroy() {
    this.stop();
    this.ws?.close();
    this.ws = null;
    this.sendBuffer = [];
    this.outstandingSearches = 0;
    this.setStatus('idle');
  }

  send(command) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(command);
      this._touchActivity();
      return;
    }

    this.sendBuffer.push(command);
    this.connect();
  }

  setPosition(gameState) {
    const position = buildPositionString(gameState, this.config.notation);
    this.send(`setposition ${position}`);
  }

  makeMoves(actions) {
    const moves = actions.map((action) => toAlgebraic(action, this.config.notation)).join(' ');
    if (moves) {
      this.send(`makemove ${moves}`);
    }
    this.setStatus('idle');
  }

  go(timeMode = 'short') {
    const visits = this.config.visits?.[timeMode];
    this.outstandingSearches++;

    if (Number.isFinite(visits)) {
      this.send(`setoption name visits value ${visits}`);
    }

    this.sendEngineSettings(timeMode);
    this.send('go');
    this.setStatus('searching');
  }

  ponder() {
    if (this.outstandingSearches > 0 || this.isPondering) {
      return;
    }

    this.send('go ponder');
    this.isPondering = true;
    this.setStatus('pondering');
  }

  stop() {
    if (!this.isPondering) {
      return;
    }

    this.send('stop');
    this.isPondering = false;
    this.setStatus('idle');
  }

  /** Abort an in-flight `go` search (best-effort; server may ignore). */
  abortSearch() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send('stop');
    }
    this.outstandingSearches = 0;
    this.isPondering = false;
    this.setStatus('idle');
  }

  onOpen() {
    this._touchActivity();
    this.ws.send(JSON.stringify({ token: 'rbt_token_*', version: '0.0.0' }));
    this.sendStaticSettings();
    this.sendBuffer.forEach((command) => this.send(command));
    this.sendBuffer = [];
    this.setStatus('idle');
  }

  onMessage(rawMessage) {
    this._touchActivity();
    this.onRawMessage?.(rawMessage);

    if (/log Error/i.test(rawMessage) && !/log Error: WARNING:tensorflow/i.test(rawMessage)) {
      this.setStatus('error');
      this.onError?.(new Error(rawMessage));
      return;
    }

    const infoMatch = INFO_RE.exec(rawMessage);
    if (infoMatch) {
      const info = parseInfoLine(infoMatch[1]);
      if (info.pv) {
        info.pv = info.pv.split(' ').map((move) => fromAlgebraic(move, this.config.notation));
      }
      this.onInfo?.(info);
      return;
    }

    const bestMoveMatch = BESTMOVE_RE.exec(rawMessage);
    if (!bestMoveMatch) {
      return;
    }

    this.outstandingSearches = Math.max(0, this.outstandingSearches - 1);
    this.setStatus('idle');

    const action = fromAlgebraic(bestMoveMatch[1].trim().split(' ')[0], this.config.notation);
    this.onBestMove?.(action, bestMoveMatch[1]);
  }

  sendStaticSettings() {
    const settings = this.config.settings;
    if (!settings) {
      return;
    }

    for (const [name, value] of Object.entries(settings)) {
      if (typeof value === 'string') {
        this.send(`setoption name ${name} value ${value}`);
      }
    }
  }

  sendEngineSettings(timeMode) {
    const settings = this.config.settings;
    if (!settings) {
      return;
    }

    for (const [name, value] of Object.entries(settings)) {
      if (typeof value !== 'string') {
        this.send(`setoption name ${name} value ${value[timeMode]}`);
      }
    }
  }

  setStatus(status) {
    this.onStatus?.(status);
  }
}

module.exports = {
  QuoridorEngineClient,
  ENGINES,
  Notation,
  WallType,
  Direction,
  buildPositionString,
  toAlgebraic,
  fromAlgebraic,
};
