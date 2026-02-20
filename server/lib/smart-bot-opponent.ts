/**
 * Smart Bot Opponent - Decision engine for bot matches
 * Ported from KaspaClash logic.
 */

export type MoveType = "punch" | "kick" | "block" | "special" | "stunned";

const COMBAT_CONSTANTS = {
  GUARD_BUILDUP_ON_BLOCK: 25,
  GUARD_BUILDUP_ON_HIT: 15,
  GUARD_BREAK_THRESHOLD: 100,
};

const BASE_MOVE_STATS: Record<MoveType, { energyCost: number }> = {
  punch: { energyCost: 0 },
  kick: { energyCost: 25 },
  block: { energyCost: 0 },
  special: { energyCost: 50 },
  stunned: { energyCost: 0 },
};

export interface SmartBotContext {
  botHealth: number;
  botMaxHealth: number;
  botEnergy: number;
  botMaxEnergy: number;
  botGuardMeter: number;
  botIsStunned: boolean;
  botIsStaggered: boolean;
  opponentHealth: number;
  opponentMaxHealth: number;
  opponentEnergy: number;
  opponentMaxEnergy: number;
  opponentGuardMeter: number;
  opponentIsStunned: boolean;
  opponentIsStaggered: boolean;
  roundNumber: number;
  turnNumber: number;
  botRoundsWon: number;
  opponentRoundsWon: number;
  blockDisabled?: boolean;
  specialEnergyExtraCost?: number;
  lastOpponentMove?: MoveType;
  lastBotMove?: MoveType;
  consecutiveOpponentBlocks: number;
  consecutiveOpponentAttacks: number;
  consecutiveBotBlocks: number;
}

export interface SmartBotDecision {
  move: MoveType;
  confidence: number;
  reasoning?: string;
}

type ActionMoveType = "punch" | "kick" | "block" | "special";

interface MoveWeights {
  punch: number;
  kick: number;
  block: number;
  special: number;
}

const AVAILABLE_MOVES: ActionMoveType[] = ["punch", "kick", "block", "special"];

const ENERGY_COSTS = {
  punch: BASE_MOVE_STATS.punch.energyCost,
  kick: BASE_MOVE_STATS.kick.energyCost,
  block: BASE_MOVE_STATS.block.energyCost,
  special: BASE_MOVE_STATS.special.energyCost,
};

export class SmartBotOpponent {
  private context: SmartBotContext;
  private botName: string;
  private moveHistory: MoveType[] = [];
  private readonly random: () => number;

  constructor(name?: string, random?: () => number) {
    this.botName = name || "Fighter_bot";
    this.random = random ?? Math.random;
    this.context = this.createInitialContext();
  }

