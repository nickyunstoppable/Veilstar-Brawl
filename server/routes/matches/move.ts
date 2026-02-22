/**
 * Move Submission Route
 * POST /api/matches/:matchId/move
 */

import { getSupabase } from "../../lib/supabase";
import { resolveTurn } from "../../lib/combat-resolver";
import { broadcastGameEvent } from "../../lib/matchmaker";
import { isValidMove } from "../../lib/round-resolver";
import { GAME_CONSTANTS } from "../../lib/game-types";

const PRIVATE_ROUNDS_ENABLED = true;

interface SubmitMoveBody {
    address: string;
    move: string;
    signature?: string;
    signedMessage?: string;
}

async function getOrCreateCurrentRound(matchId: string) {
    const supabase = getSupabase();

    let { data: currentRound } = await supabase
        .from("rounds")
        .select("*")
        .eq("match_id", matchId)
        .order("round_number", { ascending: false })
        .order("turn_number", { ascending: false })
        .limit(1)
        .maybeSingle();

    if (!currentRound || (currentRound.player1_move && currentRound.player2_move)) {
        const nextRound = currentRound ? currentRound.round_number : 1;
        const nextTurn = currentRound?.player1_move && currentRound?.player2_move
            ? (currentRound.turn_number || 1) + 1
            : 1;

        const isNewRound = currentRound?.winner_address != null;
        const roundNumber = isNewRound ? nextRound + 1 : nextRound;

        const moveDeadline = new Date(
            Date.now() + GAME_CONSTANTS.MOVE_TIMER_SECONDS * 1000
        ).toISOString();

        const { data: newRound, error: createError } = await supabase
            .from("rounds")
            .insert({
                match_id: matchId,
                round_number: roundNumber,
                turn_number: isNewRound ? 1 : nextTurn,
                move_deadline_at: moveDeadline,
                countdown_seconds: GAME_CONSTANTS.COUNTDOWN_SECONDS,
            })
            .select("*")
            .single();

        if (createError || !newRound) {
            throw new Error("Failed to create round");
        }

        currentRound = newRound;
    }

    return currentRound;
}

