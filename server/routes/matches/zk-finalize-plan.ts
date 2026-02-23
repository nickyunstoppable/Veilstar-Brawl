import { createHash } from "node:crypto";
import { getSupabase } from "../../lib/supabase";

type MoveType = "punch" | "kick" | "block" | "special" | "stunned";

interface FinalizePlanResponse {
    success: boolean;
    matchId: string;
    winnerAddress: string;
    roundNumber: number;
    turnNumber: number;
    movePlan: MoveType[];
    surgeCardId: null;
    transcriptHash: string;
}

function isMoveType(value: unknown): value is MoveType {
    return value === "punch" || value === "kick" || value === "block" || value === "special" || value === "stunned";
}

function stableStringify(value: unknown): string {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value);
    }

    if (Array.isArray(value)) {
        return `[${value.map((item) => stableStringify(item)).join(",")}]`;
    }

    const entries = Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`).join(",")}}`;
}

function normalizeMovePlan(moves: MoveType[]): MoveType[] {
    const out = moves.slice(0, 10);
    while (out.length < 10) out.push("block");
    return out;
}

export async function handleGetFinalizePlan(matchId: string, req: Request): Promise<Response> {
    try {
        const supabase = getSupabase();
        const url = new URL(req.url);

        const { data: match, error: matchError } = await supabase
            .from("matches")
            .select("id, status, winner_address, player1_address, player2_address")
            .eq("id", matchId)
            .single();

        if (matchError || !match) {
            return Response.json({ error: "Match not found" }, { status: 404 });
        }

        const winnerAddress = (url.searchParams.get("winnerAddress") || match.winner_address || "").trim();
        if (!winnerAddress) {
            return Response.json({ error: "winnerAddress is required (or match must already have winner_address)" }, { status: 400 });
        }

        if (winnerAddress !== match.player1_address && winnerAddress !== match.player2_address) {
            return Response.json({ error: "winnerAddress must be one of the match participants" }, { status: 400 });
        }

        const { data: rounds } = await supabase
            .from("rounds")
            .select("id, round_number, turn_number, player1_move, player2_move")
            .eq("match_id", matchId)
            .order("round_number", { ascending: true })
            .order("turn_number", { ascending: true });

        const winnerIsPlayer1 = winnerAddress === match.player1_address;
        const winnerMoves = (rounds || [])
            .map((round) => winnerIsPlayer1 ? round.player1_move : round.player2_move)
            .filter(isMoveType);

        const movePlan = normalizeMovePlan(winnerMoves);
        const roundNumber = Math.max(1, ...(rounds || []).map((round) => Number(round.round_number || 1)));

        const roundIds = (rounds || []).map((round) => round.id);
        const { data: moves } = roundIds.length > 0
            ? await supabase
                .from("moves")
                .select("*")
                .in("round_id", roundIds)
            : { data: [] as any[] };

        const { data: surges } = await supabase
            .from("power_surges")
            .select("*")
            .eq("match_id", matchId)
            .order("round_number", { ascending: true });

        const transcript = {
            match,
            rounds: rounds || [],
            moves: moves || [],
            powerSurges: surges || [],
        };
        const transcriptHash = createHash("sha256").update(stableStringify(transcript)).digest("hex");

        const response: FinalizePlanResponse = {
            success: true,
            matchId,
            winnerAddress,
            roundNumber,
            turnNumber: 1,
            movePlan,
            surgeCardId: null,
            transcriptHash,
        };

        return Response.json(response);
    } catch (error) {
        console.error("[ZK Finalize Plan] Error:", error);
        return Response.json(
            { error: error instanceof Error ? error.message : "Failed to build finalize plan" },
            { status: 500 },
        );
    }
}
