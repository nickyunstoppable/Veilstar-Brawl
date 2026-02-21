/**
 * Bot Match Service
 * Pre-computes entire bot matches server-side for spectating
 * Manages the single active bot match room
 */

import { getSupabase } from "./supabase";
import { claimOnChainPayoutAsAdmin, createOnChainBotPool, ensureZkBettingVerifierConfigured, getOnChainPoolStatus, isZkBettingConfigured, lockOnChainPool, matchIdToBytes32, revealOnChainBetAsAdmin, settleOnChainPoolZk } from "./zk-betting-contract";
import { SmartBotOpponent } from "./smart-bot-opponent";
import { getOrCreateRoundDeck, type PowerSurgeCardId, type StoredSurgeDeck } from "./power-surge";
import { calculateSurgeEffects, isBlockDisabled } from "./surge-effects";
import { resolveRound } from "./round-resolver";
import { getCharacterCombatCaps } from "./character-combat-stats";
import { proveBotBettingSettlement } from "./zk-betting-settle-prover";

// =============================================================================
// TYPES
// =============================================================================

export interface BotTurnData {
    turnNumber: number;
    roundNumber: number;
    bot1Move: MoveType;
    bot2Move: MoveType;
    bot1Hp: number;
    bot2Hp: number;
    bot1Energy: number;
    bot2Energy: number;
    bot1Guard: number;
    bot2Guard: number;
    bot1DamageTaken?: number;
    bot2DamageTaken?: number;
    bot1Outcome?: MoveOutcome;
    bot2Outcome?: MoveOutcome;
    bot1IsStunned?: boolean;
    bot2IsStunned?: boolean;
    surgeCardIds?: PowerSurgeCardId[];
    bot1SurgeSelection?: PowerSurgeCardId | null;
    bot2SurgeSelection?: PowerSurgeCardId | null;
    description: string;
    narrative?: string;
    isRoundStart?: boolean;
    isRoundEnd?: boolean;
    isMatchEnd?: boolean;
    roundWinner?: "player1" | "player2" | null;
    matchWinner?: "player1" | "player2" | null;
}

export interface BotMatch {
    id: string;
    bot1CharacterId: string;
    bot2CharacterId: string;
    bot1Name: string;
    bot2Name: string;
    seed: string;
    turns: BotTurnData[];
    totalTurns: number;
    matchWinner: string | null;
    status: string;
    turnDurationMs: number;
    createdAt: number;
}

// =============================================================================
// CHARACTER ROSTER (server-side subset for bot selection)
// =============================================================================

const BOT_CHARACTERS = [
    { id: "cyber-ninja", name: "Cyber Ninja" },
    { id: "sonic-striker", name: "Sonic Striker" },
    { id: "ledger-titan", name: "Ledger Titan" },
    { id: "heavy-loader", name: "Heavy Loader" },
    { id: "soroban-sage", name: "Soroban Sage" },
    { id: "technomancer", name: "Technomancer" },
    { id: "hash-hunter", name: "Hash Hunter" },
    { id: "prism-duelist", name: "Prism Duelist" },
    { id: "chrono-drifter", name: "Chrono Drifter" },
    { id: "neon-wraith", name: "Neon Wraith" },
    { id: "gene-smasher", name: "Gene Smasher" },
    { id: "bastion-hulk", name: "Bastion Hulk" },
    { id: "nano-brawler", name: "Nano Brawler" },
    { id: "razor-bot-7", name: "Razor Bot 7" },
    { id: "kitsune-09", name: "Kitsune-09" },
    { id: "void-reaper", name: "Void Reaper" },
    { id: "viperblade", name: "Viperblade" },
    { id: "scrap-goliath", name: "Scrap Goliath" },
    { id: "cyber-paladin", name: "Cyber Paladin" },
    { id: "aeon-guard", name: "Aeon Guard" },
];

type MoveType = "punch" | "kick" | "block" | "special" | "stunned";
type MoveOutcome = "hit" | "blocked" | "stunned" | "staggered" | "reflected" | "shattered" | "missed" | "guarding";

const MOVES: Exclude<MoveType, "stunned">[] = ["punch", "kick", "block", "special"];

const BASE_MOVE_STATS: Record<MoveType, { damage: number; energyCost: number }> = {
    punch: { damage: 10, energyCost: 0 },
    kick: { damage: 15, energyCost: 25 },
    block: { damage: 0, energyCost: 0 },
    special: { damage: 25, energyCost: 50 },
    stunned: { damage: 0, energyCost: 0 },
};

const RESOLUTION_MATRIX: Record<MoveType, Record<MoveType, MoveOutcome>> = {
    punch: { punch: "hit", kick: "staggered", block: "blocked", special: "hit", stunned: "hit" },
    kick: { punch: "hit", kick: "hit", block: "reflected", special: "hit", stunned: "hit" },
    block: { punch: "guarding", kick: "guarding", block: "guarding", special: "shattered", stunned: "guarding" },
    special: { punch: "missed", kick: "hit", block: "hit", special: "hit", stunned: "hit" },
    stunned: { punch: "stunned", kick: "stunned", block: "stunned", special: "stunned", stunned: "stunned" },
};

const COMBAT_CONSTANTS = {
    BASE_ENERGY_REGEN: 20,
    GUARD_BUILDUP_ON_BLOCK: 25,
    GUARD_BUILDUP_ON_HIT: 15,
    GUARD_BREAK_THRESHOLD: 100,
    SHATTER_DAMAGE_MULTIPLIER: 1.5,
    BLOCK_DAMAGE_REDUCTION: 0.5,
    KICK_REFLECT_PERCENT: 0.3,
    STAGGER_DAMAGE_REDUCTION: 0.5,
};

// =============================================================================
// SEEDED RNG
// =============================================================================

function seededRandom(seed: string): () => number {
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
        const char = seed.charCodeAt(i);
        hash = (hash << 5) - hash + char;
        hash = hash & hash;
    }
    let s = Math.abs(hash);
    return () => {
        s = (s * 9301 + 49297) % 233280;
        return s / 233280;
    };
}

