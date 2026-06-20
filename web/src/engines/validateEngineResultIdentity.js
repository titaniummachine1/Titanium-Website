import { EngineBackendKind } from './engineBackend.js';

/**
 * Validate that an engine result still matches the active request context.
 * Remote-only fields (connectionEpoch, syncState) are checked only for REMOTE_WS.
 */
export function validateEngineResultIdentity({
  engineEntry,
  resultContext,
  currentContext,
}) {
  const common = [
    ['requestSeq', 'stale-request-seq'],
    ['gameGeneration', 'stale-generation'],
    ['positionKey', 'stale-position'],
    ['seatIndex', 'wrong-seat'],
    ['sideToMove', 'wrong-side'],
    ['engineId', 'wrong-engine'],
  ];

  for (const [field, reason] of common) {
    if (resultContext[field] !== currentContext[field]) {
      return { ok: false, reason };
    }
  }

  if (engineEntry?.backend === EngineBackendKind.REMOTE_WS) {
    if (resultContext.connectionEpoch !== currentContext.connectionEpoch) {
      return { ok: false, reason: 'stale-connection' };
    }
    if (currentContext.syncState !== 'SYNCED') {
      return { ok: false, reason: 'remote-desynced' };
    }
  }

  return { ok: true };
}
