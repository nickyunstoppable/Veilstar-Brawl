/**
 * Combat Engine for Veilstar Brawl
 * Core game logic for turn-based fighting
 */

import type { MoveType } from "@/types/game";
import {
    type CombatState,
    type PlayerCombatState,
    type TurnResult,
    type PlayerTurnResult,
    type MoveOutcome,
    type TurnEffect,
    RESOLUTION_MATRIX,
    BASE_MOVE_STATS,
    COMBAT_CONSTANTS,
} from "./types";
import { getCharacterCombatStats } from "./CharacterStats";
import {
    calculateSurgeEffects,
    applyDamageModifiers,
    applyDefensiveModifiers,
    applyEnergyEffects,
    applyHpEffects,
    checkRandomWin,
    isInvisibleMove,
    shouldStunOpponent,
    shouldBypassBlock,
    isBlockDisabled,
    type SurgeModifiers,
} from "./SurgeEffects";
import type { PowerSurgeCardId } from "@/types/power-surge";

// =============================================================================
// COMBAT ENGINE
// =============================================================================

/**
 * Main combat engine that handles all game logic.
 */
export class CombatEngine {
    private state: CombatState;

    private static readonly MAX_TURNS_PER_ROUND = 10;

    // Track if surge stun has been applied this round (Mempool Congest)
    // REFACTORED: Now checking currentTurn === 1 instead of using state flags to be stateless-safe


    constructor(
        player1CharacterId: string,
        player2CharacterId: string,
        matchFormat: "best_of_1" | "best_of_3" | "best_of_5" = "best_of_5"
    ) {
        const p1Stats = getCharacterCombatStats(player1CharacterId);
        const p2Stats = getCharacterCombatStats(player2CharacterId);

        this.state = {
            player1: {
                characterId: player1CharacterId,
                hp: p1Stats.maxHp,
                maxHp: p1Stats.maxHp,
                energy: p1Stats.maxEnergy,
                maxEnergy: p1Stats.maxEnergy,
                guardMeter: 0,
                isStunned: false,
                isStaggered: false,
                roundsWon: 0,
            },
            player2: {
                characterId: player2CharacterId,
                hp: p2Stats.maxHp,
                maxHp: p2Stats.maxHp,
                energy: p2Stats.maxEnergy,
                maxEnergy: p2Stats.maxEnergy,
                guardMeter: 0,
                isStunned: false,
                isStaggered: false,
                roundsWon: 0,
            },
            currentRound: 1,
            currentTurn: 1,
            matchFormat,
            roundsToWin: matchFormat === "best_of_5" ? 3 : matchFormat === "best_of_3" ? 2 : 1,
            isRoundOver: false,
            isMatchOver: false,
            roundWinner: null,
            matchWinner: null,
        };
    }

    // ===========================================================================
    // STATE ACCESSORS
    // ===========================================================================

    /**
     * Get current combat state (immutable copy).
     */
    /**
     * Get current combat state (immutable copy).
     * IMPORTANT: Must deep copy nested player objects to prevent reference mutations.
     */
    getState(): Readonly<CombatState> {
        return {
            ...this.state,
            player1: { ...this.state.player1 },
            player2: { ...this.state.player2 }
        };
    }

    /**
     * Restore combat state from a saved state object.
     * Used for reconnection/refresh scenarios.
     */
    setState(savedState: CombatState): void {
        this.state = {
            ...savedState,
            player1: { ...savedState.player1 },
            player2: { ...savedState.player2 }
        };
    }

    /**
     * Set stun state for a player.
     * Used by PracticeScene/SurvivalScene to apply Power Surge stun effects immediately.
     */
    setPlayerStunned(player: "player1" | "player2", isStunned: boolean): void {
        this.state[player].isStunned = isStunned;
    }

    /**
     * Set health for a player.
     * Used by FightScene for server-authoritative state sync.
     */
    setPlayerHealth(player: "player1" | "player2", hp: number): void {
        this.state[player].hp = Math.max(0, Math.min(this.state[player].maxHp, hp));
    }

    /**
     * Set energy for a player.
     * Used by FightScene for server-authoritative state sync.
     */
    setPlayerEnergy(player: "player1" | "player2", energy: number): void {
        this.state[player].energy = Math.max(0, Math.min(this.state[player].maxEnergy, energy));
    }

