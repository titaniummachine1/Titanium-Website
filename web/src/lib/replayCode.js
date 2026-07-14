/**
 * Copy-paste replay format for terminal ↔ web.
 *
 *   tq1 e2 e8 e3 e7 d6h ...
 *   tq1#{"game":1,"winner":"Ka"} e2 e8 ...
 *
 * Also accepts wallz.gg move-history paste:
 *   ve4 / v e4  (vertical wall prefix)
 *   hd3 / h d3  (horizontal wall prefix)
 *   numbered lines: "1. e2 e8"
 */

import { parseAlgebraic, toAlgebraic } from './gameLogic.js';

const PREFIX = 'tq1';

/** Wall/pawn tokens in paste order (suffix walls before bare squares). */
const NOTATION_TOKEN_RE =
  /\b[hv][a-h][1-8]\b|\b[a-h][1-8][hv]\b|\b[a-i][1-9]\b/gi;

/** `ve1` / `hf8` (wallz prefix) → `e1v` / `f8h` for our parser. */
export function normalizeReplayToken(token) {
  const lower = String(token ?? '').trim().toLowerCase();
  if (lower.length === 3 && (lower[0] === 'h' || lower[0] === 'v')) {
    return `${lower.slice(1)}${lower[0]}`;
  }
  return lower;
}

function preprocessNotationText(text) {
  return String(text)
    .replace(/\r\n/g, '\n')
    // wallz / PGN-style move numbers: "12." before the next token
    .replace(/(?:^|\s)\d+\.(?=\s)/g, ' ')
    // split prefix walls: "v e4" → "e4v"
    .replace(/(?:^|\s)([hv])\s+([a-h][1-8])(?=\s|$)/gi, ' $2$1 ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeAlgebraicMovesPart(movesPart) {
  const preprocessed = preprocessNotationText(movesPart);
  const regexTokens = (preprocessed.match(NOTATION_TOKEN_RE) ?? []).map((token) =>
    normalizeReplayToken(token),
  );
  if (regexTokens.length > 0) {
    return regexTokens;
  }

  const tokens = [];
  for (const part of preprocessed.split(/\s+/).filter(Boolean)) {
    const lower = part.toLowerCase();
    if (/^\d+\.?$/.test(lower)) {
      continue;
    }
    if (lower === 'h' || lower === 'v') {
      continue;
    }
    tokens.push(normalizeReplayToken(lower));
  }
  return tokens;
}

function parseReplayHeader(text) {
  let meta = null;
  let movesPart = text;

  if (text.startsWith(PREFIX)) {
    const hashIdx = text.indexOf('#');
    const spaceAfterPrefix = text.indexOf(' ');
    if (hashIdx > 0 && spaceAfterPrefix > hashIdx) {
      meta = JSON.parse(text.slice(hashIdx + 1, spaceAfterPrefix));
      movesPart = text.slice(spaceAfterPrefix + 1);
    } else if (spaceAfterPrefix > 0) {
      movesPart = text.slice(spaceAfterPrefix + 1);
    } else {
      movesPart = '';
    }
  }

  return { meta, movesPart };
}

/**
 * Extract algebraic move tokens from plain lists, tq1 codes, or wallz paste layouts.
 */
export function tokenizeAlgebraicNotation(text) {
  if (!text || !String(text).trim()) {
    return [];
  }
  const trimmed = text.trim();
  if (/^REPLAY/i.test(trimmed) && !trimmed.startsWith(PREFIX)) {
    const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const codeLine = lines.find((l) => l.startsWith(PREFIX)) ?? lines[lines.length - 1];
    return tokenizeAlgebraicNotation(codeLine);
  }
  const { movesPart } = parseReplayHeader(trimmed);
  return tokenizeAlgebraicMovesPart(movesPart);
}

export function encodeReplayFromAlgebraic(algebraicMoves, meta = null) {
  const body = algebraicMoves.join(' ');
  if (!meta || Object.keys(meta).length === 0) {
    return `${PREFIX} ${body}`;
  }
  return `${PREFIX}#${JSON.stringify(meta)} ${body}`;
}

export function encodeReplayFromActions(actions, meta = null) {
  return encodeReplayFromAlgebraic(actions.map((a) => toAlgebraic(a)), meta);
}

export function decodeReplayCode(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('Empty replay');
  }

  if (/^REPLAY/i.test(trimmed) && !trimmed.startsWith(PREFIX)) {
    const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const codeLine = lines.find((l) => l.startsWith(PREFIX)) ?? lines[lines.length - 1];
    return decodeReplayCode(codeLine);
  }

  const { meta, movesPart } = parseReplayHeader(trimmed);
  const tokens = tokenizeAlgebraicMovesPart(movesPart);
  if (tokens.length === 0) {
    throw new Error('No moves in replay');
  }

  const actions = tokens.map((token) => parseAlgebraic(token));
  return { actions, meta, algebraic: tokens };
}

export function formatReplayBlock(code, { label = 'REPLAY — paste in web → Replay tab' } = {}) {
  return [
    '',
    `┌─ ${label} ─────────────────────────────────────────`,
    code,
    '└────────────────────────────────────────────────────',
    '',
  ].join('\n');
}
