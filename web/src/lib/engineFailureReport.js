/**
 * Shared formatting for engine crashes — copy-logs, player-card errors, halt UI.
 */

import { formatBuildIdentityLines, mergedBuildIdentity } from './wasmBuildInfo.js';

/** Enrich a worker/controller Error with panic/stack when not already in message. */
export function formatEngineFailureMessage(error) {
  const base = error?.message ?? String(error ?? 'Engine error');
  const diag = error?.diagnostics;
  const extra = [];

  if (diag?.panic && !base.includes(diag.panic)) {
    extra.push(`panic="${diag.panic}"`);
  }
  if (diag?.buildMeta?.git_commit && !base.includes(diag.buildMeta.git_commit)) {
    extra.push(`commit=${diag.buildMeta.git_commit}`);
  }
  if (diag?.buildMeta?.wasm_sha256 && !base.includes(String(diag.buildMeta.wasm_sha256).slice(0, 16))) {
    extra.push(`wasm=${String(diag.buildMeta.wasm_sha256).slice(0, 16)}`);
  }
  if (diag?.workerOnError && diag?.filename) {
    extra.push(`at=${diag.filename}:${diag.lineno ?? 0}:${diag.colno ?? 0}`);
  }

  let message = extra.length ? `${base} | ${extra.join(' | ')}` : base;
  const stack = error?.stack;
  if (stack && !message.includes(stack.split('\n')[0])) {
    const stackLines = stack
      .split('\n')
      .slice(0, 6)
      .map((line) => line.trim())
      .filter(Boolean);
    if (stackLines.length) {
      message += `\nstack:\n  ${stackLines.join('\n  ')}`;
    }
  }
  return message;
}

/** HTTP-style exponential backoff for engine search retries (ms). */
export function engineFailureBackoffMs(attempt, { baseMs = 250, maxMs = 30_000 } = {}) {
  const n = Math.max(1, Number(attempt) || 1);
  return Math.min(maxMs, baseMs * (2 ** (n - 1)));
}

export function formatWasmBuildBlock() {
  return ['=== WASM build ===', ...formatBuildIdentityLines(mergedBuildIdentity())];
}

/** Prominent crash/halt block for copy-logs (always above the think log). */
export function formatEngineStatusBlock(state) {
  const players = state.settings?.players ?? [];
  const errors = state.engineErrors ?? {};
  const statuses = state.engineStatus ?? {};
  const lines = [];

  const errorSeats = [];
  for (let seat = 0; seat < 2; seat++) {
    const err = errors[seat];
    if (typeof err === 'string' && err.length > 0) {
      errorSeats.push(seat);
    }
  }

  if (!state.gameHalted && errorSeats.length === 0) {
    return [];
  }

  if (state.gameHalted) {
    lines.push('=== GAME HALTED (engine failure) ===');
  } else {
    lines.push('=== Engine errors ===');
  }

  for (const seat of errorSeats) {
    const color = seat === 0 ? 'White' : 'Black';
    const engine = players[seat] ?? 'AI';
    const status = statuses[seat] ?? '?';
    lines.push(`${color} (${engine}) status=${status}`);
    lines.push(`  reason: ${errors[seat]}`);
  }

  const failedPly = (state.moveThinkLog ?? []).findLast?.((entry) => entry?.error);
  if (failedPly?.error) {
    lines.push(
      `failed ply: ${failedPly.ply ?? '?'} engine=${failedPly.engine ?? '?'}`,
    );
    if (!errorSeats.length) {
      lines.push(`  reason: ${failedPly.error}`);
    }
  }

  return lines;
}
