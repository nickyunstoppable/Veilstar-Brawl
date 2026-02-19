/**
 * Bot Match Service
 * Pre-computes entire bot matches server-side for spectating
 * Manages the single active bot match room
 */

import { getSupabase } from "./supabase";
import { lockOnChainPool, settleOnChainPool } from "./zk-betting-contract";

// =============================================================================
// TYPES
// =============================================================================

export interface BotTurnData {
    turnNumber: number;
    roundNumber: number;
    bot1Move: string;
    bot2Move: string;
    bot1Hp: number;
    bot2Hp: number;
    bot1Energy: number;
    bot2Energy: number;
    bot1Guard: number;
    bot2Guard: number;
    description: string;
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
    { id: "block-bruiser", name: "Block Bruiser" },
    { id: "heavy-loader", name: "Heavy Loader" },
    { id: "dag-warrior", name: "DAG Warrior" },
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

const MOVES = ["punch", "kick", "block", "special"];

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
const MAX_TURNS = 40;

export function simulateBotMatch(matchId: string, bot1Id?: string, bot2Id?: string): BotMatch {
    const seed = matchId + "-" + Date.now();
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

    let bot1Hp = 100;
    let bot2Hp = 100;
    let bot1Energy = 50;
    let bot2Energy = 50;
    let bot1Guard = 100;
    let bot2Guard = 100;

    const turns: BotTurnData[] = [];
    let matchWinner: string | null = null;
    let roundNumber = 1;

    for (let turn = 1; turn <= MAX_TURNS && !matchWinner; turn++) {
        // AI move selection (weighted random)
        const bot1Move = selectBotMove(rng, bot1Hp, bot1Energy, bot1Guard);
        const bot2Move = selectBotMove(rng, bot2Hp, bot2Energy, bot2Guard);

        // Resolve combat
        const result = resolveTurn(bot1Move, bot2Move, rng);

        bot1Hp = Math.max(0, bot1Hp - result.bot1Damage);
        bot2Hp = Math.max(0, bot2Hp - result.bot2Damage);
        bot1Energy = Math.min(100, bot1Energy + result.bot1EnergyChange);
        bot2Energy = Math.min(100, bot2Energy + result.bot2EnergyChange);
        bot1Guard = Math.max(0, Math.min(100, bot1Guard + result.bot1GuardChange));
        bot2Guard = Math.max(0, Math.min(100, bot2Guard + result.bot2GuardChange));

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
            description: result.description,
        });

