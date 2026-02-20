export interface CharacterCombatCaps {
  maxHp: number;
  maxEnergy: number;
}

const DEFAULT_CAPS: CharacterCombatCaps = {
  maxHp: 100,
  maxEnergy: 100,
};

const CAPS_BY_CHARACTER_ID: Record<string, CharacterCombatCaps> = {
  "cyber-ninja": { maxHp: 96, maxEnergy: 105 },
  "soroban-sage": { maxHp: 100, maxEnergy: 100 },
  "ledger-titan": { maxHp: 115, maxEnergy: 90 },
  "hash-hunter": { maxHp: 98, maxEnergy: 105 },

  "neon-wraith": { maxHp: 92, maxEnergy: 120 },
  "kitsune-09": { maxHp: 90, maxEnergy: 110 },
  "viperblade": { maxHp: 105, maxEnergy: 100 },
  "chrono-drifter": { maxHp: 120, maxEnergy: 105 },

  "heavy-loader": { maxHp: 135, maxEnergy: 70 },
  "gene-smasher": { maxHp: 115, maxEnergy: 90 },
  "bastion-hulk": { maxHp: 115, maxEnergy: 115 },
  "scrap-goliath": { maxHp: 115, maxEnergy: 80 },

  "cyber-paladin": { maxHp: 115, maxEnergy: 95 },
  "nano-brawler": { maxHp: 95, maxEnergy: 105 },
  "technomancer": { maxHp: 95, maxEnergy: 120 },
  "aeon-guard": { maxHp: 120, maxEnergy: 120 },

  "razor-bot-7": { maxHp: 95, maxEnergy: 100 },
  "sonic-striker": { maxHp: 105, maxEnergy: 100 },
  "prism-duelist": { maxHp: 100, maxEnergy: 110 },
  "void-reaper": { maxHp: 95, maxEnergy: 120 },
};

export function getCharacterCombatCaps(characterId: string): CharacterCombatCaps {
  return CAPS_BY_CHARACTER_ID[characterId] ?? DEFAULT_CAPS;
}
