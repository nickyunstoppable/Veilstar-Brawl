/**
 * Smart Bot Opponent - Decision engine for matchmaking bot matches
 * Provides intelligent AI move selection with hardcoded logical decisions for edge cases
 * Designed to feel like a real player with smart moves at appropriate times
 */

import type { MoveType } from "@/types/game";
import { COMBAT_CONSTANTS, BASE_MOVE_STATS } from "@/game/combat/types";

/**
 * Bot game state context for decision making.
 */
export interface SmartBotContext {
  // Bot state
  botHealth: number;
  botMaxHealth: number;
  botEnergy: number;
  botMaxEnergy: number;
  botGuardMeter: number;
  botIsStunned: boolean;
  botIsStaggered: boolean;

  // Opponent (player) state
  opponentHealth: number;
  opponentMaxHealth: number;
  opponentEnergy: number;
  opponentMaxEnergy: number;
  opponentGuardMeter: number;
  opponentIsStunned: boolean;
  opponentIsStaggered: boolean;

  // Match state
  roundNumber: number;
  turnNumber: number;
  botRoundsWon: number;
  opponentRoundsWon: number;

  // Power surge effects
  blockDisabled?: boolean; // Pruned Rage disables blocking

  // History for pattern recognition
  lastOpponentMove?: MoveType;
  lastBotMove?: MoveType;
  consecutiveOpponentBlocks: number;
  consecutiveOpponentAttacks: number;
  consecutiveBotBlocks: number;
}

/**
 * Bot decision result.
 */
export interface SmartBotDecision {
  move: MoveType;
  confidence: number;
  reasoning?: string;
}

/**
 * Action move types (excludes 'stunned')
 */
type ActionMoveType = "punch" | "kick" | "block" | "special";

/**
 * Move weights for decision making.
 */
interface MoveWeights {
  punch: number;
  kick: number;
  block: number;
  special: number;
}

/**
 * Available moves array
 */
const AVAILABLE_MOVES: ActionMoveType[] = ["punch", "kick", "block", "special"];

/**
 * Energy costs
 */
const ENERGY_COSTS = {
  punch: BASE_MOVE_STATS.punch.energyCost,
  kick: BASE_MOVE_STATS.kick.energyCost,
  block: BASE_MOVE_STATS.block.energyCost,
  special: BASE_MOVE_STATS.special.energyCost,
};

/**
 * Generate a random bot name like "Fighter_qp0tk7"
 */