        if (bot1Hp <= 0) matchWinner = "bot2";
        else if (bot2Hp <= 0) matchWinner = "bot1";
    }

    // If no winner after max turns, winner is whoever has more HP
    if (!matchWinner) {
        matchWinner = bot1Hp >= bot2Hp ? "bot1" : "bot2";
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

function selectBotMove(rng: () => number, hp: number, energy: number, guard: number): string {
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

interface TurnResult {
    bot1Damage: number;
    bot2Damage: number;
    bot1EnergyChange: number;
    bot2EnergyChange: number;
    bot1GuardChange: number;
    bot2GuardChange: number;
    description: string;
}

function resolveTurn(bot1Move: string, bot2Move: string, rng: () => number): TurnResult {
    let bot1Damage = 0;
    let bot2Damage = 0;
    let bot1EnergyChange = 5;
    let bot2EnergyChange = 5;
    let bot1GuardChange = 0;
    let bot2GuardChange = 0;
    let description = "";

    // Calculate damage
    const p1Atk = getMoveDamage(bot1Move, rng);
    const p2Atk = getMoveDamage(bot2Move, rng);

    if (bot2Move === "block" && (bot1Move === "punch" || bot1Move === "kick")) {
        bot2Damage = Math.floor(p1Atk * 0.2);
        bot2GuardChange = -10;
        description = "Bot 2 blocks!";
    } else {
        bot2Damage = p1Atk;
    }

    if (bot1Move === "block" && (bot2Move === "punch" || bot2Move === "kick")) {
        bot1Damage = Math.floor(p2Atk * 0.2);
        bot1GuardChange = -10;
        description += (description ? " " : "") + "Bot 1 blocks!";
    } else {
        bot1Damage = p2Atk;
    }

    // Special costs energy
    if (bot1Move === "special") bot1EnergyChange = -20;
    if (bot2Move === "special") bot2EnergyChange = -20;

    // Guard regen on block
    if (bot1Move === "block") { bot1GuardChange += 10; bot1EnergyChange += 5; }
    if (bot2Move === "block") { bot2GuardChange += 10; bot2EnergyChange += 5; }

    if (!description) {
        description = `${bot1Move} vs ${bot2Move}`;
    }

    return { bot1Damage, bot2Damage, bot1EnergyChange, bot2EnergyChange, bot1GuardChange, bot2GuardChange, description };
}

function getMoveDamage(move: string, rng: () => number): number {
    const variance = 0.8 + rng() * 0.4; // 80%-120% damage variance
    switch (move) {
        case "punch": return Math.floor(8 * variance);
        case "kick": return Math.floor(12 * variance);
        case "special": return Math.floor(20 * variance);
        case "block": return 0;
        default: return 0;
    }
}

// =============================================================================
// ACTIVE MATCH MANAGEMENT
// =============================================================================

let activeMatch: BotMatch | null = null;
let lifecycleSyncInFlight = false;
const finalizedMatchIds = new Set<string>();

async function lockBotPoolIfNeeded(match: BotMatch): Promise<void> {
    try {
        const supabase = getSupabase();
        const { data: pool } = await supabase
            .from("betting_pools")
            .select("id,onchain_pool_id,onchain_status,status")
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

async function finalizeCompletedBotMatch(match: BotMatch): Promise<void> {
    try {
        if (finalizedMatchIds.has(match.id)) return;

        const supabase = getSupabase();
        const winner = match.matchWinner === "bot1" ? "player1" : "player2";

        const { data: pool } = await supabase
            .from("betting_pools")
            .select("id,onchain_pool_id,onchain_status,status")
            .eq("match_id", match.id)
            .eq("match_type", "bot")
            .single();

        if (!pool) return;
        if (pool.status === "resolved" || pool.onchain_status === "settled") {
            finalizedMatchIds.add(match.id);
            return;
        }

        let lastTx: string | null = null;
        if (pool.onchain_pool_id) {
            if (!pool.onchain_status || pool.onchain_status === "open") {
                const lockTx = await lockOnChainPool(Number(pool.onchain_pool_id));
                lastTx = lockTx.txHash || lastTx;
            }
            const settleTx = await settleOnChainPool(Number(pool.onchain_pool_id), winner as "player1" | "player2");
            lastTx = settleTx.txHash || lastTx;
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

        await supabase
            .from("bets")
            .update({ status: "lost" })
            .eq("pool_id", pool.id);

        await supabase
            .from("bets")
            .update({ status: "won" })
            .eq("pool_id", pool.id)
            .eq("bet_on", winner)
            .eq("revealed", true);

        finalizedMatchIds.add(match.id);
    } catch (error) {
        console.error("[BotMatchService] finalizeCompletedBotMatch error:", error);
    }
}

export async function syncActiveBotBettingLifecycle(): Promise<void> {
    if (!activeMatch || lifecycleSyncInFlight) return;

    lifecycleSyncInFlight = true;

    try {
        const matchDuration = activeMatch.totalTurns * TURN_DURATION_MS + BETTING_DURATION_MS;
        const elapsed = Date.now() - activeMatch.createdAt;

        if (elapsed >= BETTING_DURATION_MS && elapsed < matchDuration) {
            await lockBotPoolIfNeeded(activeMatch);
        }

        if (elapsed >= matchDuration + 5000) {
            await finalizeCompletedBotMatch(activeMatch);
        }
    } finally {
        lifecycleSyncInFlight = false;
    }
}

export async function ensureActiveBotMatch(): Promise<BotMatch> {
    void syncActiveBotBettingLifecycle();

    // Check if current match is still "playing"
    if (activeMatch) {
        const matchDuration = activeMatch.totalTurns * TURN_DURATION_MS + BETTING_DURATION_MS;
        const elapsed = Date.now() - activeMatch.createdAt;
        if (elapsed < matchDuration + 5000) {
            return activeMatch;
        }
    }

    // Generate new match
    const matchId = crypto.randomUUID();
    activeMatch = simulateBotMatch(matchId);
    finalizedMatchIds.delete(matchId);

    console.log(`[BotMatchService] Generated new bot match: ${matchId} (${activeMatch.bot1Name} vs ${activeMatch.bot2Name}, ${activeMatch.totalTurns} turns)`);

    return activeMatch;
}

export function getActiveMatch(): BotMatch | null {
    return activeMatch;
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
