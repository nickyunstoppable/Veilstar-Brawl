/**
 * Move Timeout Route
 * POST /api/matches/:matchId/move-timeout
 */

import { getSupabase } from "../../lib/supabase";
import { handleMoveTimeout } from "../../lib/combat-resolver";

interface MoveTimeoutBody {
    address: string;
}

export async function handleMoveTimeoutRoute(matchId: string, req: Request): Promise<Response> {
    try {
        const body = await req.json() as MoveTimeoutBody;
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

        const isParticipant = address === match.player1_address || address === match.player2_address;
        if (!isParticipant) {
            return Response.json({ error: "You are not a participant in this match" }, { status: 403 });
        }

        if (match.status !== "in_progress") {
            return Response.json({
                success: true,
                data: { result: "no_action", reason: `match_not_in_progress:${match.status}` },
            });
        }

        // Active unresolved round/turn
        const { data: round } = await supabase
            .from("rounds")
            .select("id, round_number, turn_number, player1_move, player2_move, winner_address, move_deadline_at, player1_health_after, player2_health_after")
            .eq("match_id", matchId)
            .order("round_number", { ascending: false })
            .order("turn_number", { ascending: false })
            .limit(1)
            .maybeSingle();

        if (!round) {
            return Response.json({
                success: true,
                data: { result: "no_action", reason: "no_round_found" },
            });
        }

        // Already resolved turn guard
        const alreadyResolved = !!round.winner_address ||
            (round.player1_health_after !== null && round.player2_health_after !== null);

        if (alreadyResolved) {
            return Response.json({
                success: true,
                data: { result: "no_action", reason: "turn_already_resolved" },
            });
        }

        // Deadline guard
        const deadlineMs = round.move_deadline_at ? new Date(round.move_deadline_at).getTime() : 0;
        if (deadlineMs > 0 && Date.now() < deadlineMs) {
            return Response.json({
                success: true,
                data: { result: "no_action", reason: "deadline_not_reached", moveDeadlineAt: deadlineMs },
            });
        }

        const result = await handleMoveTimeout(matchId, round.id);
        if (!result.success) {
            return Response.json({ error: result.error || "Failed to resolve timeout" }, { status: 500 });
        }

        return Response.json({
            success: true,
            data: {
                result: result.isMatchOver ? "match_resolved" : "round_forfeited",
                roundWinner: result.roundWinner,
                isMatchOver: result.isMatchOver,
                matchWinner: result.matchWinner,
            },
        });
    } catch (err) {
        console.error("[MoveTimeout POST] Error:", err);
        return Response.json({ error: "Failed to process move timeout" }, { status: 500 });
    }
}