  getName(): string {
    return this.botName;
  }

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
      specialEnergyExtraCost: 0,
      consecutiveOpponentBlocks: 0,
      consecutiveOpponentAttacks: 0,
      consecutiveBotBlocks: 0,
    };
  }

  reset(): void {
    this.context = this.createInitialContext();
    this.moveHistory = [];
  }

  updateContext(updates: Partial<SmartBotContext>): void {
    this.context = { ...this.context, ...updates };
  }

  recordOpponentMove(move: MoveType): void {
    this.context.lastOpponentMove = move;
    if (move === "block") {
      this.context.consecutiveOpponentBlocks++;
      this.context.consecutiveOpponentAttacks = 0;
    } else if (move === "punch" || move === "kick" || move === "special") {
      this.context.consecutiveOpponentAttacks++;
      this.context.consecutiveOpponentBlocks = 0;
    }
  }

  recordBotMove(move: MoveType): void {
    this.context.lastBotMove = move;
    this.moveHistory.push(move);
    if (move === "block") {
      this.context.consecutiveBotBlocks++;
    } else {
      this.context.consecutiveBotBlocks = 0;
    }
  }

  private canAfford(move: ActionMoveType): boolean {
    const extraSpecialCost = move === "special" ? Math.max(0, Math.floor(this.context.specialEnergyExtraCost ?? 0)) : 0;
    return this.context.botEnergy >= (ENERGY_COSTS[move] + extraSpecialCost);
  }

  private getAffordableMoves(): ActionMoveType[] {
    return AVAILABLE_MOVES.filter((move) => {
      if (!this.canAfford(move)) return false;
      if (move === "block" && this.context.blockDisabled) return false;
      return true;
    });
  }

  decide(): SmartBotDecision {
    if (this.context.botIsStunned) {
      return { move: "punch", confidence: 0, reasoning: "Bot is stunned, cannot act" };
    }

    const affordableMoves = this.getAffordableMoves();
    if (affordableMoves.length === 0) {
      return { move: "punch", confidence: 0.5, reasoning: "No affordable moves" };
    }

    if (this.context.opponentIsStunned) {
      if (this.canAfford("special")) return { move: "special", confidence: 1.0, reasoning: "OPPONENT STUNNED" };
      if (this.canAfford("kick")) return { move: "kick", confidence: 0.95, reasoning: "OPPONENT STUNNED" };
      return { move: "punch", confidence: 0.9, reasoning: "OPPONENT STUNNED" };
    }

    const guardAfterBlock = this.context.botGuardMeter + COMBAT_CONSTANTS.GUARD_BUILDUP_ON_BLOCK;
    const guardAfterBlockAndHit = guardAfterBlock + COMBAT_CONSTANTS.GUARD_BUILDUP_ON_HIT;
    const blockWouldBreakGuard = guardAfterBlockAndHit >= COMBAT_CONSTANTS.GUARD_BREAK_THRESHOLD;
    const opponentLowHealth = this.context.opponentHealth <= 25;
    const botLowHealth = this.context.botHealth <= 25;

    if (this.context.opponentIsStaggered) {
      if (this.canAfford("special")) return { move: "special", confidence: 0.85, reasoning: "Opponent staggered" };
      if (this.canAfford("kick")) return { move: "kick", confidence: 0.8, reasoning: "Opponent staggered" };
    }

    if (opponentLowHealth) {
      if (this.canAfford("special")) return { move: "special", confidence: 0.9, reasoning: "Finish low hp" };
      if (this.canAfford("kick")) return { move: "kick", confidence: 0.85, reasoning: "Finish low hp" };
      return { move: "punch", confidence: 0.8, reasoning: "Finish low hp" };
    }

    if (this.context.consecutiveOpponentBlocks >= 2) {
      if (this.canAfford("special")) return { move: "special", confidence: 0.85, reasoning: "Break block spam" };
      return { move: "punch", confidence: 0.75, reasoning: "Chip vs block spam" };
    }

    if (this.context.consecutiveOpponentAttacks >= 2 && !blockWouldBreakGuard && !this.context.blockDisabled) {
      return { move: "block", confidence: 0.8, reasoning: "Counter aggression" };
    }

    if (botLowHealth && !blockWouldBreakGuard && !this.context.blockDisabled && this.random() < 0.35) {
      return { move: "block", confidence: 0.7, reasoning: "Low health defense" };
    }

    if (this.context.botEnergy >= 70 && this.canAfford("special") && this.random() < 0.42) {
      return { move: "special", confidence: 0.7, reasoning: "High energy special" };
    }

    if (this.context.lastOpponentMove) {
      const lastMove = this.context.lastOpponentMove;
      if (lastMove === "punch" && !blockWouldBreakGuard && !this.context.blockDisabled && this.random() < 0.4) {
        return { move: "block", confidence: 0.65, reasoning: "Predict punch" };
      }
      if (lastMove === "kick" && !blockWouldBreakGuard && !this.context.blockDisabled && this.random() < 0.35) {
        return { move: "block", confidence: 0.65, reasoning: "Predict kick" };
      }
      if (lastMove === "block" && this.random() < 0.52 && this.canAfford("special")) {
        return { move: "special", confidence: 0.7, reasoning: "Punish block" };
      }
      if (lastMove === "special" && this.random() < 0.35) {
        return { move: "punch", confidence: 0.65, reasoning: "Counter post-special" };
      }
    }

    const weights: MoveWeights = {
      punch: 24,
      kick: 30,
      block: (blockWouldBreakGuard || this.context.blockDisabled) ? 0 : 20,
      special: this.canAfford("special") ? 26 : 0,
    };

    const hpDiff = this.context.botHealth - this.context.opponentHealth;
    const energyDiff = this.context.botEnergy - this.context.opponentEnergy;
    const ahead = hpDiff >= 18 || energyDiff >= 25;
    const behind = hpDiff <= -18;

    if (ahead) {
      weights.kick += 8;
      weights.special += this.canAfford("special") ? 10 : 0;
      weights.block = Math.max(0, weights.block - 8);
    } else if (behind) {
      weights.block += (blockWouldBreakGuard || this.context.blockDisabled) ? 0 : 12;
      weights.punch += 8;
      weights.special = Math.max(0, weights.special - 6);
    }

    if (!this.canAfford("kick")) {
      weights.kick = 0;
      weights.punch += 15;
    }

    if (this.context.lastBotMove) {
      const lastMove = this.context.lastBotMove as keyof MoveWeights;
      if (weights[lastMove]) {
        weights[lastMove] = Math.max(5, weights[lastMove] - 10);
      }
    }

    return this.weightedMove(weights);
  }

  private weightedMove(weights: MoveWeights): SmartBotDecision {
    const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);
    if (totalWeight === 0) return { move: "punch", confidence: 0.5, reasoning: "Fallback" };

    let random = this.random() * totalWeight;
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

    return { move: "punch", confidence: 0.5, reasoning: "Weighted fallback" };
  }
}

export default SmartBotOpponent;