// =============================================================================
// MATCH SIMULATION
// =============================================================================

const TURN_DURATION_MS = 2500;
const BETTING_DURATION_MS = 30000;
const ONCHAIN_DEADLINE_BUFFER_SECONDS = 20;
const MAX_TURNS_PER_ROUND = 12;
const ROUNDS_TO_WIN = 2;
const PLAYBACK_END_SIGNAL_TIMEOUT_MS = 120000;

function getMatchDurationMs(match: BotMatch): number {
    return match.totalTurns * TURN_DURATION_MS + BETTING_DURATION_MS;
}

function isMatchPlaybackComplete(match: BotMatch): boolean {
    return Date.now() - match.createdAt >= getMatchDurationMs(match);
}

async function getBotSettlementZkArtifacts(params: {
    matchId: string;
    poolId: number;
    winner: "player1" | "player2";
}): Promise<{ vkIdHex: string; proof: Buffer; publicInputs: Buffer[]; verificationKeyPath: string }> {
    const winnerSide = params.winner === "player1" ? 0 : 1;
    const proved = await proveBotBettingSettlement({
        matchIdFieldBytes: matchIdToBytes32(params.matchId),
        poolId: params.poolId,
        winnerSide,
    });

    return {
        vkIdHex: proved.vkIdHex,
        proof: proved.proof,
        publicInputs: proved.publicInputs,
        verificationKeyPath: proved.verificationKeyPath,
    };
}

