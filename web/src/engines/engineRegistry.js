/**
 * Single source of truth for engine metadata and backend classification.
 */

import { PlayerType } from '../lib/engineConfig.js';
import { resolveAceTier } from '../lib/aceTier.js';
import { EngineBackendKind } from './engineBackend.js';

function aceBackendForTier(strengthLevel, playerType) {
  const tier = resolveAceTier(strengthLevel, playerType);
  if (tier.kind.endsWith('-js')) {
    return EngineBackendKind.LOCAL_JS;
  }
  return EngineBackendKind.LOCAL_WASM;
}

export const ENGINE_REGISTRY = new Map([
  [
    PlayerType.Human,
    {
      id: PlayerType.Human,
      displayName: 'Human',
      backend: EngineBackendKind.HUMAN,
      capabilities: {
        remoteSync: false,
        livePv: false,
        playNow: false,
        abort: false,
      },
      controls: {},
    },
  ],
  [
    PlayerType.GorisansonMCTS,
    {
      id: PlayerType.GorisansonMCTS,
      displayName: 'Gorisanson (JS, original)',
      backend: EngineBackendKind.LOCAL_JS,
      capabilities: {
        remoteSync: false,
        livePv: false,
        playNow: false,
        abort: false,
      },
      controls: { timeSlider: true },
    },
  ],
  [
    PlayerType.QuoridorV3,
    {
      id: PlayerType.QuoridorV3,
      displayName: 'Quoridor v3 (JS αβ)',
      backend: EngineBackendKind.LOCAL_JS,
      capabilities: {
        remoteSync: false,
        livePv: false,
        playNow: false,
        abort: false,
      },
      controls: { timeSlider: true },
    },
  ],
  [
    PlayerType.TitaniumMinimax,
    {
      id: PlayerType.TitaniumMinimax,
      displayName: 'Titanium v16',
      backend: EngineBackendKind.LOCAL_WASM,
      capabilities: {
        remoteSync: false,
        livePv: true,
        playNow: true,
        abort: true,
      },
      controls: { timeSlider: true, nodes: true, strength: true },
    },
  ],
  [
    PlayerType.TitaniumV15Frozen,
    {
      id: PlayerType.TitaniumV15Frozen,
      displayName: 'Titanium v16 (Frozen)',
      backend: EngineBackendKind.LOCAL_WASM,
      capabilities: {
        remoteSync: false,
        livePv: true,
        playNow: true,
        abort: true,
      },
      controls: { timeSlider: true, nodes: true },
    },
  ],
  [
    PlayerType.AceV13,
    {
      id: PlayerType.AceV13,
      displayName: 'ACE v13',
      backend: EngineBackendKind.LOCAL_JS,
      resolveBackend: (aiSettings) => aceBackendForTier(aiSettings?.strengthLevel, PlayerType.AceV13),
      capabilities: {
        remoteSync: false,
        livePv: true,
        playNow: true,
        abort: true,
      },
      controls: { timeSlider: true, strength: true },
    },
  ],
  [
    PlayerType.ZeroInk,
    {
      id: PlayerType.ZeroInk,
      displayName: 'zero.ink (AlphaZero)',
      // Stateless REST; treated as a local backend (no WS session sync).
      backend: EngineBackendKind.LOCAL_JS,
      capabilities: {
        remoteSync: false,
        livePv: true,
        playNow: false,
        abort: true,
      },
      // Discrete difficulty (Time preset → visits map), same as the cloud engines.
      controls: { thinkingMode: true },
    },
  ],
  [
    PlayerType.KaAI,
    {
      id: PlayerType.KaAI,
      displayName: 'Ka',
      backend: EngineBackendKind.REMOTE_WS,
      capabilities: {
        remoteSync: true,
        livePv: true,
        playNow: false,
        abort: true,
      },
      controls: { thinkingMode: true },
    },
  ],
  [
    PlayerType.IshtarV3,
    {
      id: PlayerType.IshtarV3,
      displayName: 'Ishtar',
      backend: EngineBackendKind.REMOTE_WS,
      capabilities: {
        remoteSync: true,
        livePv: true,
        playNow: false,
        abort: true,
      },
      controls: { thinkingMode: true },
    },
  ],
]);

export function getEngineEntry(engineId) {
  return ENGINE_REGISTRY.get(engineId) ?? null;
}

export function resolveEngineBackend(entry, aiSettings) {
  if (!entry) {
    return null;
  }
  if (typeof entry.resolveBackend === 'function') {
    return entry.resolveBackend(aiSettings);
  }
  return entry.backend;
}

export function getEngineEntryForPlayer(playerType, aiSettings = null) {
  const entry = getEngineEntry(playerType);
  if (!entry) {
    return null;
  }
  return {
    ...entry,
    backend: resolveEngineBackend(entry, aiSettings),
  };
}
