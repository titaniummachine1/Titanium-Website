# Quoridor AI Engine Protocol

Scraped from [quoridor-ai.netlify.app](https://quoridor-ai.netlify.app) (June 2025 build).

## Key finding: engine is server-side, not WASM

There is **no WebAssembly** in the deployed site. The "Ishtar" and "Ka" engines run on remote servers and are reached over WebSocket. The browser bundle only contains:

- Board rules / move generation (`p9` class in the minified bundle)
- A thin WebSocket client (`mT` class)
- React UI (Chakra UI, Redux)

## Not a game server (read this before touching Ka/Ishtar code)

**Ka and Ishtar do not play a game with you.** The WebSocket API is a remote search service:

1. **You own the game state.** The server only knows what you last sent via `makemove` or `setposition`.
2. **`go` searches that position** and returns `bestmove`. It does not apply that move on the server.
3. **You must `makemove` every ply** — yours _and_ the engine's. If you skip echoing Ka's own `bestmove` back as `makemove`, the server is one ply behind and the next search is from a nonsense position (illegal moves, hangs, garbage eval).
4. **Disconnect = amnesia.** A new connection starts from empty unless you replay the full move list (`makemove m1 m2 m3 ...`). Our harness keeps `_appliedActions` in `site/ishtar_match.js` for exactly this.
5. **No correlation with your local board.** The server does not know about your titanium.exe session, SQLite games, or UI — only the makemove stream on that socket.

This matches the scraped site's middleware: every `takeAction` in the React app notifies all engine clients, including when the AI moves.

**Our overnight harness (`ishtar_match.js`):**

| When             | What we send to Ka                                                  |
| ---------------- | ------------------------------------------------------------------- |
| We play a move   | `notifyMove` → `makemove` that ply                                  |
| Ka's turn        | `go` → read `bestmove`                                              |
| After Ka replies | `notifyMove` again with Ka's move (server must be told it "played") |
| WS reconnect     | `makemove` full `_appliedActions` replay, then continue             |

Do not assume Ka "remembers" the game, "knows" the pairing, or will catch up from a partial state. Always replay or incrementally makemove.

## Endpoints

| Engine    | WebSocket URI                     | Notation    |
| --------- | --------------------------------- | ----------- |
| Ishtar v3 | `wss://quoridor-ai.com/ishtar-v3` | Glendenning |
| Ka        | `wss://quoridor-ai.com/ka`        | Official    |

## Connection handshake

On `open`, the client sends:

```json
{ "token": "rbt_token_*", "version": "0.0.0" }
```

Then engine-specific `setoption` commands from config.

## Commands (client → server)

| Command       | Example                             | Purpose                         |
| ------------- | ----------------------------------- | ------------------------------- |
| `setposition` | `setposition  /  e2 e8 / 10 10 / 1` | Set board state                 |
| `makemove`    | `makemove e2 e3`                    | Apply moves since last position |
| `go`          | `go`                                | Start search                    |
| `go ponder`   | `go ponder`                         | Ponder while opponent thinks    |
| `stop`        | `stop`                              | Stop pondering                  |
| `setoption`   | `setoption name visits value 3200`  | Engine options                  |

### Position format

```
{horizontal_walls} / {vertical_walls} / {pawn_positions} / {walls_remaining} / {player_to_move}
```

- Walls: concatenated algebraic coords (no spaces), e.g. `d2h` = horizontal wall at d2
- Pawns: space-separated, e.g. `e2 e8`
- Walls remaining: space-separated per player, e.g. `10 10`
- Player to move: `1` or `2`

**Glendenning notation** (Ishtar): coordinates are flipped one row up before sending to the engine.

### Move format

- Pawn move: `e2`
- Horizontal wall: `d2h`
- Vertical wall: `d2v`

### Ishtar strength presets (visits)

| Preset    | Visits    |
| --------- | --------- |
| Intuition | 2         |
| Short     | 3,200     |
| Medium    | 200,000   |
| Long      | 1,000,000 |

### Ishtar extra options

```
setoption name display value false
setoption name alternative_action_threshold value 0.1
setoption name parallelism value 32   # varies by strength preset
```

## Responses (server → client)

| Pattern        | Example                                       |
| -------------- | --------------------------------------------- |
| `info ...`     | `info multipv 1 score 0.995 visits 1 pv e2`   |
| `bestmove ...` | `bestmove e2`                                 |
| `log ...`      | `log Debug: Connected to tunnel successfully` |

### Useful `info` fields

- `score`, `p1`, `p2` — win probability style eval
- `visits`, `depth`, `time`
- `pv` — principal variation (space-separated moves)
- `multipv`, `visitspct`
- `game_length`, `victory_margin`

## Probing from Node

```bash
node probe_ws.js
node probe_ws.js wss://quoridor-ai.com/ka
```

## Legal / ethical note

The engine binary is proprietary server-side software. This scrape documents the **public wire protocol** used by the website's frontend. Using the remote API for heavy automated play may violate the operator's terms of service.

## Alternative open-source engines

If you need a local engine you can modify:

- [gorisanson/quoridor-ai](https://github.com/gorisanson/quoridor-ai) — MCTS in JavaScript (runs in browser)
- [pavlosdais/Quoridor](https://github.com/pavlosdais/Quoridor) — alpha-beta C engine
- [v-ade-r/QuoridorAI-AlphaZero](https://github.com/v-ade-r/QuoridorAI-AlphaZero) — AlphaZero Python
