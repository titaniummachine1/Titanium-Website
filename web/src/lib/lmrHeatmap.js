/** LMR vision — root move depth / reduction overlays from engine JSON. */

import { fetchLmrFromWorker } from './catHeatmap.js';

/**
 * Pre-search LMR plan via the warm WASM engine (works on static Pages — no
 * server). `lmrAggressionPercent` is LMR tuning: -500 = absolute max cut,
 * 0 = CAT-shaped max cut, -177 = current engine default, 150 = full depth.
 * @param {string[]} algebraicMoves
 * @param {number} [timeSec]
 * @param {number} [idDepth]
 */
export async function fetchLmrSnapshot(algebraicMoves, timeSec = 10, idDepth = 8) {
  return fetchLmrFromWorker(algebraicMoves, timeSec, idDepth);
}

function num(entry, camel, snake, fallback = 0) {
  const v = entry[camel] ?? entry[snake];
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeLmrEntry(entry) {
  const reduction = num(entry, 'reduction', 'reduction', 0);
  const childFull = num(entry, 'childDepthFull', 'child_depth_full', 0);
  const childUsed = num(entry, 'childDepthUsed', 'child_depth_used', childFull);
  const baselineReduction = num(entry, 'baselineReduction', 'baseline_reduction', 0);
  const baselineChildUsed = num(
    entry,
    'baselineChildDepthUsed',
    'baseline_child_depth_used',
    childFull,
  );
  return {
    move: entry.move ?? entry.mv,
    kind: entry.kind ?? (entry.is_pawn || entry.isPawn ? 'pawn' : 'wall'),
    order: entry.order ?? 0,
    catCm: entry.catCm ?? entry.cat_cm ?? 0,
    tactical: Boolean(entry.tactical),
    hot: Boolean(entry.hot),
    cold: Boolean(entry.cold),
    protected: Boolean(entry.protected),
    pruned: Boolean(entry.pruned),
    baselineReductionFp: num(entry, 'baselineReductionFp', 'baseline_reduction_fp', 0),
    baselineReduction,
    baselineChildDepthFull: num(entry, 'baselineChildDepthFull', 'baseline_child_depth_full', childFull),
    baselineChildDepthUsed: baselineChildUsed,
    requestedReductionFp: num(entry, 'requestedReductionFp', 'requested_reduction_fp', 0),
    reduction,
    childDepthFull: childFull,
    childDepthUsed: childUsed,
    reductionClamped: Boolean(entry.reductionClamped ?? entry.reduction_clamped),
    inFullWindow: Boolean(entry.inFullWindow ?? entry.in_full_window),
    attentionRatio: num(entry, 'attentionRatio', 'attention_ratio', 0),
    deadTail: Boolean(entry.deadTail ?? entry.dead_tail),
    score: entry.score ?? null,
    nodes: Number(entry.nodes ?? 0),
    sharePct: 0,
    displaySharePct: 0,
    searched: entry.searched !== false,
    unsearched: Boolean(entry.unsearched),
  };
}

function logWeight(value) {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) {
    return 0;
  }
  return Math.log1p(v);
}

/** Match engine `cat_heat_fraction` — 0 at cold floor, 1 at node max. */
export function catHeatFraction(catCm, catMax, coldCm = 60) {
  const h = Number(catCm) || 0;
  const max = Number(catMax) || 0;
  const cold = Number(coldCm) || 0;
  if (max <= cold) {
    return h > cold ? 1 : 0;
  }
  return Math.min(1, Math.max(0, (h - cold) / (max - cold)));
}

/** Max legal-move impact at this node — single denominator for attention. */
function catHeatRefs(moves) {
  let all = 0;
  for (const m of moves) {
    all = Math.max(all, Number(m.catCm) || 0);
  }
  return { all, walls: all, pawns: all };
}

function catRefMax(_entry, refs) {
  return refs.all;
}

/**
 * Effort shares for board overlay coloring.
 * Search: linear node % (truth) + log-scaled bar width (spread).
 * Shallow plan: CAT-shaped planned attention.
 */
