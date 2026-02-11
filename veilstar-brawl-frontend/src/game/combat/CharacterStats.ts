/**
 * Character Combat Stats
 * Per-character combat statistics for all 20 fighters
 */

import type { CharacterCombatStats, CharacterArchetype } from "./types";

function createStats(
  characterId: string,
  archetype: CharacterArchetype,
  overrides: Partial<CharacterCombatStats> = {}
): CharacterCombatStats {
  // Base stats by archetype
  const archetypeDefaults: Record<CharacterArchetype, Partial<CharacterCombatStats>> = {
    speed: {
      maxHp: 85,
      maxEnergy: 110,
      energyRegen: 12,
      damageModifiers: { punch: 1.1, kick: 1.15, block: 1.0, special: 1.05 },
      blockEffectiveness: 0.35,
      specialCostModifier: 0.9,
    },
    tank: {
      maxHp: 120,
      maxEnergy: 90,
      energyRegen: 8,
      damageModifiers: { punch: 1.05, kick: 1.0, block: 1.0, special: 1.1 },
      blockEffectiveness: 0.55,
      specialCostModifier: 1.1,
    },
    tech: {
      maxHp: 95,
      maxEnergy: 100,
      energyRegen: 10,
      damageModifiers: { punch: 1.0, kick: 1.05, block: 1.0, special: 1.2 },
      blockEffectiveness: 0.4,
      specialCostModifier: 0.85,
    },
    precision: {
      maxHp: 90,
      maxEnergy: 105,
      energyRegen: 11,
      damageModifiers: { punch: 1.15, kick: 1.1, block: 1.0, special: 1.15 },
      blockEffectiveness: 0.38,
      specialCostModifier: 0.95,
    },
  };

  const defaults = archetypeDefaults[archetype];

  return {
    characterId,
    archetype,
    maxHp: overrides.maxHp ?? defaults.maxHp ?? 100,
    maxEnergy: overrides.maxEnergy ?? defaults.maxEnergy ?? 100,
    energyRegen: overrides.energyRegen ?? defaults.energyRegen ?? 10,
    damageModifiers: overrides.damageModifiers ?? defaults.damageModifiers ?? { punch: 1.0, kick: 1.0, block: 1.0, special: 1.0 },
    blockEffectiveness: overrides.blockEffectiveness ?? defaults.blockEffectiveness ?? 0.4,
    specialCostModifier: overrides.specialCostModifier ?? defaults.specialCostModifier ?? 1.0,
  };
}

// =============================================================================
// CHARACTER STATS
// =============================================================================