    /**
     * Set guard meter for a player.
     * Used by FightScene for server-authoritative state sync.
     */
    setPlayerGuardMeter(player: "player1" | "player2", guardMeter: number): void {
        this.state[player].guardMeter = Math.max(0, Math.min(100, guardMeter));
    }

    /**
     * Set rounds won for a player.
     * Used by FightScene for server-authoritative state sync.
     */
    setPlayerRoundsWon(player: "player1" | "player2", roundsWon: number): void {
        this.state[player].roundsWon = Math.max(0, roundsWon);
    }

    /**
     * Get specific player state.
     */
    getPlayerState(player: "player1" | "player2"): Readonly<PlayerCombatState> {
        return { ...this.state[player] };
    }

    /**
     * Check if a move is affordable for a player.
     */
    canAffordMove(player: "player1" | "player2", move: MoveType): boolean {
        const playerState = this.state[player];
        const cost = this.getMoveCost(playerState.characterId, move);
        return playerState.energy >= cost;
    }

    /**
     * Get the energy cost of a move for a character.
     */
    getMoveCost(characterId: string, move: MoveType): number {
        const baseCost = BASE_MOVE_STATS[move].energyCost;
        if (move !== "special") return baseCost;

        const stats = getCharacterCombatStats(characterId);
        return Math.floor(baseCost * stats.specialCostModifier);
    }

    /**
     * Get available moves for a player based on energy.
     */
    getAvailableMoves(player: "player1" | "player2"): MoveType[] {
        const moves: MoveType[] = ["punch", "kick", "block", "special"];
        return moves.filter((move) => this.canAffordMove(player, move));
    }

    // ===========================================================================
    // TURN RESOLUTION
    // ===========================================================================

