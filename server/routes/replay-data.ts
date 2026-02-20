/**
 * Replay Data
 * GET /api/replay-data?matchId=...
 *
 * Returns round-by-round data for ReplayScene playback and MP4 export.
 */

import { getSupabase } from "../lib/supabase";
import { normalizeStoredDeck } from "../lib/power-surge";

// Card order must match the client's POWER_SURGE_CARDS array in src/types/power-surge.ts exactly.
const CLIENT_POWER_SURGE_CARD_IDS = [
    "dag-overclock",
    "block-fortress",
    "tx-storm",
    "mempool-congest",
    "blue-set-heal",
    "orphan-smasher",
    "10bps-barrage",
    "pruned-rage",
    "sompi-shield",
    "hash-hurricane",
    "ghost-dag",
    "finality-fist",
    "bps-blitz",
    "vaultbreaker",
    "chainbreaker",
] as const;

/**
 * Mirrors getDeterministicPowerSurgeCards() from veilstar-brawl-frontend/src/types/power-surge.ts.
 * Uses FNV-1a with seed "{matchId}:{roundNumber}" — must stay in sync with client.
 */
function getDeterministicSurgeCardIds(matchId: string, roundNumber: number, count = 3): string[] {
    const normalized = `${matchId}:${roundNumber}`;
    let hash = 2166136261;
    for (let i = 0; i < normalized.length; i++) {
        hash ^= normalized.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }

    const available: string[] = [...CLIENT_POWER_SURGE_CARD_IDS];
    const selected: string[] = [];
    const targetCount = Math.min(count, available.length);

    for (let pick = 0; pick < targetCount; pick++) {
        const seed = Math.abs(hash + pick * 1013904223);
        const idx = seed % available.length;
        selected.push(available[idx]);
        available.splice(idx, 1);
    }

    return selected;
}

type MoveType = "punch" | "kick" | "block" | "special" | "stunned";

export interface ReplayRoundData {
    roundNumber: number;
    player1Move: MoveType;
    player2Move: MoveType;
    player1DamageDealt: number;
    player2DamageDealt: number;
    player1HealthAfter: number;
    player2HealthAfter: number;
    winnerAddress: string | null;
    surgeCardIds?: string[];
    player1SurgeSelection?: string;
    player2SurgeSelection?: string;
}

export interface ReplayData {
    matchId: string;
    player1Address: string;
    player2Address: string;
    player1Character: string;
    player2Character: string;
    winnerAddress: string | null;
    player1RoundsWon: number;
    player2RoundsWon: number;
    rounds: ReplayRoundData[];
}

function isValidMove(move: unknown): move is MoveType {
    return typeof move === "string" && ["punch", "kick", "block", "special", "stunned"].includes(move);
}

export async function handleGetReplayData(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const matchId = url.searchParams.get("matchId");

    if (!matchId) {
        return Response.json({ error: "matchId is required" }, { status: 400 });
    }
    if (!/^[a-f0-9-]{16,}$/i.test(matchId)) {
        return Response.json({ error: "Invalid matchId" }, { status: 400 });
    }

    try {
        const supabase = getSupabase();

        const { data: match, error: matchError } = await supabase
            .from("matches")
            .select("id,status,player1_address,player2_address,player1_character_id,player2_character_id,winner_address,player1_rounds_won,player2_rounds_won,power_surge_deck")
            .eq("id", matchId)
            .single();

        if (matchError || !match) {
            return Response.json({ error: "Match not found" }, { status: 404 });
        }

        if (match.status !== "completed") {
            return Response.json({ error: "Match is not completed yet" }, { status: 400 });
        }

        const { data: rounds, error: roundsError } = await supabase
            .from("rounds")
            .select("*")
            .eq("match_id", matchId)
            .order("round_number", { ascending: true })
            .order("turn_number", { ascending: true });

        if (roundsError) {
            return Response.json({ error: "Failed to fetch rounds" }, { status: 500 });
        }

        const deck = normalizeStoredDeck(match.power_surge_deck);

        // Query the power_surges table — ZK-path stores selections here (not in power_surge_deck)
        const { data: powerSurgesRows } = await supabase
            .from("power_surges")
            .select("round_number, player1_card_id, player2_card_id")
            .eq("match_id", matchId);

        const powerSurgesByRound = new Map<number, { player1_card_id: string | null; player2_card_id: string | null }>();
        for (const ps of powerSurgesRows || []) {
            powerSurgesByRound.set(Number(ps.round_number), ps);
        }

        // Filter rounds with valid moves
        const filtered = (rounds || []).filter((r: any) => isValidMove(r.player1_move) && isValidMove(r.player2_move));

        // Track game rounds so we can attach deck data once per game round (like KaspaClash)
        let currentGameRound = 1;
        const outRounds: ReplayRoundData[] = [];

        for (let i = 0; i < filtered.length; i++) {
            const r: any = filtered[i];
            const isFirstTurnOfGameRound = i === 0 || Boolean(filtered[i - 1]?.winner_address);

            const deckRound = isFirstTurnOfGameRound ? deck.rounds[String(currentGameRound)] : undefined;
            // ZK path stores selections in power_surges table; legacy path uses power_surge_deck
            const powerSurgeRow = isFirstTurnOfGameRound ? powerSurgesByRound.get(r.round_number) : undefined;

            // Merge: ZK table wins over legacy deck for selections
            const rawP1Selection = powerSurgeRow?.player1_card_id || deckRound?.player1Selection || null;
            const rawP2Selection = powerSurgeRow?.player2_card_id || deckRound?.player2Selection || null;

            // Card pool to display: use dealt deck if available, otherwise re-derive deterministically
            let surgeCardIds: string[] | undefined = deckRound?.player1Cards;
            if (!surgeCardIds?.length && (rawP1Selection || rawP2Selection)) {
                // ZK mode: dealt cards were never persisted — regenerate using the same
                // client-side algorithm (FNV-1a, seed "{matchId}:{roundNumber}").
                surgeCardIds = getDeterministicSurgeCardIds(match.id, r.round_number);
            }

            // Fallback: if a player timed out (null selection), show first card in pool
            const p1Selection = rawP1Selection || surgeCardIds?.[0] || undefined;
            const p2Selection = rawP2Selection || surgeCardIds?.[0] || undefined;

            outRounds.push({
                roundNumber: r.round_number,
                player1Move: r.player1_move,
                player2Move: r.player2_move,
                player1DamageDealt: r.player1_damage_dealt ?? 0,
                player2DamageDealt: r.player2_damage_dealt ?? 0,
                player1HealthAfter: r.player1_health_after ?? 100,
                player2HealthAfter: r.player2_health_after ?? 100,
                winnerAddress: r.winner_address ?? null,
                surgeCardIds,
                player1SurgeSelection: p1Selection,
                player2SurgeSelection: p2Selection,
            });

            if (r.winner_address) {
                currentGameRound++;
            }
        }

        const replayData: ReplayData = {
            matchId: match.id,
            player1Address: match.player1_address,
            player2Address: match.player2_address || "",
            player1Character: match.player1_character_id || "soroban-sage",
            player2Character: match.player2_character_id || "soroban-sage",
            winnerAddress: match.winner_address,
            player1RoundsWon: match.player1_rounds_won || 0,
            player2RoundsWon: match.player2_rounds_won || 0,
            rounds: outRounds,
        };

        return Response.json(replayData);
    } catch (error) {
        console.error("[Replay Data] Error:", error);
        return Response.json({ error: "Internal server error" }, { status: 500 });
    }
}
