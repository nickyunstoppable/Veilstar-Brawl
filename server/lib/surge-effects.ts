/**
 * Surge Effects (server)
 *
 * Server-authoritative implementation of Veilstar Brawl Power Surge modifiers.
 * Mirrors the frontend logic in veilstar-brawl-frontend/src/game/combat/SurgeEffects.ts.
 */

import crypto from "crypto";
import type { PowerSurgeCardId } from "./power-surge";

export type PowerSurgeEffectType =
  | "damage_boost"
  | "damage_reduction"
  | "energy_regen"
  | "energy_burn"
  | "lifesteal"
  | "stun"
  | "special_boost"
  | "counter_boost"
  | "energy_steal"
  | "random_win"
  | "block_disable"
  | "block_reflect"
  | "damage_immunity"
  | "full_heal"
  | "invisible_move";

export interface PowerSurgeEffect {
  type: PowerSurgeEffectType;
  value: number;
}

export interface SurgeCardDefinition {
  id: PowerSurgeCardId;
  effects: PowerSurgeEffect[];
}

// Keep in sync with veilstar-brawl-frontend/src/types/power-surge.ts
const SURGE_CARDS: Record<PowerSurgeCardId, SurgeCardDefinition> = {
  "dag-overclock": {
    id: "dag-overclock",
    effects: [{ type: "damage_boost", value: 0.3 }],
  },
  "sompi-shield": {
    id: "sompi-shield",
    effects: [{ type: "damage_reduction", value: 0.4 }],
  },
  "mempool-burn": {
    id: "mempool-burn",
    effects: [{ type: "energy_burn", value: 0.3 }],
  },
  "bps-syphon": {
    id: "bps-syphon",
    effects: [{ type: "lifesteal", value: 0.4 }],
  },
  "mempool-congest": {
    id: "mempool-congest",
    effects: [{ type: "stun", value: 1 }],
  },
  "finality-fist": {
    id: "finality-fist",
    effects: [
      { type: "special_boost", value: 0.8 },
      // Used as extra special energy cost (see applySurgeCard)
      { type: "energy_burn", value: 20 },
    ],
  },
  "10bps-barrage": {
    id: "10bps-barrage",
    effects: [{ type: "damage_boost", value: 0.5 }],
  },
  ghostdag: {
    id: "ghostdag",
    effects: [{ type: "invisible_move", value: 1 }],
  },
  "hash-hurricane": {
    id: "hash-hurricane",
    effects: [{ type: "random_win", value: 0.3 }],
  },
  "pruned-rage": {
    id: "pruned-rage",
    effects: [{ type: "block_disable", value: 1 }],
  },
  "block-fortress": {
    id: "block-fortress",
    effects: [{ type: "block_reflect", value: 0.5 }],
  },
  "blue-set-heal": {
    id: "blue-set-heal",
    // Frontend maps energy_regen to hpRegenPerTurn for this card
    effects: [{ type: "energy_regen", value: 15 }],
  },
  "tx-storm": {
    id: "tx-storm",
    effects: [
      { type: "damage_boost", value: 0.2 },
      { type: "energy_regen", value: 10 },
    ],
  },
  "orphan-smasher": {
    id: "orphan-smasher",
    effects: [{ type: "counter_boost", value: 0.6 }],
  },
  chainbreaker: {
    id: "chainbreaker",
    // Frontend maps block_disable to bypassBlockOnHit for this card
    effects: [{ type: "block_disable", value: 0.5 }],
  },
  vaultbreaker: {
    id: "vaultbreaker",
    effects: [{ type: "energy_steal", value: 0.25 }],
  },
};

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

function getSurgeCard(id: PowerSurgeCardId): SurgeCardDefinition | undefined {
  return SURGE_CARDS[id];
}

export function calculateSurgeEffects(
  player1CardId: PowerSurgeCardId | null,
  player2CardId: PowerSurgeCardId | null
): { player1Modifiers: SurgeModifiers; player2Modifiers: SurgeModifiers } {
  const p1Mods = createDefaultModifiers();
  const p2Mods = createDefaultModifiers();

  if (player1CardId) applySurgeCard(p1Mods, p2Mods, player1CardId);
  if (player2CardId) applySurgeCard(p2Mods, p1Mods, player2CardId);

  return { player1Modifiers: p1Mods, player2Modifiers: p2Mods };
}