    /**
     * Resolve a single turn of combat for both players.
     */
    resolveTurn(
        player1Move: MoveType,
        player2Move: MoveType,
        player1Surge: PowerSurgeCardId | null = null,
        player2Surge: PowerSurgeCardId | null = null
    ): TurnResult {
        const p1State = this.state.player1;
        const p2State = this.state.player2;

        // Calculate Surge Effects for this round
        const surgeResults = calculateSurgeEffects(player1Surge, player2Surge);
        const p1SurgeMods = surgeResults.player1Modifiers;
        const p2SurgeMods = surgeResults.player2Modifiers;

        // Apply Mempool Congest stun BEFORE first turn (only once per round)
        // This ensures the opponent is stunned immediately on turn 1, not after turn 1
        // FIX: Check currentTurn === 1 instead of stateful flag to prevent re-application in stateless environments
        if (this.state.currentTurn === 1) {
            if (shouldStunOpponent(p1SurgeMods)) {
                this.state.player2.isStunned = true;
            }
            if (shouldStunOpponent(p2SurgeMods)) {
                this.state.player1.isStunned = true;
            }
        }

        // Track if players were stunned at the START of this turn
        const p1WasStunned = p1State.isStunned;
        const p2WasStunned = p2State.isStunned;

        // Handle stunned players (auto-miss)
        // Represent stunned explicitly as the "stunned" move so resolution stays consistent
        // and damage-vs-stunned always flows through the matrix.
        const effectiveP1Move: MoveType = (p1WasStunned || player1Move === "stunned") ? "stunned" : player1Move;
        const effectiveP2Move: MoveType = (p2WasStunned || player2Move === "stunned") ? "stunned" : player2Move;

        // Calculate outcomes
        const p1Result = this.resolvePlayerTurn(
            effectiveP1Move,
            effectiveP2Move,
            p1State,
            p2State,
            "player1",
            p1SurgeMods,
            p2SurgeMods
        );
        const p2Result = this.resolvePlayerTurn(
            effectiveP2Move,
            effectiveP1Move,
            p2State,
            p1State,
            "player2",
            p2SurgeMods,
            p1SurgeMods
        );

        // Apply Surge Energy Effects (Burn/Steal)
        const p1DidHit = p1Result.outcome === "hit";
        const p2DidHit = p2Result.outcome === "hit";
        const p1EnergyEffects = applyEnergyEffects(p1SurgeMods, p2State.energy, p1DidHit);
        const p2EnergyEffects = applyEnergyEffects(p2SurgeMods, p1State.energy, p2DidHit);

        // Apply Global Modifiers (Random Win / Dodge)
        // Hash Hurricane: Chance to dodge opponent's attack (reduce damageTaken to 0)
        // Note: This is applied as damage reduction, not as a hit modifier
        const p1Dodged = checkRandomWin(p1SurgeMods);
        const p2Dodged = checkRandomWin(p2SurgeMods);

        // Apply damage
        // Handle normal damage + reflection (self-damage)
        const p1SelfDamage = (p1Result as any).selfDamage || 0;
        const p2SelfDamage = (p2Result as any).selfDamage || 0;

        // Check if players are blocking (for Block Fortress reflection)
        const p1IsBlocking = effectiveP1Move === "block" && p1Result.outcome === "guarding";
        const p2IsBlocking = effectiveP2Move === "block" && p2Result.outcome === "guarding";

        // Apply defensive surge modifiers (damage reduction/amplification)
        const p1DefensiveResult = applyDefensiveModifiers(p1Result.damageTaken, p1SurgeMods, p1IsBlocking);
        const p2DefensiveResult = applyDefensiveModifiers(p2Result.damageTaken, p2SurgeMods, p2IsBlocking);

        let p1DamageTaken = p1DefensiveResult.actualDamage + p1SelfDamage;
        let p2DamageTaken = p2DefensiveResult.actualDamage + p2SelfDamage;

        // Add reflected damage to the attacker
        p2DamageTaken += p1DefensiveResult.reflectedDamage; // P1's reflection hits P2
        p1DamageTaken += p2DefensiveResult.reflectedDamage; // P2's reflection hits P1

        // Apply Surge Damage Immunity (should already be handled in applyDefensiveModifiers, but double-check)
        if (p1SurgeMods.damageImmunity) p1DamageTaken = 0;
        if (p2SurgeMods.damageImmunity) p2DamageTaken = 0;

        // Apply Hash Hurricane dodge - if dodge triggers, take no damage
        if (p1Dodged) p1DamageTaken = 0;
        if (p2Dodged) p2DamageTaken = 0;

        this.state.player1.hp = Math.max(0, p1State.hp - p1DamageTaken);
        this.state.player2.hp = Math.max(0, p2State.hp - p2DamageTaken);

        // Track HP before regen for animation purposes
        const p1HpBeforeRegen = this.state.player1.hp;
        const p2HpBeforeRegen = this.state.player2.hp;

        // Apply HP Effects (Regen / Full Heal)
        this.state.player1.hp = applyHpEffects(p1SurgeMods, this.state.player1.hp, this.state.player1.maxHp);
        this.state.player2.hp = applyHpEffects(p2SurgeMods, this.state.player2.hp, this.state.player2.maxHp);

        // Calculate actual HP regen applied (for visual feedback)
        const p1HpRegen = this.state.player1.hp - p1HpBeforeRegen;
        const p2HpRegen = this.state.player2.hp - p2HpBeforeRegen;

        // Apply Lifesteal (BPS Syphon) - heal for % of damage dealt
        // Only applies if player is still alive and dealt damage
        let p1Lifesteal = 0;
        let p2Lifesteal = 0;
        if (p1SurgeMods.lifestealPercent > 0 && p1Result.damageDealt > 0 && this.state.player1.hp > 0) {
            p1Lifesteal = Math.floor(p1Result.damageDealt * p1SurgeMods.lifestealPercent);
            this.state.player1.hp = Math.min(this.state.player1.maxHp, this.state.player1.hp + p1Lifesteal);
        }
        if (p2SurgeMods.lifestealPercent > 0 && p2Result.damageDealt > 0 && this.state.player2.hp > 0) {
            p2Lifesteal = Math.floor(p2Result.damageDealt * p2SurgeMods.lifestealPercent);
            this.state.player2.hp = Math.min(this.state.player2.maxHp, this.state.player2.hp + p2Lifesteal);
        }

        // Add regen/lifesteal info to results for visual feedback
        p1Result.hpRegen = p1HpRegen > 0 ? p1HpRegen : 0;
        p1Result.lifesteal = p1Lifesteal;
        p2Result.hpRegen = p2HpRegen > 0 ? p2HpRegen : 0;
        p2Result.lifesteal = p2Lifesteal;

        // Track energy drained by opponent's surge effects for visual feedback
        // Include BOTH burned (from energyBurn/energyDrain) AND stolen (from energySteal like Vaultbreaker)
        p1Result.energyDrained = p2EnergyEffects.energyBurned + p2EnergyEffects.energyStolen; // P1 lost energy from P2's effects
        p2Result.energyDrained = p1EnergyEffects.energyBurned + p1EnergyEffects.energyStolen; // P2 lost energy from P1's effects

        // Apply energy costs and surge energy effects
        // P1 loses energy from move cost + what P2 burned/stole, but gains what P1 stole from P2
        let p1NewEnergy = p1State.energy - p1Result.energySpent - p2EnergyEffects.energyBurned - p2EnergyEffects.energyStolen + p1EnergyEffects.energyStolen;
        // P2 loses energy from move cost + what P1 burned/stole, but gains what P2 stole from P1
        let p2NewEnergy = p2State.energy - p2Result.energySpent - p1EnergyEffects.energyBurned - p1EnergyEffects.energyStolen + p2EnergyEffects.energyStolen;

        // Apply Finality Fist extra special energy cost
        if (effectiveP1Move === "special" && p1SurgeMods.specialEnergyCost > 0) {
            p1NewEnergy -= p1SurgeMods.specialEnergyCost;
        }
        if (effectiveP2Move === "special" && p2SurgeMods.specialEnergyCost > 0) {
            p2NewEnergy -= p2SurgeMods.specialEnergyCost;
        }

        // Apply energy regen bonus from surge
        p1NewEnergy += p1EnergyEffects.energyRegenBonus;
        p2NewEnergy += p2EnergyEffects.energyRegenBonus;

        // Clamp to valid range
        this.state.player1.energy = Math.max(0, Math.min(this.state.player1.maxEnergy, p1NewEnergy));
        this.state.player2.energy = Math.max(0, Math.min(this.state.player2.maxEnergy, p2NewEnergy));

        // Apply guard buildup
        this.state.player1.guardMeter = Math.min(
            COMBAT_CONSTANTS.GUARD_BREAK_THRESHOLD,
            p1State.guardMeter + p1Result.guardBuildup
        );
        this.state.player2.guardMeter = Math.min(
            COMBAT_CONSTANTS.GUARD_BREAK_THRESHOLD,
            p2State.guardMeter + p2Result.guardBuildup
        );

        // Track guard meter BEFORE effects
        const p1GuardBeforeTurn = this.state.player1.guardMeter;
        const p2GuardBeforeTurn = this.state.player2.guardMeter;

        // Apply hit damage (calculated in resolvePlayerTurn)
        // Guard break logic is now handled in resolvePlayerTurn for bypass

        // Track if guard break happens THIS turn
        const p1GuardBreak = this.state.player1.guardMeter >= COMBAT_CONSTANTS.GUARD_BREAK_THRESHOLD
            && p1GuardBeforeTurn < COMBAT_CONSTANTS.GUARD_BREAK_THRESHOLD;
        const p2GuardBreak = this.state.player2.guardMeter >= COMBAT_CONSTANTS.GUARD_BREAK_THRESHOLD
            && p2GuardBeforeTurn < COMBAT_CONSTANTS.GUARD_BREAK_THRESHOLD;

        // Check for Guard Break (Meter >= 100)
        // Only trigger stun and reset if guard was NOT already broken
        if (p1GuardBreak) {
            this.state.player1.guardMeter = 0;
            p1Result.effects.push("guard_break"); // Add effect for UI
        }

        if (p2GuardBreak) {
            this.state.player2.guardMeter = 0;
            p2Result.effects.push("guard_break"); // Add effect for UI
        }

        // Handle stun state:
        // 1. If player WAS stunned at turn start, they missed this turn - stun will be cleared below
        // 2. If player got stunned THIS turn (by move outcome or guard break), SET the stun for next turn
        // NOTE: Check for stun effects from moves and guard breaks
        const p1StunnedByMove = p1Result.effects.includes("stun");
        const p2StunnedByMove = p2Result.effects.includes("stun");

        // Apply effects
        this.applyEffects(p1Result.effects, "player1");
        this.applyEffects(p2Result.effects, "player2");

        // Regenerate energy
        this.regenerateEnergy();

        // Clear old stun (player paid the penalty), then apply new stun if applicable
        // Mempool Congest stun is a ONE-TIME effect: it stuns the opponent on the FIRST turn only.
        // After they've been stunned (missed their turn), the stun is cleared and NOT re-applied.
        // The pXSurgeStunApplied flags track that we've already applied the stun, preventing re-application.
        this.state.player1.isStunned = p1StunnedByMove || p1GuardBreak;
        this.state.player1.isStaggered = p1Result.effects.includes("stagger");

        this.state.player2.isStunned = p2StunnedByMove || p2GuardBreak;
        this.state.player2.isStaggered = p2Result.effects.includes("stagger");

        // Check for round end
        this.checkRoundEnd();

        // Increment turn
        this.state.currentTurn++;

        // Generate narrative
        const narrative = this.generateNarrative(
            effectiveP1Move,
            effectiveP2Move,
            p1Result,
            p2Result
        );

        return {
            player1: p1Result,
            player2: p2Result,
            narrative,
        };
    }

