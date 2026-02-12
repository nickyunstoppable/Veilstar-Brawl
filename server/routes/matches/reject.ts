/**
 * Transaction Rejection Route
 * POST /api/matches/:matchId/reject
 *
 * Mirrors KaspaClash semantics:
 * - first rejection => move_rejected broadcast + waiting response
 * - second rejection (other player) => match_cancelled broadcast
 */

import { getSupabase } from "../../lib/supabase";
import { broadcastGameEvent } from "../../lib/matchmaker";

interface RejectBody {
    address: string;
}

interface RejectionState {
    players: Set<"player1" | "player2">;
    updatedAt: number;
}

const rejectionStateByMatch = new Map<string, RejectionState>();
const STALE_REJECTION_MS = 60_000;

function cleanupStaleRejections(): void {
    const now = Date.now();
    for (const [matchId, state] of rejectionStateByMatch.entries()) {
        if (now - state.updatedAt > STALE_REJECTION_MS) {
            rejectionStateByMatch.delete(matchId);
        }
    }
}

export async function handleRejectMove(matchId: string, req: Request): Promise<Response> {
    try {
        cleanupStaleRejections();

        const body = await req.json() as RejectBody;
        const address = body.address?.trim();

        if (!address) {
            return Response.json({ error: "Missing 'address'" }, { status: 400 });
        }

        const supabase = getSupabase();
        const { data: match, error: matchError } = await supabase
            .from("matches")
            .select("id, status, player1_address, player2_address")
            .eq("id", matchId)
            .single();

        if (matchError || !match) {
            return Response.json({ error: "Match not found" }, { status: 404 });
        }

        if (match.status === "completed" || match.status === "cancelled") {
            return Response.json({ error: "Match is already over" }, { status: 400 });
        }

        const isPlayer1 = match.player1_address === address;
        const isPlayer2 = match.player2_address === address;
        if (!isPlayer1 && !isPlayer2) {
            return Response.json({ error: "You are not a participant in this match" }, { status: 403 });
        }

        const player = (isPlayer1 ? "player1" : "player2") as "player1" | "player2";
        const rejectedAt = Date.now();

        await broadcastGameEvent(matchId, "move_rejected", {
            matchId,
            player,
            rejectedAt,
        });

        const existing = rejectionStateByMatch.get(matchId) ?? {
            players: new Set<"player1" | "player2">(),
            updatedAt: rejectedAt,
        };

        existing.players.add(player);
        existing.updatedAt = rejectedAt;
        rejectionStateByMatch.set(matchId, existing);

        if (existing.players.size >= 2) {
            await supabase
                .from("matches")
                .update({
                    status: "cancelled",
                    completed_at: new Date().toISOString(),
                    fight_phase: "match_end",
                })
                .eq("id", matchId)
                .in("status", ["character_select", "in_progress"]);

            const payload = {
                matchId,
                reason: "both_rejected",
                message: "Both players rejected transactions.",
                redirectTo: "/play",
            };

            await broadcastGameEvent(matchId, "match_cancelled", payload);
            rejectionStateByMatch.delete(matchId);

            return Response.json({
                success: true,
                status: "match_cancelled",
                ...payload,
            });
        }

        return Response.json({
            success: true,
            status: "waiting",
            message: "Waiting for opponent decision",
            rejectedAt,
        });
    } catch (err) {
        console.error("[Reject POST] Error:", err);
        return Response.json({ error: "Failed to record rejection" }, { status: 500 });
    }
}
