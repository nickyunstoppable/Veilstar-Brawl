/**
 * Disconnect/Reconnect Route
 * POST /api/matches/:matchId/disconnect
 */

import { getSupabase } from "../../lib/supabase";
import { broadcastGameEvent } from "../../lib/matchmaker";

interface DisconnectBody {
    address: string;
    action: "disconnect" | "reconnect";
}

export async function handleDisconnect(matchId: string, req: Request): Promise<Response> {
    try {
        const body = await req.json() as DisconnectBody;
        const address = body.address?.trim();
        const action = body.action;

        if (!address || (action !== "disconnect" && action !== "reconnect")) {
            return Response.json({ error: "Missing/invalid 'address' or 'action'" }, { status: 400 });
        }

        console.log(`[Disconnect] Request match=${matchId} action=${action} by=${address.slice(0, 6)}…${address.slice(-4)}`);

        const supabase = getSupabase();
        const { data: match, error: matchError } = await supabase
            .from("matches")
            .select("id, status, player1_address, player2_address, disconnect_timeout_seconds")
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

        const player = (isPlayer1 ? "player1" : "player2") as "player1" | "player2";
        const timeoutSeconds = match.disconnect_timeout_seconds || 30;
        const nowIso = new Date().toISOString();

        if (action === "disconnect") {
            const updateField = isPlayer1 ? "player1_disconnected_at" : "player2_disconnected_at";

            await supabase
                .from("matches")
                .update({ [updateField]: nowIso })
                .eq("id", matchId)
                .in("status", ["in_progress", "character_select"]);

            await broadcastGameEvent(matchId, "player_disconnected", {
                player,
                address,
                disconnectedAt: Date.now(),
                timeoutSeconds,
            });

            console.log(`[Disconnect] Marked disconnected match=${matchId} player=${player} timeout=${timeoutSeconds}s`);

            return Response.json({ success: true, action: "disconnect" });
        }

        // reconnect
        const updateField = isPlayer1 ? "player1_disconnected_at" : "player2_disconnected_at";

        await supabase
            .from("matches")
            .update({ [updateField]: null })
            .eq("id", matchId)
            .in("status", ["in_progress", "character_select"]);

        await broadcastGameEvent(matchId, "player_reconnected", {
            player,
            address,
            reconnectedAt: Date.now(),
        });

        console.log(`[Disconnect] Marked reconnected match=${matchId} player=${player}`);

        const { data: snapshot } = await supabase
            .from("fight_state_snapshots")
            .select("*")
            .eq("match_id", matchId)
            .maybeSingle();

        const gameState = snapshot
            ? {
                status: match.status,
                currentRound: snapshot.current_round ?? 1,
                player1Health: snapshot.player1_health ?? 100,
                player2Health: snapshot.player2_health ?? 100,
                player1RoundsWon: snapshot.player1_rounds_won ?? 0,
                player2RoundsWon: snapshot.player2_rounds_won ?? 0,
                player1Energy: snapshot.player1_energy ?? 100,
                player2Energy: snapshot.player2_energy ?? 100,
                moveDeadlineAt: snapshot.move_deadline_at ? new Date(snapshot.move_deadline_at).getTime() : null,
                pendingMoves: {
                    player1: !!snapshot.player1_has_submitted_move,
                    player2: !!snapshot.player2_has_submitted_move,
                },
            }
            : null;

        return Response.json({
            success: true,
            action: "reconnect",
            data: {
                gameState,
            },
        });
    } catch (err) {
        console.error("[Disconnect POST] Error:", err);
        return Response.json({ error: "Failed to process disconnect action" }, { status: 500 });
    }
}
