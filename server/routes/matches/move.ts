/**
 * Move Submission Route
 * POST /api/matches/:matchId/move
 */

import { getSupabase } from "../../lib/supabase";
import { resolveTurn } from "../../lib/combat-resolver";
import { broadcastGameEvent } from "../../lib/matchmaker";
import { isValidMove } from "../../lib/round-resolver";
import { GAME_CONSTANTS } from "../../lib/game-types";
import {
    isClientSignedActionConfigured,
    prepareMoveOnChain,
    submitSignedMoveOnChain,
} from "../../lib/stellar-contract";

const USE_OFFCHAIN_ACTIONS = (process.env.ZK_OFFCHAIN_ACTIONS ?? "true") !== "false";

interface SubmitMoveBody {
    address: string;
    move: string;
    signature?: string;
    signedMessage?: string;
    signedAuthEntryXdr?: string;
    transactionXdr?: string;
}

interface PrepareMoveBody {
    address: string;
    move: string;
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

export async function handlePrepareMoveOnChain(
    matchId: string,
    req: Request,
): Promise<Response> {
    try {
        if (USE_OFFCHAIN_ACTIONS) {
            return Response.json(
                { error: "Off-chain action mode enabled; move prepare is disabled" },
                { status: 409 },
            );
        }

        if (!isClientSignedActionConfigured()) {
            return Response.json(
                { error: "On-chain move signing is not configured" },
                { status: 503 },
            );
        }

        const body = await req.json() as PrepareMoveBody;
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
        const { data: match, error: matchError } = await supabase
            .from("matches")
            .select("*")
            .eq("id", matchId)
            .single();

        if (matchError || !match) {
            return Response.json({ error: "Match not found" }, { status: 404 });
        }

        const isPlayer1 = match.player1_address === body.address;
        const isPlayer2 = match.player2_address === body.address;
        if (!isPlayer1 && !isPlayer2) {
            return Response.json(
                { error: "You are not a participant in this match" },
                { status: 403 }
            );
        }

        if (match.status !== "in_progress") {
            return Response.json(
                { error: `Match is not in progress (status: ${match.status})` },
                { status: 400 }
            );
        }

        const currentRound = await getOrCreateCurrentRound(matchId);
        const moveColumn = isPlayer1 ? "player1_move" : "player2_move";
        if (currentRound[moveColumn]) {
            return Response.json(
                { error: "You already submitted a move for this turn" },
                { status: 400 }
            );
        }

        const turn = (currentRound.round_number - 1) * 10 + (currentRound.turn_number || 1);
        const prepared = await prepareMoveOnChain(matchId, body.address, body.move, turn);

        return Response.json({
            success: true,
            sessionId: prepared.sessionId,
            transactionXdr: prepared.transactionXdr,
            authEntryXdr: prepared.authEntryXdr,
            roundNumber: currentRound.round_number,
            turnNumber: currentRound.turn_number || 1,
            turn,
        });
    } catch (err) {
        console.error("[Move Prepare] Error:", err);
        return Response.json(
            { error: err instanceof Error ? err.message : "Failed to prepare move" },
            { status: 500 }
        );
    }
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

        const currentRound = await getOrCreateCurrentRound(matchId);

        // Check if player already submitted for this round
        const moveColumn = isPlayer1 ? "player1_move" : "player2_move";
        if (currentRound[moveColumn]) {
            return Response.json(
                { error: "You already submitted a move for this turn" },
                { status: 400 }
            );
        }

        let onChainTxHash: string | null = null;

        if (!USE_OFFCHAIN_ACTIONS) {
            if (!isClientSignedActionConfigured()) {
                return Response.json(
                    { error: "On-chain move signing is required for move submission" },
                    { status: 503 }
                );
            }

            if (!body.signedAuthEntryXdr || !body.transactionXdr) {
                return Response.json(
                    { error: "Missing signedAuthEntryXdr or transactionXdr. Call /move/prepare first." },
                    { status: 428 }
                );
            }

            const onChainResult = await submitSignedMoveOnChain(
                matchId,
                body.address,
                body.signedAuthEntryXdr,
                body.transactionXdr,
            );
            if (!onChainResult.success) {
                return Response.json(
                    {
                        error: "On-chain move transaction failed",
                        details: onChainResult.error || null,
                    },
                    { status: 502 }
                );
            }

            onChainTxHash = onChainResult.txHash || null;
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
                onChainTxHash,
                resolution: result,
            });
        }

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
