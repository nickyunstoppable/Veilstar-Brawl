/**
 * AI Difficulty Configuration
 * Defines behavior patterns for each difficulty level
 */

import type { AIDifficulty, MoveWeights } from "./ai-opponent";

/**
 * Difficulty configuration.
 */
export interface DifficultyConfig {
  name: string;
  description: string;

  // Decision parameters
  randomChance: number; // 0-1, chance to make completely random move
  reactionAccuracy: number; // 0-1, how well AI reads player patterns
  counterRate: number; // 0-1, how often AI counters last player move

  // Health thresholds
  defensiveHealthThreshold: number; // Switch to defensive when below this
  aggressiveHealthThreshold: number; // Switch to aggressive when player below this

  // Move weights
  baseWeights: MoveWeights;
  defensiveWeights: MoveWeights;
  aggressiveWeights: MoveWeights;

  // Timing
  thinkTimeMs: { min: number; max: number }; // Artificial delay to seem more human

  // Display
  displayName: string;
  color: string;
  icon: string;
}

/**
 * Easy difficulty - Predictable, forgiving.
 */
export const EASY_CONFIG: DifficultyConfig = {
  name: "easy",
  description: "A good starting point for new players",

  randomChance: 0.7,
  reactionAccuracy: 0.2,
  counterRate: 0.1,

  defensiveHealthThreshold: 20,
  aggressiveHealthThreshold: 20,

  baseWeights: {
    punch: 35,
    kick: 30,
    block: 25,
    special: 10,
    stunned: 0,
  },
  defensiveWeights: {
    punch: 25,
    kick: 25,
    block: 40,
    special: 10,
    stunned: 0,
  },
  aggressiveWeights: {
    punch: 40,
    kick: 35,
    block: 15,
    special: 10,
    stunned: 0,
  },

  thinkTimeMs: { min: 500, max: 2000 },

  displayName: "Beginner",
  color: "#22c55e", // Green
  icon: "🌱",
};

/**
 * Medium difficulty - Balanced, adaptive.
 */
export const MEDIUM_CONFIG: DifficultyConfig = {
  name: "medium",
  description: "Balanced challenge for experienced players",

  randomChance: 0.35,
  reactionAccuracy: 0.5,
  counterRate: 0.4,

  defensiveHealthThreshold: 30,
  aggressiveHealthThreshold: 30,

  baseWeights: {
    punch: 30,
    kick: 30,
    block: 25,
    special: 15,
    stunned: 0,
  },
  defensiveWeights: {
    punch: 20,
    kick: 20,
    block: 45,
    special: 15,
    stunned: 0,
  },
  aggressiveWeights: {
    punch: 35,
    kick: 35,
    block: 10,
    special: 20,
    stunned: 0,
  },

  thinkTimeMs: { min: 300, max: 1500 },

  displayName: "Fighter",
  color: "#f59e0b", // Amber
  icon: "⚔️",
};

/**
 * Hard difficulty - Strategic, punishing.
 */
export const HARD_CONFIG: DifficultyConfig = {
  name: "hard",
  description: "Intense challenge for skilled players",

  randomChance: 0.15,
  reactionAccuracy: 0.8,
  counterRate: 0.6,

  defensiveHealthThreshold: 35,
  aggressiveHealthThreshold: 35,

  baseWeights: {
    punch: 28,
    kick: 28,
    block: 24,
    special: 20,
    stunned: 0,
  },
  defensiveWeights: {
    punch: 15,
    kick: 15,
    block: 55,
    special: 15,
    stunned: 0,
  },
  aggressiveWeights: {
    punch: 30,
    kick: 30,
    block: 10,
    special: 30,
    stunned: 0,
  },

  thinkTimeMs: { min: 100, max: 800 },

  displayName: "Champion",
  color: "#ef4444", // Red
  icon: "🏆",
};

/**
 * Get difficulty configuration by level.
 */
export function getDifficultyConfig(difficulty: AIDifficulty): DifficultyConfig {
  switch (difficulty) {
    case "easy":
      return EASY_CONFIG;
    case "medium":
      return MEDIUM_CONFIG;
    case "hard":
      return HARD_CONFIG;
  }
}

/**
 * Get all difficulty configs for selection UI.
 */
export function getAllDifficultyConfigs(): DifficultyConfig[] {
  return [EASY_CONFIG, MEDIUM_CONFIG, HARD_CONFIG];
}

/**
 * Get display name for difficulty.
 */
export function getDifficultyDisplayName(difficulty: AIDifficulty): string {
  return getDifficultyConfig(difficulty).displayName;
}

/**
 * Get color for difficulty.
 */
export function getDifficultyColor(difficulty: AIDifficulty): string {
  return getDifficultyConfig(difficulty).color;
}

/**
 * Get a random think time within the difficulty's range.
 */
export function getAIThinkTime(difficulty: AIDifficulty): number {
  const config = getDifficultyConfig(difficulty);
  const range = config.thinkTimeMs.max - config.thinkTimeMs.min;
  return config.thinkTimeMs.min + Math.random() * range;
}

/**
 * Difficulty ranking for comparisons.
 */
export const DIFFICULTY_RANK: Record<AIDifficulty, number> = {
  easy: 1,
  medium: 2,
  hard: 3,
};

/**
 * Check if difficulty A is harder than B.
 */
export function isHarderThan(a: AIDifficulty, b: AIDifficulty): boolean {
  return DIFFICULTY_RANK[a] > DIFFICULTY_RANK[b];
}
