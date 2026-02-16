/**
 * Power Surge Types
 * Definitions for the Power Surge round boost feature
 * 
 * Power Surge cards appear at the start of each round in FightScene.
 * Players can choose one card by clicking and confirming via Kaspa transaction.
 * Effects last for ONE round only.
 */

// =============================================================================
// CARD DEFINITIONS
// =============================================================================

/**
 * Unique identifier for each Power Surge card.
 */
export type PowerSurgeCardId =
  | "dag-overclock"
  | "block-fortress"
  | "tx-storm"
  | "mempool-congest"
  | "blue-set-heal"
  | "orphan-smasher"
  | "10bps-barrage"
  | "pruned-rage"
  | "sompi-shield"
  | "hash-hurricane"
  | "ghost-dag"
  | "finality-fist"
  | "bps-blitz"
  | "vaultbreaker"
  | "chainbreaker";

/**
 * Rarity tier for visual styling.
 */
export type PowerSurgeRarity = "common" | "rare" | "epic" | "legendary";

/**
 * Power Surge card definition with all display and effect data.
 */
export interface PowerSurgeCard {
  /** Unique identifier */
  id: PowerSurgeCardId;
  /** Display name */
  name: string;
  /** Short description of effect */
  description: string;
  /** Neon border color (hex) */
  glowColor: number;
  /** Icon key for Phaser (e.g., "surge_dag_overclock") */
  iconKey: string;
  /** Effect type for combat engine */
  effectType: PowerSurgeEffectType;
  /** Effect parameters */
  effectParams: PowerSurgeEffectParams;
}

// =============================================================================
// EFFECT TYPES
// =============================================================================

/**
 * Categories of power surge effects.
 */
export type PowerSurgeEffectType =
  | "damage_multiplier"    // Multiply damage dealt
  | "damage_reduction"     // Reduce incoming damage
  | "hp_regen"            // Restore HP
  | "damage_reflect"      // Reflect damage when blocking
  | "priority_boost"      // Move goes first
  | "energy_burn"         // Burn opponent energy on hit
  | "conditional_heal"    // Heal on condition
  | "counter_multiplier"  // Multiplied counter damage
  | "double_hit"          // Attacks hit twice
  | "fury_boost"          // Boost fury/damage meter (+ damage, can't block)
  | "damage_immunity"     // Immune to all damage
  | "random_win"          // Random move auto-wins / dodge chance
  | "invisible_move"      // Move cannot be countered
  | "critical_special"    // Guaranteed crit on special
  | "energy_regen"        // Bonus energy regen
  | "energy_regen_with_cost" // Energy regen with HP cost
  | "energy_steal"        // Steal opponent energy
  | "opponent_stun"       // Stun opponent next move
  | "lifesteal"           // Heal for % of damage dealt
  | "energy_drain"        // Passive energy drain from opponent
  | "guard_break";        // Break guard on any hit

/**
 * Parameters for power surge effects.
 */
export interface PowerSurgeEffectParams {
  /** Damage multiplier (e.g., 1.5 for +50%) */
  damageMultiplier?: number;
  /** Incoming damage reduction (0.6 = take 60% less damage) */
  incomingDamageReduction?: number;
  /** HP amount to restore */
  hpRestore?: number;
  /** HP regen per turn */
  hpRegen?: number;
  /** HP cost to pay */
  hpCost?: number;
  /** Damage reflect percentage (0-1) */
  reflectPercent?: number;
  /** Priority boost amount */
  priorityBoost?: number;
  /** Energy to burn on hit */
  energyBurn?: number;
  /** Moves affected (e.g., ["punch", "kick"]) */
  affectedMoves?: string[];
  /** Counter damage multiplier */
  counterMultiplier?: number;
  /** Fury meter boost */
  furyBoost?: number;
  /** Energy to steal */
  energySteal?: number;
  /** Energy regen bonus per turn */
  energyRegenBonus?: number;
  /** Random win chance (0-1) */
  randomWinChance?: number;
  /** Disable block for this player */
  blockDisabled?: boolean;
  /** Disable block for opponent */
  opponentBlockDisabled?: boolean;
  /** Percentage of damage converted to HP */
  lifestealPercent?: number;
  /** Energy drained from opponent */
  energyDrain?: number;
  /** Extra energy cost for move */
  energyCostBonus?: number;
}

// =============================================================================
// CARD CATALOG
// =============================================================================

