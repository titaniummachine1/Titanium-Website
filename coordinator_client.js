'use strict';
/** HTTP client for training/coordinator.py (single writer, no file lock fights). */

const DEFAULT_URL = 'http://127.0.0.1:8765';

function baseUrl() {
  return (process.env.COORDINATOR_URL || DEFAULT_URL).replace(/\/$/, '');
}

async function request(method, path, body = null, retries = 3, timeoutMs = 30_000) {
  const url = `${baseUrl()}${path}`;
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const opts = { method, headers: {} };
      if (body != null) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
      }
      if (timeoutMs > 0) {
        const controller = new AbortController();
        opts.signal = controller.signal;
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await fetch(url, opts);
          clearTimeout(timer);
          const text = await res.text();
          let data = {};
          if (text) {
            try { data = JSON.parse(text); } catch { data = { raw: text }; }
          }
          if (!res.ok) {
            throw new Error(data.error || text || `HTTP ${res.status}`);
          }
          return data;
        } catch (e) {
          clearTimeout(timer);
          throw e;
        }
      }
      const res = await fetch(url, opts);
      const text = await res.text();
      let data = {};
      if (text) {
        try { data = JSON.parse(text); } catch { data = { raw: text }; }
      }
      if (!res.ok) {
        throw new Error(data.error || text || `HTTP ${res.status}`);
      }
      return data;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 100 * (i + 1)));
    }
  }
  throw lastErr;
}

async function lookupMatchup(engineA, engineB, tcA, tcB) {
  const q = new URLSearchParams({
    engine_a: engineA,
    engine_b: engineB,
    tc_a: tcA || '5s',
    tc_b: tcB || '5s',
  });
  const j = await request('GET', `/api/matchup?${q}`);
  return { aW: j.a_wins || 0, bW: j.b_wins || 0, ourW: j.a_wins || 0, oppW: j.b_wins || 0 };
}

async function upsertMatchup({
  engineA, engineB, aWins, bWins, tcA, tcB, gamesFile, source,
}) {
  return request('POST', '/api/matchup', {
    engine_a: engineA,
    engine_b: engineB,
    a_wins: aWins,
    b_wins: bWins,
    tc_a: tcA || '5s',
    tc_b: tcB || '5s',
    games_file: gamesFile || undefined,
    source: source || undefined,
  });
}

async function upsertGame({ moves, result, tag, gamesFile, releaseRemote, gameId }) {
  return request('POST', '/api/game', {
    moves,
    result,
    tag: tag || undefined,
    games_file: gamesFile || undefined,
    release_remote: releaseRemote || undefined,
    game_id: gameId || undefined,
  });
}

async function claimPairing() {
  return request('POST', '/api/claim-pairing', {});
}

async function releaseRemoteSlot(gameId) {
  return request('POST', '/api/release-remote', { game_id: gameId || undefined });
}

async function acquireKaSearch(tcB, gameId, timeoutSec = 900) {
  const data = await request(
    'POST',
    '/api/ka-search-acquire',
    { tc_b: tcB, game_id: gameId, timeout_sec: timeoutSec },
    1,
    (timeoutSec + 30) * 1000,
  );
  if (!data?.ok) {
    throw new Error(data?.error || 'ka search acquire failed');
  }
  return data;
}

async function releaseKaSearch(tcB, gameId) {
  return request('POST', '/api/ka-search-release', { tc_b: tcB, game_id: gameId }, 3, 15_000);
}

async function fetchScoreboard(compact = true) {
  const q = compact ? '?compact=1' : '';
  const j = await request('GET', `/api/scoreboard${q}`);
  return j.text || '';
}

async function fetchPoolStatus() {
  return request('GET', '/api/pool-status');
}

async function ensurePoolCoordinator() {
  const res = await fetch(`${baseUrl()}/health`);
  if (!res.ok) {
    throw new Error(`coordinator not healthy at ${baseUrl()}`);
  }
  const h = await res.json();
  if (!h.pool) {
    throw new Error(
      `coordinator at ${baseUrl()} is too old (no pool API) — `
      + 'kill stale python on port 8765 and restart run_overnight.bat',
    );
  }
  return fetchPoolStatus();
}

module.exports = {
  baseUrl,
  lookupMatchup,
  upsertMatchup,
  upsertGame,
  claimPairing,
  releaseRemoteSlot,
  acquireKaSearch,
  releaseKaSearch,
  fetchScoreboard,
  fetchPoolStatus,
  ensurePoolCoordinator,
};
