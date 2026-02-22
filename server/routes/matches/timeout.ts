/**
 * Disconnect Timeout Route
 * POST /api/matches/:matchId/timeout
 * Claim victory if opponent stayed disconnected past timeout window.
 */

import { getSupabase } from "../../lib/supabase";
import { broadcastGameEvent } from "../../lib/matchmaker";
import { reportMatchResultOnChain, isStellarConfigured, matchIdToSessionId } from "../../lib/stellar-contract";
import { shouldAutoProveFinalize, triggerAutoProveFinalize, getAutoProveFinalizeStatus } from "../../lib/zk-finalizer-client";

const PRIVATE_ROUNDS_ENABLED = true;
const ZK_STRICT_FINALIZE = true;

interface TimeoutBody {
    address: string;
}

export async function handleTimeoutVictory(matchId: string, req: Request): Promise<Response> {
    try {
        const autoFinalize = getAutoProveFinalizeStatus();

        if (PRIVATE_ROUNDS_ENABLED && ZK_STRICT_FINALIZE && !autoFinalize.enabled) {
            return Response.json(
                {
                    error: "Timeout victory requires ZK auto-finalization in strict mode.",
                    reason: autoFinalize.reason,
                },
                { status: 409 },
            );
        }

        const body = await req.json() as TimeoutBody;
        const address = body.address?.trim();

        if (!address) {
            return Response.json({ error: "Missing 'address'" }, { status: 400 });
        }

        console.log(`[Timeout POST] Request match=${matchId} claimer=${address.slice(0, 6)}…${address.slice(-4)}`);

        const supabase = getSupabase();
        const { data: match, error: matchError } = await supabase
            .from("matches")
            .select("id, status, format, room_code, player1_address, player2_address, player1_disconnected_at, player2_disconnected_at, onchain_session_id, onchain_contract_id")
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

            console.log(`[Timeout POST] Both players disconnected match=${matchId}; cancelled`);

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

        console.log(
            `[Timeout POST] Winner resolved match=${matchId} winner=${winnerAddress.slice(0, 6)}…${winnerAddress.slice(-4)} score=${player1RoundsWon}-${player2RoundsWon}`,
        );

        let onChainTxHash: string | undefined;
        let onChainSkippedReason: string | undefined;
        const stellarReady = isStellarConfigured();

        if (!autoFinalize.enabled && stellarReady) {
            try {
                const onChainResult = await reportMatchResultOnChain(
                    matchId,
                    match.player1_address,
                    match.player2_address,
                    winnerAddress,
                    {
                        sessionId: match.onchain_session_id ?? undefined,
                        contractId: match.onchain_contract_id || undefined,
                    },
                );
                onChainTxHash = onChainResult.txHash;
                if (onChainResult.txHash) {
                    await supabase
                        .from("matches")
                        .update({ onchain_result_tx_hash: onChainResult.txHash })
                        .eq("id", matchId);
                }
            } catch (err) {
                console.error("[Timeout POST] On-chain report error:", err);
            }
        } else if (autoFinalize.enabled) {
            triggerAutoProveFinalize(matchId, winnerAddress, "timeout");
            console.log(`[Timeout POST] Triggered auto ZK prove+finalize match=${matchId}`);
        } else {
            onChainSkippedReason = `${autoFinalize.reason}; Stellar not configured`;
            console.warn(`[Timeout POST] On-chain finalize skipped for ${matchId}: ${onChainSkippedReason}`);
        }

        const matchEndedPayload = {
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

        await broadcastGameEvent(matchId, "match_ended", matchEndedPayload);

        console.log(`[Timeout POST] Match ended broadcast match=${matchId} reason=timeout`);

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
