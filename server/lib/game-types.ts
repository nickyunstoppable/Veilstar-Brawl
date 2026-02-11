/**
 * Game Types — shared between server and frontend CombatEngine
 * Canonical source of truth for move properties, damage, and game constants
 */

// =============================================================================
// CORE TYPES
// =============================================================================

export type MoveType = "punch" | "kick" | "block" | "special" | "stunned";
export type PlayerRole = "player1" | "player2";
export type RoundWinner = "player1" | "player2" | "draw" | null;

export interface PlayerMoveResult {
    move: MoveType;
    damageDealt: number;
    damageTaken: number;
    moveSuccess: boolean;
}

export interface RoundResolutionResult {
    player1: PlayerMoveResult;
    player2: PlayerMoveResult;
    winner: RoundWinner;
    isKnockout: boolean;
    player1HealthAfter: number;
    player2HealthAfter: number;
    player1EnergyAfter: number;
    player2EnergyAfter: number;
    player1GuardAfter: number;
    player2GuardAfter: number;
    narrative: string;
}

export interface RoundResolutionInput {
    player1Move: MoveType;
    player2Move: MoveType;
    player1Health: number;
    player2Health: number;
    player1Energy: number;
    player2Energy: number;
    player1Guard: number;
    player2Guard: number;
}

// =============================================================================
// MOVE PROPERTIES — must match frontend CombatEngine BASE_MOVE_STATS
// =============================================================================

export interface MoveProperties {
    damage: number;
    energyCost: number;
    guardDamage: number;
    guardBuild: number;
    description: string;
}

export const MOVE_PROPERTIES: Record<MoveType, MoveProperties> = {
    punch: {
        damage: 8,
        energyCost: 0,
        guardDamage: 5,
        guardBuild: 0,
        description: "Quick strike",
    },
    kick: {
        damage: 14,
        energyCost: 15,
        guardDamage: 10,
        guardBuild: 0,
        description: "Powerful kick",
    },
    block: {
        damage: 0,
        energyCost: 0,
        guardDamage: 0,
        guardBuild: 20,
        description: "Defensive stance",
    },
    special: {
        damage: 22,
        energyCost: 40,
        guardDamage: 20,
        guardBuild: 0,
        description: "Devastating special attack",
    },
    stunned: {
        damage: 0,
        energyCost: 0,
        guardDamage: 0,
        guardBuild: 0,
        description: "Stunned — cannot act",
    },
};

// =============================================================================
// DAMAGE MULTIPLIERS
// =============================================================================

export const DAMAGE_MULTIPLIERS = {
    /** Base damage when attack beats defense */
    NORMAL: 1.0,
    /** Reduced damage when blocked */
    BLOCKED: 0.25,
    /** Bonus when guard meter is full and guard breaks */
    GUARD_BREAK: 1.5,
    /** Special vs block bonus */
    SPECIAL_VS_BLOCK: 1.2,
    /** Chip damage through block (percentage of base) */
    CHIP_DAMAGE: 0.15,
};

// =============================================================================
// GAME CONSTANTS
// =============================================================================

export const GAME_CONSTANTS = {
    /** Default starting health */
    MAX_HEALTH: 100,
    /** Default starting energy */
    MAX_ENERGY: 100,
    /** Energy regen per turn */
    ENERGY_REGEN: 8,
    /** Max guard meter */
    MAX_GUARD: 100,
    /** Rounds needed to win best-of-3 */
    ROUNDS_TO_WIN_BEST_OF_3: 2,
    /** Rounds needed to win best-of-5 */
    ROUNDS_TO_WIN_BEST_OF_5: 3,
    /** Seconds for move selection */
    MOVE_TIMER_SECONDS: 30,
    /** Seconds for character selection */
    CHARACTER_SELECT_SECONDS: 30,
    /** Countdown before round starts */
    COUNTDOWN_SECONDS: 3,
};

// =============================================================================
// MOVE ADVANTAGE TABLE
// Punch beats Kick, Kick beats Block, Block beats Punch, Special beats all but Block
// =============================================================================

export const MOVE_ADVANTAGE: Record<MoveType, MoveType[]> = {
    punch: ["kick"],
    kick: ["block"],
    block: ["punch"],
    special: ["punch", "kick"],
    stunned: [],
};

// =============================================================================
// ELO RATING
// =============================================================================

export function calculateEloChange(
    winnerRating: number,
    loserRating: number,
    kFactor: number = 32
): { winnerChange: number; loserChange: number } {
    const expectedWinner = 1 / (1 + Math.pow(10, (loserRating - winnerRating) / 400));
    const expectedLoser = 1 / (1 + Math.pow(10, (winnerRating - loserRating) / 400));

    const winnerChange = Math.round(kFactor * (1 - expectedWinner));
    const loserChange = Math.round(kFactor * (0 - expectedLoser));

    return { winnerChange, loserChange };
}