export function simulateBotMatch(matchId: string, bot1Id?: string, bot2Id?: string): BotMatch {
    const seed = matchId;
    const rng = seededRandom(seed);

    // Pick random characters if not specified
    if (!bot1Id) {
        bot1Id = BOT_CHARACTERS[Math.floor(rng() * BOT_CHARACTERS.length)].id;
    }
    if (!bot2Id) {
        // Ensure different characters
        let bot2Idx = Math.floor(rng() * BOT_CHARACTERS.length);
        while (BOT_CHARACTERS[bot2Idx].id === bot1Id) {
            bot2Idx = Math.floor(rng() * BOT_CHARACTERS.length);
        }
        bot2Id = BOT_CHARACTERS[bot2Idx].id;
    }

    const bot1Char = BOT_CHARACTERS.find(c => c.id === bot1Id);
    const bot2Char = BOT_CHARACTERS.find(c => c.id === bot2Id);

    const bot1Caps = getCharacterCombatCaps(bot1Id!);
    const bot2Caps = getCharacterCombatCaps(bot2Id!);
    let bot1Hp = bot1Caps.maxHp;
    let bot2Hp = bot2Caps.maxHp;
    let bot1Energy = Math.min(50, bot1Caps.maxEnergy);
    let bot2Energy = Math.min(50, bot2Caps.maxEnergy);
    let bot1Guard = 0;
    let bot2Guard = 0;
    let bot1RoundsWon = 0;
    let bot2RoundsWon = 0;
    let roundTurn = 0;
    let roundNumber = 1;
    let bot1IsStunned = false;
    let bot2IsStunned = false;
    let bot1IsStaggered = false;
    let bot2IsStaggered = false;
    let currentBot1Surge: PowerSurgeCardId | null = null;
    let currentBot2Surge: PowerSurgeCardId | null = null;
    let currentRoundSurgeCards: PowerSurgeCardId[] = [];
    let surgeDeck: StoredSurgeDeck = { version: 1, rounds: {} };

    const turns: BotTurnData[] = [];
    let matchWinner: string | null = null;
    const bot1Rng = seededRandom(`${seed}:bot1`);
    const bot2Rng = seededRandom(`${seed}:bot2`);
    const smartBot1 = new SmartBotOpponent(bot1Char?.name || "Bot 1", bot1Rng);
    const smartBot2 = new SmartBotOpponent(bot2Char?.name || "Bot 2", bot2Rng);

    for (let turn = 1; turn <= 120 && !matchWinner; turn++) {
        roundTurn++;

        if (roundTurn === 1) {
            const deckResult = getOrCreateRoundDeck({
                matchId,
                player1Address: bot1Id!,
                player2Address: bot2Id!,
                roundNumber,
                existingDeck: surgeDeck,
            });
            surgeDeck = deckResult.deck;
            currentRoundSurgeCards = [...deckResult.round.player1Cards];
            currentBot1Surge = selectSurgeCard(currentRoundSurgeCards, bot1Rng);
            currentBot2Surge = selectSurgeCard(currentRoundSurgeCards, bot2Rng);
        }

        const surge = calculateSurgeEffects(currentBot1Surge, currentBot2Surge);
        const bot1BlockDisabled = isBlockDisabled(surge.player1Modifiers, surge.player2Modifiers);
        const bot2BlockDisabled = isBlockDisabled(surge.player2Modifiers, surge.player1Modifiers);

        // AI move selection (weighted random)
        const selectedBot1Move = getSmartMove({
            bot: smartBot1,
            botHealth: bot1Hp,
            botMaxHealth: bot1Caps.maxHp,
            botEnergy: bot1Energy,
            botMaxEnergy: bot1Caps.maxEnergy,
            botGuardMeter: bot1Guard,
            botIsStunned: bot1IsStunned,
            botIsStaggered: bot1IsStaggered,
            opponentHealth: bot2Hp,
            opponentMaxHealth: bot2Caps.maxHp,
            opponentEnergy: bot2Energy,
            opponentMaxEnergy: bot2Caps.maxEnergy,
            opponentGuardMeter: bot2Guard,
            opponentIsStunned: bot2IsStunned,
            opponentIsStaggered: bot2IsStaggered,
            roundNumber,
            turnNumber: roundTurn,
            botRoundsWon: bot1RoundsWon,
            opponentRoundsWon: bot2RoundsWon,
            blockDisabled: bot1BlockDisabled,
            specialEnergyExtraCost: surge.player1Modifiers.specialEnergyCost,
        });
        const selectedBot2Move = getSmartMove({
            bot: smartBot2,
            botHealth: bot2Hp,
            botMaxHealth: bot2Caps.maxHp,
            botEnergy: bot2Energy,
            botMaxEnergy: bot2Caps.maxEnergy,
            botGuardMeter: bot2Guard,
            botIsStunned: bot2IsStunned,
            botIsStaggered: bot2IsStaggered,
            opponentHealth: bot1Hp,
            opponentMaxHealth: bot1Caps.maxHp,
            opponentEnergy: bot1Energy,
            opponentMaxEnergy: bot1Caps.maxEnergy,
            opponentGuardMeter: bot1Guard,
            opponentIsStunned: bot1IsStunned,
            opponentIsStaggered: bot1IsStaggered,
            roundNumber,
            turnNumber: roundTurn,
            botRoundsWon: bot2RoundsWon,
            opponentRoundsWon: bot1RoundsWon,
            blockDisabled: bot2BlockDisabled,
            specialEnergyExtraCost: surge.player2Modifiers.specialEnergyCost,
        });
        const bot1Move: MoveType = bot1IsStunned ? "stunned" : selectedBot1Move;
        const bot2Move: MoveType = bot2IsStunned ? "stunned" : selectedBot2Move;

        if (!bot1IsStunned) {
            smartBot1.recordOpponentMove(bot2Move);
            smartBot1.recordBotMove(bot1Move);
        }
        if (!bot2IsStunned) {
            smartBot2.recordOpponentMove(bot1Move);
            smartBot2.recordBotMove(bot2Move);
        }

        const result = resolveRound(
            {
                player1Move: bot1Move,
                player2Move: bot2Move,
                player1Health: bot1Hp,
                player2Health: bot2Hp,
                player1MaxHealth: bot1Caps.maxHp,
                player2MaxHealth: bot2Caps.maxHp,
                player1Energy: bot1Energy,
                player2Energy: bot2Energy,
                player1MaxEnergy: bot1Caps.maxEnergy,
                player2MaxEnergy: bot2Caps.maxEnergy,
                player1Guard: bot1Guard,
                player2Guard: bot2Guard,
            },
            {
                matchId,
                roundNumber,
                turnNumber: roundTurn,
                player1Surge: currentBot1Surge,
                player2Surge: currentBot2Surge,
            }
        );

        bot1Hp = result.player1HealthAfter;
        bot2Hp = result.player2HealthAfter;
        bot1Energy = result.player1EnergyAfter;
        bot2Energy = result.player2EnergyAfter;
        bot1Guard = result.player1GuardAfter;
        bot2Guard = result.player2GuardAfter;
        bot1IsStunned = result.player1IsStunnedNext;
        bot2IsStunned = result.player2IsStunnedNext;
        bot1IsStaggered = result.player1.outcome === "staggered";
        bot2IsStaggered = result.player2.outcome === "staggered";

        let roundWinner: "player1" | "player2" | null = null;
        const bothKo = result.winner === "draw" && bot1Hp <= 0 && bot2Hp <= 0;
        roundWinner = result.winner === "draw" ? null : result.winner;
        const isRoundEnd = result.isRoundOver;

        if (isRoundEnd) {
            if (roundWinner === "player1") bot1RoundsWon++;
            if (roundWinner === "player2") bot2RoundsWon++;
            if (bot1RoundsWon >= ROUNDS_TO_WIN) matchWinner = "bot1";
            if (bot2RoundsWon >= ROUNDS_TO_WIN) matchWinner = "bot2";
        }

        const narrative = result.narrative;

        turns.push({
            turnNumber: turn,
            roundNumber,
            bot1Move,
            bot2Move,
            bot1Hp,
            bot2Hp,
            bot1Energy,
            bot2Energy,
            bot1Guard,
            bot2Guard,
            bot1DamageTaken: result.player1.damageTaken,
            bot2DamageTaken: result.player2.damageTaken,
            bot1Outcome: result.player1.outcome,
            bot2Outcome: result.player2.outcome,
            bot1IsStunned,
            bot2IsStunned,
            description: `${bot1Move} vs ${bot2Move}`,
            narrative,
            isRoundStart: roundTurn === 1,
            isRoundEnd,
            isMatchEnd: Boolean(matchWinner),
            roundWinner,
            matchWinner: matchWinner === "bot1" ? "player1" : matchWinner === "bot2" ? "player2" : null,
            surgeCardIds: roundTurn === 1 ? currentRoundSurgeCards : undefined,
            bot1SurgeSelection: roundTurn === 1 ? currentBot1Surge : undefined,
            bot2SurgeSelection: roundTurn === 1 ? currentBot2Surge : undefined,
        });

        if (isRoundEnd && !matchWinner) {
            roundNumber++;
            roundTurn = 0;
            bot1Hp = bot1Caps.maxHp;
            bot2Hp = bot2Caps.maxHp;
            bot1Energy = Math.min(50, bot1Caps.maxEnergy);
            bot2Energy = Math.min(50, bot2Caps.maxEnergy);
            bot1Guard = 0;
            bot2Guard = 0;
            bot1IsStunned = false;
            bot2IsStunned = false;
            bot1IsStaggered = false;
            bot2IsStaggered = false;
            currentBot1Surge = null;
            currentBot2Surge = null;
            currentRoundSurgeCards = [];
        }
    }

    // Fallback winner if match did not naturally finish
    if (!matchWinner) {
        if (bot1RoundsWon > bot2RoundsWon) matchWinner = "bot1";
        else if (bot2RoundsWon > bot1RoundsWon) matchWinner = "bot2";
        else matchWinner = bot1Hp >= bot2Hp ? "bot1" : "bot2";
    }

    return {
        id: matchId,
        bot1CharacterId: bot1Id!,
        bot2CharacterId: bot2Id!,
        bot1Name: bot1Char?.name || "Bot 1",
        bot2Name: bot2Char?.name || "Bot 2",
        seed,
        turns,
        totalTurns: turns.length,
        matchWinner,
        status: "active",
        turnDurationMs: TURN_DURATION_MS,
        createdAt: Date.now(),
    };
}

