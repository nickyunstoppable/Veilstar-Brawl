/**
 * Move Timeout Route
 * POST /api/matches/:matchId/move-timeout
 */

import { getSupabase } from "../../lib/supabase";
import { handleMoveTimeout } from "../../lib/combat-resolver";
import { broadcastGameEvent } from "../../lib/matchmaker";
import { reportMatchResultOnChain, isStellarConfigured, matchIdToSessionId } from "../../lib/stellar-contract";
import { triggerAutoProveFinalize, getAutoProveFinalizeStatus } from "../../lib/zk-finalizer-client";

const PRIVATE_ROUNDS_ENABLED = (process.env.ZK_PRIVATE_ROUNDS ?? "true") !== "false";

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
            .select("id, status, format, room_code, player1_address, player2_address, player1_rounds_won, player2_rounds_won, onchain_session_id, onchain_contract_id")
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

        if (PRIVATE_ROUNDS_ENABLED) {
            const { data: latestRound } = await supabase
                .from("rounds")
                .select("round_number")
                .eq("match_id", matchId)
                .order("round_number", { ascending: false })
                .order("turn_number", { ascending: false })
                .limit(1)
                .maybeSingle();

            const { data: snapshot } = await supabase
                .from("fight_state_snapshots")
                .select("current_round")
                .eq("match_id", matchId)
                .maybeSingle();

            const currentRound = Number(snapshot?.current_round ?? latestRound?.round_number ?? 1);

            const { data: commits } = await supabase
                .from("round_private_commits")
                .select("player_address")
                .eq("match_id", matchId)
                .eq("round_number", currentRound);

            const committed = new Set((commits || []).map((row) => String(row.player_address || "").trim().toLowerCase()));
            const p1Address = String(match.player1_address || "").trim();
            const p2Address = String(match.player2_address || "").trim();
            const p1Committed = committed.has(p1Address.toLowerCase());
            const p2Committed = committed.has(p2Address.toLowerCase());

            if (!p1Committed && !p2Committed) {
                await supabase
                    .from("matches")
                    .update({
                        status: "cancelled",
                        fight_phase: "match_end",
                        completed_at: new Date().toISOString(),
                    })
                    .eq("id", matchId)
                    .in("status", ["in_progress", "character_select"]);

                const cancelPayload = {
                    matchId,
                    reason: "both_timeout",
                    message: "Both players failed to submit a private round plan in time.",
                    redirectTo: "/play",
                };

                await broadcastGameEvent(matchId, "match_cancelled", cancelPayload);

                return Response.json({
                    success: true,
                    data: {
                        result: "match_cancelled",
                        ...cancelPayload,
                    },
                });
            }

            if (p1Committed !== p2Committed) {
                const winner = p1Committed ? "player1" : "player2";
                const winnerAddress = winner === "player1" ? p1Address : p2Address;
                const roundsToWin = match.format === "best_of_5" ? 3 : 2;
                const player1RoundsWon = winner === "player1" ? roundsToWin : Number(match.player1_rounds_won || 0);
                const player2RoundsWon = winner === "player2" ? roundsToWin : Number(match.player2_rounds_won || 0);

                await supabase
                    .from("matches")
                    .update({
                        status: "completed",
                        winner_address: winnerAddress,
                        player1_rounds_won: player1RoundsWon,
                        player2_rounds_won: player2RoundsWon,
                        completed_at: new Date().toISOString(),
                        fight_phase: "match_end",
                    })
                    .eq("id", matchId)
                    .in("status", ["in_progress", "character_select"]);

                let onChainTxHash: string | undefined;
                let onChainSkippedReason: string | undefined;
                const autoFinalize = getAutoProveFinalizeStatus();
                const stellarReady = isStellarConfigured();

                if (!autoFinalize.enabled && stellarReady) {
                    try {
                        const onChainResult = await reportMatchResultOnChain(
                            matchId,
                            p1Address,
                            p2Address,
                            winnerAddress,
                            {
                                sessionId: match.onchain_session_id ?? undefined,
                                contractId: match.onchain_contract_id || undefined,
                            },
                        );
                        onChainTxHash = onChainResult.txHash;
                        if (onChainTxHash) {
                            await supabase
                                .from("matches")
                                .update({ onchain_result_tx_hash: onChainTxHash })
                                .eq("id", matchId);
                        }
                    } catch (err) {
                        console.error("[MoveTimeout POST] On-chain report error:", err);
                    }
                } else if (autoFinalize.enabled) {
                    triggerAutoProveFinalize(matchId, winnerAddress, "private-round-timeout");
                } else {
                    onChainSkippedReason = `${autoFinalize.reason}; Stellar not configured`;
                }

                const endedPayload = {
                    matchId,
                    winner,
                    winnerAddress,
                    reason: "timeout",
                    finalScore: {
                        player1RoundsWon,
                        player2RoundsWon,
                    },
                    player1RoundsWon,
                    player2RoundsWon,
                    isPrivateRoom: !!match.room_code,
                    onChainSessionId: match.onchain_session_id ?? matchIdToSessionId(matchId),
                    onChainTxHash,
                    onChainSkippedReason,
                    contractId: match.onchain_contract_id || process.env.VITE_VEILSTAR_BRAWL_CONTRACT_ID || "",
                };

                await broadcastGameEvent(matchId, "match_ended", endedPayload);

                return Response.json({
                    success: true,
                    data: {
                        result: "match_resolved",
                        isMatchOver: true,
                        matchWinner: winner,
                        matchEndedPayload: endedPayload,
                    },
                });
            }

            return Response.json({
                success: true,
                data: { result: "no_action", reason: "both_committed_private_round" },
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
