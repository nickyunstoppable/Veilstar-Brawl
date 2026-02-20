/**
 * Character Data for Veilstar Brawl
 * 20 fighters across 4 archetypes
 */

import type { Character, CharacterArchetype, SpriteConfig } from "@/types/game";

// Default sprite config (6x6 grid, 36 frames, 24fps)
const defaultSpriteConfig: SpriteConfig = {
  idle: { key: "idle", frames: 36, frameRate: 24, repeat: true },
  run: { key: "run", frames: 36, frameRate: 24, repeat: true },
  punch: { key: "punch", frames: 36, frameRate: 24, repeat: false },
  kick: { key: "kick", frames: 36, frameRate: 24, repeat: false },
  block: { key: "block", frames: 36, frameRate: 24, repeat: false },
  special: { key: "special", frames: 36, frameRate: 24, repeat: false },
  hurt: { key: "hurt", frames: 36, frameRate: 24, repeat: false },
  victory: { key: "victory", frames: 36, frameRate: 24, repeat: false },
  defeat: { key: "defeat", frames: 36, frameRate: 24, repeat: false },
  dead: { key: "dead", frames: 36, frameRate: 24, repeat: false },
};

function createCharacter(
  id: string,
  name: string,
  theme: string,
  archetype: CharacterArchetype,
  colors: { primary: string; secondary: string; accent: string }
): Character {
  return {
    id,
    name,
    theme,
    portraitUrl: `/characters/${id}/portrait.webp`,
    spriteSheet: `/characters/${id}/idle.webp`,
    animations: { ...defaultSpriteConfig },
    archetype,
    colors,
  };
}

// =============================================================================
// CHARACTER ROSTER
// =============================================================================

// Speed Characters (5)
const SPEED_CHARACTERS: Character[] = [
  createCharacter("cyber-ninja", "Cyber Ninja", "Swift shadow assassin with digital blades", "speed", { primary: "#8B5CF6", secondary: "#6D28D9", accent: "#A78BFA" }),
  createCharacter("sonic-striker", "Sonic Striker", "Hypersonic combatant breaking sound barriers", "speed", { primary: "#06B6D4", secondary: "#0891B2", accent: "#67E8F9" }),
  createCharacter("chrono-drifter", "Chrono Drifter", "Time-bending fighter from another epoch", "speed", { primary: "#3B82F6", secondary: "#2563EB", accent: "#93C5FD" }),
  createCharacter("neon-wraith", "Neon Wraith", "Spectral warrior phasing through reality", "speed", { primary: "#EC4899", secondary: "#DB2777", accent: "#F9A8D4" }),
  createCharacter("viperblade", "Viperblade", "Venomous assassin with plasma edge", "speed", { primary: "#10B981", secondary: "#059669", accent: "#6EE7B7" }),
];

// Tank Characters (5)
const TANK_CHARACTERS: Character[] = [
  createCharacter("ledger-titan", "Ledger Titan", "Armored juggernaut built on the Stellar ledger", "tank", { primary: "#F59E0B", secondary: "#D97706", accent: "#FCD34D" }),
  createCharacter("heavy-loader", "Heavy Loader", "Industrial powerhouse with hydraulic fists", "tank", { primary: "#EF4444", secondary: "#DC2626", accent: "#FCA5A5" }),
  createCharacter("gene-smasher", "Gene Smasher", "Mutated brawler with unstable DNA", "tank", { primary: "#84CC16", secondary: "#65A30D", accent: "#BEF264" }),
  createCharacter("bastion-hulk", "Bastion Hulk", "Defensive titan with impenetrable armor", "tank", { primary: "#6366F1", secondary: "#4F46E5", accent: "#A5B4FC" }),
  createCharacter("scrap-goliath", "Scrap Goliath", "Junkyard colossus reassembled from scrap", "tank", { primary: "#78716C", secondary: "#57534E", accent: "#D6D3D1" }),
];

// Tech Characters (5)
const TECH_CHARACTERS: Character[] = [
  createCharacter("soroban-sage", "Soroban Sage", "Blockchain-powered fighter channeling Soroban smart contracts", "tech", { primary: "#22C55E", secondary: "#16A34A", accent: "#86EFAC" }),
  createCharacter("technomancer", "Technomancer", "Wizard of circuits blending magic and tech", "tech", { primary: "#A855F7", secondary: "#9333EA", accent: "#D8B4FE" }),
  createCharacter("nano-brawler", "Nano Brawler", "Microscopic warrior with nanite swarm powers", "tech", { primary: "#14B8A6", secondary: "#0D9488", accent: "#5EEAD4" }),
  createCharacter("razor-bot-7", "Razor Bot 7", "Military-grade automaton designed for combat", "tech", { primary: "#F97316", secondary: "#EA580C", accent: "#FDBA74" }),
  createCharacter("cyber-paladin", "Cyber Paladin", "Holy warrior in quantum-forged armor", "tech", { primary: "#FBBF24", secondary: "#F59E0B", accent: "#FDE68A" }),
];

// Precision Characters (5)
const PRECISION_CHARACTERS: Character[] = [
  createCharacter("hash-hunter", "Hash Hunter", "Sharpshooter tracking targets across the grid", "precision", { primary: "#F43F5E", secondary: "#E11D48", accent: "#FDA4AF" }),
  createCharacter("prism-duelist", "Prism Duelist", "Light-bending fencer with photon rapier", "precision", { primary: "#8B5CF6", secondary: "#7C3AED", accent: "#C4B5FD" }),
  createCharacter("kitsune-09", "Kitsune-09", "Fox spirit with nine tails of digital fire", "precision", { primary: "#F97316", secondary: "#EA580C", accent: "#FB923C" }),
  createCharacter("void-reaper", "Void Reaper", "Dimensional harvester from the quantum void", "precision", { primary: "#6366F1", secondary: "#4F46E5", accent: "#818CF8" }),
  createCharacter("aeon-guard", "Aeon Guard", "Ancient sentinel awakened by the blockchain", "precision", { primary: "#0EA5E9", secondary: "#0284C7", accent: "#7DD3FC" }),
];

// Combined roster
export const CHARACTER_ROSTER: Character[] = [
  ...SPEED_CHARACTERS,
  ...TANK_CHARACTERS,
  ...TECH_CHARACTERS,
  ...PRECISION_CHARACTERS,
];

// Lookup maps
export const CHARACTERS_BY_ID = new Map<string, Character>(
  CHARACTER_ROSTER.map((c) => [c.id, c])
);

export const CHARACTER_COLORS = new Map<string, { primary: string; secondary: string; accent: string }>(
  CHARACTER_ROSTER.map((c) => [c.id, c.colors])
);

// Helper functions
export function getCharacter(id: string): Character | undefined {
  return CHARACTERS_BY_ID.get(id);
}

export function getRandomCharacter(): Character {
  return CHARACTER_ROSTER[Math.floor(Math.random() * CHARACTER_ROSTER.length)];
}

export function getCharactersByArchetype(archetype: CharacterArchetype): Character[] {
  return CHARACTER_ROSTER.filter((c) => c.archetype === archetype);
}

export function getCharacterColor(id: string): { primary: string; secondary: string; accent: string } {
  return CHARACTER_COLORS.get(id) || { primary: "#ffffff", secondary: "#cccccc", accent: "#999999" };
}
