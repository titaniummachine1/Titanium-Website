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
  if (state.gameHalted) {
    const seat = erroredSeatIndex(state);
    if (seat >= 0) {
      return `Game halted — ${playerColorName(seat + 1)} engine error`;
    }
    return 'Game halted';
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
