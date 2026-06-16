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

function bootstrapSec(opp, mode) {
  return calibrationMaxSec(opp, mode);
}

function calibrationMaxSec(opp, mode) {
  const entry = loadTimings()[opp]?.[mode];
  if (entry) {
    const maxSec = entry.max_think_sec ?? entry.think_sec;
    if (maxSec != null && maxSec > 0) return maxSec;
  }
  return FALLBACK[opp]?.[mode] ?? 10;
}

function remoteConnectTimeoutSec() {
  return 15;
}

function remoteMoveTimeoutSec(opp, mode) {
  const maxSec = calibrationMaxSec(opp, mode);
  // Search-only budget (connect uses remoteConnectTimeoutSec). No 45s floor.
  return Math.min(300, Math.max(maxSec + 15, maxSec * 2 + 10));
}

function fairBudgetSec(opp, mode, gameMaxSec = 0) {
  return Math.max(calibrationMaxSec(opp, mode), gameMaxSec || 0);
}

function minThinkSec(opp, mode) {
  return MIN_THINK[opp]?.[mode] ?? 1;
}

function schedulePersist() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    if (writeInFlight || !docCache) return;
    writeInFlight = true;
    docCache.updated_at = new Date().toISOString();
    fs.mkdir(path.dirname(TIMING_PATH), { recursive: true }, (mkErr) => {
      if (mkErr) {
        writeInFlight = false;
        return;
      }
      fs.writeFile(TIMING_PATH, JSON.stringify(docCache, null, 2) + '\n', (err) => {
        writeInFlight = false;
      });
    });
  }, 750);
}

/** Exponential moving average — refine calibration after each measured move. */
function recordThink(opp, mode, thinkSec) {
  if (!thinkSec || thinkSec <= 0) return;
  if (thinkSec < minThinkSec(opp, mode)) return;

  const doc = ensureDoc();
  doc.timings[opp] = doc.timings[opp] || {};
  const prev = doc.timings[opp][mode];
  const prevAvg = prev?.think_sec;
  const nextAvg = prevAvg == null ? thinkSec : prevAvg * 0.7 + thinkSec * 0.3;
  const prevMax = prev?.max_think_sec ?? prev?.think_sec ?? 0;
  const nextMax = Math.max(prevMax, thinkSec);
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
  fairBudgetSec,
  remoteConnectTimeoutSec,
  remoteMoveTimeoutSec,
  recordThink,
  TIMING_PATH,
  FALLBACK,
  minThinkSec,
  preload: ensureDoc,
};