function buildNarrative(
    bot1Move: MoveType,
    bot2Move: MoveType,
    bot1DamageTaken: number,
    bot2DamageTaken: number,
    roundWinner: "player1" | "player2" | null,
    bothKo: boolean
): string {
    const moveNames: Record<string, string> = {
        punch: "throws a punch",
        kick: "fires a kick",
        block: "raises guard",
        special: "unleashes a special",
        stunned: "is stunned",
    };

    if (bothKo) return "DOUBLE KO! Both bots crash to the floor!";
    if (roundWinner === "player1") return "Bot 1 takes the round with a decisive finish!";
    if (roundWinner === "player2") return "Bot 2 steals the round with a clutch strike!";

    const p1Action = moveNames[bot1Move] ?? bot1Move;
    const p2Action = moveNames[bot2Move] ?? bot2Move;

    if (bot1Move === "block" && bot2Move === "block") {
        return "Both bots hold their guard and wait for an opening.";
    }

    if (bot2DamageTaken > 0 && bot1DamageTaken > 0) {
        if (bot2DamageTaken > bot1DamageTaken) {
            return `Heavy trade! Bot 1 ${p1Action} for ${bot2DamageTaken}, but eats ${bot1DamageTaken} back.`;
        }
        if (bot1DamageTaken > bot2DamageTaken) {
            return `Wild exchange! Bot 2 ${p2Action} for ${bot1DamageTaken}, but takes ${bot2DamageTaken}.`;
        }
        return `Even clash! Both bots deal ${bot1DamageTaken} damage.`;
    }

    if (bot2DamageTaken > 0) return `Bot 1 ${p1Action} and lands ${bot2DamageTaken} damage.`;
    if (bot1DamageTaken > 0) return `Bot 2 ${p2Action} and lands ${bot1DamageTaken} damage.`;
    return `Bot 1 ${p1Action}; Bot 2 ${p2Action}. Neither side connects cleanly.`;
}

function selectBotMove(rng: () => number, hp: number, energy: number, guard: number): Exclude<MoveType, "stunned"> {
    const r = rng();

    // Low HP: more defensive
    if (hp < 30) {
        if (r < 0.4) return "block";
        if (r < 0.7) return "punch";
        if (r < 0.85) return "kick";
        return energy >= 30 ? "special" : "punch";
    }

    // High energy: more aggressive
    if (energy >= 70) {
        if (r < 0.3) return "special";
        if (r < 0.6) return "punch";
        if (r < 0.85) return "kick";
        return "block";
    }

    // Default balanced
    if (r < 0.3) return "punch";
    if (r < 0.55) return "kick";
    if (r < 0.75) return "block";
    return energy >= 30 ? "special" : "punch";
}

function getSmartMove(params: {
    bot: SmartBotOpponent;
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
    blockDisabled: boolean;
    specialEnergyExtraCost: number;
}): Exclude<MoveType, "stunned"> {
    params.bot.updateContext({
        botHealth: params.botHealth,
        botMaxHealth: params.botMaxHealth,
        botEnergy: params.botEnergy,
        botMaxEnergy: params.botMaxEnergy,
        botGuardMeter: params.botGuardMeter,
        botIsStunned: params.botIsStunned,
        botIsStaggered: params.botIsStaggered,
        opponentHealth: params.opponentHealth,
        opponentMaxHealth: params.opponentMaxHealth,
        opponentEnergy: params.opponentEnergy,
        opponentMaxEnergy: params.opponentMaxEnergy,
        opponentGuardMeter: params.opponentGuardMeter,
        opponentIsStunned: params.opponentIsStunned,
        opponentIsStaggered: params.opponentIsStaggered,
        roundNumber: params.roundNumber,
        turnNumber: params.turnNumber,
        botRoundsWon: params.botRoundsWon,
        opponentRoundsWon: params.opponentRoundsWon,
        blockDisabled: params.blockDisabled,
        specialEnergyExtraCost: params.specialEnergyExtraCost,
    });

    const decision = params.bot.decide().move;
    if (decision === "stunned") return "punch";
    return decision;
}

function selectSurgeCard(cards: PowerSurgeCardId[], rng: () => number): PowerSurgeCardId | null {
    if (!cards.length) return null;

    const finality = cards.find((card) => card === "finality-fist");
    if (finality && rng() < 0.35) return finality;

    const vaultbreaker = cards.find((card) => card === "vaultbreaker");
    if (vaultbreaker && rng() < 0.2) return vaultbreaker;

    return cards[Math.floor(rng() * cards.length)] ?? cards[0];
}

interface TurnResult {
    bot1Damage: number;
    bot2Damage: number;
    bot1EnergyChange: number;
    bot2EnergyChange: number;
    bot1GuardChange: number;
    bot2GuardChange: number;
    bot1Outcome: MoveOutcome;
    bot2Outcome: MoveOutcome;
    bot1NextStunned: boolean;
    bot2NextStunned: boolean;
    bot1NextStaggered: boolean;
    bot2NextStaggered: boolean;
    description: string;
}

