/**
 * Round Resolver — pure functions for combat resolution
 * Adapted from KaspaClash lib/game/round-resolver.ts
 * No database calls — just math
 */

import {
    type MoveType,
    type RoundWinner,
    type RoundResolutionInput,
    type RoundResolutionResult,
    type PlayerMoveResult,
    MOVE_PROPERTIES,
    MOVE_ADVANTAGE,
    DAMAGE_MULTIPLIERS,
    GAME_CONSTANTS,
} from "./game-types";

// =============================================================================
// MOVE COMPARISON
// =============================================================================

/** Check if moveA beats moveB */
export function doesMoveBeat(moveA: MoveType, moveB: MoveType): boolean {
    return MOVE_ADVANTAGE[moveA]?.includes(moveB) ?? false;
}

/** Get advantage: 1 = move1 wins, -1 = move2 wins, 0 = draw */
export function getMoveAdvantage(move1: MoveType, move2: MoveType): -1 | 0 | 1 {
    if (move1 === move2) return 0;
    if (move1 === "stunned") return -1;
    if (move2 === "stunned") return 1;
    if (doesMoveBeat(move1, move2)) return 1;
    if (doesMoveBeat(move2, move1)) return -1;
    return 0;
}

// =============================================================================
// DAMAGE CALCULATION
// =============================================================================

/** Calculate damage dealt by attacker's move against defender's move */
export function calculateDamage(
    attackerMove: MoveType,
    defenderMove: MoveType,
    defenderHealth: number = 100,
    defenderGuard: number = 0
): number {
    const attackProps = MOVE_PROPERTIES[attackerMove];

    // No-damage moves
    if (attackerMove === "block" || attackerMove === "stunned") return 0;

    // Base damage
    let damage = attackProps.damage;

    // Block interactions
    if (defenderMove === "block") {
        if (attackerMove === "special") {
            // Special vs block: reduced but still hits
            damage = Math.round(damage * DAMAGE_MULTIPLIERS.SPECIAL_VS_BLOCK * DAMAGE_MULTIPLIERS.BLOCKED);
        } else if (attackerMove === "kick") {
            // Kick beats block — full damage
            damage = Math.round(damage * DAMAGE_MULTIPLIERS.NORMAL);
        } else {
            // Punch vs block — chip damage only
            damage = Math.round(damage * DAMAGE_MULTIPLIERS.CHIP_DAMAGE);
        }
    } else if (doesMoveBeat(attackerMove, defenderMove)) {
        // Attacker wins matchup — full damage
        damage = Math.round(damage * DAMAGE_MULTIPLIERS.NORMAL);
    } else if (doesMoveBeat(defenderMove, attackerMove)) {
        // Defender wins matchup — reduced damage
        damage = Math.round(damage * DAMAGE_MULTIPLIERS.BLOCKED);
    }

    // Guard break bonus
    if (defenderGuard >= GAME_CONSTANTS.MAX_GUARD) {
        damage = Math.round(damage * DAMAGE_MULTIPLIERS.GUARD_BREAK);
    }

    return Math.max(0, damage);
}

// =============================================================================
// ENERGY CALCULATION
// =============================================================================

/** Calculate energy after a move */
export function calculateEnergyAfter(currentEnergy: number, move: MoveType): number {
    const cost = MOVE_PROPERTIES[move].energyCost;
    const afterCost = Math.max(0, currentEnergy - cost);
    // Regen applies after cost
    return Math.min(GAME_CONSTANTS.MAX_ENERGY, afterCost + GAME_CONSTANTS.ENERGY_REGEN);
}

/** Check if player has enough energy for a move */
export function hasEnoughEnergy(energy: number, move: MoveType): boolean {
    return energy >= MOVE_PROPERTIES[move].energyCost;
}

// =============================================================================
// GUARD CALCULATION
// =============================================================================

/** Calculate guard meter after a move interaction */
export function calculateGuardAfter(
    currentGuard: number,
    myMove: MoveType,
    opponentMove: MoveType
): number {
    let guard = currentGuard;

    // Build guard when blocking
    if (myMove === "block") {
        guard += MOVE_PROPERTIES["block"].guardBuild;
    }

    // Take guard damage when opponent attacks and I'm blocking
    if (myMove === "block" && opponentMove !== "block" && opponentMove !== "stunned") {
        guard -= MOVE_PROPERTIES[opponentMove].guardDamage;
    }

    // Guard breaks at max — reset to 0
    if (guard >= GAME_CONSTANTS.MAX_GUARD) {
        guard = 0;
    }

    return Math.max(0, Math.min(GAME_CONSTANTS.MAX_GUARD, guard));
}

// =============================================================================
// ROUND RESOLUTION
// =============================================================================

