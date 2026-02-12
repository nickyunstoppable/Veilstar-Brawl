/**
 * Combat Surge Effects
 * Applies Power Surge card effects during combat resolution
 * 
 * This module provides functions to calculate damage modifiers,
 * priority changes, and other effects based on active surge cards.
 */

import type { MoveType } from "@/types/game";
import type {
  PowerSurgeCardId,
  PowerSurgeCard,
} from "@/types/power-surge";
import { getPowerSurgeCard } from "@/types/power-surge";

// =============================================================================
// TYPES
// =============================================================================

export interface SurgeModifiers {
  /** Damage multiplier (1.0 = normal) */
  damageMultiplier: number;
  /** Incoming damage reduction (0.0 = none, 0.6 = 60% less damage) */
  incomingDamageReduction: number;
  /** Priority boost (0 = normal) */
  priorityBoost: number;
  /** Energy burn on hit */
  energyBurn: number;
  /** Energy steal on hit */
  energySteal: number;
  /** Passive energy drain (always applies) */
  energyDrain: number;
  /** HP regen this turn */
  hpRegen: number;
  /** HP cost to pay when using this surge */
  hpCost: number;
  /** Full heal flag */
  fullHeal: boolean;
  /** Damage immunity flag */
  damageImmunity: boolean;
  /** Invisible move (cannot be countered) */
  invisibleMove: boolean;
  /** Random win chance (0-1) for dodge/evasion */
  randomWinChance: number;
  /** Double hit for affected moves */
  doubleHit: boolean;
  /** Counter multiplier (for counter-attacks) */
  counterMultiplier: number;
  /** Damage reflect percent (0-1) */
  reflectPercent: number;
  /** Opponent stun next turn */
  opponentStun: boolean;
  /** Bypass opponent's block reduction on any hit */
  bypassBlockOnHit: boolean;
  /** Critical hit guaranteed */
  criticalHit: boolean;
  /** Energy regen bonus */
  energyRegenBonus: number;
  /** Moves affected by double hit */
  doubleHitMoves: MoveType[];
  /** Block is disabled (cannot use block effectively) */
  blockDisabled: boolean;
  /** Opponent's block is disabled (Pruned Rage) */
  opponentBlockDisabled: boolean;
  /** Lifesteal percentage */
  lifestealPercent: number;
  /** Extra energy cost for special move (Finality Fist) */
  specialEnergyCost: number;
}

export interface SurgeEffectResult {
  player1Modifiers: SurgeModifiers;
  player2Modifiers: SurgeModifiers;
}

// =============================================================================
// DEFAULT MODIFIERS
// =============================================================================

function getDefaultModifiers(): SurgeModifiers {
  return {
    damageMultiplier: 1.0,
    incomingDamageReduction: 0,
    priorityBoost: 0,
    energyBurn: 0,
    energySteal: 0,
    energyDrain: 0,
    hpRegen: 0,
    hpCost: 0,
    fullHeal: false,
    damageImmunity: false,
    invisibleMove: false,
    randomWinChance: 0,
    doubleHit: false,
    counterMultiplier: 1.0,
    reflectPercent: 0,
    opponentStun: false,
    bypassBlockOnHit: false,
    criticalHit: false,
    energyRegenBonus: 0,
    doubleHitMoves: [],
    blockDisabled: false,
    opponentBlockDisabled: false,
    lifestealPercent: 0,
    specialEnergyCost: 0,
  };
}

// =============================================================================
// SURGE EFFECT CALCULATION
// =============================================================================

/**
 * Calculate surge modifiers for both players based on their active cards.
 * 
 * @param player1Surge - Player 1's active surge card (or null)
 * @param player2Surge - Player 2's active surge card (or null)
 * @returns Modifiers for both players
 */
export function calculateSurgeEffects(
  player1Surge: PowerSurgeCardId | null,
  player2Surge: PowerSurgeCardId | null
): SurgeEffectResult {
  return {
    player1Modifiers: player1Surge
      ? calculateCardModifiers(getPowerSurgeCard(player1Surge) ?? null)
      : getDefaultModifiers(),
    player2Modifiers: player2Surge
      ? calculateCardModifiers(getPowerSurgeCard(player2Surge) ?? null)
      : getDefaultModifiers(),
  };
}

/**
 * Calculate modifiers for a single surge card.
 */
