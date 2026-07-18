const STORAGE_KEY = 'titanium.recentGames.v1';
const MAX_RECENT = 10;

function readStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStore(entries) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_RECENT)));
  } catch {
    // Quota or private mode — ignore.
  }
}

/**
 * Remember a finished game (newest first, max 10, deduped by notation).
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

  const entry = {
    id: `${at}:${text.slice(0, 48)}`,
    notation: text,
    winner: winner ?? null,
    plies: Number.isFinite(Number(plies)) ? Number(plies) : text.split(/\s+/).filter(Boolean).length,
    at,
    label: label != null && String(label).trim() ? String(label).trim() : null,
  };

  const next = [
    entry,
    ...readStore().filter((item) => item?.notation !== text),
  ].slice(0, MAX_RECENT);

  writeStore(next);
}

export function listRecentGames() {
  return readStore()
    .filter((item) => item && typeof item.notation === 'string' && item.notation.trim())
    .slice(0, MAX_RECENT);
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
