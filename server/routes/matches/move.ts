/**
 * Move Submission Route
 * POST /api/matches/:matchId/move
 */

import { getSupabase } from "../../lib/supabase";
import { resolveTurn } from "../../lib/combat-resolver";
import { broadcastGameEvent } from "../../lib/matchmaker";
import { isValidMove } from "../../lib/round-resolver";
import { GAME_CONSTANTS } from "../../lib/game-types";
import { submitMoveOnChain, isStellarConfigured } from "../../lib/stellar-contract";

interface SubmitMoveBody {
    address: string;
    move: string;
    signature?: string;
    signedMessage?: string;
}

export async function handleSubmitMove(
    matchId: string,
    req: Request
): Promise<Response> {
    try {
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

        // Get or create current round
        let { data: currentRound } = await supabase
            .from("rounds")
            .select("*")
            .eq("match_id", matchId)
            .order("round_number", { ascending: false })
            .order("turn_number", { ascending: false })
            .limit(1)
            .maybeSingle();

        // Create new round if needed
        if (!currentRound || (currentRound.player1_move && currentRound.player2_move)) {
            const nextRound = currentRound ? currentRound.round_number : 1;
            const nextTurn = currentRound?.player1_move && currentRound?.player2_move
                ? (currentRound.turn_number || 1) + 1
                : 1;

            // Check if this is a new round (knockout happened in previous)
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
                return Response.json(
                    { error: "Failed to create round" },
                    { status: 500 }
                );
            }

            currentRound = newRound;
        }

        // Check if player already submitted for this round
        const moveColumn = isPlayer1 ? "player1_move" : "player2_move";
        if (currentRound[moveColumn]) {
            return Response.json(
                { error: "You already submitted a move for this turn" },
                { status: 400 }
            );
        }

        // Submit the move
        const updateData: Record<string, unknown> = {
            [moveColumn]: body.move,
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
                move_type: body.move,
                signature: body.signature || null,
                signed_message: body.signedMessage || null,
            });

        // Fire-and-forget: record move on-chain (0.0001 XLM transfer per move)
        if (isStellarConfigured()) {
            const turn = (currentRound.round_number - 1) * 10 + (currentRound.turn_number || 1);
            submitMoveOnChain(matchId, body.address, body.move, turn).catch((err) => {
                console.error(`[Move] On-chain submit_move failed (non-blocking):`, err);
            });
        }

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
        });

        // Re-fetch to check if both submitted
        const { data: updatedRound } = await supabase
            .from("rounds")
            .select("*")
            .eq("id", currentRound.id)
            .single();

        let bothSubmitted = updatedRound?.player1_move && updatedRound?.player2_move;

        if (bothSubmitted) {
            // Resolve the turn
            const result = await resolveTurn(matchId, currentRound.id);

            return Response.json({
                success: true,
                awaitingOpponent: false,
                resolution: result,
            });
        }

        return Response.json({
            success: true,
            awaitingOpponent: true,
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
