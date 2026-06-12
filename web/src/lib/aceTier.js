/**
 * ACE v10 — one player slot; strength slider picks implementation tier.
 * Left (Beg/Inter) = JS reference · Mid = Rust · Right = MoveGen+ / PMC
 */

import { StrengthLevel } from './engineConfig.js';

/** Ordered weakest → strongest (matches strength slider left → right). */
export const ACE_V10_STRENGTH_TIERS = [
  {
    maxStrength: StrengthLevel.Intermediate,
    kind: 'ace-v10-js',
    engineMode: 'ace-v10-js',
    shortLabel: 'JS',
    tooltip: 'Original quoridor (8).html engine in a Web Worker — reference baseline',
  },
  {
    maxStrength: StrengthLevel.Advanced,
    kind: 'ace',
    engineMode: 'ace-v10',
    shortLabel: 'Rust',
    tooltip: 'Rust 1:1 port of ACE v10 (HalfPW eval, iterative deepening)',
  },
  {
    maxStrength: StrengthLevel.Expert,
    kind: 'ace',
    engineMode: 'ace-v10-ti',
    shortLabel: 'MoveGen+',
    tooltip: 'ACE v10 Rust with Titanium legal-move generation in search',
  },
  {
    maxStrength: StrengthLevel.Alpha,
    kind: 'ace',
    engineMode: 'ace-v10-ti-pmc',
    shortLabel: 'MoveGen+ PMC',
    tooltip: 'ACE v10 + Titanium movegen + pseudo-MCTS root verification',
  },
];

export function resolveAceV10Tier(strengthLevel) {
  const level = Number(strengthLevel ?? StrengthLevel.Intermediate);
  for (const tier of ACE_V10_STRENGTH_TIERS) {
    if (level <= tier.maxStrength) {
      return tier;
    }
  }
  return ACE_V10_STRENGTH_TIERS[ACE_V10_STRENGTH_TIERS.length - 1];
}

export function aceV10TierLabel(strengthLevel) {
  return resolveAceV10Tier(strengthLevel).shortLabel;
}

export function aceV10DisplayName(strengthLevel) {
  return `ACE v10 · ${aceV10TierLabel(strengthLevel)}`;
}
