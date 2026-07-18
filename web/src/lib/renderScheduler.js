/**
 * Coalesce UI renders through requestAnimationFrame with a minimum interval
 * so bursts of controller callbacks cannot flood the main thread.
 */

export function createRenderScheduler({
  onFrame,
  uiIntervalMs = 100,
  animIntervalMs = 42,
} = {}) {
  if (typeof onFrame !== 'function') {
    throw new Error('createRenderScheduler requires onFrame');
  }

  let rafId = 0;
  /** @type {'full' | 'live' | 'anim' | null} */
  let pendingKind = null;
  let lastUiAt = 0;
  let lastAnimAt = 0;

  function rank(kind) {
    if (kind === 'full') return 3;
    if (kind === 'live') return 2;
    return 1;
  }

  function mergeKind(next) {
    if (!pendingKind || rank(next) > rank(pendingKind)) {
      pendingKind = next;
    }
  }

  function schedule(kind) {
    mergeKind(kind);
    if (rafId) return;
    rafId = requestAnimationFrame(flush);
  }

  function flush(now) {
    rafId = 0;
    const kind = pendingKind ?? 'live';
    pendingKind = null;
    const interval = kind === 'anim' ? animIntervalMs : uiIntervalMs;
    const lastAt = kind === 'anim' ? lastAnimAt : lastUiAt;
    const ts = typeof now === 'number' ? now : performance.now();
    if (ts - lastAt < interval) {
      mergeKind(kind);
      rafId = requestAnimationFrame(flush);
      return;
    }
    if (kind === 'anim') {
      lastAnimAt = ts;
    } else {
      lastUiAt = ts;
    }
    onFrame(kind, ts);
  }

  function flushNow() {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    pendingKind = null;
    const ts = performance.now();
    lastUiAt = ts;
    onFrame('full', ts);
  }

  return {
    schedule,
    scheduleFull: () => schedule('full'),
    scheduleLive: () => schedule('live'),
    scheduleAnim: () => schedule('anim'),
    flushNow,
  };
}
