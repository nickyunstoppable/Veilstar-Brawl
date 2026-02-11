/**
 * Game Types for Veilstar Brawl
 */

// =============================================================================
// PLAYER & CHARACTER TYPES
// =============================================================================

export interface Player {
  publicKey: string;
  name: string;
  elo?: number;
  avatarUrl?: string;
}

export interface SpriteAnimation {
  key: string;
  frames: number;
  frameRate: number;
  repeat: boolean;
}

export interface SpriteConfig {
  idle: SpriteAnimation;
  run: SpriteAnimation;
  punch: SpriteAnimation;
  kick: SpriteAnimation;
  block: SpriteAnimation;
  special: SpriteAnimation;
  hurt: SpriteAnimation;
  victory: SpriteAnimation;
  defeat: SpriteAnimation;
  dead: SpriteAnimation;
}

export type CharacterArchetype = "speed" | "tank" | "tech" | "precision";

export interface Character {
  id: string;
  name: string;
  theme: string;
  portraitUrl: string;
  spriteSheet: string;
  animations: SpriteConfig;
  archetype: CharacterArchetype;
  colors: {
    primary: string;
    secondary: string;
    accent: string;
  };
}

// =============================================================================
// MATCH & ROUND TYPES
// =============================================================================

export type MoveType = "punch" | "kick" | "block" | "special" | "stunned";

export interface Move {
  type: MoveType;
  timestamp: number;
  confirmed: boolean;
}

export interface Round {
  number: number;
  moves: {
    player1: Move[];
    player2: Move[];
  };
  winner: "player1" | "player2" | "draw" | null;
  player1Health: number;
  player2Health: number;
}

export type MatchFormat = "best_of_1" | "best_of_3" | "best_of_5";

export type MatchStatus =
  | "waiting"
  | "character_select"
  | "starting"
  | "in_progress"
  | "round_end"
  | "match_end"
  | "cancelled"
  | "expired";

export interface MatchResult {
  winner: "player1" | "player2";
  score: {
    player1: number;
    player2: number;
  };
  rounds: Round[];
  totalTurns: number;
  duration: number;
}

export interface Match {
  id: string;
  status: MatchStatus;
  format: MatchFormat;
  players: {
    player1: Player;
    player2: Player;
  };
  characters: {
    player1: Character | null;
    player2: Character | null;
  };
  currentRound: number;
  rounds: Round[];
  result: MatchResult | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
}

// =============================================================================
// GAME STATE TYPES
// =============================================================================

export interface GameState {
  match: Match | null;
  playerRole: "player1" | "player2" | null;
  selectedMove: MoveType | null;
  isSubmitting: boolean;
  localHealth: {
    player1: number;
    player2: number;
  };
}

// =============================================================================
// UI TYPES
// =============================================================================

export interface MoveOption {
  type: MoveType;
  label: string;
  description: string;
  icon: string;
  energyCost: number;
  color: string;
}
