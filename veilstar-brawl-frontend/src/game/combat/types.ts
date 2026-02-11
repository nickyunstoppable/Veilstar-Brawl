/**
 * Combat Types for Veilstar Brawl
 */

import type { MoveType } from "@/types/game";

// =============================================================================
// CHARACTER COMBAT STATS
// =============================================================================

export type CharacterArchetype = "speed" | "tank" | "tech" | "precision";

export interface CharacterCombatStats {
  characterId: string;
  archetype: CharacterArchetype;
  maxHp: number;
  maxEnergy: number;
  energyRegen: number;
  damageModifiers: Record<string, number>;
  blockEffectiveness: number;
  specialCostModifier: number;
}

// =============================================================================
// MOVE STATS
// =============================================================================

export interface MoveStats {
  damage: number;
  energyCost: number;
  priority: number;
}

export const BASE_MOVE_STATS: Record<string, MoveStats> = {
  punch: { damage: 12, energyCost: 0, priority: 2 },
  kick: { damage: 18, energyCost: 15, priority: 1 },
  block: { damage: 0, energyCost: 5, priority: 3 },
  special: { damage: 30, energyCost: 35, priority: 0 },
  stunned: { damage: 0, energyCost: 0, priority: -1 },
};

// =============================================================================
// TURN RESOLUTION
// =============================================================================

export type MoveOutcome =
  | "hit"
  | "missed"
  | "guarding"
  | "stunned"
  | "staggered"
  | "reflected"
  | "shattered"
  | "clash";

export type TurnEffect =
  | "stun"
  | "stagger"
  | "guard_break"
  | "guard_up"
  | "critical";

export interface PlayerTurnResult {
  move: MoveType;
  outcome: MoveOutcome;
  damageDealt: number;
  damageTaken: number;
  energySpent: number;
  guardBuildup: number;
  effects: TurnEffect[];
  hpRegen?: number;
  lifesteal?: number;
  energyDrained?: number;
}

export interface TurnResult {
  player1: PlayerTurnResult;
  player2: PlayerTurnResult;
  narrative: string;
}

// =============================================================================
// COMBAT STATE
// =============================================================================

export interface PlayerCombatState {
  characterId: string;
  hp: number;
  maxHp: number;
  energy: number;
  maxEnergy: number;
  guardMeter: number;
  isStunned: boolean;
  isStaggered: boolean;
  roundsWon: number;
}

export interface CombatState {
  player1: PlayerCombatState;
  player2: PlayerCombatState;
  currentRound: number;
  currentTurn: number;
  matchFormat: "best_of_1" | "best_of_3" | "best_of_5";
  roundsToWin: number;
  isRoundOver: boolean;
  isMatchOver: boolean;
  roundWinner: "player1" | "player2" | null;
  matchWinner: "player1" | "player2" | null;
}

// =============================================================================
// RESOLUTION MATRIX
// =============================================================================

/**
 * Rock-Paper-Scissors resolution matrix
 * Punch > Special, Kick > Punch, Block > Kick (reflects), Special > Block (shatters)
 */
export const RESOLUTION_MATRIX: Record<string, Record<string, MoveOutcome>> = {
  punch: {
    punch: "clash",
    kick: "missed",
    block: "guarding",
    special: "hit",
    stunned: "hit",
  },
  kick: {
    punch: "hit",
    kick: "clash",
    block: "reflected",
    special: "missed",
    stunned: "hit",
  },
  block: {
    punch: "guarding",
    kick: "guarding",
    block: "clash",
    special: "shattered",
    stunned: "guarding",
  },
  special: {
    punch: "missed",
    kick: "hit",
    block: "hit",
    special: "clash",
    stunned: "hit",
  },
  stunned: {
    punch: "stunned",
    kick: "stunned",
    block: "stunned",
    special: "stunned",
    stunned: "stunned",
  },
};

// =============================================================================
// COMBAT CONSTANTS
// =============================================================================

export const COMBAT_CONSTANTS = {
  GUARD_BUILDUP_ON_BLOCK: 25,
  GUARD_BUILDUP_ON_HIT: 15,
  GUARD_BREAK_THRESHOLD: 100,
  STAGGER_DAMAGE_REDUCTION: 0.7,
  KICK_REFLECT_PERCENT: 0.3,
  SHATTER_DAMAGE_MULTIPLIER: 1.5,
};