/**
 * Complete catalog of all 15 Power Surge cards.
 */
export const POWER_SURGE_CARDS: readonly PowerSurgeCard[] = [
  {
    id: "dag-overclock",
    name: "DAG Overclock",
    description: "+40% damage dealt",
    glowColor: 0x00ff88,
    iconKey: "surge_dag-overclock",
    effectType: "damage_multiplier",
    effectParams: { damageMultiplier: 1.4, incomingDamageReduction: 0.0 },
  },
  {
    id: "block-fortress",
    name: "Block Fortress",
    description: "Blocks reflect 120% damage",
    glowColor: 0x00ffff,
    iconKey: "surge_block-fortress",
    effectType: "damage_reflect",
    effectParams: { reflectPercent: 1.2 },
  },
  {
    id: "tx-storm",
    name: "Tx Tempo",
    description: "+2 priority on all clashes this round",
    glowColor: 0xffff00,
    iconKey: "surge_tx-storm",
    effectType: "priority_boost",
    effectParams: { priorityBoost: 2 },
  },
  {
    id: "mempool-congest",
    name: "Mempool Mirror",
    description: "While blocking, reflect 75% incoming damage",
    glowColor: 0xff4400,
    iconKey: "surge_mempool-burn",
    effectType: "damage_reflect",
    effectParams: { reflectPercent: 0.75 },
  },
  {
    id: "blue-set-heal",
    name: "Blue Set Heal",
    description: "Restore 10 HP over time",
    glowColor: 0x0088ff,
    iconKey: "surge_blue-set-heal",
    effectType: "hp_regen",
    effectParams: { hpRegen: 10 },
  },
  {
    id: "orphan-smasher",
    name: "Orphan Smasher",
    description: "Counter deals +75% damage",
    glowColor: 0xff0044,
    iconKey: "surge_orphan-smasher",
    effectType: "counter_multiplier",
    effectParams: { counterMultiplier: 1.75 },
  },
  {
    id: "10bps-barrage",
    name: "10BPS Barrage",
    description: "Punch hits twice",
    glowColor: 0x00ff44,
    iconKey: "surge_10bps-barrage",
    effectType: "double_hit",
    effectParams: { affectedMoves: ["punch"] },
  },
  {
    id: "pruned-rage",
    name: "Pruned Rage",
    description: "+30% damage, opponent can't block",
    glowColor: 0xff4444,
    iconKey: "surge_pruned-rage",
    effectType: "fury_boost",
    effectParams: { damageMultiplier: 1.3, opponentBlockDisabled: true },
  },
  {
    id: "sompi-shield",
    name: "Sompi Shield",
    description: "Take 45% less damage",
    glowColor: 0xffd700,
    iconKey: "surge_sompi-shield",
    effectType: "damage_reduction",
    effectParams: { incomingDamageReduction: 0.45 },
  },
  {
    id: "hash-hurricane",
    name: "Hash Hurricane",
    description: "35% chance to dodge attack",
    glowColor: 0x8800ff,
    iconKey: "surge_hash-hurricane",
    effectType: "random_win",
    effectParams: { randomWinChance: 0.35 },
  },
  {
    id: "ghost-dag",
    name: "GhostDAG",
    description: "Your attacks can't be countered",
    glowColor: 0x666699,
    iconKey: "surge_ghost-dag",
    effectType: "invisible_move",
    effectParams: {},
  },
  {
    id: "finality-fist",
    name: "Finality Fist",
    description: "Special always crits at +70% damage",
    glowColor: 0xff00ff,
    iconKey: "surge_finality-fist",
    effectType: "critical_special",
    effectParams: { damageMultiplier: 1.7 },
  },
  {
    id: "bps-blitz",
    name: "BPS Syphon",
    description: "Heal for 35% of damage dealt",
    glowColor: 0x44ff88,
    iconKey: "surge_bps-blitz",
    effectType: "lifesteal",
    effectParams: { lifestealPercent: 0.35 },
  },
  {
    id: "vaultbreaker",
    name: "Vaultbreaker Rush",
    description: "Kick hits twice",
    glowColor: 0xffaa00,
    iconKey: "surge_vaultbreaker",
    effectType: "double_hit",
    effectParams: { affectedMoves: ["kick"] },
  },
  {
    id: "chainbreaker",
    name: "Chainbreaker",
    description: "Bypass block, +15% damage",
    glowColor: 0xff0000,
    iconKey: "surge_chainbreaker",
    effectType: "guard_break",
    effectParams: { damageMultiplier: 1.15 },
  },
] as const;

