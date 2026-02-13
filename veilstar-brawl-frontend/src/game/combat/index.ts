/**
 * Combat Module Exports
 */

export { CombatEngine } from "./CombatEngine";
export { getCharacterCombatStats, CHARACTER_COMBAT_STATS } from "./CharacterStats";
export {
    type CharacterCombatStats,
    type CombatState,
    type PlayerCombatState,
    type TurnResult,
    type PlayerTurnResult,
    type MoveOutcome,
    type TurnEffect,
    type MoveStats,
    BASE_MOVE_STATS,
    COMBAT_CONSTANTS,
    RESOLUTION_MATRIX,
} from "./types";

// Power Surge combat effects
export {
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
    comparePriority,
    type SurgeModifiers,
    type SurgeEffectResult,
} from "./SurgeEffects";