function attachEffortShares(moves, coldCm = 60, { shallow = false } = {}) {
  const refs = catHeatRefs(moves);
  const linearTotal = moves.reduce((sum, m) => sum + (m.nodes > 0 ? m.nodes : 0), 0);
  const hasSearchNodes = !shallow && linearTotal > 0;

  if (hasSearchNodes) {
    const logWeights = moves.map((m) => logWeight(m.nodes));
    const logTotal = logWeights.reduce((sum, w) => sum + w, 0);
    return moves.map((m, i) => {
      const refMax = catRefMax(m, refs);
      const frac = catHeatFraction(m.catCm, refMax, coldCm);
      const sharePct =
        m.nodes > 0 ? Math.round((m.nodes / linearTotal) * 1000) / 10 : 0;
      const effortBarPct =
        logTotal > 0 ? Math.round((logWeights[i] / logTotal) * 100) : 0;
      return {
        ...m,
        sharePct,
        displaySharePct: Math.round(sharePct),
        effortBarPct,
        heatFraction: frac,
      };
    });
  }

  const weights = moves.map((m) => {
    const refMax = catRefMax(m, refs);
    const frac = catHeatFraction(m.catCm, refMax, coldCm);
    const catW = frac * frac * 100;
    const nodeW = logWeight(m.nodes);
    if (m.nodes > 0) {
      return catW * 0.7 + nodeW * 0.3;
    }
    return catW;
  });
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (total <= 0) {
    return moves;
  }
  return moves.map((m, i) => {
    const refMax = catRefMax(m, refs);
    const frac = catHeatFraction(m.catCm, refMax, coldCm);
    const displayShare = Math.round((weights[i] / total) * 100);
    return {
      ...m,
      sharePct: displayShare,
      displaySharePct: displayShare,
      effortBarPct: displayShare,
      heatFraction: frac,
      planAttentionPct: m.unsearched ? displayShare : undefined,
    };
  });
}

/**
 * Fill gaps in search rootMoves with the static pre-search plan (same legal list).
 * Search behaviour unchanged — viz only.
 *
 * @param {object[]} planMoves
 * @param {object[]} searchMoves
 */
export function mergeLmrPlanWithSearch(planMoves, searchMoves) {
  if (!planMoves?.length) {
    return searchMoves ?? [];
  }
  if (!searchMoves?.length) {
    return planMoves.map((m) => ({ ...m, unsearched: true, searched: false, nodes: 0 }));
  }
  const planByKey = indexLmrMoves(planMoves);
  const searchByKey = indexLmrMoves(searchMoves);
  const keys = new Set([...planByKey.keys(), ...searchByKey.keys()]);
  const merged = [];
  for (const key of keys) {
    const plan = planByKey.get(key);
    const search = searchByKey.get(key);
    if (search) {
      merged.push({
        ...plan,
        ...search,
        catCm: search.catCm ?? plan?.catCm ?? 0,
        searched: true,
        unsearched: false,
      });
    } else if (plan) {
      merged.push({
        ...plan,
        searched: false,
        unsearched: true,
        nodes: 0,
        sharePct: 0,
      });
    }
  }
  merged.sort((a, b) => a.order - b.order);
  return merged;
}

/**
 * @param {Array<Record<string, unknown>>} moves
 * @returns {Map<string, object>}
 */
export function indexLmrMoves(moves) {
  const map = new Map();
  for (const entry of moves ?? []) {
    const alg = entry.move ?? entry.mv;
    if (!alg) {
      continue;
    }
    map.set(String(alg), entry);
  }
  return map;
}

function coldCmThreshold(viz) {
  return Number(viz?.lmrProfile?.coldCm ?? 60);
}

function fmtDepth(used) {
  const d = Number(used ?? 0);
  return d > 0 ? `d${d}` : '';
}

function formatFp(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return '0';
  }
  return n < 10 ? n.toFixed(2) : n.toFixed(1);
}

/** Minimum ply reduction before we paint a slot in live search. */
function minCutToShow(viz) {
  return viz?.shallow ? 0 : 2;
}

function requestedCutFp(entry) {
  return Number(entry?.requestedReductionFp ?? entry?.reduction ?? 0) || 0;
}