function resolveTurn(params: {
    bot1Move: MoveType;
    bot2Move: MoveType;
    bot1Energy: number;
    bot2Energy: number;
    bot1Guard: number;
    bot2Guard: number;
    bot1IsStaggered: boolean;
    bot2IsStaggered: boolean;
}): TurnResult {
    const p1Outcome = RESOLUTION_MATRIX[params.bot1Move][params.bot2Move];
    const p2Outcome = RESOLUTION_MATRIX[params.bot2Move][params.bot1Move];

    const baseP1Damage = p1Outcome === "hit"
        ? Math.floor(BASE_MOVE_STATS[params.bot1Move].damage * (params.bot1IsStaggered ? COMBAT_CONSTANTS.STAGGER_DAMAGE_REDUCTION : 1))
        : 0;
    const baseP2Damage = p2Outcome === "hit"
        ? Math.floor(BASE_MOVE_STATS[params.bot2Move].damage * (params.bot2IsStaggered ? COMBAT_CONSTANTS.STAGGER_DAMAGE_REDUCTION : 1))
        : 0;

    let bot1Damage = 0;
    let bot2Damage = 0;

    // Damage taken by player1 from player2
    if (p1Outcome === "guarding") {
        bot1Damage = Math.floor(baseP2Damage * COMBAT_CONSTANTS.BLOCK_DAMAGE_REDUCTION);
    } else if (p1Outcome === "shattered") {
        bot1Damage = Math.floor(baseP2Damage * COMBAT_CONSTANTS.SHATTER_DAMAGE_MULTIPLIER);
    } else {
        bot1Damage = baseP2Damage;
    }

    // Damage taken by player2 from player1
    if (p2Outcome === "guarding") {
        bot2Damage = Math.floor(baseP1Damage * COMBAT_CONSTANTS.BLOCK_DAMAGE_REDUCTION);
    } else if (p2Outcome === "shattered") {
        bot2Damage = Math.floor(baseP1Damage * COMBAT_CONSTANTS.SHATTER_DAMAGE_MULTIPLIER);
    } else {
        bot2Damage = baseP1Damage;
    }

    // Kick reflected by block
    if (p1Outcome === "reflected" && params.bot1Move === "kick") {
        bot1Damage += Math.floor(BASE_MOVE_STATS.kick.damage * COMBAT_CONSTANTS.KICK_REFLECT_PERCENT);
    }
    if (p2Outcome === "reflected" && params.bot2Move === "kick") {
        bot2Damage += Math.floor(BASE_MOVE_STATS.kick.damage * COMBAT_CONSTANTS.KICK_REFLECT_PERCENT);
    }

    // Energy changes this turn (regen applied by caller)
    const bot1EnergyChange = -BASE_MOVE_STATS[params.bot1Move].energyCost;
    const bot2EnergyChange = -BASE_MOVE_STATS[params.bot2Move].energyCost;

    // Guard meter updates
    let bot1GuardChange = 0;
    let bot2GuardChange = 0;

    if (params.bot1Move === "block") {
        if (p1Outcome === "guarding") {
            bot1GuardChange += COMBAT_CONSTANTS.GUARD_BUILDUP_ON_BLOCK;
            if (params.bot2Move !== "block" && params.bot2Move !== "stunned") {
                bot1GuardChange += COMBAT_CONSTANTS.GUARD_BUILDUP_ON_HIT;
            }
        } else if (p1Outcome === "shattered") {
            bot1GuardChange = -params.bot1Guard;
        }
    }

    if (params.bot2Move === "block") {
        if (p2Outcome === "guarding") {
            bot2GuardChange += COMBAT_CONSTANTS.GUARD_BUILDUP_ON_BLOCK;
            if (params.bot1Move !== "block" && params.bot1Move !== "stunned") {
                bot2GuardChange += COMBAT_CONSTANTS.GUARD_BUILDUP_ON_HIT;
            }
        } else if (p2Outcome === "shattered") {
            bot2GuardChange = -params.bot2Guard;
        }
    }

    const nextP1Guard = Math.max(0, Math.min(100, params.bot1Guard + bot1GuardChange));
    const nextP2Guard = Math.max(0, Math.min(100, params.bot2Guard + bot2GuardChange));

    const bot1GuardBreak = nextP1Guard >= COMBAT_CONSTANTS.GUARD_BREAK_THRESHOLD && params.bot1Move !== "block";
    const bot2GuardBreak = nextP2Guard >= COMBAT_CONSTANTS.GUARD_BREAK_THRESHOLD && params.bot2Move !== "block";

    if (bot1GuardBreak) {
        bot1GuardChange = -params.bot1Guard;
    }
    if (bot2GuardBreak) {
        bot2GuardChange = -params.bot2Guard;
    }

    // Stun semantics aligned with FightScene/CombatEngine timing:
    // - "missed" means got countered (e.g., special vs punch) and is stunned next turn
    // - guard break also stuns next turn
    const bot1NextStunned = p1Outcome === "missed" || bot1GuardBreak;
    const bot2NextStunned = p2Outcome === "missed" || bot2GuardBreak;

    const bot1NextStaggered = p1Outcome === "staggered";
    const bot2NextStaggered = p2Outcome === "staggered";

    return {
        bot1Damage: Math.max(0, Math.floor(bot1Damage)),
        bot2Damage: Math.max(0, Math.floor(bot2Damage)),
        bot1EnergyChange,
        bot2EnergyChange,
        bot1GuardChange,
        bot2GuardChange,
        bot1Outcome: p1Outcome,
        bot2Outcome: p2Outcome,
        bot1NextStunned,
        bot2NextStunned,
        bot1NextStaggered,
        bot2NextStaggered,
        description: `${params.bot1Move} vs ${params.bot2Move}`,
    };
}

// =============================================================================
// ACTIVE MATCH MANAGEMENT
// =============================================================================

let activeMatch: BotMatch | null = null;
let nextMatch: BotMatch | null = null;
let lifecycleSyncInFlight = false;
let ensureActiveMatchInFlight: Promise<BotMatch> | null = null;
const finalizedMatchIds = new Set<string>();
const provisioningPoolForMatch = new Map<string, Promise<boolean>>();
const playbackEndedSignalTsByMatchId = new Map<string, number>();
const BOT_MATCH_WORKER_INTERVAL_MS = 1000;
let botMatchWorkerTimer: ReturnType<typeof setInterval> | null = null;

async function runBotMatchLifecycleTick(): Promise<void> {
    try {
        await ensureActiveBotMatch();
        await syncActiveBotBettingLifecycle();
    } catch (error) {
        console.error("[BotMatchService] lifecycle tick failed:", error);
    }
}

export function startBotMatchLifecycleWorker(): void {
    if (botMatchWorkerTimer) return;

    void runBotMatchLifecycleTick();

    botMatchWorkerTimer = setInterval(() => {
        void runBotMatchLifecycleTick();
    }, BOT_MATCH_WORKER_INTERVAL_MS);

    console.log(`[BotMatchService] Lifecycle worker started (${BOT_MATCH_WORKER_INTERVAL_MS}ms interval)`);
}

