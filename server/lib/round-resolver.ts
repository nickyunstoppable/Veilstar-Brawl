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
export type { MoveType } from "./game-types";
import type { PowerSurgeCardId } from "./power-surge";
import {
    calculateSurgeEffects,
    applyDamageModifiers,
    applyDefensiveModifiers,
    applyEnergyEffects,
    applyHpEffects,
    deterministicChance,
    isBlockDisabled,
    isInvisibleMove,
    shouldBypassBlock,
} from "./surge-effects";

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

function calculateDamageWithSurges(params: {
    attackerMove: MoveType;
    defenderMove: MoveType;
    defenderGuard: number;
    attackerMods: ReturnType<typeof calculateSurgeEffects>["player1Modifiers"];
    defenderMods: ReturnType<typeof calculateSurgeEffects>["player1Modifiers"];
    isCounterHit: boolean;
}): number {
    const {
        attackerMove,
        defenderMove,
        defenderGuard,
        attackerMods,
        defenderMods,
        isCounterHit,
    } = params;

    // No-damage moves
    if (attackerMove === "block" || attackerMove === "stunned") return 0;

    // Block disabled (Pruned Rage): treat as if defender isn't blocking
    const blockDisabled = defenderMove === "block" && isBlockDisabled(defenderMods, attackerMods);
    const effectiveDefenderMove = blockDisabled ? "stunned" : defenderMove;

    // Base damage (server canonical)
    const baseDamage = MOVE_PROPERTIES[attackerMove].damage;

    // Determine matchup multiplier (mirrors existing calculateDamage with two surge additions:
    // - Invisible move: cannot be countered (never reduced by defender advantage)
    // - Chainbreaker bypass: if defender blocks and attacker bypasses, ignore block reductions
    let damage = baseDamage;

    const attackerInvisible = isInvisibleMove(attackerMods);
    const bypassBlock = shouldBypassBlock(attackerMods);

    if (effectiveDefenderMove === "block") {
        if (bypassBlock) {
            // Block provides no reduction at all
            damage = Math.round(damage * DAMAGE_MULTIPLIERS.NORMAL);
        } else if (attackerMove === "special") {
            damage = Math.round(damage * DAMAGE_MULTIPLIERS.SPECIAL_VS_BLOCK * DAMAGE_MULTIPLIERS.BLOCKED);
        } else if (attackerMove === "kick") {
            damage = Math.round(damage * DAMAGE_MULTIPLIERS.NORMAL);
        } else {
            damage = Math.round(damage * DAMAGE_MULTIPLIERS.CHIP_DAMAGE);
        }
    } else if (doesMoveBeat(attackerMove, effectiveDefenderMove)) {
        damage = Math.round(damage * DAMAGE_MULTIPLIERS.NORMAL);
    } else if (doesMoveBeat(effectiveDefenderMove, attackerMove)) {
        damage = Math.round(damage * (attackerInvisible ? DAMAGE_MULTIPLIERS.NORMAL : DAMAGE_MULTIPLIERS.BLOCKED));
    }

    // Guard break bonus
    if (defenderGuard >= GAME_CONSTANTS.MAX_GUARD) {
        damage = Math.round(damage * DAMAGE_MULTIPLIERS.GUARD_BREAK);
    }

    // Apply surge offensive multipliers
    damage = applyDamageModifiers(damage, attackerMods, attackerMove, isCounterHit);

    // If defender had damage immunity, damage becomes 0 (handled again in defensive step)
    if ((defenderMods as any).damageImmunity) return 0;

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
export function resolveRound(
    input: RoundResolutionInput,
    ctx?: {
        matchId: string;
        roundNumber: number;
        turnNumber: number;
        player1Surge: PowerSurgeCardId | null;
        player2Surge: PowerSurgeCardId | null;
    }
): RoundResolutionResult {
    const {
        player1Move, player2Move,
        player1Health, player2Health,
        player1Energy, player2Energy,
        player1Guard, player2Guard,
    } = input;

    const surges = ctx ? calculateSurgeEffects(ctx.player1Surge, ctx.player2Surge) : null;
    const p1Mods = surges ? surges.player1Modifiers : null;
    const p2Mods = surges ? surges.player2Modifiers : null;

    // Block disabled behavior: if a player's block is disabled by opponent, treat it as stunned for resolution.
    const p1EffectiveMove: MoveType =
        surges && player1Move === "block" && isBlockDisabled(p1Mods!, p2Mods!)
            ? "stunned"
            : player1Move;
    const p2EffectiveMove: MoveType =
        surges && player2Move === "block" && isBlockDisabled(p2Mods!, p1Mods!)
            ? "stunned"
            : player2Move;

    // Counter-hit definition (server-side): attacker has move advantage
    const p1CounterHit = doesMoveBeat(player1Move, player2Move);
    const p2CounterHit = doesMoveBeat(player2Move, player1Move);

    // Calculate damage
    const p1DamageBase = surges
        ? calculateDamageWithSurges({
            attackerMove: player1Move,
            defenderMove: p2EffectiveMove,
            defenderGuard: player2Guard,
            attackerMods: p1Mods!,
            defenderMods: p2Mods!,
            isCounterHit: p1CounterHit,
        })
        : calculateDamage(player1Move, player2Move, player2Health, player2Guard);

    const p2DamageBase = surges
        ? calculateDamageWithSurges({
            attackerMove: player2Move,
            defenderMove: p1EffectiveMove,
            defenderGuard: player1Guard,
            attackerMods: p2Mods!,
            defenderMods: p1Mods!,
            isCounterHit: p2CounterHit,
        })
        : calculateDamage(player2Move, player1Move, player1Health, player1Guard);

    // Defensive surge modifiers (reduction, reflection, immunity)
    // NOTE: reflection uses incoming damage BEFORE reduction.
    const p1IsBlocking = p1EffectiveMove === "block";
    const p2IsBlocking = p2EffectiveMove === "block";

    const p1Def = surges ? applyDefensiveModifiers(p2DamageBase, p1Mods!, p1IsBlocking) : { actualDamage: p2DamageBase, reflectedDamage: 0 };
    const p2Def = surges ? applyDefensiveModifiers(p1DamageBase, p2Mods!, p2IsBlocking) : { actualDamage: p1DamageBase, reflectedDamage: 0 };

    let p1DamageTaken = p1Def.actualDamage;
    let p2DamageTaken = p2Def.actualDamage;

    // Apply reflected damage back to attackers
    p2DamageTaken += p1Def.reflectedDamage;
    p1DamageTaken += p2Def.reflectedDamage;

    // Deterministic dodge chance (Hash Hurricane)
    if (surges && ctx) {
        const p1Dodged = deterministicChance(`${ctx.matchId}|${ctx.roundNumber}|${ctx.turnNumber}|player1|dodge`, p1Mods!.randomWinChance);
        const p2Dodged = deterministicChance(`${ctx.matchId}|${ctx.roundNumber}|${ctx.turnNumber}|player2|dodge`, p2Mods!.randomWinChance);
        if (p1Dodged) p1DamageTaken = 0;
        if (p2Dodged) p2DamageTaken = 0;
    }

    // Final damage dealt numbers for reporting
    const p1Damage = Math.max(0, p1DamageBase);
    const p2Damage = Math.max(0, p2DamageBase);

    // Apply damage
    let p1HealthAfter = Math.max(0, player1Health - p1DamageTaken);
    let p2HealthAfter = Math.max(0, player2Health - p2DamageTaken);

    // HP effects: full heal + per-turn regen
    let p1HpRegen = 0;
    let p2HpRegen = 0;
    if (surges) {
        const p1Before = p1HealthAfter;
        p1HealthAfter = applyHpEffects(p1Mods!, p1HealthAfter, GAME_CONSTANTS.MAX_HEALTH);
        p1HpRegen = Math.max(0, p1HealthAfter - p1Before);

        const p2Before = p2HealthAfter;
        p2HealthAfter = applyHpEffects(p2Mods!, p2HealthAfter, GAME_CONSTANTS.MAX_HEALTH);
        p2HpRegen = Math.max(0, p2HealthAfter - p2Before);
    }

    // Lifesteal (heal % of damage dealt)
    let p1Lifesteal = 0;
    let p2Lifesteal = 0;
    if (surges) {
        if (p1Mods!.lifestealPercent > 0 && p1Damage > 0 && p1HealthAfter > 0) {
            p1Lifesteal = Math.floor(p1Damage * p1Mods!.lifestealPercent);
            p1HealthAfter = Math.min(GAME_CONSTANTS.MAX_HEALTH, p1HealthAfter + p1Lifesteal);
        }
        if (p2Mods!.lifestealPercent > 0 && p2Damage > 0 && p2HealthAfter > 0) {
            p2Lifesteal = Math.floor(p2Damage * p2Mods!.lifestealPercent);
            p2HealthAfter = Math.min(GAME_CONSTANTS.MAX_HEALTH, p2HealthAfter + p2Lifesteal);
        }
    }

    // Energy after moves
    let p1EnergyAfter = calculateEnergyAfter(player1Energy, player1Move);
    let p2EnergyAfter = calculateEnergyAfter(player2Energy, player2Move);

    // Surge energy effects (burn/steal/extra cost/regen bonus)
    let p1EnergyDrained = 0;
    let p2EnergyDrained = 0;
    if (surges) {
        const p1DidHit = p1Damage > 0;
        const p2DidHit = p2Damage > 0;

        const p1EnergyEffects = applyEnergyEffects(p1Mods!, player2Energy, p1DidHit);
        const p2EnergyEffects = applyEnergyEffects(p2Mods!, player1Energy, p2DidHit);

        p1EnergyDrained = p2EnergyEffects.energyBurned + p2EnergyEffects.energyStolen;
        p2EnergyDrained = p1EnergyEffects.energyBurned + p1EnergyEffects.energyStolen;

        p1EnergyAfter = p1EnergyAfter - p2EnergyEffects.energyBurned - p2EnergyEffects.energyStolen + p1EnergyEffects.energyStolen;
        p2EnergyAfter = p2EnergyAfter - p1EnergyEffects.energyBurned - p1EnergyEffects.energyStolen + p2EnergyEffects.energyStolen;

        // Finality Fist extra special energy cost
        if (player1Move === "special" && p1Mods!.specialEnergyCost > 0) p1EnergyAfter -= p1Mods!.specialEnergyCost;
        if (player2Move === "special" && p2Mods!.specialEnergyCost > 0) p2EnergyAfter -= p2Mods!.specialEnergyCost;

        // Regen bonus
        p1EnergyAfter += p1EnergyEffects.energyRegenBonus;
        p2EnergyAfter += p2EnergyEffects.energyRegenBonus;

        // Clamp
        p1EnergyAfter = Math.max(0, Math.min(GAME_CONSTANTS.MAX_ENERGY, p1EnergyAfter));
        p2EnergyAfter = Math.max(0, Math.min(GAME_CONSTANTS.MAX_ENERGY, p2EnergyAfter));
    }

    // Guard after moves
    const p1GuardAfter = calculateGuardAfter(player1Guard, p1EffectiveMove, p2EffectiveMove);
    const p2GuardAfter = calculateGuardAfter(player2Guard, p2EffectiveMove, p1EffectiveMove);

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
            damageTaken: p1DamageTaken,
            moveSuccess: advantage >= 0,
            hpRegen: p1HpRegen,
            lifesteal: p1Lifesteal,
            energyDrained: p1EnergyDrained,
        },
        player2: {
            move: player2Move,
            damageDealt: p2Damage,
            damageTaken: p2DamageTaken,
            moveSuccess: advantage <= 0,
            hpRegen: p2HpRegen,
            lifesteal: p2Lifesteal,
            energyDrained: p2EnergyDrained,
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
