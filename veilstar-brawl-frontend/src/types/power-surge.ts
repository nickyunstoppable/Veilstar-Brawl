/**
 * Power Surge Card Types & Data
 */

// =============================================================================
// TYPES
// =============================================================================

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

export type PowerSurgeCardId =
  | "dag-overclock"
  | "sompi-shield"
  | "mempool-burn"
  | "bps-syphon"
  | "mempool-congest"
  | "finality-fist"
  | "10bps-barrage"
  | "ghostdag"
  | "hash-hurricane"
  | "pruned-rage"
  | "block-fortress"
  | "blue-set-heal"
  | "tx-storm"
  | "orphan-smasher"
  | "chainbreaker"
  | "vaultbreaker";

export interface PowerSurgeEffect {
  type: PowerSurgeEffectType;
  value: number;
  description: string;
}

export interface PowerSurgeCard {
  id: PowerSurgeCardId;
  name: string;
  description: string;
  effects: PowerSurgeEffect[];
  iconKey: string;
  glowColor: number;
  rarity: "common" | "rare" | "epic" | "legendary";
}

// =============================================================================
// CARD CATALOG
// =============================================================================

export const POWER_SURGE_CARDS: PowerSurgeCard[] = [
  {
    id: "dag-overclock",
    name: "DAG Overclock",
    description: "+30% damage this round",
    effects: [{ type: "damage_boost", value: 0.3, description: "+30% damage" }],
    iconKey: "surge_dag-overclock",
    glowColor: 0xff6600,
    rarity: "rare",
  },
  {
    id: "sompi-shield",
    name: "Sompi Shield",
    description: "-40% incoming damage this round",
    effects: [{ type: "damage_reduction", value: 0.4, description: "-40% incoming damage" }],
    iconKey: "surge_sompi-shield",
    glowColor: 0x00ccff,
    rarity: "rare",
  },
  {
    id: "mempool-burn",
    name: "Mempool Burn",
    description: "Burn 30% of opponent's energy",
    effects: [{ type: "energy_burn", value: 0.3, description: "Burn 30% opponent energy" }],
    iconKey: "surge_mempool-burn",
    glowColor: 0xff3300,
    rarity: "epic",
  },
  {
    id: "bps-syphon",
    name: "BPS Syphon",
    description: "Lifesteal: heal 40% of damage dealt",
    effects: [{ type: "lifesteal", value: 0.4, description: "40% lifesteal" }],
    iconKey: "surge_bps-blitz",
    glowColor: 0x9933ff,
    rarity: "epic",
  },
  {
    id: "mempool-congest",
    name: "Mempool Congest",
    description: "Stun opponent for 1 turn",
    effects: [{ type: "stun", value: 1, description: "Stun 1 turn" }],
    iconKey: "surge_tx-storm",
    glowColor: 0xffcc00,
    rarity: "legendary",
  },
  {
    id: "finality-fist",
    name: "Finality Fist",
    description: "+80% special damage, costs 20 extra energy",
    effects: [
      { type: "special_boost", value: 0.8, description: "+80% special damage" },
      { type: "energy_burn", value: 20, description: "Costs 20 extra energy" },
    ],
    iconKey: "surge_finality-fist",
    glowColor: 0xff0066,
    rarity: "legendary",
  },
  {
    id: "10bps-barrage",
    name: "10 BPS Barrage",
    description: "+50% kick & punch damage",
    effects: [
      { type: "damage_boost", value: 0.5, description: "+50% punch/kick damage" },
    ],
    iconKey: "surge_10bps-barrage",
    glowColor: 0x00ff88,
    rarity: "rare",
  },
  {
    id: "ghostdag",
    name: "GhostDAG",
    description: "Your moves can't be countered this round",
    effects: [{ type: "invisible_move", value: 1, description: "Cannot be countered" }],
    iconKey: "surge_ghost-dag",
    glowColor: 0x6666ff,
    rarity: "epic",
  },
  {
    id: "hash-hurricane",
    name: "Hash Hurricane",
    description: "30% chance to dodge opponent's attack",
    effects: [{ type: "random_win", value: 0.3, description: "30% dodge chance" }],
    iconKey: "surge_hash-hurricane",
    glowColor: 0x00ffcc,
    rarity: "epic",
  },
  {
    id: "pruned-rage",
    name: "Pruned Rage",
    description: "Disable opponent's block this round",
    effects: [{ type: "block_disable", value: 1, description: "Disable opponent block" }],
    iconKey: "surge_pruned-rage",
    glowColor: 0xff0000,
    rarity: "legendary",
  },
  {
    id: "block-fortress",
    name: "Block Fortress",
    description: "Reflect 50% damage when blocking",
    effects: [{ type: "block_reflect", value: 0.5, description: "50% block reflect" }],
    iconKey: "surge_block-fortress",
    glowColor: 0x3399ff,
    rarity: "rare",
  },
  {
    id: "blue-set-heal",
    name: "Blue Set Heal",
    description: "Regenerate 15 HP per turn this round",
    effects: [{ type: "energy_regen", value: 15, description: "+15 HP per turn" }],
    iconKey: "surge_blue-set-heal",
    glowColor: 0x00ff00,
    rarity: "rare",
  },
  {
    id: "tx-storm",
    name: "TX Storm",
    description: "+20% damage and +10 energy regen per turn",
    effects: [
      { type: "damage_boost", value: 0.2, description: "+20% damage" },
      { type: "energy_regen", value: 10, description: "+10 energy regen" },
    ],
    iconKey: "surge_tx-storm",
    glowColor: 0xffaa00,
    rarity: "epic",
  },
  {
    id: "orphan-smasher",
    name: "Orphan Smasher",
    description: "+60% damage on counter-hits",
    effects: [{ type: "counter_boost", value: 0.6, description: "+60% counter damage" }],
    iconKey: "surge_orphan-smasher",
    glowColor: 0xff6633,
    rarity: "rare",
  },
  {
    id: "chainbreaker",
    name: "Chainbreaker",
    description: "Bypass opponent's block damage reduction",
    effects: [{ type: "block_disable", value: 0.5, description: "Bypass block reduction" }],
    iconKey: "surge_chainbreaker",
    glowColor: 0xcc00ff,
    rarity: "epic",
  },
  {
    id: "vaultbreaker",
    name: "Vaultbreaker",
    description: "Steal 25% of opponent's energy on hit",
    effects: [{ type: "energy_steal", value: 0.25, description: "25% energy steal on hit" }],
    iconKey: "surge_vaultbreaker",
    glowColor: 0xff9900,
    rarity: "legendary",
  },
];

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

