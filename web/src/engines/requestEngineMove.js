import { createAbortError } from '../lib/engineAbort.js';
import { EngineBackendKind } from './engineBackend.js';

async function requestLocalMove({ engineEntry, controller, request }) {
  if (!controller) {
    throw new Error(`Missing local controller: ${engineEntry.id}`);
  }
  if (request.signal?.aborted) {
    throw createAbortError();
  }

  return controller.requestMove({
    aiSettings: request.aiSettings,
    gameSnapshot: request.gameSnapshot,
    moveHistory: request.history,
    isFreshGame: request.isFreshGame,
    positionKey: request.positionKey,
    requestSeq: request.requestSeq,
    signal: request.signal,
    onLiveUpdate: request.onLiveUpdate,
  });
}

async function requestRemoteMove({ engineEntry, controller, request }) {
  if (!controller) {
    throw new Error(`Missing remote controller: ${engineEntry.id}`);
  }

  await controller.ensureSynchronized({
    history: request.history,
    positionKey: request.positionKey,
    requestSeq: request.requestSeq,
    gameGeneration: request.gameGeneration,
    gameSnapshot: request.gameSnapshot,
    isFreshGame: request.isFreshGame,
    signal: request.signal,
  });

  if (request.signal?.aborted) {
    throw createAbortError();
  }

  return controller.requestMove({
    aiSettings: request.aiSettings,
    gameSnapshot: request.gameSnapshot,
    moveHistory: request.history,
    isFreshGame: request.isFreshGame,
    positionKey: request.positionKey,
    requestSeq: request.requestSeq,
    signal: request.signal,
    onLiveUpdate: request.onLiveUpdate,
  });
}

export async function requestEngineMove({ engineEntry, controller, request }) {
  switch (engineEntry.backend) {
    case EngineBackendKind.LOCAL_JS:
    case EngineBackendKind.LOCAL_WASM:
      return requestLocalMove({ engineEntry, controller, request });

    case EngineBackendKind.REMOTE_WS:
      return requestRemoteMove({ engineEntry, controller, request });

    case EngineBackendKind.HUMAN:
      throw new Error('Engine request attempted for Human');

    default:
      throw new Error(
        `Unknown backend for ${engineEntry.id}: ${engineEntry.backend}`,
      );
  }
}
