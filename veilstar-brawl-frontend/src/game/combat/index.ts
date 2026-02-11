export { CombatEngine } from "./CombatEngine";
export { getCharacterCombatStats, CHARACTER_COMBAT_STATS } from "./CharacterStats";
export { BASE_MOVE_STATS, COMBAT_CONSTANTS, RESOLUTION_MATRIX } from "./types";
export type { CombatState, PlayerCombatState, TurnResult, PlayerTurnResult, MoveOutcome, TurnEffect, CharacterCombatStats } from "./types";
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
} from "./SurgeEffects";
export type { SurgeModifiers } from "./SurgeEffects";
