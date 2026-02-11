/**
 * Power Surge Effects System
 * Calculates and applies Power Surge card modifiers during combat
 */

import type { PowerSurgeCardId } from "@/types/power-surge";
import { getPowerSurgeCard } from "@/types/power-surge";

// =============================================================================
// SURGE MODIFIERS
// =============================================================================

export interface SurgeModifiers {
  // Damage
  damageMultiplier: number;
  damageReduction: number;
  damageImmunity: boolean;
  specialDamageMultiplier: number;
  counterDamageMultiplier: number;
  punchKickDamageMultiplier: number;

  // Energy
  energyBurnPercent: number;
  energyStealPercent: number;
  energyRegenBonus: number;
  specialEnergyCost: number;

  // Health
  lifestealPercent: number;
  hpRegenPerTurn: number;
  fullHeal: boolean;

  // Status
  stunOpponent: boolean;
  invisibleMove: boolean;

  // Block
  blockDisabled: boolean;
  blockReflectPercent: number;
  bypassBlockOnHit: boolean;

  // Random
  dodgeChance: number;
}

function createDefaultModifiers(): SurgeModifiers {
  return {
    damageMultiplier: 1.0,
    damageReduction: 0,
    damageImmunity: false,
    specialDamageMultiplier: 1.0,
    counterDamageMultiplier: 1.0,
    punchKickDamageMultiplier: 1.0,
    energyBurnPercent: 0,
    energyStealPercent: 0,
    energyRegenBonus: 0,
    specialEnergyCost: 0,
    lifestealPercent: 0,
    hpRegenPerTurn: 0,
    fullHeal: false,
    stunOpponent: false,
    invisibleMove: false,
    blockDisabled: false,
    blockReflectPercent: 0,
    bypassBlockOnHit: false,
    dodgeChance: 0,
  };
}

// =============================================================================
// CALCULATE SURGE EFFECTS
// =============================================================================

export function calculateSurgeEffects(
  player1CardId: PowerSurgeCardId | null,
  player2CardId: PowerSurgeCardId | null
): {
  player1Modifiers: SurgeModifiers;
  player2Modifiers: SurgeModifiers;
} {
  const p1Mods = createDefaultModifiers();
  const p2Mods = createDefaultModifiers();

  if (player1CardId) {
    applySurgeCard(p1Mods, p2Mods, player1CardId);
  }
  if (player2CardId) {
    applySurgeCard(p2Mods, p1Mods, player2CardId);
  }

  return { player1Modifiers: p1Mods, player2Modifiers: p2Mods };
}

function applySurgeCard(
  selfMods: SurgeModifiers,
  opponentMods: SurgeModifiers,
  cardId: PowerSurgeCardId
): void {
  const card = getPowerSurgeCard(cardId);
  if (!card) return;

  for (const effect of card.effects) {
    switch (effect.type) {
      case "damage_boost":
        if (cardId === "10bps-barrage") {
          selfMods.punchKickDamageMultiplier += effect.value;
        } else {
          selfMods.damageMultiplier += effect.value;
        }
        break;
      case "damage_reduction":
        selfMods.damageReduction += effect.value;
        break;
      case "energy_burn":
        if (cardId === "finality-fist") {
          selfMods.specialEnergyCost += effect.value;
        } else {
          opponentMods.energyBurnPercent += effect.value;
        }
        break;
      case "energy_regen":
        if (cardId === "blue-set-heal") {
          selfMods.hpRegenPerTurn += effect.value;
        } else {
          selfMods.energyRegenBonus += effect.value;
        }
        break;
      case "lifesteal":
        selfMods.lifestealPercent += effect.value;
        break;
      case "stun":
        selfMods.stunOpponent = true;
        break;
      case "special_boost":
        selfMods.specialDamageMultiplier += effect.value;
        break;
      case "counter_boost":
        selfMods.counterDamageMultiplier += effect.value;
        break;
      case "invisible_move":
        selfMods.invisibleMove = true;
        break;
      case "random_win":
        selfMods.dodgeChance += effect.value;
        break;
      case "block_disable":
        if (cardId === "chainbreaker") {
          selfMods.bypassBlockOnHit = true;
        } else {
          opponentMods.blockDisabled = true;
        }
        break;
      case "block_reflect":
        selfMods.blockReflectPercent += effect.value;
        break;
      case "energy_steal":
        selfMods.energyStealPercent += effect.value;
        break;
      case "damage_immunity":
        selfMods.damageImmunity = true;
        break;
      case "full_heal":
        selfMods.fullHeal = true;
        break;
    }
  }
}

