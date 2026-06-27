import { TitaniumOracleStatus } from './titaniumOracleResult.js';

/**
 * Hard legality gate: canonical first, then Titanium WASM oracle.
 * Oracle UNAVAILABLE is never reported as titanium-illegal.
 */
export async function validateMoveLegality({
  move,
  canonicalLegalMoves,
  titaniumOracle,
  historyTokens,
  positionKey,
  signal,
  trustCanonicalOnly = false,
}) {
  const canonicalSet =
    canonicalLegalMoves instanceof Set
      ? canonicalLegalMoves
      : new Set(canonicalLegalMoves);

  if (!canonicalSet.has(move)) {
    return {
      ok: false,
      reason: 'canonical-illegal',
      titanium: null,
    };
  }

  if (trustCanonicalOnly) {
    return {
      ok: true,
      reason: null,
      titanium: null,
    };
  }

  const titanium = await titaniumOracle.legalMoves({
    historyTokens,
    positionKey,
    signal,
  });

  if (titanium.status === TitaniumOracleStatus.UNAVAILABLE) {
    // Oracle crashed or is unavailable — do not block a canonical-legal move.
    // The canonical JS check already passed; oracle failure is not proof of illegality.
    return {
      ok: true,
      reason: 'titanium-oracle-unavailable',
      titanium,
    };
  }

  if (titanium.status === TitaniumOracleStatus.INVALID_POSITION) {
    return {
      ok: false,
      reason: 'titanium-position-invalid',
      titanium,
    };
  }

  if (!titanium.moves.has(move)) {
    return {
      ok: false,
      reason: 'titanium-illegal',
      titanium,
    };
  }

  return {
    ok: true,
    reason: null,
    titanium,
  };
}
