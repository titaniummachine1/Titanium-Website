# Engine patches: Titanium movegen V11

This directory carries engine work that belongs in the
[titanium-quoridor](https://github.com/titaniummachine1/titanium-quoridor)
repository (the `engine/` submodule). This session could only push to the
website repository, so the change ships here as a `git format-patch` file.

## Apply

```sh
cd engine                      # the titanium-quoridor checkout
git checkout -b movegen-v11
git am ../engine-patches/0001-feat-movegen-V11-wall-legality-parallel-u128-flood-w.patch
cargo test --lib               # 115 passed, 0 failed
```

Then push the engine branch and bump the website's submodule pointer.

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

## Performance (release, `examples/bench_movegen.rs`)

| Workload | V10 | V11 | |
|---|---|---|---|
| perft d3 × 15 canta midgames | 4.35 Mnodes/s | 24.14 Mnodes/s | 5.5× |
| perft d4 startpos | 83.3 Mnodes/s | 150.6 Mnodes/s | 1.8× |