// =============================================================================
// APPLY MODIFIERS
// =============================================================================

export function applyDamageModifiers(
  baseDamage: number,
  surgeMods: SurgeModifiers,
  moveType: string,
  isCounterHit: boolean
): number {
  let damage = baseDamage;

  // General damage multiplier
  damage *= surgeMods.damageMultiplier;

  // Punch/kick specific multiplier (10 BPS Barrage)
  if (moveType === "punch" || moveType === "kick") {
    damage *= surgeMods.punchKickDamageMultiplier;
  }

  // Special damage multiplier (Finality Fist)
  if (moveType === "special") {
    damage *= surgeMods.specialDamageMultiplier;
  }

  // Counter hit multiplier (Orphan Smasher)
  if (isCounterHit) {
    damage *= surgeMods.counterDamageMultiplier;
  }

  return Math.floor(damage);
}

export function applyDefensiveModifiers(
  incomingDamage: number,
  surgeMods: SurgeModifiers,
  isBlocking: boolean
): { actualDamage: number; reflectedDamage: number } {
  let actualDamage = incomingDamage;
  let reflectedDamage = 0;

  // Damage immunity
  if (surgeMods.damageImmunity) {
    return { actualDamage: 0, reflectedDamage: 0 };
  }

  // Damage reduction (Sompi Shield)
  if (surgeMods.damageReduction > 0) {
    actualDamage = Math.floor(actualDamage * (1 - surgeMods.damageReduction));
  }

  // Block reflection (Block Fortress)
  if (isBlocking && surgeMods.blockReflectPercent > 0) {
    reflectedDamage = Math.floor(incomingDamage * surgeMods.blockReflectPercent);
  }

  return { actualDamage, reflectedDamage };
}

export function applyEnergyEffects(
  surgeMods: SurgeModifiers,
  opponentEnergy: number,
  didHit: boolean
): { energyBurned: number; energyStolen: number; energyRegenBonus: number } {
  let energyBurned = 0;
  let energyStolen = 0;
  const energyRegenBonus = surgeMods.energyRegenBonus;

  // Energy burn (Mempool Burn)
  if (surgeMods.energyBurnPercent > 0) {
    energyBurned = Math.floor(opponentEnergy * surgeMods.energyBurnPercent);
  }

  // Energy steal (Vaultbreaker) - only on hit
  if (surgeMods.energyStealPercent > 0 && didHit) {
    energyStolen = Math.floor(opponentEnergy * surgeMods.energyStealPercent);
  }

  return { energyBurned, energyStolen, energyRegenBonus };
}

export function applyHpEffects(
  surgeMods: SurgeModifiers,
  currentHp: number,
  maxHp: number
): number {
  let hp = currentHp;

  // Full heal
  if (surgeMods.fullHeal) {
    hp = maxHp;
  }

  // HP regen per turn (Blue Set Heal)
  if (surgeMods.hpRegenPerTurn > 0) {
    hp = Math.min(maxHp, hp + surgeMods.hpRegenPerTurn);
  }

  return hp;
}

// =============================================================================
// HELPER CHECKS
// =============================================================================

export function checkRandomWin(surgeMods: SurgeModifiers): boolean {
  if (surgeMods.dodgeChance <= 0) return false;
  return Math.random() < surgeMods.dodgeChance;
}

export function isInvisibleMove(surgeMods: SurgeModifiers): boolean {
  return surgeMods.invisibleMove;
}

export function shouldStunOpponent(surgeMods: SurgeModifiers): boolean {
  return surgeMods.stunOpponent;
}

export function shouldBypassBlock(surgeMods: SurgeModifiers): boolean {
  return surgeMods.bypassBlockOnHit;
}

export function isBlockDisabled(
  selfMods: SurgeModifiers,
  opponentMods: SurgeModifiers
): boolean {
  return selfMods.blockDisabled || opponentMods.blockDisabled;
}
