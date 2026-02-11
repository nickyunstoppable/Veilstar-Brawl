/**
 * AI Opponent for Practice Mode
 */

import type { MoveType } from "@/types/game";
import { BASE_MOVE_STATS, COMBAT_CONSTANTS } from "@/game/combat/types";

export type AIDifficulty = "easy" | "medium" | "hard";

export interface MoveWeights {
  punch: number;
  kick: number;
  block: number;
  special: number;
  stunned: number;
}

export class AIOpponent {
  private difficulty: AIDifficulty;
  private moveHistory: MoveType[] = [];
  private playerHistory: MoveType[] = [];

  constructor(difficulty: AIDifficulty = "medium") {
    this.difficulty = difficulty;
  }

  recordPlayerMove(move: MoveType): void {
    this.playerHistory.push(move);
  }

  getMove(
    energy: number,
    health: number,
    maxHealth: number,
    opponentHealth: number,
    guardMeter: number
  ): MoveType {
    // Random chance to make completely random move (based on difficulty)
    const randomChance =
      this.difficulty === "easy" ? 0.7 : this.difficulty === "medium" ? 0.35 : 0.15;

    if (Math.random() < randomChance) {
      return this.randomMove(energy);
    }

    // Pattern recognition (higher accuracy at harder difficulties)
    const reactionAccuracy =
      this.difficulty === "easy" ? 0.2 : this.difficulty === "medium" ? 0.5 : 0.8;

    if (this.playerHistory.length > 0 && Math.random() < reactionAccuracy) {
      const lastPlayerMove = this.playerHistory[this.playerHistory.length - 1];
      return this.counterMove(lastPlayerMove, energy);
    }

    // Health-based decisions
    const healthPercent = health / maxHealth;
    const opponentHealthPercent = opponentHealth / maxHealth;

    // Low health - be defensive
    if (healthPercent < 0.3 && Math.random() < 0.4) {
      if (energy >= BASE_MOVE_STATS.block.energyCost) return "block";
    }

    // Opponent low health - be aggressive
    if (opponentHealthPercent < 0.25) {
      if (energy >= BASE_MOVE_STATS.special.energyCost && Math.random() < 0.5) return "special";
      if (energy >= BASE_MOVE_STATS.kick.energyCost) return "kick";
      return "punch";
    }

    // Guard meter high - don't block
    if (guardMeter >= COMBAT_CONSTANTS.GUARD_BREAK_THRESHOLD * 0.75) {
      const moves: MoveType[] = ["punch", "kick"];
      if (energy >= BASE_MOVE_STATS.special.energyCost) moves.push("special");
      return moves[Math.floor(Math.random() * moves.length)];
    }

    // Default weighted random
    return this.weightedMove(energy);
  }

  private counterMove(playerMove: MoveType, energy: number): MoveType {
    // Counter based on RPS system
    switch (playerMove) {
      case "punch":
        // Kick beats punch
        if (energy >= BASE_MOVE_STATS.kick.energyCost) return "kick";
        return "block";
      case "kick":
        // Block reflects kick
        if (energy >= BASE_MOVE_STATS.block.energyCost) return "block";
        return "punch";
      case "block":
        // Special shatters block
        if (energy >= BASE_MOVE_STATS.special.energyCost) return "special";
        return "punch";
      case "special":
        // Punch beats special
        return "punch";
      default:
        return this.randomMove(energy);
    }
  }

  private weightedMove(energy: number): MoveType {
    const weights: Record<string, number> = {
      punch: 30,
      kick: energy >= BASE_MOVE_STATS.kick.energyCost ? 25 : 0,
      block: energy >= BASE_MOVE_STATS.block.energyCost ? 25 : 0,
      special: energy >= BASE_MOVE_STATS.special.energyCost ? 20 : 0,
    };

    const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);
    let random = Math.random() * totalWeight;

    for (const [move, weight] of Object.entries(weights)) {
      random -= weight;
      if (random <= 0) return move as MoveType;
    }

    return "punch";
  }

  private randomMove(energy: number): MoveType {
    const moves: MoveType[] = ["punch"];
    if (energy >= BASE_MOVE_STATS.kick.energyCost) moves.push("kick");
    if (energy >= BASE_MOVE_STATS.block.energyCost) moves.push("block");
    if (energy >= BASE_MOVE_STATS.special.energyCost) moves.push("special");
    return moves[Math.floor(Math.random() * moves.length)];
  }

  getDifficulty(): AIDifficulty {
    return this.difficulty;
  }

  setDifficulty(difficulty: AIDifficulty): void {
    this.difficulty = difficulty;
    this.moveHistory = [];
    this.playerHistory = [];
  }
}

export function createAIOpponent(difficulty: AIDifficulty = "medium"): AIOpponent {
  return new AIOpponent(difficulty);
}

export function getAIMove(
  ai: AIOpponent,
  energy: number,
  health: number,
  maxHealth: number,
  opponentHealth: number,
  guardMeter: number
): MoveType {
  return ai.getMove(energy, health, maxHealth, opponentHealth, guardMeter);
}
