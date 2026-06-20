/** Structured AI request lifecycle logging (no secrets). */

export function logAiRequestEvent(event, fields = {}) {
  const payload = { event, ...fields };
  if (payload.signal?.aborted != null) {
    payload.signalAborted = payload.signal.aborted;
    delete payload.signal;
  }
  console.debug('[AI]', payload);
}
