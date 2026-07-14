import { playerColorName } from './playerColors.js';

/** Seat index (0|1) with a recorded engine error, or -1. */
export function erroredSeatIndex(state) {
  const errors = state.engineErrors ?? {};
  for (let seat = 0; seat < 2; seat++) {
    if (errors[seat]) {
      return seat;
    }
  }
  return -1;
}

/** Headline for the board terminal overlay or moves-card result line. */
export function formatGameEndHeadline(state) {
  const recovery = state.engineRecovery;
  if (state.gameHalted && recovery?.active) {
    const seat =
      recovery.seatIndex >= 0 ? recovery.seatIndex : erroredSeatIndex(state);
    const attempt = recovery.attempt ?? 0;
    const max = recovery.max ?? 10;
    if (seat >= 0) {
      return `Game halted — ${playerColorName(seat + 1)} engine error (retry ${attempt}/${max})`;
    }
    return `Game halted — engine error (retry ${attempt}/${max})`;
  }
  if (state.gameHalted) {
    const seat = erroredSeatIndex(state);
    if (seat >= 0) {
      return `Game halted — ${playerColorName(seat + 1)} engine error`;
    }
    return 'Game halted';
  }
  const errored = erroredSeatIndex(state);
  if (errored >= 0 && !state.winner && !state.isDraw) {
    return `Game halted — ${playerColorName(errored + 1)} engine error`;
  }
  if (state.isDraw) {
    return 'Draw — threefold repetition';
  }
  if (!state.winner) {
    return null;
  }
  const name = playerColorName(state.winner);
  if (state.endReason === 'time') {
    return `${name} wins on time`;
  }
  if (state.endReason === 'resignation') {
    return `${name} wins by resignation`;
  }
  return `${name} wins!`;
}

export function terminalOverlayShowsCopyLogs(state) {
  return (
    !!state.gameHalted ||
    erroredSeatIndex(state) >= 0 ||
    state.endReason === 'engine_error'
  );
}