    /**
     * Resolve a single player's turn.
     */
    private resolvePlayerTurn(
        myMove: MoveType | null,
        opponentMove: MoveType | null,
        myState: PlayerCombatState,
        opponentState: PlayerCombatState,
        playerRole: "player1" | "player2",
        mySurgeMods: SurgeModifiers,
        opponentSurgeMods: SurgeModifiers
    ): PlayerTurnResult {
        // Handle stunned player - they can't act but still take damage
        if (myMove === null) {
            // Calculate damage taken from opponent's attack (we're defenseless)
            let damageTaken = 0;
            if (opponentMove) {
                const opponentStats = getCharacterCombatStats(opponentState.characterId);
                const baseDamage = BASE_MOVE_STATS[opponentMove].damage;
                const modifier = opponentStats.damageModifiers[opponentMove];
                const rawDamage = Math.floor(baseDamage * modifier);

                // Apply Surge Damage Multiplier from opponent
                damageTaken = applyDamageModifiers(rawDamage, opponentSurgeMods, opponentMove, false);
            }

            return {
                move: "stunned",
                outcome: "stunned",
                damageDealt: 0,
                damageTaken,
                energySpent: 0,
                guardBuildup: 0,
                effects: [],
            };
        }

        const myStats = getCharacterCombatStats(myState.characterId);
        const opponentStats = getCharacterCombatStats(opponentState.characterId);

        // Handle block disabled (Pruned Rage)
        // If opponent has Pruned Rage, our block is disabled and fails completely
        const effectiveMove = (myMove === "block" && isBlockDisabled(mySurgeMods, opponentSurgeMods))
            ? null // Block fails, treated as if stunned
            : myMove;

        if (effectiveMove === null && myMove === "block") {
            // Block was disabled - take full damage from opponent
            let damageTaken = 0;
            if (opponentMove) {
                const baseDamage = BASE_MOVE_STATS[opponentMove].damage;
                const modifier = opponentStats.damageModifiers[opponentMove];
                const rawDamage = Math.floor(baseDamage * modifier);
                damageTaken = applyDamageModifiers(rawDamage, opponentSurgeMods, opponentMove, false);
            }

            return {
                move: myMove,
                outcome: "missed", // Block failed
                damageDealt: 0,
                damageTaken,
                energySpent: this.getMoveCost(myState.characterId, myMove),
                guardBuildup: 0,
                effects: [],
            };
        }

        const normalizeOutcomeForInvisibleMove = (
            rawOutcome: MoveOutcome,
            move: MoveType,
            surgeMods: SurgeModifiers
        ): MoveOutcome => {
            if (move === "block" || move === "stunned") return rawOutcome;
            if (!isInvisibleMove(surgeMods)) return rawOutcome;
            if (rawOutcome === "missed" || rawOutcome === "staggered" || rawOutcome === "reflected") {
                return "hit";
            }
            return rawOutcome;
        };

        // Get outcome from resolution matrix
        const outcome = normalizeOutcomeForInvisibleMove(
            opponentMove
                ? RESOLUTION_MATRIX[myMove][opponentMove]
                : "hit", // If opponent is stunned, we hit
            myMove,
            mySurgeMods
        );

        // Detect counter-hit: when your move beats the opponent's move in RPS
        // Punch > Special, Kick > Punch, Special > Block
        const isCounterHit = !!(opponentMove && (
            (myMove === "punch" && opponentMove === "special") ||
            (myMove === "kick" && opponentMove === "punch") ||
            (myMove === "special" && opponentMove === "block")
        ));

        // Calculate damage dealt
        let damageDealt = 0;
        if (outcome === "hit") {
            const baseDamage = BASE_MOVE_STATS[myMove].damage;
            const modifier = myStats.damageModifiers[myMove];

            // Calculate Counter Multiplier (archetype-based)
            const counterMult = this.getArchetypeMultiplier(myState.characterId, opponentState.characterId);

            const rawDamage = Math.floor(baseDamage * modifier * counterMult);

            // Apply Surge Damage Multipliers (with counter-hit for Orphan Smasher)
            damageDealt = applyDamageModifiers(rawDamage, mySurgeMods, myMove, isCounterHit);

            // Apply stagger penalty
            if (myState.isStaggered) {
                damageDealt = Math.floor(damageDealt * COMBAT_CONSTANTS.STAGGER_DAMAGE_REDUCTION);
            }
        } else if (outcome === "reflected" && myMove === "kick") {
            // Kick was reflected, we take reflected damage
            const baseDamage = BASE_MOVE_STATS.kick.damage;
            damageDealt = -Math.floor(baseDamage * COMBAT_CONSTANTS.KICK_REFLECT_PERCENT);
        }

        // Calculate damage taken
        let damageTaken = 0;
        if (opponentMove && outcome !== "guarding") {
            const opponentOutcome = normalizeOutcomeForInvisibleMove(
                RESOLUTION_MATRIX[opponentMove][myMove],
                opponentMove,
                opponentSurgeMods
            );
            if (opponentOutcome === "hit") {
                const baseDamage = BASE_MOVE_STATS[opponentMove].damage;
                const modifier = opponentStats.damageModifiers[opponentMove];
                const rawDamage = Math.floor(baseDamage * modifier);

                // Detect if opponent's attack is a counter-hit (from their perspective)
                // Counter-hits: Punch > Special, Kick > Punch, Special > Block
                const opponentIsCounterHit = !!(myMove && (
                    (opponentMove === "punch" && myMove === "special") ||
                    (opponentMove === "kick" && myMove === "punch") ||
                    (opponentMove === "special" && myMove === "block")
                ));

                // Apply Surge Damage Multiplier from opponent (including counter multiplier)
                damageTaken = applyDamageModifiers(rawDamage, opponentSurgeMods, opponentMove, opponentIsCounterHit);

                // Apply block damage reduction
                if (myMove === "block" && outcome === "shattered") {
                    // Block was shattered, take extra damage
                    damageTaken = Math.floor(damageTaken * COMBAT_CONSTANTS.SHATTER_DAMAGE_MULTIPLIER);
                }
            }
        } else if (outcome === "guarding" && opponentMove) {
            // We're blocking, take reduced damage
            const baseDamage = BASE_MOVE_STATS[opponentMove].damage;
            const modifier = opponentStats.damageModifiers[opponentMove];
            const rawFullDamage = baseDamage * modifier;

            // Apply Surge Damage Multiplier from opponent
            const fullDamage = applyDamageModifiers(rawFullDamage, opponentSurgeMods, opponentMove, false);

            // Chainbreaker: Bypass block reduction if attacker has bypassBlockOnHit
            const blockEffectiveness = shouldBypassBlock(opponentSurgeMods) ? 0 : myStats.blockEffectiveness;
            damageTaken = Math.floor(fullDamage * (1 - blockEffectiveness));
        }

        // Calculate energy spent
        const energySpent = this.getMoveCost(myState.characterId, myMove);

        // Calculate guard buildup
        let guardBuildup = 0;
        if (myMove === "block") {
            if (outcome === "guarding") {
                guardBuildup = COMBAT_CONSTANTS.GUARD_BUILDUP_ON_BLOCK;
                if (opponentMove && opponentMove !== "block") {
                    guardBuildup += COMBAT_CONSTANTS.GUARD_BUILDUP_ON_HIT;
                }
            } else if (outcome === "shattered") {
                // Guard was broken
                guardBuildup = -myState.guardMeter; // Reset to 0
            }
        }

        // Determine effects
        const effects: TurnEffect[] = [];
        if (outcome === "missed") {
            effects.push("stun");
        }
        if (outcome === "staggered") {
            effects.push("stagger");
        }
        if (outcome === "shattered") {
            effects.push("guard_break");
        }
        if (outcome === "guarding") {
            effects.push("guard_up");
        }

        return {
            move: myMove,
            outcome,
            damageDealt: Math.max(0, damageDealt), // damageDealt should always be positive for narrative
            damageTaken: Math.max(0, damageTaken),
            energySpent,
            guardBuildup,
            effects,
            // Internal field to track self-damage (reflection)
            // @ts-ignore - Adding internal property safely
            selfDamage: damageDealt < 0 ? Math.abs(damageDealt) : 0
        } as PlayerTurnResult & { selfDamage: number };
    }

