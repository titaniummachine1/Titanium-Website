'use strict';
/** Load/update calibrated remote think times per opp@preset (in-memory cache, async writes). */
const fs = require('fs');
const path = require('path');

const TIMING_PATH = path.resolve(__dirname, '../training/data/remote_timing.json');

const FALLBACK = {
  ka: { intuition: 0.5, short: 8, medium: 15, long: 35 },
  ishtar: { intuition: 1, short: 12, medium: 45, long: 90 },
};

const MIN_THINK = {
  ka: { intuition: 0.2, short: 3, medium: 5, long: 10 },
  ishtar: { intuition: 0.2, short: 5, medium: 15, long: 30 },
};

/** Hard ceiling on stored max_think_sec spikes (single outlier must not poison fair-time). */
const MAX_SPIKE_MULT = 3.5;

let docCache = null;
let writeTimer = null;
let writeInFlight = false;

function ensureDoc() {
  if (docCache) return docCache;
  try {
    docCache = JSON.parse(fs.readFileSync(TIMING_PATH, 'utf8'));
  } catch {
    docCache = { timings: {} };
  }
  docCache.timings = docCache.timings || {};
  return docCache;
}

function loadTimings() {
  return ensureDoc().timings;
}

function _entry(opp, mode) {
  return loadTimings()[opp]?.[mode];
}

function _avgSec(opp, mode) {
  const entry = _entry(opp, mode);
  if (entry?.think_sec != null && entry.think_sec > 0) return entry.think_sec;
  return FALLBACK[opp]?.[mode] ?? 10;
}

/** Cap absurd max_think outliers while keeping headroom for real slow moves. */
function cappedMaxSec(opp, mode) {
  const entry = _entry(opp, mode);
  const avg = _avgSec(opp, mode);
  const fb = FALLBACK[opp]?.[mode] ?? 10;
  if (!entry) return fb;
  const rawMax = entry.max_think_sec ?? entry.think_sec ?? avg;
  const ceiling = Math.max(avg * MAX_SPIKE_MULT + 10, fb * 2, minThinkSec(opp, mode) * 4);
  return Math.round(Math.min(Math.max(rawMax, avg), ceiling) * 10) / 10;
}

function bootstrapSec(opp, mode) {
  return cappedMaxSec(opp, mode);
}

function calibrationMaxSec(opp, mode) {
  return cappedMaxSec(opp, mode);
}

/** Progress bar + fair-time local budget — avg-based, not single-spike max. */
function calibrationBudgetSec(opp, mode) {
  const avg = _avgSec(opp, mode);
  return Math.round(Math.max(avg * 2.5 + 5, minThinkSec(opp, mode)) * 10) / 10;
}

/** Per-preset hard caps — fail fast and reconnect (pool throughput). */
const CONNECT_TIMEOUT_SEC = {
  intuition: 25,
  short: 20,
  medium: 25,
  long: 30,
};

const SEARCH_TIMEOUT_CAP_SEC = {
  ka: { intuition: 40, short: 30, medium: 50, long: 85 },
  ishtar: { intuition: 35, short: 35, medium: 65, long: 110 },
};

function remoteConnectTimeoutSec(_opp, mode) {
  return CONNECT_TIMEOUT_SEC[mode] ?? 12;
}

/** Max wait for bestmove before destroy + reconnect retry. */
function remoteMoveTimeoutSec(opp, mode) {
  const envKey = `REMOTE_SEARCH_CAP_${String(mode || '').toUpperCase()}`;
  const cap = Number(process.env[envKey]) || SEARCH_TIMEOUT_CAP_SEC[opp]?.[mode] || 25;
  const entry = _entry(opp, mode);
  const expected = _avgSec(opp, mode);
  const slackByMode = { intuition: 10, short: 8, medium: 12, long: 18 };
  const slack = slackByMode[mode] ?? 10;
  const floor = minThinkSec(opp, mode) + 5;

  // Ka "intuition" = 1 visit on paper, but WSS + server queue often hits 15–25s (see remote_timing.json).
  if (mode === 'intuition') {
    const observedMax = entry?.max_think_sec ?? Math.max(expected * 3, 8);
    const budget = Math.max(observedMax + slack, expected + slack, 28);
    return Math.min(cap, budget);
  }

  const calMax = cappedMaxSec(opp, mode);
  return Math.min(cap, Math.max(calMax + slack, expected + slack, floor));
}

