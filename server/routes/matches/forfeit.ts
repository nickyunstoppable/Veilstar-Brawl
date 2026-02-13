/**
 * Forfeit Route
 * POST /api/matches/:matchId/forfeit
 */

import { getSupabase } from "../../lib/supabase";
import { broadcastGameEvent } from "../../lib/matchmaker";
import { calculateEloChange } from "../../lib/game-types";
import { reportMatchResultOnChain, isStellarConfigured, matchIdToSessionId } from "../../lib/stellar-contract";
import { shouldAutoProveFinalize, triggerAutoProveFinalize, getAutoProveFinalizeStatus } from "../../lib/zk-finalizer-client";

interface ForfeitBody {
    address: string;
}

export async function handleForfeit(
    matchId: string,
    req: Request
): Promise<Response> {
    try {
        const body = await req.json() as ForfeitBody;

        if (!body.address) {
            return Response.json(
                { error: "Missing 'address' in request body" },
                { status: 400 }
            );
        }

        const supabase = getSupabase();

        const { data: match, error } = await supabase
            .from("matches")
            .select("*")
            .eq("id", matchId)
            .single();

        if (error || !match) {
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

        if (match.status === "completed" || match.status === "cancelled") {
            return Response.json(
                { error: "Match is already over" },
                { status: 400 }
            );
        }

        // Winner is the opponent
        const winnerAddress = isPlayer1
            ? match.player2_address
            : match.player1_address;

        // If no opponent yet (waiting state), just cancel
        if (!winnerAddress) {
            await supabase
                .from("matches")
                .update({
                    status: "cancelled",
                    completed_at: new Date().toISOString(),
                })
                .eq("id", matchId);

            return Response.json({ success: true, cancelled: true });
        }

        // Complete the match with opponent as winner
        const winnerRoundsWon = match.format === "best_of_5" ? 3 : 2;
        await supabase
            .from("matches")
            .update({
                status: "completed",
                winner_address: winnerAddress,
                completed_at: new Date().toISOString(),
                fight_phase: "match_end",
                [isPlayer1 ? "player2_rounds_won" : "player1_rounds_won"]: winnerRoundsWon,
            })
            .eq("id", matchId);

        // Update Elo
        let ratingChanges: {
            winner: { before: number; after: number; change: number };
            loser: { before: number; after: number; change: number };
        } | undefined;

        const { data: forfeitingPlayer } = await supabase
            .from("players")
            .select("rating, losses")
            .eq("address", body.address)
            .single();

        const { data: winningPlayer } = await supabase
            .from("players")
            .select("rating, wins")
            .eq("address", winnerAddress)
            .single();

        if (forfeitingPlayer && winningPlayer) {
            const { winnerChange, loserChange } = calculateEloChange(
                winningPlayer.rating,
                forfeitingPlayer.rating
            );

            const winnerAfter = Math.max(100, winningPlayer.rating + winnerChange);
            const loserAfter = Math.max(100, forfeitingPlayer.rating + loserChange);

            await supabase
                .from("players")
                .update({
                    rating: winnerAfter,
                    wins: winningPlayer.wins + 1,
                })
                .eq("address", winnerAddress);

            await supabase
                .from("players")
                .update({
                    rating: loserAfter,
                    losses: forfeitingPlayer.losses + 1,
                })
                .eq("address", body.address);

            ratingChanges = {
                winner: { before: winningPlayer.rating, after: winnerAfter, change: winnerChange },
                loser: { before: forfeitingPlayer.rating, after: loserAfter, change: loserChange },
            };
        }

        // Report result on-chain
        let onChainTxHash: string | undefined;
        let onChainSkippedReason: string | undefined;
        const autoFinalize = getAutoProveFinalizeStatus();
        const stellarReady = isStellarConfigured();

        if (!autoFinalize.enabled && stellarReady) {
            try {
                const onChainResult = await reportMatchResultOnChain(
                    matchId,
                    match.player1_address,
                    match.player2_address,
                    winnerAddress,
                );
                onChainTxHash = onChainResult.txHash;
                if (onChainResult.txHash) {
                    await supabase.from('matches').update({
                        onchain_result_tx_hash: onChainResult.txHash,
                    }).eq('id', matchId);
                }
            } catch (err) {
                console.error('[Forfeit] On-chain report error:', err);
            }
        }

        if (autoFinalize.enabled) {
            triggerAutoProveFinalize(matchId, winnerAddress, "forfeit");
        } else if (!stellarReady) {
            onChainSkippedReason = `${autoFinalize.reason}; Stellar not configured`;
            console.warn(`[Forfeit] On-chain finalize skipped for ${matchId}: ${onChainSkippedReason}`);
        }

        // Broadcast
        const p1RoundsWon = isPlayer1 ? (match.player1_rounds_won || 0) : winnerRoundsWon;
        const p2RoundsWon = isPlayer1 ? winnerRoundsWon : (match.player2_rounds_won || 0);

        await broadcastGameEvent(matchId, "match_ended", {
            matchId,
            winner: isPlayer1 ? "player2" : "player1",
            winnerAddress,
            reason: "forfeit",
            forfeitedBy: body.address,
            finalScore: {
                player1RoundsWon: p1RoundsWon,
                player2RoundsWon: p2RoundsWon,
            },
            player1RoundsWon: p1RoundsWon,
            player2RoundsWon: p2RoundsWon,
            ratingChanges,
            onChainSessionId: matchIdToSessionId(matchId),
            onChainTxHash,
            onChainSkippedReason,
            contractId: process.env.VITE_VEILSTAR_BRAWL_CONTRACT_ID || '',
        });

        return Response.json({ success: true, forfeited: true });
    } catch (err) {
        console.error("[Forfeit POST] Error:", err);
        return Response.json(
            { error: "Failed to forfeit" },
            { status: 500 }
        );
    }
}
