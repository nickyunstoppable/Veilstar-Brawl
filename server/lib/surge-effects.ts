/**
 * Surge Effects (server)
 *
 * Server-authoritative implementation of Veilstar Brawl Power Surge modifiers.
 * Mirrors KaspaClash surge logic and card parameters.
 */

import crypto from "crypto";
import type { MoveType } from "./game-types";
import type { PowerSurgeCardId } from "./power-surge";

export type PowerSurgeEffectType =
  | "damage_multiplier"
  | "glass_cannon"
  | "damage_reduction"
  | "hp_regen"
  | "damage_reflect"
  | "thorns_aura"
  | "priority_boost"
  | "energy_burn"
  | "conditional_heal"
  | "counter_multiplier"
  | "double_hit"
  | "fury_boost"
  | "damage_immunity"
  | "random_win"
  | "invisible_move"
  | "critical_special"
  | "energy_regen"
  | "energy_regen_with_cost"
  | "energy_steal"
  | "opponent_stun"
  | "lifesteal"
  | "guard_pressure"
  | "energy_drain"
  | "guard_break";

export interface PowerSurgeEffectParams {
  damageMultiplier?: number;
  incomingDamageReduction?: number;
  hpRestore?: number;
  hpRegen?: number;
  hpCost?: number;
  reflectPercent?: number;
  thornsPercent?: number;
  priorityBoost?: number;
  energyBurn?: number;
  affectedMoves?: string[];
  counterMultiplier?: number;
  furyBoost?: number;
  energySteal?: number;
  energyRegenBonus?: number;
  randomWinChance?: number;
  blockDisabled?: boolean;
  opponentBlockDisabled?: boolean;
  lifestealPercent?: number;
  guardPressureOnHit?: number;
  energyDrain?: number;
  energyCostBonus?: number;
}

interface SurgeCardDefinition {
  id: PowerSurgeCardId;
  effectType: PowerSurgeEffectType;
  effectParams: PowerSurgeEffectParams;
}

const SURGE_CARDS: Record<PowerSurgeCardId, SurgeCardDefinition> = {
  "dag-overclock": {
    id: "dag-overclock",
    effectType: "damage_multiplier",
    effectParams: { damageMultiplier: 1.4, incomingDamageReduction: 0.0 },
  },
  "block-fortress": {
    id: "block-fortress",
    effectType: "damage_reflect",
    effectParams: { reflectPercent: 1.2 },
  },
  "tx-storm": {
    id: "tx-storm",
    effectType: "priority_boost",
    effectParams: { priorityBoost: 2 },
  },
  "mempool-congest": {
    id: "mempool-congest",
    effectType: "glass_cannon",
    effectParams: { damageMultiplier: 1.25, incomingDamageReduction: -0.2 },
  },
  "blue-set-heal": {
    id: "blue-set-heal",
    effectType: "hp_regen",
    effectParams: { hpRegen: 5 },
  },
  "orphan-smasher": {
    id: "orphan-smasher",
    effectType: "counter_multiplier",
    effectParams: { counterMultiplier: 1.75 },
  },
  "10bps-barrage": {
    id: "10bps-barrage",
    effectType: "double_hit",
    effectParams: { affectedMoves: ["punch"] },
  },
  "pruned-rage": {
    id: "pruned-rage",
    effectType: "fury_boost",
    effectParams: { damageMultiplier: 1.3, opponentBlockDisabled: true },
  },
  "sompi-shield": {
    id: "sompi-shield",
    effectType: "damage_reduction",
    effectParams: { incomingDamageReduction: 0.25 },
  },
  "hash-hurricane": {
    id: "hash-hurricane",
    effectType: "thorns_aura",
    effectParams: { thornsPercent: 0.35 },
  },
  "ghost-dag": {
    id: "ghost-dag",
    effectType: "invisible_move",
    effectParams: {},
  },
  "finality-fist": {
    id: "finality-fist",
    effectType: "critical_special",
    effectParams: { damageMultiplier: 1.7 },
  },
  "bps-blitz": {
    id: "bps-blitz",
    effectType: "lifesteal",
    effectParams: { lifestealPercent: 0.35 },
  },
  "vaultbreaker": {
    id: "vaultbreaker",
    effectType: "guard_pressure",
    effectParams: { guardPressureOnHit: 30 },
  },
  "chainbreaker": {
    id: "chainbreaker",
    effectType: "guard_break",
    effectParams: { damageMultiplier: 1.15 },
  },
};

export interface SurgeModifiers {
  damageMultiplier: number;
  incomingDamageReduction: number;
  priorityBoost: number;
  energyBurn: number;
  energySteal: number;
  energyDrain: number;
  hpRegen: number;
  hpCost: number;
  fullHeal: boolean;
  damageImmunity: boolean;
  invisibleMove: boolean;
  randomWinChance: number;
  doubleHit: boolean;
  counterMultiplier: number;
  reflectPercent: number;
  thornsPercent: number;
  opponentStun: boolean;
  bypassBlockOnHit: boolean;
  criticalHit: boolean;
  energyRegenBonus: number;
  doubleHitMoves: MoveType[];
  blockDisabled: boolean;
  opponentBlockDisabled: boolean;
  lifestealPercent: number;
  guardPressureOnHit: number;
  specialEnergyCost: number;
}

