# Engine patches: Titanium movegen V11 + ACE v11

> **Status: applied** — merged to [titanium-engine `main`](https://github.com/titaniummachine1/titanium-engine/commit/da75d4a) (`da75d4a`). Patches kept here for history / `git am` replay.

This directory carries engine work that belongs in the
[titanium-engine](https://github.com/titaniummachine1/titanium-engine)
repository. This session could only push to the website repository, so the
changes ship here as a `git format-patch` series.

## Apply

```sh
cd ../engine                   # the canonical titanium-engine checkout
git checkout -b movegen-v11
git am ../engine-patches/000*.patch
cargo test --lib               # 118 passed, 0 failed
```

Then push the engine branch and rebuild the website WASM from `../engine`.

## Patch 0002 — ACE v11 (pathfix gen11_ghi, from quoridor_5.html)

Ports the new ACE engine onto the v10 base (HalfPW `NET_DATA` is
byte-identical — no net re-ingestion needed), mirroring the
browser-shipping config node-for-node:

- **ZeroFence-A GHI guard** (PLAIN, `ghiAnchor=false`): path-dependent
  repetition zeros demote TT flags or taint the entry; tainted entries never
  give score cutoffs.
- **RaceProof** (ships ON, SPRT-passed +3.74 LLR): exact retrograde
  race-endgame solver over 81×81×2 states (`src/ace/race.rs`), 64-slot LRU
  keyed by wall-config zobrist, budget-gated in-tree solves, draw-aware eval
  verdicts, exact root solve when both hands are empty, last-wall commitment
  gate with deadline reserve.
- **`wall_legal` topology gate removed** — the JS deleted
  `wallCanBlockTopology` (its right-edge condition was the same off-by-one
  fixed in Titanium movegen by patch 0001).
- **ThreatPrice / WallSense are NOT ported** — they ship `false` in the JS
  (falsifier-v2 / SPRT-killed per the source header) and no-op when false.
- Session keys `ace-v11`, `ace-v11-ti`, `ace-v11-ti-pmc` added.

**Parity oracle**: `_vendor/acev11_engine.js` (extracted from
quoridor_5.html) + `_vendor/acev11_parity.mjs` run the JS engine under node
against `titanium ace-bench` — 14/14 positions match move, score, depth, and
EXACT node counts (startpos d4–d8, wall fights, jump tangles, a 24-ply line,
a both-hands-empty race endgame, and last-wall / two-left gate lines).

## What it is

Movegen V11: wall legality is checked by the fixed O(n) parallel-flood POC
(`src/path/parallel.rs`) instead of the per-trial `set_wall` + zobrist +
`DirMasks` rebuild + BFS of V10.

- **WallGrids** — four directional "step out of this square is blocked" u128
  masks in the existing centered 11-stride flood layout. A speculative wall
  trial is a flip of a precomputed const mask delta; the board is never
  mutated during wall generation.
- **Linear flood** — every frontier cell advances one square in all four
  directions per iteration (4 shifts + masks, branch-free), early exit on
  goal contact or stagnation. Strictly O(n) in board cells.
- **Bit theft** — Player 2's flood annexes Player 1's cached visited region on
  first contact (pawn connectivity is undirected), with the annexed pool
  goal-tested at theft time.

### Fixes to the original POC (`quoridor_parallel_engine.txt`)

1. **Layout**: 9 rows × 16-bit stride needs 144 bits — does not fit u128
   ("row 8 = bits 128..137" was out of range). Uses the proven centered
   11-stride layout (max bit 108) whose buffer ring absorbs off-board shifts.
2. **Expansion**: the "directional ray sweeps" (`!f & -f`, `first_blocker - 1`)
   treat the whole register as a single ray — with more than one frontier bit
   the carry chains leak across rows and skip blockers. Replaced with correct
   one-step parallel dilation.
3. **Wall gating**: blocked-step masks gate the *source* square before the
   shift, not destinations after it.
4. **Bit theft goal miss**: annexed cells never re-enter the frontier, so a
   flood that inherited goal-row cells could still report "trapped". The
   annexed pool is goal-tested immediately.

### V10 soundness bugs fixed along the way

1. **False negatives** — `both_players_reach_goals_with_masks` concluded from
   P1's *partial* early-exit flood component that P2 was trapped (empty board
   with pawns at (7,4)/(6,4) returned `false`). Three replay tests had
   encoded these false negatives as expected behavior (a5h ply 14, g1v,
   a6h); an independent naive `can_step` BFS confirms all three walls keep
   both goal paths open. Tests corrected, full external replay test
   re-enabled.
2. **False positives** — `can_wall_block_topology` compared the horizontal
   right edge against `js_col == 9`, unreachable for 0-based slots, so
   right-edge horizontal walls skipped the path check entirely and trapping
   walls were accepted. This was the standing canta oracle failure
   (game 0 depth 2: 5980 ≠ 5978). All 15 canta games now match at
   depths 1–3.

The ACE module (`src/ace/`) is intentionally untouched — it mirrors the
scraped site JS for search parity.

## Validation

- `cargo test --lib`: 115 passed (was 106 passed / 1 failed on the base
  commit — the canta oracle mismatch).
- New differential test: 500 seeded random positions, V11 floods vs naive
  queue-BFS over `can_step` — exact agreement, plus per-square
  `WallGrids`/`can_step` equivalence for every single-wall board.

## Performance (release)

End-to-end perft (`examples/bench_movegen.rs`):

| Workload | V10 | V11 | |
|---|---|---|---|
| perft d3 × 15 canta midgames | 4.35 Mnodes/s | 24.14 Mnodes/s | 5.5× |
| perft d4 startpos | 83.3 Mnodes/s | 150.6 Mnodes/s | 1.8× |

Isolated wall-legality check (`examples/bench_wall_check.rs`, 428 flood-gated
wall trials across the 15 canta midgames, identical legal counts):

| Per wall trial | ns/trial | |
|---|---|---|
| V10: `set_wall` + zobrist + `DirMasks` rebuild (324 `can_step` calls) + 2 floods | 937.6 | baseline |
| V10 floods alone (masks prebuilt — unsound lower bound) | 103.0 | 9.1× of cost was the rebuild |
| **V11: const mask flip + parallel flood + bit theft** | **70.2** | **13.3× less work** |

V11 averages 11.7 dilation iterations per legality check (≈12 register ops
each), and bit theft fires on 97.2% of trials — Player 2 almost never
refloods, it annexes Player 1's visited region on contact.
