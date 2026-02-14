import { getSupabase } from "./supabase";
import { broadcastGameEvent } from "./matchmaker";
import { calculateEloChange } from "./game-types";
import { cancelMatchOnChainWithOptions, isStellarConfigured, matchIdToSessionId, reportMatchResultOnChain } from "./stellar-contract";
import { getAutoProveFinalizeStatus, triggerAutoProveFinalize } from "./zk-finalizer-client";

const MONITOR_INTERVAL_MS = 60_000;
let monitorTimer: ReturnType<typeof setInterval> | null = null;
let sweepInProgress = false;

function isPastTimeout(disconnectedAt: string | null, timeoutSeconds: number, nowMs: number): boolean {
    if (!disconnectedAt) return false;
    const ts = new Date(disconnectedAt).getTime();
    if (!Number.isFinite(ts)) return false;
    return nowMs >= ts + timeoutSeconds * 1000;
}

async function applyEloForTimeoutWin(
    winnerAddress: string,
    loserAddress: string,
): Promise<{
    winner: { before: number; after: number; change: number };
    loser: { before: number; after: number; change: number };
} | undefined> {
    const supabase = getSupabase();

    const { data: winnerPlayer } = await supabase
        .from("players")
        .select("rating, wins")
        .eq("address", winnerAddress)
        .single();

    const { data: loserPlayer } = await supabase
        .from("players")
        .select("rating, losses")
        .eq("address", loserAddress)
        .single();

    if (!winnerPlayer || !loserPlayer) return undefined;

    const { winnerChange, loserChange } = calculateEloChange(
        winnerPlayer.rating,
        loserPlayer.rating,
    );

    const winnerAfter = Math.max(100, winnerPlayer.rating + winnerChange);
    const loserAfter = Math.max(100, loserPlayer.rating + loserChange);

    await supabase
        .from("players")
        .update({
            rating: winnerAfter,
            wins: winnerPlayer.wins + 1,
        })
        .eq("address", winnerAddress);

    await supabase
        .from("players")
        .update({
            rating: loserAfter,
            losses: loserPlayer.losses + 1,
        })
        .eq("address", loserAddress);

    return {
        winner: { before: winnerPlayer.rating, after: winnerAfter, change: winnerChange },
        loser: { before: loserPlayer.rating, after: loserAfter, change: loserChange },
    };
}

async function resolveBothDisconnected(match: any): Promise<void> {
    const supabase = getSupabase();
    const hadAnyStakePaid = Boolean(match.player1_stake_confirmed_at || match.player2_stake_confirmed_at);

    let onChainTxHash: string | null = null;
    if (isStellarConfigured()) {
        const onChainCancel = await cancelMatchOnChainWithOptions(match.id, {
            sessionId: match.onchain_session_id ?? undefined,
            contractId: match.onchain_contract_id || undefined,
        });
        if (!onChainCancel.success) {
            const cancelError = onChainCancel.error || "unknown";
            if (/Contract,\s*#1|MatchNotFound/i.test(cancelError)) {
                console.info(
                    `[AbandonmentMonitor] cancel_match skipped for ${match.id}: on-chain session missing/unregistered (${match.onchain_session_id ?? "n/a"})`,
                );
            } else {
                console.warn(`[AbandonmentMonitor] cancel_match failed for ${match.id}: ${cancelError}`);
            }
        } else {
            onChainTxHash = onChainCancel.txHash || null;
            console.log(
                `[AbandonmentMonitor] cancel_match succeeded for ${match.id} tx=${onChainTxHash || "n/a"} hadAnyStakePaid=${hadAnyStakePaid}`,
            );
        }
    }

    await supabase
        .from("matches")
        .update({
            status: "cancelled",
            completed_at: new Date().toISOString(),
            fight_phase: "match_end",
            player1_disconnected_at: null,
            player2_disconnected_at: null,
            player1_stake_confirmed_at: null,
            player2_stake_confirmed_at: null,
        })
        .eq("id", match.id)
        .in("status", ["character_select", "in_progress"]);

    await broadcastGameEvent(match.id, "match_cancelled", {
        matchId: match.id,
        reason: "both_disconnected_timeout",
        message: "Both players disconnected for 30 seconds. Match cancelled and stakes refunded.",
        onChainSessionId: match.onchain_session_id ?? matchIdToSessionId(match.id),
        onChainTxHash,
        redirectTo: "/play",
    });

    console.log(
        `[AbandonmentMonitor] Match cancelled for both-disconnect timeout: match=${match.id} refunded=${hadAnyStakePaid ? "possible" : "none"}`,
    );
}

