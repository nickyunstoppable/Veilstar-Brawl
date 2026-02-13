/**
 * Combat Types for KaspaClash
 * Core type definitions for the turn-based fighting system
 */

import type { MoveType } from "@/types/game";

// =============================================================================
// CHARACTER COMBAT STATS
// =============================================================================

/**
 * Combat-specific stats for a character.
 */
export interface CharacterCombatStats {
    /** Character class/role for counter system */
    archetype: CharacterArchetype;
    /** Base health points */
    maxHp: number;
    /** Base energy pool */
    maxEnergy: number;
    /** Damage modifiers per move type (multiplier, 1.0 = 100%) */
    damageModifiers: Record<MoveType, number>;
    /** Block effectiveness (damage reduction multiplier) */
    blockEffectiveness: number;
    /** Special move cost modifier (multiplier) */
    specialCostModifier: number;
    /** Energy regeneration per turn */
    energyRegen: number;
}

/**
 * Character Archetypes for the Counter System.
 * Cycle: Speed > Tech > Tank > Precision > Speed
 */
export type CharacterArchetype = "speed" | "tank" | "tech" | "precision";

// =============================================================================
// MOVE DEFINITIONS
// =============================================================================

/**
 * Base stats for each move type.
 */
export interface MoveStats {
    damage: number;
    energyCost: number;
    /** Priority: higher = faster (used for same-speed resolution) */
    priority: number;
}

/**
 * Default move stats (before character modifiers).
 */
export const BASE_MOVE_STATS: Record<MoveType, MoveStats> = {
    punch: { damage: 10, energyCost: 0, priority: 3 },
    kick: { damage: 15, energyCost: 25, priority: 2 },
    block: { damage: 0, energyCost: 0, priority: 4 },
    special: { damage: 25, energyCost: 50, priority: 1 },
    stunned: { damage: 0, energyCost: 0, priority: 0 },
};

// =============================================================================
// TURN RESOLUTION
// =============================================================================

/**
 * Result of a move interaction (what happened to a player).
 */
export type MoveOutcome =
    | "hit"
    | "blocked"
    | "stunned"
    | "staggered"
    | "reflected"
    | "shattered"
    | "missed"
    | "guarding";

/**
 * Result for a single player in a turn.
 */
export interface PlayerTurnResult {
    move: MoveType;
    outcome: MoveOutcome;
    damageDealt: number;
    damageTaken: number;
    energySpent: number;
    guardBuildup: number;
    effects: TurnEffect[];
    /** HP regenerated this turn (from Blue Set Heal, etc.) */
    hpRegen?: number;
    /** HP gained from lifesteal this turn */
    lifesteal?: number;
    /** Energy drained by opponent's surge effects (GhostDAG, etc.) */
    energyDrained?: number;
}

/**
 * Effects applied after a turn.
 */
export type TurnEffect =
    | "stun"
    | "stagger"
    | "guard_break"
    | "guard_up";

/**
 * Complete turn resolution result.
 */
export interface TurnResult {
    player1: PlayerTurnResult;
    player2: PlayerTurnResult;
    /** Description of what happened */
    narrative: string;
}

// =============================================================================
// GAME STATE
// =============================================================================

/**
 * Current state of a player during combat.
 */
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

/**
 * Current state of the combat.
 */
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
// MOVE RESOLUTION MATRIX
// =============================================================================

/**
 * Resolution matrix: [attacker move][defender move] = attacker outcome
 * This defines the rock-paper-scissors interactions.
 */
export type ResolutionMatrix = Record<MoveType, Record<MoveType, MoveOutcome>>;

/**
 * The game's resolution matrix.
 * Punch > Special, Kick > Punch, Block > Kick, Special > Block
 */
export const RESOLUTION_MATRIX: ResolutionMatrix = {
    punch: {
        punch: "hit",
        kick: "staggered",
        block: "blocked",
        special: "hit",
        stunned: "hit",
    },
    kick: {
        punch: "hit",
        kick: "hit",
        block: "reflected",
        special: "hit",
        stunned: "hit",
    },
    block: {
        punch: "guarding",
        kick: "guarding",
        block: "guarding",
        special: "shattered",
        stunned: "guarding",
    },
    special: {
        punch: "missed",
        kick: "hit",
        block: "hit",
        special: "hit",
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
// CONSTANTS
// =============================================================================

export const COMBAT_CONSTANTS = {
    BASE_ENERGY_REGEN: 20,
    GUARD_BUILDUP_ON_BLOCK: 25,
    GUARD_BUILDUP_ON_HIT: 15,
    GUARD_BREAK_THRESHOLD: 100,
    SHATTER_DAMAGE_MULTIPLIER: 1.5,
    BLOCK_DAMAGE_REDUCTION: 0.5,
    KICK_REFLECT_PERCENT: 0.3,
    STAGGER_DAMAGE_REDUCTION: 0.5,
};