/** Resolve a complete round between two players */
export function resolveRound(input: RoundResolutionInput): RoundResolutionResult {
    const {
        player1Move, player2Move,
        player1Health, player2Health,
        player1Energy, player2Energy,
        player1Guard, player2Guard,
    } = input;

    // Calculate damage
    const p1Damage = calculateDamage(player1Move, player2Move, player2Health, player2Guard);
    const p2Damage = calculateDamage(player2Move, player1Move, player1Health, player1Guard);

    // Apply damage
    const p1HealthAfter = Math.max(0, player1Health - p2Damage);
    const p2HealthAfter = Math.max(0, player2Health - p1Damage);

    // Energy after moves
    const p1EnergyAfter = calculateEnergyAfter(player1Energy, player1Move);
    const p2EnergyAfter = calculateEnergyAfter(player2Energy, player2Move);

    // Guard after moves
    const p1GuardAfter = calculateGuardAfter(player1Guard, player1Move, player2Move);
    const p2GuardAfter = calculateGuardAfter(player2Guard, player2Move, player1Move);

    // Determine advantage
    const advantage = getMoveAdvantage(player1Move, player2Move);

    // Determine round winner (only if knockout)
    let winner: RoundWinner = null;
    const isKnockout = p1HealthAfter <= 0 || p2HealthAfter <= 0;

    if (isKnockout) {
        if (p1HealthAfter <= 0 && p2HealthAfter <= 0) {
            // Both KO — higher remaining health wins, else draw
            winner = "draw";
        } else if (p1HealthAfter <= 0) {
            winner = "player2";
        } else {
            winner = "player1";
        }
    }

    // Generate narrative
    const narrative = generateNarrative(player1Move, player2Move, p1Damage, p2Damage, advantage);

    return {
        player1: {
            move: player1Move,
            damageDealt: p1Damage,
            damageTaken: p2Damage,
            moveSuccess: advantage >= 0,
        },
        player2: {
            move: player2Move,
            damageDealt: p2Damage,
            damageTaken: p1Damage,
            moveSuccess: advantage <= 0,
        },
        winner,
        isKnockout,
        player1HealthAfter: p1HealthAfter,
        player2HealthAfter: p2HealthAfter,
        player1EnergyAfter: p1EnergyAfter,
        player2EnergyAfter: p2EnergyAfter,
        player1GuardAfter: p1GuardAfter,
        player2GuardAfter: p2GuardAfter,
        narrative,
    };
}

// =============================================================================
// MATCH STATE HELPERS
// =============================================================================

/** Check if match should end based on rounds won */
export function isMatchOver(
    p1Rounds: number,
    p2Rounds: number,
    roundsToWin: number = GAME_CONSTANTS.ROUNDS_TO_WIN_BEST_OF_3
): boolean {
    return p1Rounds >= roundsToWin || p2Rounds >= roundsToWin;
}

/** Get match winner (null if not over) */
export function getMatchWinner(
    p1Rounds: number,
    p2Rounds: number,
    roundsToWin: number = GAME_CONSTANTS.ROUNDS_TO_WIN_BEST_OF_3
): "player1" | "player2" | null {
    if (p1Rounds >= roundsToWin) return "player1";
    if (p2Rounds >= roundsToWin) return "player2";
    return null;
}

// =============================================================================
// NARRATIVE GENERATOR
// =============================================================================

function generateNarrative(
    p1Move: MoveType,
    p2Move: MoveType,
    p1Damage: number,
    p2Damage: number,
    advantage: -1 | 0 | 1
): string {
    const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

    if (p1Move === "stunned" && p2Move === "stunned") {
        return "Both fighters are stunned!";
    }
    if (p1Move === "stunned") return "Player 1 is stunned! Player 2 attacks freely.";
    if (p2Move === "stunned") return "Player 2 is stunned! Player 1 attacks freely.";

    if (p1Move === p2Move) {
        return `Both fighters use ${capitalize(p1Move)}! The attacks clash!`;
    }

    if (p1Move === "block" && p2Move === "block") {
        return "Both fighters hold their ground.";
    }

    if (advantage === 1) {
        return `${capitalize(p1Move)} beats ${capitalize(p2Move)}! Player 1 deals ${p1Damage} damage!`;
    } else if (advantage === -1) {
        return `${capitalize(p2Move)} beats ${capitalize(p1Move)}! Player 2 deals ${p2Damage} damage!`;
    }

    return `${capitalize(p1Move)} vs ${capitalize(p2Move)}! P1 deals ${p1Damage}, P2 deals ${p2Damage}.`;
}

/** Get valid moves (excluding stunned which is auto-assigned) */
export function getValidMoves(): MoveType[] {
    return ["punch", "kick", "block", "special"];
}

/** Check if a string is a valid move type */
export function isValidMove(move: string): move is MoveType {
    return ["punch", "kick", "block", "special", "stunned"].includes(move);
}
