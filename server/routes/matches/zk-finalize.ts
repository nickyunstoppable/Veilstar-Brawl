/**
 * ZK Finalize Route
 * POST /api/matches/:matchId/zk/finalize
 *
 * Intended for Option B flow:
 * - Gameplay/actions run off-chain
 * - A final ZK proof is produced off-chain
 * - Server verifies basic payload shape and finalizes on-chain result once
 */

import { getSupabase } from "../../lib/supabase";
import { broadcastGameEvent } from "../../lib/matchmaker";
import { isStellarConfigured, matchIdToSessionId, reportMatchResultOnChain } from "../../lib/stellar-contract";
import { verifyNoirProof } from "../../lib/zk-proof";

interface FinalizeBody {
    winnerAddress?: string;
    proof?: string;
    publicInputs?: unknown;
    transcriptHash?: string;
    broadcast?: boolean;
}

export async function handleFinalizeWithZkProof(matchId: string, req: Request): Promise<Response> {
    try {
        console.log(`[ZK Finalize] Request received for match ${matchId}`);
        const body = await req.json() as FinalizeBody;
        const winnerAddress = body.winnerAddress?.trim();
        const proof = body.proof?.trim();

        if (!winnerAddress || !proof) {
            return Response.json(
                { error: "Missing 'winnerAddress' or 'proof'" },
                { status: 400 },
            );
        }

        const verification = await verifyNoirProof({
            proof,
            publicInputs: body.publicInputs,
            transcriptHash: body.transcriptHash,
            matchId,
            winnerAddress,
        });

        if (!verification.ok) {
            return Response.json(
                { error: "ZK proof verification failed" },
                { status: 400 },
            );
        }

        console.log(`[ZK Finalize] Proof verified for match ${matchId} via ${verification.backend}`);

        const supabase = getSupabase();
        const { data: match, error } = await supabase
            .from("matches")
            .select("id, status, player1_address, player2_address, player1_rounds_won, player2_rounds_won")
            .eq("id", matchId)
            .single();

        if (error || !match) {
            return Response.json({ error: "Match not found" }, { status: 404 });
        }

        const isWinnerPlayer1 = winnerAddress === match.player1_address;
        const isWinnerPlayer2 = winnerAddress === match.player2_address;

        if (!isWinnerPlayer1 && !isWinnerPlayer2) {
            return Response.json(
                { error: "winnerAddress must be one of the match participants" },
                { status: 400 },
            );
        }

        if (match.status !== "completed") {
            await supabase
                .from("matches")
                .update({
                    status: "completed",
                    winner_address: winnerAddress,
                    completed_at: new Date().toISOString(),
                    fight_phase: "match_end",
                })
                .eq("id", matchId)
                .in("status", ["in_progress", "character_select"]);
        }

        let onChainTxHash: string | null = null;
        if (isStellarConfigured()) {
            console.log(`[ZK Finalize] Reporting on-chain result for match ${matchId}`);
            const onChainResult = await reportMatchResultOnChain(
                matchId,
                match.player1_address,
                match.player2_address,
                winnerAddress,
            );

            if (!onChainResult.success) {
                return Response.json(
                    {
                        error: "On-chain result transaction failed",
                        details: onChainResult.error || null,
                    },
                    { status: 502 },
                );
            }

            onChainTxHash = onChainResult.txHash || null;

            console.log(`[ZK Finalize] On-chain finalize complete for match ${matchId}, tx=${onChainTxHash || "n/a"}`);

            if (onChainTxHash) {
                await supabase
                    .from("matches")
                    .update({ onchain_result_tx_hash: onChainTxHash })
                    .eq("id", matchId);
            }
        }

        if (body.broadcast !== false) {
            await broadcastGameEvent(matchId, "match_ended", {
                matchId,
                winner: isWinnerPlayer1 ? "player1" : "player2",
                winnerAddress,
                reason: "zk_proof",
                player1RoundsWon: match.player1_rounds_won,
                player2RoundsWon: match.player2_rounds_won,
                onChainSessionId: matchIdToSessionId(matchId),
                onChainTxHash,
                zkProofSubmitted: true,
                transcriptHash: body.transcriptHash || null,
                proofPublicInputs: body.publicInputs || null,
            });
        }

        return Response.json({
            success: true,
            onChainTxHash,
            onChainSessionId: matchIdToSessionId(matchId),
            zkProofAccepted: true,
            zkVerification: {
                backend: verification.backend,
                command: verification.command,
            },
        });
    } catch (err) {
        console.error("[ZK Finalize] Error:", err);
        return Response.json(
            { error: err instanceof Error ? err.message : "Failed to finalize with ZK proof" },
            { status: 500 },
        );
    }
}