    /**
     * Apply effects to a player.
     */
    private applyEffects(effects: TurnEffect[], player: "player1" | "player2"): void {
        const state = this.state[player];

        for (const effect of effects) {
            switch (effect) {
                case "guard_break":
                    state.guardMeter = 0;
                    break;
                // stun and stagger are handled in the main resolution
            }
        }
    }

    /**
     * Regenerate energy for both players.
     */
    private regenerateEnergy(): void {
        const p1Stats = getCharacterCombatStats(this.state.player1.characterId);
        const p2Stats = getCharacterCombatStats(this.state.player2.characterId);

        this.state.player1.energy = Math.min(
            this.state.player1.maxEnergy,
            this.state.player1.energy + p1Stats.energyRegen
        );
        this.state.player2.energy = Math.min(
            this.state.player2.maxEnergy,
            this.state.player2.energy + p2Stats.energyRegen
        );
    }

    // ===========================================================================
    // ROUND/MATCH MANAGEMENT
    // ===========================================================================

    /**
     * Check if round has ended.
     */
    private checkRoundEnd(): void {
        if (this.state.player1.hp <= 0 || this.state.player2.hp <= 0) {
            this.state.isRoundOver = true;

            if (this.state.player1.hp <= 0 && this.state.player2.hp <= 0) {
                // Double KO - DRAW! No one wins this round
                // roundWinner stays null to indicate a draw
                this.state.roundWinner = null;
                // Don't award any rounds - the match will continue
            } else if (this.state.player1.hp <= 0) {
                this.state.roundWinner = "player2";
                this.state.player2.roundsWon++;
            } else {
                this.state.roundWinner = "player1";
                this.state.player1.roundsWon++;
            }

            // Check match end
            this.checkMatchEnd();
        }

        // Turn limit tiebreaker: if no one is KO'd after N turns, higher remaining HP% wins.
        // If HP% is equal, treat as draw (no round awarded).
        if (!this.state.isRoundOver && this.state.currentTurn >= CombatEngine.MAX_TURNS_PER_ROUND) {
            this.state.isRoundOver = true;

            const p1Pct = this.state.player1.maxHp > 0 ? this.state.player1.hp / this.state.player1.maxHp : 0;
            const p2Pct = this.state.player2.maxHp > 0 ? this.state.player2.hp / this.state.player2.maxHp : 0;

            if (p1Pct > p2Pct) {
                this.state.roundWinner = "player1";
                this.state.player1.roundsWon++;
            } else if (p2Pct > p1Pct) {
                this.state.roundWinner = "player2";
                this.state.player2.roundsWon++;
            } else {
                this.state.roundWinner = null;
            }

            this.checkMatchEnd();
        }
    }