function maxSafeReduction(entry) {
  const childFull = Number(entry?.childDepthFull ?? entry?.baselineChildDepthFull ?? 0) || 0;
  return Math.max(1, childFull - 1);
}

export function lmrCutIntensity(entry) {
  const requested = requestedCutFp(entry);
  if (!Number.isFinite(requested) || requested <= 0) {
    return 0;
  }
  return Math.min(1, Math.max(0, requested / maxSafeReduction(entry)));
}

/**
 * Skip pruned / noise — only draw moves with a meaningful cut, corridor heat, or search share.
 * `−1` in the UI means "1 ply LMR cut", not a leaf-node flag; we hide lone 1-ply plan noise.
 */
export function lmrEntryWorthShowing(entry, viz) {
  if (!entry) {
    return false;
  }
  if (viz?.shallow) {
    return true;
  }
  // Engine marks CAT-top moves — always paint in shallow plan.
  // Pierce cap dropout — still paint in shallow when CAT says the wall matters.
  if (entry.pruned) {
    return false;
  }
  const cold = coldCmThreshold(viz);
  const minCut = minCutToShow(viz);

  if (entry.reSearched) {
    return true;
  }

  const displayShare = Number(entry.displaySharePct ?? entry.sharePct) || 0;
  // Actually searched at root — always interesting.
  if (!viz?.shallow && entry.searched && (entry.nodes > 0 || displayShare > 0)) {
    return true;
  }

  // Any measurable node share in live search.
  if (!viz?.shallow && (entry.nodes > 0 || displayShare >= 0.5)) {
    return true;
  }

  // Significant planned or actual cut.
  if (entry.reduction >= minCut) {
    return true;
  }

  // Corridor-hot — LMR treats as tactical.
  if (entry.catCm >= cold) {
    return true;
  }

  // First root slot with a real signal only.
  if (entry.order === 0 && (entry.tactical || entry.inFullWindow)) {
    return (
      entry.catCm > 0 ||
      entry.reduction >= minCut ||
      (!viz?.shallow && entry.searched && entry.nodes > 0)
    );
  }

  // Pre-search plan slots.
  if (viz?.shallow) {
    if (requestedCutFp(entry) > 0.01 || entry.reduction >= minCut) {
      return true;
    }
    return false;
  }

  if (entry.unsearched && entry.reduction >= minCut) {
    return true;
  }

  return false;
}

/** Map value into 0..1 using this view's min–max (zeros are not drawn). */
function proportionalT(value, min, max) {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) {
    return 0;
  }
  if (max <= min) {
    return 1;
  }
  return Math.min(1, Math.max(0, (v - min) / (max - min)));
}

function displayShareOf(entry) {
  return Number(entry.displaySharePct ?? entry.sharePct) || 0;
}

function computeLmrRanges(visibleMoves) {
  const catValues = visibleMoves.map((m) => Number(m.catCm) || 0).filter((v) => v > 0);
  const cutValues = visibleMoves.map((m) => Number(m.reduction) || 0).filter((v) => v > 0);
  const shareValues = visibleMoves.map((m) => displayShareOf(m)).filter((v) => v > 0);
  const minCat = catValues.length ? Math.min(...catValues) : 0;
  const maxCat = catValues.length ? Math.max(...catValues) : 1;
  const maxCut = cutValues.length ? Math.max(...cutValues) : 1;
  const maxShare = shareValues.length ? Math.max(...shareValues) : 1;
  return {
    catCm: { min: minCat, max: maxCat },
    reduction: { min: 0, max: maxCut },
    sharePct: { min: 0, max: maxShare },
  };
}

/** Corridor cm — yellow → orange → red, scaled to visible min..max. */
function corridorFill(t, alpha = 0.8) {
  const hue = Math.round(52 * (1 - t));
  const sat = Math.round(86 + 10 * t);
  const light = Math.round(58 - 12 * t);
  return {
    fill: `hsla(${hue}, ${sat}%, ${light}%, ${alpha})`,
    textLight: light < 48 || t > 0.72,
  };
}

/** Dead CAT tail (≤10% of max legal impact) — maximum reduction zone. */
function deadTailFill(alpha = 0.9) {
  return {
    fill: `hsla(348, 88%, 42%, ${alpha})`,
    textLight: true,
  };
}

