const STORAGE_KEY = 'titanium.recentGames.v1';
export const MAX_RECENT = 100;
const EXPORT_SCHEMA = 'titanium-game-database-v1';

function readStore() {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStore(entries) {
  try {
    globalThis.localStorage?.setItem(
      STORAGE_KEY,
      JSON.stringify(entries.slice(0, MAX_RECENT)),
    );
  } catch {
    // Quota or private mode — ignore.
  }
}

function finiteTimestamp(value, fallback = Date.now()) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : fallback;
}

function moveTokensFromNotation(notation) {
  return notation.split(/\s+/).filter(Boolean);
}

function validMoveTokens(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const moves = value.map((move) => (typeof move === 'string' ? move.trim() : ''));
  return moves.every(Boolean) ? moves : null;
}

function normalizeEntry(raw, fallbackAt = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  const notationText =
    typeof raw.notation === 'string' ? raw.notation.trim() : '';
  const suppliedMoves = validMoveTokens(raw.moves);
  const notation = notationText || (suppliedMoves ? suppliedMoves.join(' ') : '');
  if (!notation) return null;

  const at = finiteTimestamp(raw.at, fallbackAt);
  const suppliedWinner =
    raw.winner === 'white' || raw.winner === 'black' || raw.winner === 'draw'
      ? raw.winner
      : null;
  const numericResult =
    typeof raw.result === 'number'
      ? raw.result
      : typeof raw.result === 'string' && raw.result.trim()
        ? Number(raw.result)
        : NaN;
  const winner =
    suppliedWinner ??
    (numericResult === 1
      ? 'white'
      : numericResult === -1
        ? 'black'
        : numericResult === 0
          ? 'draw'
          : null);
  const numericPlies = raw.plies == null ? NaN : Number(raw.plies);
  const plies =
    Number.isInteger(numericPlies) && numericPlies >= 0
      ? numericPlies
      : notation.split(/\s+/).filter(Boolean).length;
  const label =
    raw.label != null && String(raw.label).trim()
      ? String(raw.label).trim()
      : null;

  return {
    id:
      typeof raw.id === 'string' && raw.id.trim()
        ? raw.id.trim()
        : `${at}:${notation.slice(0, 48)}`,
    notation,
    winner,
    plies,
    at,
    label,
  };
}

function normalizeStore(entries) {
  const byNotation = new Map();
  for (const raw of Array.isArray(entries) ? entries : []) {
    const entry = normalizeEntry(raw);
    if (!entry) continue;
    const existing = byNotation.get(entry.notation);
    if (!existing || entry.at >= existing.at) {
      byNotation.set(entry.notation, entry);
    }
  }
  return [...byNotation.values()]
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_RECENT);
}

/**
 * Remember a finished or loaded game (newest first, max 100, deduped by notation).
 * @param {{ notation: string, winner?: string|null, plies?: number, at?: number, label?: string|null }} game
 */
export function rememberRecentGame({
  notation,
  winner = null,
  plies = null,
  at = Date.now(),
  label = null,
} = {}) {
  const text = String(notation ?? '').trim();
  if (!text) return;

  const entry = normalizeEntry({
    notation: text,
    winner,
    plies,
    at,
    label,
  });
  if (!entry) return;

  const next = [
    entry,
    ...listRecentGames().filter((item) => item.notation !== text),
  ].slice(0, MAX_RECENT);

  writeStore(next);
}

export function listRecentGames() {
  return normalizeStore(readStore());
}

export function exportRecentGamesJson() {
  return JSON.stringify(
    {
      schema: EXPORT_SCHEMA,
      exportedAt: new Date().toISOString(),
      games: listRecentGames().map((entry) => ({
        ...entry,
        moves: moveTokensFromNotation(entry.notation),
        result:
          entry.winner === 'white'
            ? 1
            : entry.winner === 'black'
              ? -1
              : entry.winner === 'draw'
                ? 0
                : null,
        source: 'website_finished_game',
      })),
    },
    null,
    2,
  );
}

/**
 * Import a versioned game database export, or a raw array of game entries.
 * JSON is parsed as data only; no imported field is executed.
 */
export function importRecentGamesJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text ?? ''));
  } catch (error) {
    throw new Error(`Invalid game database JSON: ${error?.message ?? 'parse failed'}`);
  }

  const importedGames = Array.isArray(parsed) ? parsed : parsed?.games;
  if (!Array.isArray(importedGames)) {
    throw new Error('Invalid game database: expected a games array');
  }

  const normalized = importedGames
    .map((entry) => normalizeEntry(entry))
    .filter(Boolean);
  if (!normalized.length) {
    throw new Error(
      'Invalid game database: no games with move notation or moves found',
    );
  }

  const existing = listRecentGames();
  const before = new Set(existing.map((entry) => entry.notation));
  const merged = normalizeStore([...normalized, ...existing]);
  writeStore(merged);

  const uniqueImported = new Set(normalized.map((entry) => entry.notation));
  return {
    imported: [...uniqueImported].filter((notation) => !before.has(notation)).length,
    total: merged.length,
  };
}

export function formatRecentGameLabel(entry) {
  if (entry?.label != null && String(entry.label).trim()) {
    return String(entry.label).trim();
  }
  const at = Number(entry?.at) || Date.now();
  const date = new Date(at);
  const dateStr = date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const plies = entry?.plies ?? '?';

  if (entry?.winner === 'white' || entry?.winner === 'black') {
    const who = entry.winner === 'white' ? 'White' : 'Black';
    return `${dateStr} · ${plies} plies · ${who} won`;
  }
  if (entry?.winner === 'draw') {
    return `${dateStr} · ${plies} plies · draw`;
  }
  return `${dateStr} · ${plies} plies`;
}