async function ensureBotPoolProvisioned(match: BotMatch): Promise<boolean> {
    const inFlight = provisioningPoolForMatch.get(match.id);
    if (inFlight) return inFlight;

    const provisioningPromise = (async () => {

        try {
            const supabase = getSupabase();
            let { data: pool } = await supabase
                .from("betting_pools")
                .select("id,match_id,match_type,status,onchain_pool_id,onchain_status")
                .eq("match_id", match.id)
                .eq("match_type", "bot")
                .single();

            if (!pool) {
                const { data: createdPool } = await supabase
                    .from("betting_pools")
                    .insert({
                        match_id: match.id,
                        match_type: "bot",
                        status: "open",
                        player1_total: 0,
                        player2_total: 0,
                        total_pool: 0,
                        total_fees: 0,
                        onchain_status: "open",
                    })
                    .select("id,match_id,match_type,status,onchain_pool_id,onchain_status")
                    .single();

                pool = createdPool ?? null;
            }

            if (!pool || !isZkBettingConfigured()) return false;
            if (pool.onchain_pool_id) return true;

            const nowTs = Math.floor(Date.now() / 1000);
            const deadlineTs = nowTs + Math.ceil(BETTING_DURATION_MS / 1000) + ONCHAIN_DEADLINE_BUFFER_SECONDS;
            const created = await createOnChainBotPool(match.id, deadlineTs);

            await supabase
                .from("betting_pools")
                .update({
                    onchain_pool_id: created.poolId,
                    onchain_status: "open",
                    onchain_last_tx_id: created.txHash || null,
                })
                .eq("id", pool.id)
                .is("onchain_pool_id", null);

            return true;
        } catch (error) {
            console.error("[BotMatchService] ensureBotPoolProvisioned error:", error);
            return false;
        } finally {
            provisioningPoolForMatch.delete(match.id);
        }
    })();

    provisioningPoolForMatch.set(match.id, provisioningPromise);
    return provisioningPromise;
}

async function lockBotPoolIfNeeded(match: BotMatch): Promise<void> {
    try {
        const supabase = getSupabase();
        const { data: pool } = await supabase
            .from("betting_pools")
            .select("id,onchain_pool_id,onchain_status,status,onchain_last_tx_id")
            .eq("match_id", match.id)
            .eq("match_type", "bot")
            .single();

        if (!pool) return;
        if (pool.onchain_status === "locked" || pool.onchain_status === "settled") return;

        let lastTx: string | null = null;
        if (pool.onchain_pool_id) {
            const lockTx = await lockOnChainPool(Number(pool.onchain_pool_id));
            lastTx = lockTx.txHash || null;
        }

        await supabase
            .from("betting_pools")
            .update({
                status: "locked",
                onchain_status: "locked",
                onchain_last_tx_id: lastTx,
            })
            .eq("id", pool.id);
    } catch (error) {
        console.error("[BotMatchService] lockBotPoolIfNeeded error:", error);
    }
}

async function settleBotBetsOffchain(params: {
    poolId: string;
    onchainPoolId: number | null;
    winner: "player1" | "player2";
    settleTxId: string | null;
    attemptRevealOnChain?: boolean;
}): Promise<void> {
    const supabase = getSupabase();

    const { data: poolBets } = await supabase
        .from("bets")
        .select("id,bettor_address,bet_on,amount,reveal_salt,revealed,claim_tx_id")
        .eq("pool_id", params.poolId);

    for (const bet of poolBets ?? []) {
        const bettorAddress = String(bet.bettor_address || "");
        const betOn = String(bet.bet_on || "");
        const revealSalt = typeof bet.reveal_salt === "string" ? bet.reveal_salt : "";
        let revealed = Boolean(bet.revealed);
        let revealTxId = null as string | null;
        let claimTxId = typeof bet.claim_tx_id === "string" ? bet.claim_tx_id : null;

        if (params.attemptRevealOnChain && params.onchainPoolId && bettorAddress && betOn && revealSalt && !revealed) {
            const reveal = await revealOnChainBetAsAdmin({
                poolId: params.onchainPoolId,
                bettor: bettorAddress,
                side: betOn === "player1" ? "player1" : "player2",
                saltHex: revealSalt,
            });

            if (reveal.txHash) {
                revealed = true;
                revealTxId = reveal.txHash;
            } else if (reveal.skipped && reveal.reason === "already_revealed") {
                revealed = true;
                revealTxId = params.settleTxId ? `auto-reveal:${params.settleTxId}` : "auto-reveal";
            }
        }

        const isWinningBet = betOn === params.winner;
        let status: "won" | "lost" = isWinningBet ? "won" : "lost";
        let payoutAmount = 0;
        if (isWinningBet) {
            payoutAmount = Number(bet.amount ?? 0) * 2;
        }

        if (isWinningBet && revealed && !claimTxId && params.onchainPoolId && bettorAddress) {
            const claim = await claimOnChainPayoutAsAdmin({
                poolId: params.onchainPoolId,
                bettor: bettorAddress,
            });
            if (claim.txHash) {
                claimTxId = claim.txHash;
            } else if (claim.skipped && claim.reason === "already_claimed") {
                claimTxId = params.settleTxId ? `already-claimed:${params.settleTxId}` : "already-claimed";
            } else if (claim.skipped) {
                console.warn("[BotMatchService][Finalize] Claim skipped", {
                    poolId: params.poolId,
                    onchainPoolId: params.onchainPoolId,
                    bettorAddress,
                    reason: claim.reason,
                });
            }
        }

        await supabase
            .from("bets")
            .update({
                revealed,
                reveal_tx_id: revealTxId,
                status,
                payout_amount: isWinningBet ? payoutAmount : null,
                onchain_payout_amount: isWinningBet ? payoutAmount : null,
                claim_tx_id: claimTxId,
            })
            .eq("id", bet.id);
    }

    console.log("[BotMatchService][Finalize] Bets settled", {
        poolId: params.poolId,
        onchainPoolId: params.onchainPoolId,
        winner: params.winner,
        betCount: (poolBets || []).length,
    });
}

