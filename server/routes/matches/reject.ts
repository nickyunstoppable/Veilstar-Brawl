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
import { cancelMatchOnChainWithOptions, isStellarConfigured, matchIdToSessionId } from "../../lib/stellar-contract";

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

        console.log(`[Reject] Request match=${matchId} by=${address.slice(0, 6)}…${address.slice(-4)}`);

        const supabase = getSupabase();
        const { data: match, error: matchError } = await supabase
            .from("matches")
            .select("id, status, player1_address, player2_address, stake_amount_stroops, player1_stake_confirmed_at, player2_stake_confirmed_at, onchain_session_id, onchain_contract_id")
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

        console.log(`[Reject] Player rejected move match=${matchId} player=${player}`);

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
            let onChainTxHash: string | null = null;
            const hasStakePaid = !!match.player1_stake_confirmed_at || !!match.player2_stake_confirmed_at;

            if (isStellarConfigured()) {
                const onChainCancel = await cancelMatchOnChainWithOptions(matchId, {
                    sessionId: match.onchain_session_id ?? undefined,
                    contractId: match.onchain_contract_id || undefined,
                });

                if (!onChainCancel.success) {
                    const cancelError = onChainCancel.error || "unknown";
                    const isMissingSession = /Contract,\s*#1|MatchNotFound/i.test(cancelError);

                    if (hasStakePaid && !isMissingSession) {
                        return Response.json(
                            {
                                error: "Failed to cancel match on-chain; stake refund could not be guaranteed",
                                details: cancelError,
                            },
                            { status: 502 },
                        );
                    }

                    if (!isMissingSession) {
                        console.warn(`[Reject] cancel_match failed for ${matchId}: ${cancelError}`);
                    }
                } else {
                    onChainTxHash = onChainCancel.txHash || null;
                    console.log(`[Reject] On-chain cancel success match=${matchId} tx=${onChainTxHash || "n/a"}`);
                }
            }

            await supabase
                .from("matches")
                .update({
                    status: "cancelled",
                    completed_at: new Date().toISOString(),
                    fight_phase: "match_end",
                    player1_stake_confirmed_at: null,
                    player2_stake_confirmed_at: null,
                })
                .eq("id", matchId)
                .in("status", ["character_select", "in_progress"]);

            const payload = {
                matchId,
                reason: "both_rejected",
                message: "Both players rejected transactions.",
                onChainSessionId: match.onchain_session_id ?? matchIdToSessionId(matchId),
                onChainTxHash,
                redirectTo: "/play",
            };

            await broadcastGameEvent(matchId, "match_cancelled", payload);
            rejectionStateByMatch.delete(matchId);

            console.log(
                `[Reject] Match cancelled after dual rejection match=${matchId} hadStakePaid=${hasStakePaid} onChainTx=${onChainTxHash || "n/a"}`,
            );

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