const CARDS_MAP = new Map<PowerSurgeCardId, PowerSurgeCard>(
  POWER_SURGE_CARDS.map((card) => [card.id, card])
);

export function getPowerSurgeCard(id: PowerSurgeCardId): PowerSurgeCard | undefined {
  return CARDS_MAP.get(id);
}

export function getRandomPowerSurgeCards(
  count: number,
  exclude: PowerSurgeCardId[] = []
): PowerSurgeCard[] {
  const available = POWER_SURGE_CARDS.filter((c) => !exclude.includes(c.id));
  const shuffled = [...available].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

// =============================================================================
// MATCH SURGE STATE TYPES
// =============================================================================

export interface MatchSurgeState {
  roundNumber: number;
  playerCards: PowerSurgeCardId[];
  opponentCards: PowerSurgeCardId[];
  playerSelection: PowerSurgeCardId | null;
  opponentSelection: PowerSurgeCardId | null;
  selectionDeadline: number;
  isSelecting: boolean;
  isRevealed: boolean;
}

export function createInitialSurgeState(): MatchSurgeState {
  return {
    roundNumber: 0,
    playerCards: [],
    opponentCards: [],
    playerSelection: null,
    opponentSelection: null,
    selectionDeadline: 0,
    isSelecting: false,
    isRevealed: false,
  };
}