async function revealBotBetsOnChainBeforeSettle(params: {
    poolId: string;
    onchainPoolId: number | null;
    anchorTxId: string | null;
}): Promise<void> {
    if (!params.onchainPoolId) return;

    const supabase = getSupabase();
    const { data: poolBets } = await supabase
        .from("bets")
        .select("id,bettor_address,bet_on,reveal_salt,revealed")
        .eq("pool_id", params.poolId);

    let revealedCount = 0;
    for (const bet of poolBets ?? []) {
        if (bet.revealed) continue;

        const bettorAddress = String(bet.bettor_address || "");
        const betOn = String(bet.bet_on || "");
        const revealSalt = typeof bet.reveal_salt === "string" ? bet.reveal_salt : "";
        if (!bettorAddress || !betOn || !revealSalt) continue;

        const reveal = await revealOnChainBetAsAdmin({
            poolId: params.onchainPoolId,
            bettor: bettorAddress,
            side: betOn === "player1" ? "player1" : "player2",
            saltHex: revealSalt,
        });

        if (reveal.txHash || (reveal.skipped && reveal.reason === "already_revealed")) {
            await supabase
                .from("bets")
                .update({
                    revealed: true,
                    reveal_tx_id: reveal.txHash || (params.anchorTxId ? `auto-reveal:${params.anchorTxId}` : "auto-reveal"),
                })
                .eq("id", bet.id);
            revealedCount += 1;
        }
    }

    if (revealedCount > 0) {
        console.log("[BotMatchService][Finalize] Revealed bets", {
            poolId: params.poolId,
            onchainPoolId: params.onchainPoolId,
            count: revealedCount,
        });
    }
}

async function finalizeCompletedBotMatch(match: BotMatch): Promise<void> {
    try {
        if (finalizedMatchIds.has(match.id)) return;

        const supabase = getSupabase();
        const winner = match.matchWinner === "bot1" ? "player1" : "player2";

        console.log("[BotMatchService][Finalize] Start", {
            matchId: match.id,
            winner,
            matchWinner: match.matchWinner,
        });

        const { data: pool } = await supabase
            .from("betting_pools")
            .select("id,onchain_pool_id,onchain_status,status,onchain_last_tx_id")
            .eq("match_id", match.id)
            .eq("match_type", "bot")
            .single();

        if (!pool) return;
        if (pool.status === "resolved" || pool.onchain_status === "settled") {
            console.log("[BotMatchService][Finalize] Already finalized", {
                matchId: match.id,
                poolId: pool.id,
                status: pool.status,
                onchainStatus: pool.onchain_status,
            });

            await settleBotBetsOffchain({
                poolId: pool.id,
                onchainPoolId: pool.onchain_pool_id ? Number(pool.onchain_pool_id) : null,
                winner,
                settleTxId: pool.onchain_last_tx_id ?? null,
                attemptRevealOnChain: false,
            });

            finalizedMatchIds.add(match.id);
            return;
        }

        let lastTx: string | null = null;
        if (pool.onchain_pool_id) {
            if (!pool.onchain_status || pool.onchain_status === "open") {
                const lockTx = await lockOnChainPool(Number(pool.onchain_pool_id));
                lastTx = lockTx.txHash || lastTx;
                console.log("[BotMatchService][Finalize] Lock tx", {
                    matchId: match.id,
                    poolId: pool.id,
                    onchainPoolId: pool.onchain_pool_id,
                    txHash: lockTx.txHash || null,
                    skipped: lockTx.skipped || false,
                    reason: lockTx.reason || null,
                });
            }

            await revealBotBetsOnChainBeforeSettle({
                poolId: pool.id,
                onchainPoolId: Number(pool.onchain_pool_id),
                anchorTxId: lastTx,
            });

            try {
                const settlementArtifacts = await getBotSettlementZkArtifacts({
                    matchId: match.id,
                    poolId: Number(pool.onchain_pool_id),
                    winner: winner as "player1" | "player2",
                });

                await ensureZkBettingVerifierConfigured({
                    vkIdHex: settlementArtifacts.vkIdHex,
                    verificationKeyPath: settlementArtifacts.verificationKeyPath,
                });

                const settleTx = await settleOnChainPoolZk({
                    poolId: Number(pool.onchain_pool_id),
                    winner: winner as "player1" | "player2",
                    vkIdHex: settlementArtifacts.vkIdHex,
                    proof: settlementArtifacts.proof,
                    publicInputs: settlementArtifacts.publicInputs,
                });
                lastTx = settleTx.txHash || lastTx;
                console.log("[BotMatchService][Finalize] Settle tx", {
                    matchId: match.id,
                    poolId: pool.id,
                    onchainPoolId: pool.onchain_pool_id,
                    txHash: settleTx.txHash || null,
                    skipped: settleTx.skipped || false,
                    reason: settleTx.reason || null,
                });
            } catch (error) {
                const onchain = await getOnChainPoolStatus(Number(pool.onchain_pool_id));
                const alreadySettled = onchain?.status === 2;
                console.warn("[BotMatchService][Finalize] Settle tx failed", {
                    matchId: match.id,
                    poolId: pool.id,
                    onchainPoolId: pool.onchain_pool_id,
                    error: error instanceof Error ? error.message : String(error ?? ""),
                    onchainStatus: onchain?.status ?? null,
                    onchainWinnerSide: onchain?.winnerSide ?? null,
                    recoveredAsSettled: alreadySettled,
                });
                if (!alreadySettled) {
                    throw error;
                }
            }
        }

        await supabase
            .from("betting_pools")
            .update({
                status: "resolved",
                winner,
                onchain_status: "settled",
                onchain_last_tx_id: lastTx,
            })
            .eq("id", pool.id);

        await settleBotBetsOffchain({
            poolId: pool.id,
            onchainPoolId: pool.onchain_pool_id ? Number(pool.onchain_pool_id) : null,
            winner,
            settleTxId: lastTx,
            attemptRevealOnChain: false,
        });

        console.log("[BotMatchService][Finalize] Completed", {
            matchId: match.id,
            poolId: pool.id,
            winner,
            lastTx,
        });

        finalizedMatchIds.add(match.id);
    } catch (error) {
        console.error("[BotMatchService] finalizeCompletedBotMatch error:", error);
    }
}

