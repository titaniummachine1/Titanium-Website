/** Dev-server: replay moves on a throwaway Titanium session (Rust rules oracle). */

const SESSION_URL = '/api/titanium/session';
const VALIDATE_SEAT = '__move_validate__';

export async function validateMovesWithRust(moves) {
  if (!Array.isArray(moves) || moves.length === 0) {
    return { ok: true };
  }
  try {
    const res = await fetch(SESSION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        seatId: VALIDATE_SEAT,
        op: 'position',
        moves: moves.map(String),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      return { ok: true, plies: data.plies ?? moves.length };
    }
    return { ok: false, error: data.error ?? `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  } finally {
    fetch(SESSION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatId: VALIDATE_SEAT, op: 'destroy' }),
    }).catch(() => {});
  }
}