/**
 * Get a card by its ID.
 */
export function getPowerSurgeCard(id: PowerSurgeCardId): PowerSurgeCard | undefined {
  return POWER_SURGE_CARDS.find((card) => card.id === id);
}

/**
 * Get random cards for a round.
 * @param count Number of cards to select (default 3)
 * @param excludeIds Card IDs to exclude (e.g., cards used in previous rounds)
 */
export function getRandomPowerSurgeCards(count: number = 3, excludeIds: PowerSurgeCardId[] = []): PowerSurgeCard[] {
  const available = POWER_SURGE_CARDS.filter((card) => !excludeIds.includes(card.id));
  const shuffled = [...available].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(count, shuffled.length));
}

/**
 * Deterministic card selection for synchronized private rounds.
 * Produces the same card deck for all clients given the same match + round.
 */
export function getDeterministicPowerSurgeCards(
  matchId: string,
  roundNumber: number,
  count: number = 3,
): PowerSurgeCard[] {
  const normalized = `${matchId}:${roundNumber}`;
  let hash = 2166136261;

  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  const available = [...POWER_SURGE_CARDS];
  const selected: PowerSurgeCard[] = [];
  const targetCount = Math.min(count, available.length);

  for (let pick = 0; pick < targetCount; pick += 1) {
    const seed = Math.abs(hash + pick * 1013904223);
    const nextIndex = seed % available.length;
    selected.push(available[nextIndex]);
    available.splice(nextIndex, 1);
  }

  return selected;
}

// =============================================================================
// MATCH STATE TYPES
// =============================================================================

/**
 * Power surge state for a single round.
 */
export interface RoundSurgeState {
  /** Round number (1-5) */
  roundNumber: number;
  /** Cards offered this round */
  offeredCards: PowerSurgeCardId[];
  /** Player 1's selection (null if not chosen) */
  player1Selection: PowerSurgeCardId | null;
  /** Player 1's transaction ID (null if not confirmed) */
  player1TxId: string | null;
  /** Player 2's selection (null if not chosen) */
  player2Selection: PowerSurgeCardId | null;
  /** Player 2's transaction ID (null if not confirmed) */
  player2TxId: string | null;
  /** Timestamp when cards were shown */
  shownAt: number;
  /** Deadline for selection (shownAt + 15000ms) */
  selectionDeadline: number;
}

/**
 * Complete power surge state for a match.
 */
export interface MatchSurgeState {
  /** Surge state per round */
  rounds: RoundSurgeState[];
  /** Cards used in previous rounds (to avoid repeats if desired) */
  usedCards: PowerSurgeCardId[];
}

/**
 * Payload for power surge selection event.
 */
export interface PowerSurgeSelectedPayload {
  /** Match ID */
  matchId: string;
  /** Round number */
  roundNumber: number;
  /** Player who selected */
  player: "player1" | "player2";
  /** Selected card ID */
  cardId: PowerSurgeCardId;
  /** Transaction ID */
  txId: string;
  /** Timestamp */
  timestamp: number;
}

/**
 * Payload for power surge cards shown event.
 */
export interface PowerSurgeCardsPayload {
  /** Match ID */
  matchId: string;
  /** Round number */
  roundNumber: number;
  /** Offered card IDs */
  cardIds: PowerSurgeCardId[];
  /** Selection deadline timestamp */
  deadline: number;
}

// =============================================================================
// TRANSACTION PAYLOAD
// =============================================================================

/**
 * Encode power surge selection as transaction payload.
 * Format: "surge:cardId|matchId|roundNumber"
 */
export function encodeSurgePayload(cardId: PowerSurgeCardId, matchId: string, roundNumber: number): string {
  return `surge:${cardId}|${matchId.substring(0, 8)}|${roundNumber}`;
}

/**
 * Decode power surge transaction payload.
 */
export function decodeSurgePayload(payload: string): { cardId: string; matchIdPrefix: string; roundNumber: number } | null {
  if (!payload.startsWith("surge:")) return null;
  const parts = payload.substring(6).split("|");
  if (parts.length !== 3) return null;
  return {
    cardId: parts[0],
    matchIdPrefix: parts[1],
    roundNumber: parseInt(parts[2], 10),
  };
}