    /**
     * Check if match has ended.
     */
    private checkMatchEnd(): void {
        if (this.state.player1.roundsWon >= this.state.roundsToWin) {
            this.state.isMatchOver = true;
            this.state.matchWinner = "player1";
        } else if (this.state.player2.roundsWon >= this.state.roundsToWin) {
            this.state.isMatchOver = true;
            this.state.matchWinner = "player2";
        }
    }

    /**
     * Start a new round.
     */
    startNewRound(): void {
        if (this.state.isMatchOver) return;

        const p1Stats = getCharacterCombatStats(this.state.player1.characterId);
        const p2Stats = getCharacterCombatStats(this.state.player2.characterId);

        // Reset HP and energy
        this.state.player1.hp = p1Stats.maxHp;
        this.state.player1.energy = p1Stats.maxEnergy;
        this.state.player1.guardMeter = 0;
        this.state.player1.isStunned = false;
        this.state.player1.isStaggered = false;

        this.state.player2.hp = p2Stats.maxHp;
        this.state.player2.energy = p2Stats.maxEnergy;
        this.state.player2.guardMeter = 0;
        this.state.player2.isStunned = false;
        this.state.player2.isStaggered = false;

        // Reset round state
        this.state.currentRound++;
        this.state.currentTurn = 1;
        this.state.isRoundOver = false;
        this.state.roundWinner = null;

        // Reset surge stun tracking for new round
        // REFACTORED: No longer needed with currentTurn === 1 check

    }