function applySurgeCard(selfMods: SurgeModifiers, opponentMods: SurgeModifiers, cardId: PowerSurgeCardId): void {
  const card = getSurgeCard(cardId);
  if (!card) return;

  for (const effect of card.effects) {
    switch (effect.type) {
      case "damage_boost":
        if (cardId === "10bps-barrage") selfMods.punchKickDamageMultiplier += effect.value;
        else selfMods.damageMultiplier += effect.value;
        break;
      case "damage_reduction":
        selfMods.damageReduction += effect.value;
        break;
      case "energy_burn":
        if (cardId === "finality-fist") selfMods.specialEnergyCost += effect.value;
        else opponentMods.energyBurnPercent += effect.value;
        break;
      case "energy_regen":
        if (cardId === "blue-set-heal") selfMods.hpRegenPerTurn += effect.value;
        else selfMods.energyRegenBonus += effect.value;
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
        if (cardId === "chainbreaker") selfMods.bypassBlockOnHit = true;
        else opponentMods.blockDisabled = true;
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

export function applyDamageModifiers(baseDamage: number, surgeMods: SurgeModifiers, moveType: string, isCounterHit: boolean): number {
  let damage = baseDamage;
  damage *= surgeMods.damageMultiplier;

  if (moveType === "punch" || moveType === "kick") damage *= surgeMods.punchKickDamageMultiplier;
  if (moveType === "special") damage *= surgeMods.specialDamageMultiplier;
  if (isCounterHit) damage *= surgeMods.counterDamageMultiplier;

  return Math.floor(damage);
}

export function applyDefensiveModifiers(
  incomingDamage: number,
  surgeMods: SurgeModifiers,
  isBlocking: boolean
): { actualDamage: number; reflectedDamage: number } {
  // Immunity means no damage and no reflection
  if (surgeMods.damageImmunity) return { actualDamage: 0, reflectedDamage: 0 };

  let actualDamage = incomingDamage;
  let reflectedDamage = 0;

  if (surgeMods.damageReduction > 0) {
    actualDamage = Math.floor(actualDamage * (1 - surgeMods.damageReduction));
  }

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

  if (surgeMods.energyBurnPercent > 0) {
    energyBurned = Math.floor(opponentEnergy * surgeMods.energyBurnPercent);
  }

  if (surgeMods.energyStealPercent > 0 && didHit) {
    energyStolen = Math.floor(opponentEnergy * surgeMods.energyStealPercent);
  }

  return { energyBurned, energyStolen, energyRegenBonus };
}

export function applyHpEffects(surgeMods: SurgeModifiers, currentHp: number, maxHp: number): { hpAfter: number; hpRegen: number } {
  let hp = currentHp;

  if (surgeMods.fullHeal) {
    hp = maxHp;
  }

  const beforeRegen = hp;
  if (surgeMods.hpRegenPerTurn > 0) {
    hp = Math.min(maxHp, hp + surgeMods.hpRegenPerTurn);
  }

  return { hpAfter: hp, hpRegen: Math.max(0, hp - beforeRegen) };
}

export function shouldStunOpponent(surgeMods: SurgeModifiers): boolean {
  return surgeMods.stunOpponent;
}

export function isInvisibleMove(surgeMods: SurgeModifiers): boolean {
  return surgeMods.invisibleMove;
}

export function shouldBypassBlock(surgeMods: SurgeModifiers): boolean {
  return surgeMods.bypassBlockOnHit;
}

export function isBlockDisabled(selfMods: SurgeModifiers, opponentMods: SurgeModifiers): boolean {
  return selfMods.blockDisabled || opponentMods.blockDisabled;
}

// ---------------------------------------------------------------------------
// Deterministic RNG helpers (to keep outcomes reproducible)
// ---------------------------------------------------------------------------

function hash32(seed: string): number {
  const h = crypto.createHash("sha256").update(seed).digest();
  // Use first 4 bytes as uint32
  return h.readUInt32BE(0);
}

export function deterministicChance(seed: string, probability: number): boolean {
  if (probability <= 0) return false;
  if (probability >= 1) return true;
  const x = hash32(seed);
  const r = x / 0xffffffff;
  return r < probability;
}
