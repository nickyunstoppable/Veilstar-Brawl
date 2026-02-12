/**
 * Disconnect Timeout Route
 * POST /api/matches/:matchId/timeout
 * Claim victory if opponent stayed disconnected past timeout window.
 */

import { getSupabase } from "../../lib/supabase";
import { broadcastGameEvent } from "../../lib/matchmaker";
import { triggerAutoProveFinalize } from "../../lib/zk-finalizer-client";

interface TimeoutBody {
    address: string;
}

export async function handleTimeoutVictory(matchId: string, req: Request): Promise<Response> {
    try {
        const body = await req.json() as TimeoutBody;
        const address = body.address?.trim();

        if (!address) {
            return Response.json({ error: "Missing 'address'" }, { status: 400 });
        }

        const supabase = getSupabase();
        const { data: match, error: matchError } = await supabase
            .from("matches")
            .select("id, status, format, player1_address, player2_address, player1_disconnected_at, player2_disconnected_at")
            .eq("id", matchId)
            .single();

        if (matchError || !match) {
            return Response.json({ error: "Match not found" }, { status: 404 });
        }

        const isPlayer1 = match.player1_address === address;
        const isPlayer2 = match.player2_address === address;
        if (!isPlayer1 && !isPlayer2) {
            return Response.json({ error: "You are not a participant in this match" }, { status: 403 });
        }

        if (match.status === "completed") {
            return Response.json({ success: true, data: { result: "no_action", reason: "match_already_completed" } });
        }

        if (match.status === "cancelled") {
            return Response.json({ success: true, data: { result: "cancelled" } });
        }

        const timeoutSeconds = 30;
        const myDisconnectedAt = isPlayer1 ? match.player1_disconnected_at : match.player2_disconnected_at;
        const opponentDisconnectedAt = isPlayer1 ? match.player2_disconnected_at : match.player1_disconnected_at;

        if (!opponentDisconnectedAt) {
            return Response.json({
                success: true,
                data: { result: "no_action", reason: "opponent_connected" },
            });
        }

        const opponentDisconnectedMs = new Date(opponentDisconnectedAt).getTime();
        const expiresAt = opponentDisconnectedMs + timeoutSeconds * 1000;
        if (Date.now() < expiresAt) {
            return Response.json({
                success: true,
                data: {
                    result: "no_action",
                    reason: "timeout_not_reached",
                    remainingSeconds: Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)),
                },
            });
        }

        // If both are disconnected, cancel instead of assigning win.
        if (myDisconnectedAt) {
            await supabase
                .from("matches")
                .update({
                    status: "cancelled",
                    completed_at: new Date().toISOString(),
                    fight_phase: "match_end",
                })
                .eq("id", matchId)
                .in("status", ["in_progress", "character_select"]);

            const payload = {
                matchId,
                reason: "both_disconnected",
                message: "Both players disconnected.",
                redirectTo: "/play",
            };

            await broadcastGameEvent(matchId, "match_cancelled", payload);

            return Response.json({
                success: true,
                data: {
                    result: "cancelled",
                    ...payload,
                },
            });
        }

        const winner = isPlayer1 ? "player1" : "player2";
        const winnerAddress = address;
        const roundsToWin = match.format === "best_of_5" ? 3 : 2;
        const player1RoundsWon = winner === "player1" ? roundsToWin : 0;
        const player2RoundsWon = winner === "player2" ? roundsToWin : 0;

        await supabase
            .from("matches")
            .update({
                status: "completed",
                winner_address: winnerAddress,
                player1_rounds_won: player1RoundsWon,
                player2_rounds_won: player2RoundsWon,
                completed_at: new Date().toISOString(),
                fight_phase: "match_end",
                player1_disconnected_at: null,
                player2_disconnected_at: null,
            })
            .eq("id", matchId)
            .in("status", ["in_progress", "character_select"]);

        const matchEndedPayload = {
            matchId,
            winner,
            winnerAddress,
            reason: "opponent_disconnected",
            player1RoundsWon,
            player2RoundsWon,
        };

        triggerAutoProveFinalize(matchId, winnerAddress, "timeout");

        await broadcastGameEvent(matchId, "match_ended", matchEndedPayload);

        return Response.json({
            success: true,
            data: {
                result: "win",
                winnerAddress,
                matchEndedPayload,
            },
        });
    } catch (err) {
        console.error("[Timeout POST] Error:", err);
        return Response.json({ error: "Failed to claim timeout victory" }, { status: 500 });
    }
}
