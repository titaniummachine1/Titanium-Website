/** CAT v3 heat → subtle board overlays (never solid black bars on walls). */

let wasmCatInitPromise = null;

async function fetchCatSnapshotFromWasm(algebraicMoves) {
  if (!wasmCatInitPromise) {
    wasmCatInitPromise = import('../wasm/titanium/titanium.js').then(async (mod) => {
      await mod.default();
      return mod;
    });
  }
  const mod = await wasmCatInitPromise;
  if (typeof mod.cat_snapshot !== 'function') {
    throw new Error('WASM build missing cat_snapshot export — run npm run build:wasm');
  }
  return JSON.parse(mod.cat_snapshot((algebraicMoves ?? []).join(' ')));
}

/** Unreachable sealed square — only case that gets a dark skip overlay. */
export function isSquareSkipped(reachable) {
  return reachable === false;
}

const DEFAULT_COLD_CM = 60;
const DEFAULT_HOT_CM = 160;
// Per-player corridor ceiling: CAT_CORRIDOR_CM + BOTTLENECK_BONUS_CM (engine constants).
const DEFAULT_MAX_CM = 240;

// Fixed normalized position of the hot threshold on the color ramp.
// cold → 0, hot → 0.55, max → 1. Piecewise-linear with engine-true anchors:
// the same cm value ALWAYS renders the same color, and crossing CAT_HOT_CM
// (tactical / no-LMR) is always the same visual jump regardless of maxCm.
const HOT_ANCHOR_T = 0.55;

function heatColorParts(heat, scale = {}) {
  const t = catHeatT(heat, scale);
  const colorT = Math.pow(t, 0.92);
  const hue = Math.round(58 * (1 - colorT));
  const sat = Math.round(76 + 18 * colorT);
  const light = Math.round(62 - 14 * colorT);
  return { t, hue, sat, light };
}

/**
 * Engine-true heat → normalized 0..1 ramp position. The UI can pass `coldCm: 0`
 * to show every positive impact while still anchoring red to the engine hot/max
 * thresholds. This is never per-position normalization.
 */
export function catHeatT(heat, scale = {}) {
  const coldCm = scale.coldCm ?? DEFAULT_COLD_CM;
  const hotCm = Math.max(scale.hotCm ?? DEFAULT_HOT_CM, coldCm + 1);
  const maxCm = Math.max(scale.maxCm ?? DEFAULT_MAX_CM, hotCm + 1);
  if (!Number.isFinite(heat) || heat < coldCm) {
    return 0;
  }
  if (heat >= hotCm) {
    return HOT_ANCHOR_T + (1 - HOT_ANCHOR_T) * Math.min(1, (heat - hotCm) / (maxCm - hotCm));
  }
  return HOT_ANCHOR_T * ((heat - coldCm) / (hotCm - coldCm));
}

/**
 * Engine-true heat → color. Positive heat can be rendered faintly; callers decide
 * the visual baseline with `scale.coldCm`.
 *
 * @returns {{ fill: string, opacity: number } | null}
 */
export function catSquareOverlay(heat, reachable, scale = {}) {
  if (isSquareSkipped(reachable)) {
    return null;
  }
  if (!Number.isFinite(heat) || heat <= 0) {
    return null;
  }
  const coldCm = scale.coldCm ?? DEFAULT_COLD_CM;
  if (heat < coldCm) {
    return null;
  }
  const { t, hue, sat, light } = heatColorParts(heat, scale);
  // Yellow (55°) → orange → red (0°); alpha ramps so even the coolest warm
  // square reads against the background instead of vanishing into it.
  const alpha = Math.min(0.58, 0.035 + 0.5 * Math.pow(t, 1.18));
  return {
    fill: `hsla(${hue}, ${sat}%, ${light}%, ${alpha.toFixed(2)})`,
    opacity: 1,
  };
}

/** Fill/glow for wall hints. Low positive scores stay faint; hot walls pop. */
export function catWallOverlay(heat, scale = {}) {
  if (!Number.isFinite(heat) || heat <= 0) {
    return {
      fill: 'rgba(120, 115, 105, 0.18)',
      glow: 'rgba(120, 115, 105, 0.08)',
    };
  }
  const coldCm = scale.coldCm ?? DEFAULT_COLD_CM;
  if (heat < coldCm) {
    return {
      fill: 'rgba(120, 115, 105, 0.18)',
      glow: 'rgba(120, 115, 105, 0.08)',
    };
  }
  const { t, hue, sat, light } = heatColorParts(heat, scale);
  const fillAlpha = Math.min(0.68, 0.035 + 0.58 * Math.pow(t, 1.4));
  const glowAlpha = Math.min(0.42, 0.02 + 0.34 * Math.pow(t, 1.55));
  return {
    fill: `hsla(${hue}, ${sat}%, ${light}%, ${fillAlpha.toFixed(2)})`,
    glow: `hsla(${hue}, ${sat}%, ${light}%, ${glowAlpha.toFixed(2)})`,
  };
}

/**
 * @param {string[]} algebraicMoves
 */
export async function fetchCatSnapshot(algebraicMoves) {
  try {
    return await fetchCatSnapshotFromWasm(algebraicMoves);
  } catch (wasmErr) {
    // Dev fallback: the Vite proxy shells out to the native binary. It is useful
    // when wasm failed to initialize, but it is much slower than the in-process
    // wasm call because it pays process startup on each request.
    const res = await fetch('/api/titanium/cat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ moves: algebraicMoves }),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error ?? `CAT request failed (${res.status})`);
    }
    return data;
  }
}

/**
 * @param {Array<{alg: string, heat: number, directHeat?: number, search?: boolean, attention?: boolean, skip?: boolean, pruned?: boolean}>} walls
 * @returns {Map<string, {heat: number, directHeat: number, search: boolean, attention: boolean, skip: boolean}>}
 */
export function indexCatWalls(walls) {
  const map = new Map();
  for (const entry of walls ?? []) {
    if (!entry?.alg) {
      continue;
    }
    const skip = entry.skip ?? entry.pruned ?? false;
    const search = entry.search ?? !skip;
    map.set(entry.alg, {
      heat: entry.heat ?? 0,
      directHeat: entry.directHeat ?? entry.heat ?? 0,
      search,
      attention: entry.attention ?? search,
      skip,
    });
  }
  return map;
}

/**
 * Board-renderer row/col 0..8 → Rust CAT square index.
 *
 * The renderer stores row 0 at the top of the screen. Rust core stores row 0
 * at White's home rank (`1`), so raw CAT square arrays need a vertical flip.
 */
export function catSquareIndex(engineRow, engineCol) {
  return (8 - engineRow) * 9 + engineCol;
}