export async function handleSubmitMove(
    matchId: string,
    req: Request
): Promise<Response> {
    try {
        if (PRIVATE_ROUNDS_ENABLED) {
            return Response.json(
                { error: "Legacy move submission is disabled when ZK_PRIVATE_ROUNDS=true. Use /api/matches/:matchId/zk/round/resolve." },
                { status: 409 },
            );
        }

        const body = await req.json() as SubmitMoveBody;

        if (!body.address || !body.move) {
            return Response.json(
                { error: "Missing 'address' or 'move' in request body" },
                { status: 400 }
            );
        }

        if (!isValidMove(body.move)) {
            return Response.json(
                { error: `Invalid move: ${body.move}. Must be punch, kick, block, or special` },
                { status: 400 }
            );
        }

        console.log(
            `[Move POST] Request match=${matchId} player=${body.address.slice(0, 6)}…${body.address.slice(-4)} move=${body.move}`,
        );

        const supabase = getSupabase();

        // Fetch the match
        const { data: match, error: matchError } = await supabase
            .from("matches")
            .select("*")
            .eq("id", matchId)
            .single();

        if (matchError || !match) {
            return Response.json({ error: "Match not found" }, { status: 404 });
        }

        // Verify player is in the match
        const isPlayer1 = match.player1_address === body.address;
        const isPlayer2 = match.player2_address === body.address;

        if (!isPlayer1 && !isPlayer2) {
            return Response.json(
                { error: "You are not a participant in this match" },
                { status: 403 }
            );
        }

        // Match must be in progress
        if (match.status !== "in_progress") {
            return Response.json(
                { error: `Match is not in progress (status: ${match.status})` },
                { status: 400 }
            );
        }

        const currentRound = await getOrCreateCurrentRound(matchId);

        const { data: stunSnapshot } = await supabase
            .from("fight_state_snapshots")
            .select("player1_is_stunned, player2_is_stunned")
            .eq("match_id", matchId)
            .maybeSingle();

        // Check if player already submitted for this round
        const moveColumn = isPlayer1 ? "player1_move" : "player2_move";
        if (currentRound[moveColumn]) {
            return Response.json(
                { error: "You already submitted a move for this turn" },
                { status: 400 }
            );
        }

        let onChainTxHash: string | null = null;

        // Submit the move (server-authoritative stun forces "stunned")
        const submitterIsStunned = isPlayer1
            ? Boolean(stunSnapshot?.player1_is_stunned)
            : Boolean(stunSnapshot?.player2_is_stunned);
        const resolvedMove = submitterIsStunned ? "stunned" : body.move;

        const updateData: Record<string, unknown> = {
            [moveColumn]: resolvedMove,
        };

        const { error: updateError } = await supabase
            .from("rounds")
            .update(updateData)
            .eq("id", currentRound.id);

        if (updateError) {
            return Response.json(
                { error: "Failed to submit move" },
                { status: 500 }
            );
        }

        // Record move with signature
        await supabase
            .from("moves")
            .insert({
                round_id: currentRound.id,
                player_address: body.address,
                move_type: resolvedMove,
                signature: body.signature || null,
                signed_message: body.signedMessage || null,
            });

        // Update fight state snapshot
        const submitColumn = isPlayer1
            ? "player1_has_submitted_move"
            : "player2_has_submitted_move";
        await supabase
            .from("fight_state_snapshots")
            .update({ [submitColumn]: true })
            .eq("match_id", matchId);

        // Broadcast move submitted
        const playerRole = isPlayer1 ? "player1" : "player2";
        await broadcastGameEvent(matchId, "move_submitted", {
            player: playerRole,
            address: body.address,
            onChainTxHash,
        });

        console.log(
            `[Move POST] Move stored match=${matchId} role=${playerRole} resolvedMove=${resolvedMove} onChainTx=${onChainTxHash || "offchain"}`,
        );

        // Re-fetch to check if both submitted and auto-assign stunned opponent if needed
        let { data: updatedRound } = await supabase
            .from("rounds")
            .select("*")
            .eq("id", currentRound.id)
            .single();

        if (updatedRound) {
            const autoAssignUpdate: Record<string, unknown> = {};
            const autoSnapshotUpdate: Record<string, unknown> = {};

            if (!updatedRound.player1_move && stunSnapshot?.player1_is_stunned) {
                autoAssignUpdate.player1_move = "stunned";
                autoSnapshotUpdate.player1_has_submitted_move = true;
            }

            if (!updatedRound.player2_move && stunSnapshot?.player2_is_stunned) {
                autoAssignUpdate.player2_move = "stunned";
                autoSnapshotUpdate.player2_has_submitted_move = true;
            }

            if (Object.keys(autoAssignUpdate).length > 0) {
                await supabase
                    .from("rounds")
                    .update(autoAssignUpdate)
                    .eq("id", currentRound.id);

                if (Object.keys(autoSnapshotUpdate).length > 0) {
                    await supabase
                        .from("fight_state_snapshots")
                        .update(autoSnapshotUpdate)
                        .eq("match_id", matchId);
                }

                const refreshed = await supabase
                    .from("rounds")
                    .select("*")
                    .eq("id", currentRound.id)
                    .single();

                updatedRound = refreshed.data;
            }
        }

        let bothSubmitted = updatedRound?.player1_move && updatedRound?.player2_move;

        if (bothSubmitted) {
            console.log(`[Move POST] Both moves submitted; resolving turn match=${matchId} roundId=${currentRound.id}`);
            // Resolve the turn
            const result = await resolveTurn(matchId, currentRound.id);

            console.log(
                `[Move POST] Turn resolved match=${matchId} turn=${result.turnNumber} round=${result.roundNumber} matchOver=${result.isMatchOver}`,
            );

            return Response.json({
                success: true,
                awaitingOpponent: false,
                onChainTxHash,
                resolution: result,
            });
        }

        console.log(`[Move POST] Waiting for opponent move match=${matchId} roundId=${currentRound.id}`);

        return Response.json({
            success: true,
            awaitingOpponent: true,
            onChainTxHash,
            message: "Move submitted, waiting for opponent",
        });
    } catch (err) {
        console.error("[Move POST] Error:", err);
        return Response.json(
            { error: err instanceof Error ? err.message : "Failed to submit move" },
            { status: 500 }
        );
    }
}
