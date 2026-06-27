import { toAlgebraic } from './gameLogic.js';

const ORACLE_SUBMIT_URL =
  typeof import.meta !== 'undefined' ? import.meta.env?.VITE_ORACLE_SUBMIT_URL : null;
const ORACLE_SUBMIT_TOKEN =
  typeof import.meta !== 'undefined' ? import.meta.env?.VITE_ORACLE_SUBMIT_TOKEN : null;

export function finishedGamePayload({
  actions,
  winner,
  isDraw = false,
  players = [],
  playerAiSettings = [],
  engineLabels = [],
  initialBudgetHint = null,
  moveThinkLog = [],
}) {
  const moves = (actions ?? []).map((action) =>
    typeof action === 'string' ? action : toAlgebraic(action),
  );
  const result = isDraw ? 0 : winner === 1 ? 1 : winner === 2 ? -1 : null;
  if (result == null || moves.length === 0) {
    return null;
  }
  return {
    moves,
    result,
    winner: result === 1 ? 'white' : result === -1 ? 'black' : 'draw',
    source: 'website_finished_game',
    metadata: {
      players,
      playerAiSettings,
      engineLabels,
      initialBudgetHint,
      moveThinkLog,
      userAgent:
        typeof navigator !== 'undefined' && navigator.userAgent
          ? navigator.userAgent
          : null,
    },
  };
}

export function finishedGameSignature(payload) {
  if (!payload) return '';
  return `${payload.result}|${payload.moves.join(' ')}`;
}

export function encodeFinishedGameWire(payload) {
  if (!payload) return '';
  const moves = Array.isArray(payload.moves) ? payload.moves.map(String).filter(Boolean) : [];
  const result = Number(payload.result);
  const source = String(payload.source || 'website_finished_game');
  if (!moves.length || !Number.isFinite(result)) {
    return '';
  }
  return `TI-GAME-1\nresult=${result}\nsource=${source}\nmoves=${moves.join(' ')}\n`;
}

export async function submitFinishedGame(payload, { fetchImpl = globalThis.fetch } = {}) {
  if (!payload || typeof fetchImpl !== 'function') {
    return { ok: false, skipped: true, reason: 'unavailable' };
  }
  const target = ORACLE_SUBMIT_URL || '/api/titanium/training-game';
  const headers = { 'Content-Type': 'text/plain; charset=utf-8' };
  if (ORACLE_SUBMIT_TOKEN) {
    headers['X-Website-Submit-Token'] = ORACLE_SUBMIT_TOKEN;
  }
  const wire = encodeFinishedGameWire(payload);
  const response = await fetchImpl(target, {
    method: 'POST',
    headers,
    body: wire,
    keepalive: true,
  });
  if (!response.ok) {
    return { ok: false, status: response.status };
  }
  try {
    return await response.json();
  } catch {
    return { ok: true };
  }
}