function createDefaultModifiers(): SurgeModifiers {
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
    thornsPercent: 0,
    opponentStun: false,
    bypassBlockOnHit: false,
    criticalHit: false,
    energyRegenBonus: 0,
    doubleHitMoves: [],
    blockDisabled: false,
    opponentBlockDisabled: false,
    lifestealPercent: 0,
    guardPressureOnHit: 0,
    specialEnergyCost: 0,
  };
}

function getSurgeCard(id: PowerSurgeCardId): SurgeCardDefinition | undefined {
  return SURGE_CARDS[id];
}

export function calculateSurgeEffects(
  player1CardId: PowerSurgeCardId | null,
  player2CardId: PowerSurgeCardId | null
): { player1Modifiers: SurgeModifiers; player2Modifiers: SurgeModifiers } {
  return {
    player1Modifiers: player1CardId
      ? calculateCardModifiers(getSurgeCard(player1CardId) ?? null)
      : createDefaultModifiers(),
    player2Modifiers: player2CardId
      ? calculateCardModifiers(getSurgeCard(player2CardId) ?? null)
      : createDefaultModifiers(),
  };
}

function calculateCardModifiers(card: SurgeCardDefinition | null): SurgeModifiers {
  const mods = createDefaultModifiers();
  if (!card) return mods;

  const params = card.effectParams;

  switch (card.effectType) {
    case "damage_multiplier":
      mods.damageMultiplier = params.damageMultiplier ?? 1.0;
      if (params.incomingDamageReduction !== undefined) {
        mods.incomingDamageReduction = params.incomingDamageReduction;
      }
      break;
    case "glass_cannon":
      mods.damageMultiplier = params.damageMultiplier ?? 1.25;
      mods.incomingDamageReduction = params.incomingDamageReduction ?? -0.2;
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
    case "thorns_aura":
      mods.thornsPercent = params.thornsPercent ?? 0;
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
      mods.specialEnergyCost = params.energyCostBonus ?? 0;
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
    case "guard_pressure":
      mods.guardPressureOnHit = params.guardPressureOnHit ?? 25;
      break;
    case "guard_break":
      mods.bypassBlockOnHit = true;
      mods.damageMultiplier = params.damageMultiplier ?? 1.15;
      break;
  }

  return mods;
}

export function applyDamageModifiers(baseDamage: number, surgeMods: SurgeModifiers, moveType: MoveType, isCounterHit: boolean): number {
  let damage = baseDamage;
  damage *= surgeMods.damageMultiplier;

  if (isCounterHit) damage *= surgeMods.counterMultiplier;
  if (surgeMods.doubleHit && surgeMods.doubleHitMoves.includes(moveType)) damage *= 2;

  return Math.floor(damage);
}

export function applyDefensiveModifiers(
  incomingDamage: number,
  surgeMods: SurgeModifiers,
  isBlocking: boolean
): { actualDamage: number; reflectedDamage: number } {
  if (surgeMods.damageImmunity) return { actualDamage: 0, reflectedDamage: 0 };

  let actualDamage = incomingDamage;
  let reflectedDamage = 0;

  if (surgeMods.incomingDamageReduction !== 0) {
    const multiplier = 1 - surgeMods.incomingDamageReduction;
    actualDamage = Math.floor(actualDamage * multiplier);
  }

  if (surgeMods.thornsPercent > 0) {
    reflectedDamage += Math.floor(incomingDamage * surgeMods.thornsPercent);
  }

  if (isBlocking && surgeMods.reflectPercent > 0) {
    reflectedDamage += Math.floor(incomingDamage * surgeMods.reflectPercent);
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

  if (didHit) {
    energyBurned += Math.min(surgeMods.energyBurn, opponentEnergy);
    energyStolen += Math.min(surgeMods.energySteal, opponentEnergy);
  }

  if (surgeMods.energyDrain > 0) {
    const remainingEnergy = Math.max(0, opponentEnergy - energyBurned);
    energyBurned += Math.min(surgeMods.energyDrain, remainingEnergy);
  }

  return { energyBurned, energyStolen, energyRegenBonus: surgeMods.energyRegenBonus };
}

export function applyHpEffects(surgeMods: SurgeModifiers, currentHp: number, maxHp: number): number {
  if (currentHp <= 0) return currentHp;

  let hp = currentHp;

  if (surgeMods.fullHeal) {
    return maxHp;
  }

  if (surgeMods.hpRegen > 0) {
    hp = Math.min(maxHp, hp + surgeMods.hpRegen);
  }

  if (surgeMods.hpCost > 0) {
    hp = Math.max(1, hp - surgeMods.hpCost);
  }

  return hp;
}

export function shouldStunOpponent(surgeMods: SurgeModifiers): boolean {
  return surgeMods.opponentStun;
}

export function isInvisibleMove(surgeMods: SurgeModifiers): boolean {
  return surgeMods.invisibleMove;
}

export function shouldBypassBlock(surgeMods: SurgeModifiers): boolean {
  return surgeMods.bypassBlockOnHit;
}

export function isBlockDisabled(selfMods: SurgeModifiers, opponentMods: SurgeModifiers): boolean {
  if (selfMods.blockDisabled) return true;
  if (opponentMods.opponentBlockDisabled) return true;
  return false;
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

export function checkRandomWin(modifiers: SurgeModifiers): boolean {
  if (modifiers.randomWinChance <= 0) return false;
  return Math.random() < modifiers.randomWinChance;
}