/** Max wait in coordinator Ka search queue — fail fast instead of 15min stall. */
const KA_QUEUE_ACQUIRE_SEC = {
  intuition: 120,
  short: 180,
  medium: 300,
  long: 600,
};

function kaQueueAcquireTimeoutSec(mode) {
  return KA_QUEUE_ACQUIRE_SEC[mode] ?? 180;
}

function fairBudgetSec(opp, mode, gameMaxSec = 0) {
  const cal = calibrationBudgetSec(opp, mode);
  const peak = gameMaxSec > 0 ? Math.min(gameMaxSec * 1.25 + 5, cappedMaxSec(opp, mode)) : 0;
  return Math.max(cal, peak);
}

/** Fair-time mirror for OUR engine — capped so Ka spikes cannot inflate local search. */
const FAIR_OUR_THINK_CAP_SEC = Number(process.env.FAIR_OUR_THINK_CAP_SEC) || 15;

function fairOurThinkSec(opp, mode, gameMaxSec = 0) {
  return Math.min(fairBudgetSec(opp, mode, gameMaxSec), FAIR_OUR_THINK_CAP_SEC);
}

function minThinkSec(opp, mode) {
  return MIN_THINK[opp]?.[mode] ?? 1;
}

function schedulePersist() {
  if (process.env.REMOTE_TIMING_READONLY === '1') return;
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    if (writeInFlight || !docCache) return;
    writeInFlight = true;
    docCache.updated_at = new Date().toISOString();
    const body = JSON.stringify(docCache, null, 2) + '\n';
    const tmp = TIMING_PATH + '.tmp';
    fs.mkdir(path.dirname(TIMING_PATH), { recursive: true }, (mkErr) => {
      if (mkErr) {
        writeInFlight = false;
        return;
      }
      fs.writeFile(tmp, body, (err) => {
        if (err) {
          writeInFlight = false;
          try { fs.unlinkSync(tmp); } catch {}
          return;
        }
        fs.rename(tmp, TIMING_PATH, () => {
          writeInFlight = false;
        });
      });
    });
  }, 750);
}

/** Exponential moving average — refine calibration after each measured move. */
function recordThink(opp, mode, thinkSec) {
  if (!thinkSec || thinkSec <= 0) return;
  if (thinkSec < minThinkSec(opp, mode)) return;
  if (process.env.REMOTE_TIMING_READONLY === '1') return;

  const doc = ensureDoc();
  doc.timings[opp] = doc.timings[opp] || {};
  const prev = doc.timings[opp][mode];
  const prevAvg = prev?.think_sec;
  const nextAvg = prevAvg == null ? thinkSec : prevAvg * 0.7 + thinkSec * 0.3;
  const prevMax = prev?.max_think_sec ?? prev?.think_sec ?? 0;
  const spikeCap = nextAvg * MAX_SPIKE_MULT + 10;
  const nextMax = Math.min(Math.max(prevMax, thinkSec), spikeCap);
  doc.timings[opp][mode] = {
    think_sec: Math.round(nextAvg * 10) / 10,
    max_think_sec: Math.round(nextMax * 10) / 10,
    think_ms: Math.round(nextAvg * 1000),
    samples: (prev?.samples || 0) + 1,
  };
  schedulePersist();
}

module.exports = {
  bootstrapSec,
  calibrationMaxSec,
  calibrationBudgetSec,
  fairBudgetSec,
  fairOurThinkSec,
  FAIR_OUR_THINK_CAP_SEC,
  remoteConnectTimeoutSec,
  remoteMoveTimeoutSec,
  kaQueueAcquireTimeoutSec,
  recordThink,
  TIMING_PATH,
  FALLBACK,
  minThinkSec,
  preload: ensureDoc,
};