export function generateBotName(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let suffix = "";
  for (let i = 0; i < 6; i++) {
    suffix += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `Fighter_${suffix}`;
}

/**
 * SmartBotOpponent - Handles intelligent bot move decision making
 * with hardcoded logical decisions for edge cases
 */
export class SmartBotOpponent {
  private context: SmartBotContext;
  private botName: string;
  private moveHistory: MoveType[] = [];

  constructor(name?: string) {
    this.botName = name || generateBotName();
    this.context = this.createInitialContext();
  }

  /**
   * Get the bot's display name
   */
  getName(): string {
    return this.botName;
  }

  /**
   * Create initial bot context.
   */
  private createInitialContext(): SmartBotContext {
    return {
      botHealth: 100,
      botMaxHealth: 100,
      botEnergy: 100,
      botMaxEnergy: 100,
      botGuardMeter: 0,
      botIsStunned: false,
      botIsStaggered: false,

      opponentHealth: 100,
      opponentMaxHealth: 100,
      opponentEnergy: 100,
      opponentMaxEnergy: 100,
      opponentGuardMeter: 0,
      opponentIsStunned: false,
      opponentIsStaggered: false,

      roundNumber: 1,
      turnNumber: 1,
      botRoundsWon: 0,
      opponentRoundsWon: 0,

      blockDisabled: false,

      consecutiveOpponentBlocks: 0,
      consecutiveOpponentAttacks: 0,
      consecutiveBotBlocks: 0,
    };
  }

  /**
   * Reset bot state for new match.
   */
  reset(): void {
    this.context = this.createInitialContext();
    this.moveHistory = [];
  }

  /**
   * Reset for new round (preserves rounds won).
   */
  resetRound(): void {
    const { botRoundsWon, opponentRoundsWon, roundNumber } = this.context;
    this.context = {
      ...this.createInitialContext(),
      botRoundsWon,
      opponentRoundsWon,
      roundNumber: roundNumber + 1,
    };
  }

  /**
   * Update context with game state.
   */
  updateContext(updates: Partial<SmartBotContext>): void {
    this.context = { ...this.context, ...updates };
  }

  /**
   * Record opponent's last move for pattern recognition.
   */
  recordOpponentMove(move: MoveType): void {
    this.context.lastOpponentMove = move;

    // Track consecutive patterns
    if (move === "block") {
      this.context.consecutiveOpponentBlocks++;
      this.context.consecutiveOpponentAttacks = 0;
    } else if (move === "punch" || move === "kick" || move === "special") {
      this.context.consecutiveOpponentAttacks++;
      this.context.consecutiveOpponentBlocks = 0;
    }
  }

  /**
   * Alias for recordOpponentMove - for compatibility with AIOpponent interface
   */
  recordPlayerMove(move: MoveType): void {
    this.recordOpponentMove(move);
  }

  /**
   * Record bot's own move
   */
  recordBotMove(move: MoveType): void {
    this.context.lastBotMove = move;
    this.moveHistory.push(move);

    if (move === "block") {
      this.context.consecutiveBotBlocks++;
    } else {
      this.context.consecutiveBotBlocks = 0;
    }
  }

  /**
   * Check if bot can afford a move
   */
  private canAfford(move: ActionMoveType): boolean {
    return this.context.botEnergy >= ENERGY_COSTS[move];
  }

  /**
   * Get available moves based on energy and surge effects
   */
  private getAffordableMoves(): ActionMoveType[] {
    return AVAILABLE_MOVES.filter(move => {
      // Can't afford move due to energy
      if (!this.canAfford(move)) return false;
      
      // Block is disabled by Pruned Rage
      if (move === "block" && this.context.blockDisabled) return false;
      
      return true;
    });
  }

  /**
   * Get the bot's next move decision.
   * This is the main decision function with hardcoded logical decisions.
   */
  decide(): SmartBotDecision {
    // CASE 1: Bot is stunned - no choice
    if (this.context.botIsStunned) {
      return {
        move: "punch", // Will be overridden by combat engine
        confidence: 0,
        reasoning: "Bot is stunned, cannot act",
      };
    }

    // Get affordable moves
    const affordableMoves = this.getAffordableMoves();
    if (affordableMoves.length === 0) {
      // Shouldn't happen since punch costs 0, but fallback
      return { move: "punch", confidence: 0.5, reasoning: "No affordable moves" };
    }

    // =========================================================================
    // HARDCODED LOGICAL DECISIONS (Edge Cases)
    // =========================================================================

    // CASE 2: OPPONENT IS STUNNED - ALWAYS PUNISH WITH MAXIMUM DAMAGE
    if (this.context.opponentIsStunned) {
      // Priority: Special > Kick > Punch
      if (this.canAfford("special")) {
        return {
          move: "special",
          confidence: 1.0,
          reasoning: "OPPONENT STUNNED: Maximum damage with special!",
        };
      }
      if (this.canAfford("kick")) {
        return {
          move: "kick",
          confidence: 0.95,
          reasoning: "OPPONENT STUNNED: Heavy damage with kick",
        };
      }
      return {
        move: "punch",
        confidence: 0.9,
        reasoning: "OPPONENT STUNNED: Free hit with punch",
      };
    }

    // CASE 3: BOT GUARD METER IS HIGH - DON'T BLOCK if it would cause guard break
    // Guard breaks at 100, blocking adds 25 (GUARD_BUILDUP_ON_BLOCK) + potential 15 more if hit
    const guardAfterBlock = this.context.botGuardMeter + COMBAT_CONSTANTS.GUARD_BUILDUP_ON_BLOCK;
    const guardAfterBlockAndHit = guardAfterBlock + COMBAT_CONSTANTS.GUARD_BUILDUP_ON_HIT;

    // If blocking would put us at risk of guard break (>= 75), don't block
    const blockWouldBreakGuard = guardAfterBlockAndHit >= COMBAT_CONSTANTS.GUARD_BREAK_THRESHOLD;

    // CASE 4: OPPONENT HAS LOW ENERGY - They likely can't do special, be more aggressive
    const opponentLowEnergy = this.context.opponentEnergy < ENERGY_COSTS.special;

    // CASE 5: OPPONENT HAS LOW HEALTH - Finish them!
    const opponentLowHealth = this.context.opponentHealth <= 25;

    // CASE 6: BOT HAS LOW HEALTH - Be more careful
    const botLowHealth = this.context.botHealth <= 25;

    // CASE 7: OPPONENT IS STAGGERED - They deal less damage, be aggressive
    if (this.context.opponentIsStaggered) {
      // Opponent is staggered, attack aggressively
      if (this.canAfford("special")) {
        return {
          move: "special",
          confidence: 0.85,
          reasoning: "Opponent staggered - heavy attack opportunity",
        };
      }
      if (this.canAfford("kick")) {
        return {
          move: "kick",
          confidence: 0.8,
          reasoning: "Opponent staggered - kick for damage",
        };
      }
    }

    // CASE 8: FINISH LOW HEALTH OPPONENT
    if (opponentLowHealth) {
      // Go all in on damage
      if (this.canAfford("special") && this.context.opponentHealth <= 25) {
        return {
          move: "special",
          confidence: 0.9,
          reasoning: "Opponent low health - finishing special!",
        };
      }
      if (this.canAfford("kick")) {
        return {
          move: "kick",
          confidence: 0.85,
          reasoning: "Opponent low health - finishing kick",
        };
      }
      return {
        move: "punch",
        confidence: 0.8,
        reasoning: "Opponent low health - keep attacking",
      };
    }

    // CASE 9: OPPONENT BLOCKING A LOT - Use kick to reflect or special to shatter
    if (this.context.consecutiveOpponentBlocks >= 2) {
      // Opponent is turtling, break their defense
      if (this.canAfford("special")) {
        return {
          move: "special",
          confidence: 0.85,
          reasoning: "Opponent blocking spam - shattering with special!",
        };
      }
      // Don't use kick against block - it gets reflected
      // Use punch instead - it does chip damage through block
      return {
        move: "punch",
        confidence: 0.75,
        reasoning: "Opponent blocking - chip damage with punch",
      };
    }

    // CASE 10: OPPONENT ATTACKING A LOT - Block to counter (unless guard would break or block disabled)
    if (this.context.consecutiveOpponentAttacks >= 2 && !blockWouldBreakGuard && !this.context.blockDisabled) {
      return {
        move: "block",
        confidence: 0.8,
        reasoning: "Opponent aggressive - blocking to counter",
      };
    }

    // CASE 11: BOT LOW HEALTH - Play safer (but not if block would break guard or block disabled)
    if (botLowHealth && !blockWouldBreakGuard && !this.context.blockDisabled) {
      // Be defensive but still look for opportunities
      if (Math.random() < 0.4) {
        return {
          move: "block",
          confidence: 0.7,
          reasoning: "Low health - defensive play",
        };
      }
    }

    // CASE 12: HIGH ENERGY AND GOOD OPPORTUNITY - Use special
    if (this.context.botEnergy >= 70 && this.canAfford("special")) {
      // Good chance to use special when we have plenty of energy
      if (Math.random() < 0.3) {
        return {
          move: "special",
          confidence: 0.7,
          reasoning: "High energy - opportunistic special",
        };
      }
    }

    // CASE 13: PREDICT OPPONENT MOVE based on last move
    if (this.context.lastOpponentMove) {
      const lastMove = this.context.lastOpponentMove;

      // Players often repeat successful moves
      // Counter: Block beats punch/kick, Kick beats block, Punch beats special
      if (lastMove === "punch" && !blockWouldBreakGuard && !this.context.blockDisabled && Math.random() < 0.4) {
        return {
          move: "block",
          confidence: 0.65,
          reasoning: "Predicting punch repeat - blocking",
        };
      }
      if (lastMove === "kick" && !blockWouldBreakGuard && !this.context.blockDisabled && Math.random() < 0.35) {
        return {
          move: "block",
          confidence: 0.65,
          reasoning: "Predicting kick repeat - blocking to reflect",
        };
      }
      if (lastMove === "block" && Math.random() < 0.4) {
        // They're being defensive, use special or punch
        if (this.canAfford("special")) {
          return {
            move: "special",
            confidence: 0.7,
            reasoning: "Opponent was blocking - special to shatter",
          };
        }
      }
      if (lastMove === "special" && Math.random() < 0.35) {
        // They used special, they might be low on energy, attack
        return {
          move: "punch",
          confidence: 0.65,
          reasoning: "Opponent used special - counterattack",
        };
      }
    }

    // =========================================================================
    // DEFAULT: WEIGHTED RANDOM SELECTION (to feel like a real player)
    // =========================================================================

    const weights: MoveWeights = {
      punch: 30,
      kick: 25,
      block: (blockWouldBreakGuard || this.context.blockDisabled) ? 0 : 25, // Don't block if it would break guard OR if Pruned Rage is active
      special: this.canAfford("special") ? 20 : 0,
    };

    // Adjust weights based on energy
    if (!this.canAfford("kick")) {
      weights.kick = 0;
      weights.punch += 15;
    }

    // Vary play to not be predictable
    if (this.context.lastBotMove) {
      // Reduce weight of last move slightly
      const lastMove = this.context.lastBotMove as keyof MoveWeights;
      if (weights[lastMove]) {
        weights[lastMove] = Math.max(5, weights[lastMove] - 10);
      }
    }

    return this.weightedMove(weights);
  }

  /**
   * Select move based on weights.
   */
  private weightedMove(weights: MoveWeights): SmartBotDecision {
    const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);

    if (totalWeight === 0) {
      return { move: "punch", confidence: 0.5, reasoning: "Fallback to punch" };
    }

    let random = Math.random() * totalWeight;

    for (const move of AVAILABLE_MOVES) {
      random -= weights[move];
      if (random <= 0) {
        return {
          move,
          confidence: 0.5 + (weights[move] / totalWeight) * 0.3,
          reasoning: "Weighted random selection",
        };
      }
    }

    // Fallback
    return {
      move: "punch",
      confidence: 0.5,
      reasoning: "Weighted fallback",
    };
  }

  /**
   * Decide which character to ban.
   * Strategically bans a character that the opponent actually owns.
   * 
   * @param opponentOwnedIds - List of character IDs owned by the opponent
   * @param allCharacterIds - List of all available character IDs (fallback)
   */
  banCharacter(opponentOwnedIds: string[], allCharacterIds: string[]): string {
    // Strategy: Ban something the opponent owns to deny them their pick
    if (opponentOwnedIds && opponentOwnedIds.length > 0) {
      const randomIndex = Math.floor(Math.random() * opponentOwnedIds.length);
      return opponentOwnedIds[randomIndex];
    }

    // Fallback: Ban random character if we don't know what they own
    if (allCharacterIds && allCharacterIds.length > 0) {
      const randomIndex = Math.floor(Math.random() * allCharacterIds.length);
      return allCharacterIds[randomIndex];
    }

    // Ultimate fallback (should never happen if roster exists)
    return "cyber-ninja";
  }

  /**
   * Get current context.
   */
  getContext(): SmartBotContext {
    return { ...this.context };
  }
}

/**
 * Create a smart bot opponent.
 */
export function createSmartBotOpponent(name?: string): SmartBotOpponent {
  return new SmartBotOpponent(name);
}

export default SmartBotOpponent;