async function resolveSingleDisconnected(match: any, disconnectedPlayer: "player1" | "player2"): Promise<void> {
    const supabase = getSupabase();

    const winner = disconnectedPlayer === "player1" ? "player2" : "player1";
    const winnerAddress = winner === "player1" ? match.player1_address : match.player2_address;
    const loserAddress = disconnectedPlayer === "player1" ? match.player1_address : match.player2_address;

    const roundsToWin = match.format === "best_of_5" ? 3 : 2;
    const player1RoundsWon = winner === "player1" ? roundsToWin : 0;
    const player2RoundsWon = winner === "player2" ? roundsToWin : 0;

    const ratingChanges = await applyEloForTimeoutWin(winnerAddress, loserAddress);

    console.log(
        `[AbandonmentMonitor] Timeout winner resolved match=${match.id} winner=${winnerAddress.slice(0, 6)}…${winnerAddress.slice(-4)} loser=${loserAddress.slice(0, 6)}…${loserAddress.slice(-4)} disconnected=${disconnectedPlayer}`,
    );

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
        .eq("id", match.id)
        .in("status", ["character_select", "in_progress"]);

    let onChainTxHash: string | undefined;
    let onChainSkippedReason: string | undefined;
    const autoFinalize = getAutoProveFinalizeStatus();
    const stellarReady = isStellarConfigured();

    if (!autoFinalize.enabled && stellarReady) {
        try {
            const onChainResult = await reportMatchResultOnChain(
                match.id,
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
                    .eq("id", match.id);
            }
        } catch (err) {
            console.error("[AbandonmentMonitor] On-chain report error:", err);
        }
    } else if (autoFinalize.enabled) {
        triggerAutoProveFinalize(match.id, winnerAddress, "disconnect-timeout");
        console.log(`[AbandonmentMonitor] Triggered auto ZK prove+finalize for timeout match=${match.id}`);
    } else {
        onChainSkippedReason = `${autoFinalize.reason}; Stellar not configured`;
    }

    await broadcastGameEvent(match.id, "match_ended", {
        matchId: match.id,
        winner,
        winnerAddress,
        reason: "disconnect_timeout",
        finalScore: {
            player1RoundsWon,
            player2RoundsWon,
        },
        player1RoundsWon,
        player2RoundsWon,
        ratingChanges,
        onChainSessionId: match.onchain_session_id ?? matchIdToSessionId(match.id),
        onChainTxHash,
        onChainSkippedReason,
        contractId: match.onchain_contract_id || process.env.VITE_VEILSTAR_BRAWL_CONTRACT_ID || "",
    });
}

export async function runAbandonmentSweep(): Promise<void> {
    if (sweepInProgress) return;
    sweepInProgress = true;

    try {
        const supabase = getSupabase();
        const { data: matches, error } = await supabase
            .from("matches")
            .select("id,status,format,player1_address,player2_address,player1_disconnected_at,player2_disconnected_at,player1_stake_confirmed_at,player2_stake_confirmed_at,disconnect_timeout_seconds,onchain_session_id,onchain_contract_id")
            .in("status", ["character_select", "in_progress"])
            .or("player1_disconnected_at.not.is.null,player2_disconnected_at.not.is.null")
            .limit(200);

        if (error || !matches || matches.length === 0) return;

        console.log(`[AbandonmentMonitor] Sweep start candidates=${matches.length}`);

        const nowMs = Date.now();
        let cancelledCount = 0;
        let timeoutWinCount = 0;

        for (const match of matches) {
            const timeoutSeconds = Number(match.disconnect_timeout_seconds || 30);
            const p1Expired = isPastTimeout(match.player1_disconnected_at, timeoutSeconds, nowMs);
            const p2Expired = isPastTimeout(match.player2_disconnected_at, timeoutSeconds, nowMs);

            if (!p1Expired && !p2Expired) continue;

            if (p1Expired && p2Expired) {
                await resolveBothDisconnected(match);
                cancelledCount += 1;
                continue;
            }

            if (p1Expired && !match.player2_disconnected_at) {
                await resolveSingleDisconnected(match, "player1");
                timeoutWinCount += 1;
                continue;
            }

            if (p2Expired && !match.player1_disconnected_at) {
                await resolveSingleDisconnected(match, "player2");
                timeoutWinCount += 1;
                continue;
            }
        }

        if (cancelledCount > 0 || timeoutWinCount > 0) {
            console.log(
                `[AbandonmentMonitor] Sweep results cancelled=${cancelledCount} timeoutWins=${timeoutWinCount}`,
            );
        }
    } catch (err) {
        console.error("[AbandonmentMonitor] Sweep error:", err);
    } finally {
        sweepInProgress = false;
    }
}

export function startAbandonmentMonitor(): void {
    if (monitorTimer) return;

    console.log(`[AbandonmentMonitor] Started (interval=${MONITOR_INTERVAL_MS}ms)`);

    monitorTimer = setInterval(() => {
        runAbandonmentSweep().catch((err) => {
            console.error("[AbandonmentMonitor] Interval error:", err);
        });
    }, MONITOR_INTERVAL_MS);

    // Run once on startup as well.
    runAbandonmentSweep().catch((err) => {
        console.error("[AbandonmentMonitor] Initial sweep error:", err);
    });
}