/** Ply reduction — teal → amber → crimson, scaled to visible requested cut. */
function cutFill(t, alpha = 0.82) {
  const hue = Math.round(168 * (1 - t));
  const sat = Math.round(62 + 30 * t);
  const light = Math.round(54 - 14 * t);
  return {
    fill: `hsla(${hue}, ${sat}%, ${light}%, ${alpha})`,
    textLight: t > 0.55,
  };
}

/** Search node share — slate → indigo → violet, scaled to visible max %. */
function shareFill(t, alpha = 0.82) {
  const hue = Math.round(215 - 55 * t);
  const sat = Math.round(42 + 38 * t);
  const light = Math.round(64 - 20 * t);
  return {
    fill: `hsla(${hue}, ${sat}%, ${light}%, ${alpha})`,
    textLight: t > 0.45,
  };
}

/**
 * @param {object} payload
 * @param {object[]} [payload.planMoves] — pre-search plan to pad search gaps
 */
export function buildLmrViz(payload) {
  const shallow = payload.source === 'shallow';
  const profile = payload.lmrProfile ?? {};
  const depthLog = payload.depthLog ?? [];
  const deepFromLog = depthLog.length
    ? depthLog.reduce((best, e) => ((e.depth ?? 0) > (best?.depth ?? 0) ? e : best))
    : null;
  const searchDepth =
    payload.searchDepth ??
    profile.idDepth ??
    deepFromLog?.depth ??
    payload.idDepth ??
    1;

  let raw = payload?.moves ?? payload?.rootMoves ?? [];
  if (!shallow && payload.planMoves?.length) {
    const normalizedSearch = raw.map(normalizeLmrEntry);
    const normalizedPlan = payload.planMoves.map(normalizeLmrEntry);
    raw = mergeLmrPlanWithSearch(normalizedPlan, normalizedSearch);
  }
  if (!raw.length) {
    return null;
  }

  let moves = raw.map(normalizeLmrEntry);
  const coldCm = Number(profile.coldCm ?? 60);
  moves = attachEffortShares(moves, coldCm, { shallow });
  const vizDraft = { shallow, searchDepth, lmrProfile: profile };
  let visibleMoves = pickLmrBoardMoves(moves, vizDraft);
  const moveIndex = indexLmrMoves(visibleMoves);
  const ranges = computeLmrRanges(visibleMoves);
  const catRefs = catHeatRefs(moves);
  const summary = payload.summary ?? null;
  return {
    source: payload.source ?? 'search',
    shallow,
    idDepth: searchDepth,
    searchDepth,
    lmrAggressionPercent: payload.lmrTuningPercent ?? payload.lmrAggressionPercent ?? null,
    catRefs,
    coldCm,
    ranges,
    maxCatCm: ranges.catCm.max,
    maxSharePct: ranges.sharePct.max,
    maxReduction: ranges.reduction.max,
    lmrProfile: profile,
    summary,
    lmrReSearches: payload.lmrReSearches ?? null,
    totalNodes: moves.reduce((s, m) => s + m.nodes, 0),
    searchedCount: moves.filter((m) => m.searched).length,
    visibleCount: visibleMoves.length,
    moveIndex,
    moves,
    visibleMoves,
    label: shallow ? 'pre-search plan' : `search d${searchDepth}`,
  };
}

/** Board slots — shallow LMR renders the full legal plan; search mode stays selective. */
function pickLmrBoardMoves(moves, viz) {
  if (viz.shallow) {
    return moves
      .filter((m) => lmrEntryWorthShowing(m, viz))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }
  const searched = moves.filter((m) => m.nodes > 0 || lmrEntryWorthShowing(m, viz));
  const byNodes = [...searched].sort((a, b) => (b.nodes ?? 0) - (a.nodes ?? 0));
  const top = new Set(byNodes.slice(0, 32).map((m) => m.move));
  const coldLeaves = moves.filter(
    (m) =>
      !top.has(m.move) &&
      m.childDepthUsed <= 2 &&
      m.reduction >= 2 &&
      lmrEntryWorthShowing(m, viz),
  );
  const picked = [...byNodes.filter((m) => top.has(m.move)), ...coldLeaves.slice(0, 12)];
  const uniq = new Map();
  for (const m of picked) {
    uniq.set(m.move, m);
  }
  return [...uniq.values()];
}

