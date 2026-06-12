/** Handle sync or async onBestMove return values from engine clients. */
export function resolveOnBestMoveResult(client, result) {
  if (result != null && typeof result.then === 'function') {
    void result.then((resolved) => resolveOnBestMoveResult(client, resolved));
    return;
  }
  if (result === 'stale') {
    client.clearQueuedSearches?.();
    return;
  }
  if (result === false) {
    client.clearQueuedSearches?.();
    return;
  }
  client.drainQueuedRequest?.();
}