function calculateCardModifiers(card: PowerSurgeCard | null): SurgeModifiers {
  const mods = getDefaultModifiers();
  if (!card) return mods;

  const params = card.effectParams;

  switch (card.effectType) {
    case "damage_multiplier":
      mods.damageMultiplier = params.damageMultiplier ?? 1.0;
      if (params.incomingDamageReduction !== undefined) {
        mods.incomingDamageReduction = params.incomingDamageReduction;
      }
      break;

    case "damage_reduction":
      mods.incomingDamageReduction = params.incomingDamageReduction ?? 0;
      break;

    case "hp_regen":
      mods.hpRegen = params.hpRegen ?? 0;
      break;

    case "damage_reflect":
      mods.hpRegen = params.hpRegen ?? 0;
      mods.reflectPercent = params.reflectPercent ?? 0;
      break;

    case "priority_boost":
      mods.priorityBoost = params.priorityBoost ?? 0;
      break;

    case "energy_burn":
      mods.energyBurn = params.energyBurn ?? 0;
      break;

    case "energy_drain":
      mods.energyDrain = params.energyDrain ?? 0;
      break;

    case "conditional_heal":
      mods.fullHeal = true;
      break;

    case "counter_multiplier":
      mods.counterMultiplier = params.counterMultiplier ?? 1.0;
      break;

    case "double_hit":
      mods.doubleHit = true;
      mods.doubleHitMoves = (params.affectedMoves ?? ["punch", "kick"]) as MoveType[];
      break;

    case "fury_boost":
      mods.damageMultiplier = params.damageMultiplier ?? 1.3;
      mods.opponentBlockDisabled = params.opponentBlockDisabled ?? false;
      break;

    case "damage_immunity":
      mods.damageImmunity = true;
      break;

    case "random_win":
      mods.randomWinChance = params.randomWinChance ?? 1.0;
      break;

    case "invisible_move":
      mods.invisibleMove = true;
      break;

    case "critical_special":
      mods.criticalHit = true;
      mods.damageMultiplier = params.damageMultiplier ?? 1.7;
      mods.specialEnergyCost = params.energyCostBonus ?? 12;
      break;

    case "energy_regen":
      mods.energyRegenBonus = params.energyRegenBonus ?? 18;
      break;

    case "energy_regen_with_cost":
      mods.energyRegenBonus = params.energyRegenBonus ?? 25;
      mods.hpCost = params.hpCost ?? 4;
      break;

    case "energy_steal":
      mods.energySteal = params.energySteal ?? 18;
      break;

    case "opponent_stun":
      mods.opponentStun = true;
      mods.hpCost = params.hpCost ?? 6;
      break;

    case "lifesteal":
      mods.lifestealPercent = params.lifestealPercent ?? 0.35;
      break;

    case "guard_break":
      mods.bypassBlockOnHit = true;
      mods.damageMultiplier = params.damageMultiplier ?? 1.15;
      break;
  }

  return mods;
}

// =============================================================================
// EFFECT APPLICATION HELPERS
// =============================================================================

export function applyDamageModifiers(
  baseDamage: number,
  modifiers: SurgeModifiers,
  move: MoveType,
  isCounter: boolean = false
): number {
  let damage = baseDamage;

  damage *= modifiers.damageMultiplier;

  if (isCounter) {
    damage *= modifiers.counterMultiplier;
  }

  if (modifiers.doubleHit && modifiers.doubleHitMoves.includes(move)) {
    damage *= 2;
  }

  return Math.floor(damage);
}

export function checkRandomWin(modifiers: SurgeModifiers): boolean {
  if (modifiers.randomWinChance <= 0) return false;
  return Math.random() < modifiers.randomWinChance;
}

export function applyDefensiveModifiers(
  incomingDamage: number,
  defenderModifiers: SurgeModifiers,
  isBlocking: boolean = false
): { actualDamage: number; reflectedDamage: number } {
  if (defenderModifiers.damageImmunity) {
    return { actualDamage: 0, reflectedDamage: 0 };
  }

  let actualDamage = incomingDamage;

  if (defenderModifiers.incomingDamageReduction !== 0) {
    const multiplier = 1 - defenderModifiers.incomingDamageReduction;
    actualDamage = Math.floor(actualDamage * multiplier);
  }

  let reflectedDamage = 0;
  if (isBlocking && defenderModifiers.reflectPercent > 0) {
    reflectedDamage = Math.floor(incomingDamage * defenderModifiers.reflectPercent);
  }

  return { actualDamage, reflectedDamage };
}

export function applyEnergyEffects(
  attackerModifiers: SurgeModifiers,
  defenderEnergy: number,
  didHit: boolean
): { energyBurned: number; energyStolen: number; energyRegenBonus: number } {
  let energyBurned = 0;
  let energyStolen = 0;

  if (didHit) {
    energyBurned += Math.min(attackerModifiers.energyBurn, defenderEnergy);
    energyStolen += Math.min(attackerModifiers.energySteal, defenderEnergy);
  }

  if (attackerModifiers.energyDrain > 0) {
    const remainingEnergy = Math.max(0, defenderEnergy - energyBurned);
    energyBurned += Math.min(attackerModifiers.energyDrain, remainingEnergy);
  }

  return {
    energyBurned,
    energyStolen,
    energyRegenBonus: attackerModifiers.energyRegenBonus,
  };
}

export function applyHpEffects(
  modifiers: SurgeModifiers,
  currentHp: number,
  maxHp: number
): number {
  if (currentHp <= 0) {
    return currentHp;
  }

  let hp = currentHp;

  if (modifiers.fullHeal) {
    return maxHp;
  }

  if (modifiers.hpRegen > 0) {
    hp = Math.min(maxHp, hp + modifiers.hpRegen);
  }

  if (modifiers.hpCost > 0) {
    hp = Math.max(1, hp - modifiers.hpCost);
  }

  return hp;
}

export function isInvisibleMove(modifiers: SurgeModifiers): boolean {
  return modifiers.invisibleMove;
}

export function shouldStunOpponent(modifiers: SurgeModifiers): boolean {
  return modifiers.opponentStun;
}

export function shouldBypassBlock(modifiers: SurgeModifiers): boolean {
  return modifiers.bypassBlockOnHit;
}

export function isBlockDisabled(myModifiers: SurgeModifiers, opponentModifiers?: SurgeModifiers): boolean {
  if (myModifiers.blockDisabled) return true;

  if (opponentModifiers?.opponentBlockDisabled) return true;

  return false;
}

export function comparePriority(
  p1Priority: number,
  p1Modifiers: SurgeModifiers,
  p2Priority: number,
  p2Modifiers: SurgeModifiers
): number {
  const p1Total = p1Priority + p1Modifiers.priorityBoost;
  const p2Total = p2Priority + p2Modifiers.priorityBoost;

  if (p1Total > p2Total) return 1;
  if (p2Total > p1Total) return -1;
  return 0;
}