export async function syncActiveBotBettingLifecycle(): Promise<void> {
    const match = activeMatch;
    if (!match || lifecycleSyncInFlight) return;

    lifecycleSyncInFlight = true;

    try {
        await ensureBotPoolProvisioned(match);

        const matchDuration = getMatchDurationMs(match);
        const elapsed = Date.now() - match.createdAt;

        if (elapsed >= BETTING_DURATION_MS && elapsed < matchDuration) {
            await lockBotPoolIfNeeded(match);

            // Warm the next match simulation, but DO NOT pre-provision on-chain pool here.
            // If provisioned too early, its deadline can expire before the match starts.
            if (!nextMatch) {
                const matchId = crypto.randomUUID();
                nextMatch = simulateBotMatch(matchId);
            }
        }

        if (elapsed >= matchDuration + 5000) {
            await finalizeCompletedBotMatch(match);
        }
    } finally {
        lifecycleSyncInFlight = false;
    }
}

async function ensureActiveBotMatchInternal(): Promise<BotMatch> {
    await syncActiveBotBettingLifecycle();

    // Keep the current match until playback has ended and post-match finalization
    // has succeeded. This guarantees we do not start a new match prematurely.
    if (activeMatch) {
        if (!isMatchPlaybackComplete(activeMatch)) {
            return activeMatch;
        }

        if (!finalizedMatchIds.has(activeMatch.id)) {
            return activeMatch;
        }

        const playbackSignalTs = playbackEndedSignalTsByMatchId.get(activeMatch.id) ?? null;
        if (!playbackSignalTs) {
            const elapsedSincePlaybackComplete = Date.now() - (activeMatch.createdAt + getMatchDurationMs(activeMatch));
            if (elapsedSincePlaybackComplete < PLAYBACK_END_SIGNAL_TIMEOUT_MS) {
                return activeMatch;
            }
        }

        const elapsed = Date.now() - activeMatch.createdAt;
        if (elapsed < getMatchDurationMs(activeMatch) + 5000) {
            return activeMatch;
        }
    }

    // Generate and provision next match before making it active so betting timer
    // starts only after pool creation is complete.
    let matchToStart = nextMatch;
    if (!matchToStart) {
        const matchId = crypto.randomUUID();
        matchToStart = simulateBotMatch(matchId);
    }
    nextMatch = null; // Clear it so a new one is generated next time

    const success = await ensureBotPoolProvisioned(matchToStart);
    if (!success && isZkBettingConfigured()) {
        // If we couldn't provision the pool, we shouldn't start the match.
        // Throwing an error will cause the client to retry later.
        throw new Error("Failed to provision on-chain pool for new match");
    }

    // Reset match start time after provisioning so BETTING_DURATION_MS countdown
    // begins only when spectators can place bets.
    matchToStart.createdAt = Date.now();

    activeMatch = matchToStart;
    finalizedMatchIds.delete(matchToStart.id);
    playbackEndedSignalTsByMatchId.delete(matchToStart.id);

    console.log(`[BotMatchService] Generated new bot match: ${matchToStart.id} (${activeMatch.bot1Name} vs ${activeMatch.bot2Name}, ${activeMatch.totalTurns} turns)`);

    return activeMatch;
}

export async function ensureActiveBotMatch(): Promise<BotMatch> {
    if (ensureActiveMatchInFlight) {
        return ensureActiveMatchInFlight;
    }

    ensureActiveMatchInFlight = (async () => {
        try {
            return await ensureActiveBotMatchInternal();
        } finally {
            ensureActiveMatchInFlight = null;
        }
    })();

    return ensureActiveMatchInFlight;
}

export function getActiveMatch(): BotMatch | null {
    return activeMatch;
}

export function reportActiveMatchPlaybackEnded(matchId: string): {
    accepted: boolean;
    activeMatchId: string | null;
} {
    if (!activeMatch || activeMatch.id !== matchId) {
        return { accepted: false, activeMatchId: activeMatch?.id ?? null };
    }

    if (!playbackEndedSignalTsByMatchId.has(matchId)) {
        playbackEndedSignalTsByMatchId.set(matchId, Date.now());
        console.log("[BotMatchService] Playback-ended signal received", { matchId });
    }

    return { accepted: true, activeMatchId: activeMatch.id };
}

export function getMatchSyncInfo(matchId: string): {
    currentTurnIndex: number;
    elapsedMs: number;
    isFinished: boolean;
    bettingStatus: { isOpen: boolean; secondsRemaining: number };
} | null {
    if (!activeMatch || activeMatch.id !== matchId) return null;

    const elapsed = Date.now() - activeMatch.createdAt;

    // Betting phase
    if (elapsed < BETTING_DURATION_MS) {
        return {
            currentTurnIndex: 0,
            elapsedMs: elapsed,
            isFinished: false,
            bettingStatus: {
                isOpen: true,
                secondsRemaining: Math.ceil((BETTING_DURATION_MS - elapsed) / 1000),
            },
        };
    }

    // Match phase
    const matchElapsed = elapsed - BETTING_DURATION_MS;
    const turnIndex = Math.min(
        Math.floor(matchElapsed / TURN_DURATION_MS),
        activeMatch.totalTurns - 1
    );

    const isFinished = turnIndex >= activeMatch.totalTurns - 1;

    return {
        currentTurnIndex: turnIndex,
        elapsedMs: elapsed,
        isFinished,
        bettingStatus: {
            isOpen: false,
            secondsRemaining: 0,
        },
    };
}
