/**
 * Replay Data
 * GET /api/replay-data?matchId=...
 *
 * Returns round-by-round data for ReplayScene playback and MP4 export.
 */

import { getSupabase } from "../lib/supabase";
import { normalizeStoredDeck } from "../lib/power-surge";

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

        // Filter rounds with valid moves
        const filtered = (rounds || []).filter((r: any) => isValidMove(r.player1_move) && isValidMove(r.player2_move));

        // Track game rounds so we can attach deck data once per game round (like KaspaClash)
        let currentGameRound = 1;
        const outRounds: ReplayRoundData[] = [];

        for (let i = 0; i < filtered.length; i++) {
            const r: any = filtered[i];
            const isFirstTurnOfGameRound = i === 0 || Boolean(filtered[i - 1]?.winner_address);

            const deckRound = isFirstTurnOfGameRound ? deck.rounds[String(currentGameRound)] : undefined;

            outRounds.push({
                roundNumber: r.round_number,
                player1Move: r.player1_move,
                player2Move: r.player2_move,
                player1DamageDealt: r.player1_damage_dealt ?? 0,
                player2DamageDealt: r.player2_damage_dealt ?? 0,
                player1HealthAfter: r.player1_health_after ?? 100,
                player2HealthAfter: r.player2_health_after ?? 100,
                winnerAddress: r.winner_address ?? null,
                surgeCardIds: deckRound?.player1Cards,
                player1SurgeSelection: deckRound?.player1Selection ?? undefined,
                player2SurgeSelection: deckRound?.player2Selection ?? undefined,
            });

            if (r.winner_address) {
                currentGameRound++;
            }
        }

        const replayData: ReplayData = {
            matchId: match.id,
            player1Address: match.player1_address,
            player2Address: match.player2_address || "",
            player1Character: match.player1_character_id || "dag-warrior",
            player2Character: match.player2_character_id || "dag-warrior",
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