/**
 * @returns {{ fill: string, label: string, mode: string, textLight: boolean }}
 */
export function lmrDepthStyle(entry, viz) {
  if (!entry) {
    return { fill: 'transparent', label: '', mode: '', textLight: false };
  }
  const alpha = entry.unsearched ? 0.42 : 0.84;
  const used = entry.childDepthUsed;
  const ranges = viz?.ranges ?? computeLmrRanges([entry]);
  let painted;
  let mode;
  if (entry.deadTail) {
    painted = deadTailFill(alpha);
    mode = 'dead-tail';
  } else if (!viz?.shallow && entry.searched && entry.nodes > 0) {
    const share = entry.effortBarPct ?? displayShareOf(entry);
    painted = shareFill(
      proportionalT(share, ranges.sharePct.min, ranges.sharePct.max),
      alpha,
    );
    mode = 'share';
  } else if (lmrCutIntensity(entry) > 0) {
    painted = cutFill(lmrCutIntensity(entry), alpha);
    mode = 'cut';
  } else if (!viz?.shallow && entry.catCm > 0) {
    const refMax = viz?.catRefs?.all ?? ranges.catCm.max;
    const frac =
      entry.heatFraction ?? catHeatFraction(entry.catCm, refMax, viz?.coldCm ?? 60);
    painted = corridorFill(frac, alpha);
    mode = 'corridor';
  } else {
    painted = cutFill(0, alpha * 0.75);
    mode = 'full';
  }
  const label = entry.deadTail
    ? `dead tail ≤10% · leaf (d0)`
    : entry.unsearched
    ? `plan only · req ${formatFp(entry.requestedReductionFp)} → −${entry.reduction} ply${used > 0 ? ` · child d${used}` : ''}`
    : entry.reduction > 0
      ? `LMR cut req ${formatFp(entry.requestedReductionFp)} → −${entry.reduction} ply${used > 0 ? ` · searched d${used}` : ''}`
      : mode === 'share'
        ? `${displayShareOf(entry)}% nodes (log)`
        : entry.catCm > 0
          ? `corridor ${entry.catCm}cm`
          : used > 0
            ? `d${used} full`
            : 'full depth';
  return { fill: painted.fill, label, mode, textLight: painted.textLight };
}

export function lmrWallOutlineColor(entry, viz) {
  const style = lmrDepthStyle(entry, viz);
  return style.fill.replace(/,\s*[\d.]+%?\)$/, ', 0.95)');
}

export function lmrDisplayText(entry, viz) {
  if (!entry || !lmrEntryWorthShowing(entry, viz)) {
    return '';
  }
  if (entry.deadTail) {
    return String(Math.max(0, Number(entry.reduction) || 0));
  }
  const reduction = Number(entry.reduction);
  if (Number.isFinite(reduction)) {
    return String(Math.max(0, reduction));
  }
  // Live search overlay: node share when we have no depth label yet.
  if (!viz?.shallow && entry.nodes > 0) {
    const pct = entry.sharePct ?? displayShareOf(entry);
    return pct < 1 ? '<1%' : `${Math.round(pct)}%`;
  }
  return '';
}

export function lmrSubLabel(entry, viz) {
  if (!entry || !lmrEntryWorthShowing(entry, viz)) {
    return '';
  }
  const parts = [];
  const depth = fmtDepth(entry.childDepthUsed);
  if (entry.deadTail) {
    parts.push('≤10%');
  }
  if (!viz?.shallow && entry.nodes > 0 && depth) {
    parts.push(depth);
  } else if (entry.reduction > 0 && depth) {
    parts.push(depth);
  }
  if (entry.reduction > 0 && !viz?.shallow && entry.nodes > 0) {
    parts.push(`−${entry.reduction}`);
  }
  if (entry.reSearched) {
    parts.push('↺');
  }
  return parts.join(' ');
}
