/** Shared abort helpers for engine search clients. */

export function createAbortError(message = 'Search aborted') {
  if (typeof DOMException !== 'undefined') {
    return new DOMException(message, 'AbortError');
  }
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

export function isAbortError(err, signal) {
  if (signal?.aborted) {
    return true;
  }
  if (!err) {
    return false;
  }
  if (err.name === 'AbortError') {
    return true;
  }
  if (err.code === 20) {
    return true;
  }
  const message = String(err.message ?? '');
  if (/abort/i.test(message)) {
    return true;
  }
  // Native session proxy rejects in-flight `go` with Error('stop') on cancel — not a user error.
  return message === 'stop' || message === 'stopped' || message === 'client disconnected';
}

/**
 * Cancel one active search request without touching a newer request's controller.
 */
export function cancelActiveSearchRequest(active) {
  if (!active) {
    return;
  }
  const controller = active.abortController;
  if (controller && !controller.signal.aborted) {
    controller.abort();
  }
}