export const CHARACTER_COMBAT_STATS: Record<string, CharacterCombatStats> = {
  // Speed Characters
  "cyber-ninja": createStats("cyber-ninja", "speed", { maxHp: 82, maxEnergy: 115, energyRegen: 13, damageModifiers: { punch: 1.15, kick: 1.2, block: 1.0, special: 1.1 } }),
  "sonic-striker": createStats("sonic-striker", "speed", { maxHp: 80, maxEnergy: 120, energyRegen: 14, damageModifiers: { punch: 1.1, kick: 1.25, block: 1.0, special: 1.0 } }),
  "chrono-drifter": createStats("chrono-drifter", "speed", { maxHp: 88, maxEnergy: 108, energyRegen: 12, damageModifiers: { punch: 1.1, kick: 1.1, block: 1.0, special: 1.15 } }),
  "neon-wraith": createStats("neon-wraith", "speed", { maxHp: 78, maxEnergy: 118, energyRegen: 13, damageModifiers: { punch: 1.2, kick: 1.15, block: 1.0, special: 1.05 } }),
  "viperblade": createStats("viperblade", "speed", { maxHp: 84, maxEnergy: 112, energyRegen: 12, damageModifiers: { punch: 1.1, kick: 1.15, block: 1.0, special: 1.1 } }),

  // Tank Characters
  "block-bruiser": createStats("block-bruiser", "tank", { maxHp: 130, maxEnergy: 85, energyRegen: 7, blockEffectiveness: 0.6, damageModifiers: { punch: 1.1, kick: 1.0, block: 1.0, special: 1.15 } }),
  "heavy-loader": createStats("heavy-loader", "tank", { maxHp: 125, maxEnergy: 88, energyRegen: 8, blockEffectiveness: 0.55, damageModifiers: { punch: 1.15, kick: 1.05, block: 1.0, special: 1.1 } }),
  "gene-smasher": createStats("gene-smasher", "tank", { maxHp: 118, maxEnergy: 92, energyRegen: 9, blockEffectiveness: 0.5, damageModifiers: { punch: 1.05, kick: 1.1, block: 1.0, special: 1.2 } }),
  "bastion-hulk": createStats("bastion-hulk", "tank", { maxHp: 135, maxEnergy: 82, energyRegen: 7, blockEffectiveness: 0.65, damageModifiers: { punch: 1.0, kick: 0.95, block: 1.0, special: 1.05 } }),
  "scrap-goliath": createStats("scrap-goliath", "tank", { maxHp: 122, maxEnergy: 90, energyRegen: 8, blockEffectiveness: 0.52, damageModifiers: { punch: 1.1, kick: 1.05, block: 1.0, special: 1.1 } }),

  // Tech Characters
  "dag-warrior": createStats("dag-warrior", "tech", { maxHp: 95, maxEnergy: 105, energyRegen: 11, specialCostModifier: 0.8, damageModifiers: { punch: 1.0, kick: 1.0, block: 1.0, special: 1.25 } }),
  "technomancer": createStats("technomancer", "tech", { maxHp: 90, maxEnergy: 110, energyRegen: 12, specialCostModifier: 0.78, damageModifiers: { punch: 0.95, kick: 1.0, block: 1.0, special: 1.3 } }),
  "nano-brawler": createStats("nano-brawler", "tech", { maxHp: 92, maxEnergy: 102, energyRegen: 10, specialCostModifier: 0.85, damageModifiers: { punch: 1.05, kick: 1.1, block: 1.0, special: 1.15 } }),
  "razor-bot-7": createStats("razor-bot-7", "tech", { maxHp: 98, maxEnergy: 98, energyRegen: 10, specialCostModifier: 0.9, damageModifiers: { punch: 1.1, kick: 1.05, block: 1.0, special: 1.2 } }),
  "cyber-paladin": createStats("cyber-paladin", "tech", { maxHp: 100, maxEnergy: 95, energyRegen: 9, specialCostModifier: 0.88, damageModifiers: { punch: 1.05, kick: 1.0, block: 1.0, special: 1.2 } }),

  // Precision Characters
  "hash-hunter": createStats("hash-hunter", "precision", { maxHp: 88, maxEnergy: 108, energyRegen: 11, damageModifiers: { punch: 1.2, kick: 1.15, block: 1.0, special: 1.15 } }),
  "prism-duelist": createStats("prism-duelist", "precision", { maxHp: 85, maxEnergy: 110, energyRegen: 12, damageModifiers: { punch: 1.15, kick: 1.2, block: 1.0, special: 1.1 } }),
  "kitsune-09": createStats("kitsune-09", "precision", { maxHp: 87, maxEnergy: 112, energyRegen: 11, damageModifiers: { punch: 1.1, kick: 1.15, block: 1.0, special: 1.2 } }),
  "void-reaper": createStats("void-reaper", "precision", { maxHp: 92, maxEnergy: 105, energyRegen: 10, damageModifiers: { punch: 1.15, kick: 1.1, block: 1.0, special: 1.2 } }),
  "aeon-guard": createStats("aeon-guard", "precision", { maxHp: 93, maxEnergy: 102, energyRegen: 10, damageModifiers: { punch: 1.1, kick: 1.1, block: 1.0, special: 1.15 } }),
};

export function getCharacterCombatStats(characterId: string): CharacterCombatStats {
  return CHARACTER_COMBAT_STATS[characterId] || CHARACTER_COMBAT_STATS["dag-warrior"];
}