    // ===========================================================================
    // NARRATIVE GENERATION
    // ===========================================================================

    /**
     * Generate a narrative description of the turn.
     */
    private generateNarrative(
        p1Move: MoveType | null,
        p2Move: MoveType | null,
        p1Result: PlayerTurnResult,
        p2Result: PlayerTurnResult
    ): string {
        if (!p1Move && !p2Move) {
            return "Both fighters are stunned!";
        }

        if (!p1Move) {
            return `Player 1 is stunned! Player 2 ${p2Move}s for ${p2Result.damageDealt} damage!`;
        }

        if (!p2Move) {
            return `Player 2 is stunned! Player 1 ${p1Move}s for ${p1Result.damageDealt} damage!`;
        }

        const parts: string[] = [];

        // Describe the interaction
        if (p1Move === p2Move) {
            parts.push(`Both fighters ${p1Move}!`);
        } else {
            parts.push(`${p1Move.toUpperCase()} vs ${p2Move.toUpperCase()}!`);
        }

        // Describe outcomes
        if (p1Result.damageDealt > 0) {
            parts.push(`P1 deals ${p1Result.damageDealt} damage!`);
        }
        if (p2Result.damageDealt > 0) {
            parts.push(`P2 deals ${p2Result.damageDealt} damage!`);
        }

        if (p1Result.outcome === "guarding") {
            parts.push("P1 blocks!");
        }
        if (p2Result.outcome === "guarding") {
            parts.push("P2 blocks!");
        }

        if (p1Result.effects.includes("stun")) {
            parts.push("P1 is stunned!");
        }
        if (p2Result.effects.includes("stun")) {
            parts.push("P2 is stunned!");
        }

        if (p1Result.effects.includes("guard_break")) {
            parts.push("P1's guard is shattered!");
        }
        if (p2Result.effects.includes("guard_break")) {
            parts.push("P2's guard is shattered!");
        }

        return parts.join(" ");
    }

    /**
     * Calculate damage multiplier based on Archetype Counters.
     * Cycle: Speed > Tech > Tank > Precision > Speed
     * Effect: +20% damage (1.2x)
     */
    private getArchetypeMultiplier(attackerId: string, defenderId: string): number {
        const attackerArgs = getCharacterCombatStats(attackerId);
        const defenderArgs = getCharacterCombatStats(defenderId);

        const aType = attackerArgs.archetype;
        const dType = defenderArgs.archetype;

        let isCounter = false;

        if (aType === 'speed' && dType === 'tech') isCounter = true;
        if (aType === 'tech' && dType === 'tank') isCounter = true;
        if (aType === 'tank' && dType === 'precision') isCounter = true;
        if (aType === 'precision' && dType === 'speed') isCounter = true;

        return isCounter ? 1.2 : 1.0;
    }
}

export default CombatEngine;
