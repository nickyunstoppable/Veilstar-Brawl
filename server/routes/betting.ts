/**
 * Betting API Routes
 * Handles PvP and bot match betting
 */

import { getSupabase } from "../lib/supabase";
import { getActiveMatch, simulateBotMatch } from "../lib/bot-match-service";
import { getOnChainPoolStatus } from "../lib/zk-betting-contract";

const lastBotPoolSnapshotLog = new Map<string, string>();

function mapOnChainPoolStatus(status: number): { status: string; onchain_status: string } {
    if (status === 0) return { status: "open", onchain_status: "open" };
    if (status === 1) return { status: "locked", onchain_status: "locked" };
    if (status === 2) return { status: "resolved", onchain_status: "settled" };
    if (status === 3) return { status: "resolved", onchain_status: "refunded" };
    return { status: "open", onchain_status: "open" };
}

async function syncPoolFromOnChain(pool: any): Promise<{ pool: any; onchainReachable: boolean }> {
    if (!pool?.onchain_pool_id) {
        return { pool, onchainReachable: true };
    }

    const supabase = getSupabase();
    const onchain = await getOnChainPoolStatus(Number(pool.onchain_pool_id));
    if (!onchain) {
        return { pool, onchainReachable: false };
    }

    const mapped = mapOnChainPoolStatus(onchain.status);
    if (pool.status === mapped.status && pool.onchain_status === mapped.onchain_status) {
        return { pool, onchainReachable: true };
    }

    const { data: syncedPool } = await supabase
        .from("betting_pools")
        .update({
            status: mapped.status,
            onchain_status: mapped.onchain_status,
        })
        .eq("id", pool.id)
        .select("*")
        .single();

    return { pool: syncedPool ?? pool, onchainReachable: true };
}

async function reconcileBotBetStatusIfResolved(params: {
    poolId: string;
    bettorAddress: string;
}): Promise<void> {
    const supabase = getSupabase();

    const { data: pool } = await supabase
        .from("betting_pools")
        .select("status,winner")
        .eq("id", params.poolId)
        .eq("match_type", "bot")
        .single();

    if (!pool || pool.status !== "resolved" || !pool.winner) return;

    const { data: bet } = await supabase
        .from("bets")
        .select("id,status,bet_on,revealed,claim_tx_id")
        .eq("pool_id", params.poolId)
        .eq("bettor_address", params.bettorAddress)
        .single();

    if (!bet) return;

    if (bet?.claim_tx_id && String(bet.claim_tx_id).startsWith("auto-claim:")) {
        await supabase
            .from("bets")
            .update({ claim_tx_id: null })
            .eq("id", bet.id);
    }

    const nextStatus = bet.revealed && bet.bet_on === pool.winner ? "won" : "lost";

    if (bet.status === nextStatus) return;

    console.log("[BotBetting][Reconcile] Updating bet status", {
        poolId: params.poolId,
        bettorAddress: params.bettorAddress,
        from: bet.status,
        to: nextStatus,
        betOn: bet.bet_on,
        revealed: bet.revealed,
        poolWinner: pool.winner,
    });

    const updatePayload: Record<string, unknown> = { status: nextStatus };
    if (nextStatus === "lost") {
        updatePayload.payout_amount = null;
        updatePayload.onchain_payout_amount = null;
        updatePayload.claim_tx_id = null;
    }

    await supabase
        .from("bets")
        .update(updatePayload)
        .eq("id", bet.id);
}

// =============================================================================
// PvP Betting
// =============================================================================

export async function handleGetBettingPool(matchId: string, req: Request): Promise<Response> {
    return Response.json(
        {
            error: "PvP betting is disabled. Use bot betting only.",
            code: "PVP_BETTING_DISABLED",
        },
        { status: 410 }
    );

    try {
        const supabase = getSupabase();
        const url = new URL(req.url);
        const bettorAddress = url.searchParams.get("address");

        // Get or create pool
        let { data: pool } = await supabase
            .from("betting_pools")
            .select("*")
            .eq("match_id", matchId)
            .eq("match_type", "pvp")
            .single();

        if (!pool) {
            // Create pool
            const { data: newPool, error } = await supabase
                .from("betting_pools")
                .insert({
                    match_id: matchId,
                    match_type: "pvp",
                    player1_total: 0,
                    player2_total: 0,
                    total_pool: 0,
                    total_fees: 0,
                    status: "open",
                })
                .select()
                .single();

            if (error) {
                return Response.json({ pool: null, userBet: null });
            }
            pool = newPool;
        }

        // Check user's bet
        let userBet = null;
        if (bettorAddress && pool) {
            await reconcileBotBetStatusIfResolved({
                poolId: pool.id,
                bettorAddress,
            });

            const { data: bet } = await supabase
                .from("bets")
                .select("*")
                .eq("pool_id", pool.id)
                .eq("bettor_address", bettorAddress)
                .single();
            userBet = bet;
        }

        return Response.json({ pool, userBet });
    } catch (error) {
        console.error("[Betting] Pool error:", error);
        return Response.json({ error: "Failed to get betting pool" }, { status: 500 });
    }
}

export async function handlePlaceBet(req: Request): Promise<Response> {
    return Response.json(
        {
            error: "PvP betting is disabled. Use bot betting only.",
            code: "PVP_BETTING_DISABLED",
        },
        { status: 410 }
    );

    try {
        const body = await req.json();
        const { matchId, betOn, amount, bettorAddress } = body;

        if (!matchId || !betOn || !amount || !bettorAddress) {
            return Response.json({ error: "Missing required fields" }, { status: 400 });
        }

        const supabase = getSupabase();

        // Get or create pool
        let { data: pool } = await supabase
            .from("betting_pools")
            .select("*")
            .eq("match_id", matchId)
            .eq("match_type", "pvp")
            .single();

        if (!pool) {
            const { data: newPool } = await supabase
                .from("betting_pools")
                .insert({
                    match_id: matchId,
                    match_type: "pvp",
                    status: "open",
                    player1_total: 0,
                    player2_total: 0,
                    total_pool: 0,
                    total_fees: 0,
                })
                .select()
                .single();
            pool = newPool;
        }

        if (pool?.onchain_pool_id) {
            const onchain = await getOnChainPoolStatus(Number(pool.onchain_pool_id));
            if (onchain) {
                const mapped = mapOnChainPoolStatus(onchain.status);
                if (pool.status !== mapped.status || pool.onchain_status !== mapped.onchain_status) {
                    const { data: syncedPool } = await supabase
                        .from("betting_pools")
                        .update({
                            status: mapped.status,
                            onchain_status: mapped.onchain_status,
                        })
                        .eq("id", pool.id)
                        .select("*")
                        .single();

                    if (syncedPool) {
                        pool = syncedPool;
                    }
                }
            }
        }

        if (!pool || pool.status !== "open") {
            return Response.json({ error: "Betting is closed for this match" }, { status: 400 });
        }

        // Check for existing bet
        const { data: existingBet } = await supabase
            .from("bets")
            .select("id")
            .eq("pool_id", pool.id)
            .eq("bettor_address", bettorAddress)
            .single();

        if (existingBet) {
            return Response.json({ error: "Already placed a bet on this match" }, { status: 400 });
        }

        // Calculate fee (0.1%)
        // House model: 1% fee, stake remains full `amount`
        const fee = Math.floor(amount / 100);
        const netAmount = amount;

        // Insert bet
        const { data: bet, error: betError } = await supabase
            .from("bets")
            .insert({
                pool_id: pool.id,
                bettor_address: bettorAddress,
                bet_on: betOn,
                amount,
                fee_paid: fee,
                net_amount: netAmount,
                status: "confirmed",
                tx_id: `sim-${Date.now()}`, // Simulated tx for now
            })
            .select()
            .single();

        if (betError) {
            return Response.json({ error: "Failed to place bet" }, { status: 500 });
        }

        // Update pool totals
        const updateField = betOn === "player1" ? "player1_total" : "player2_total";
        await supabase
            .from("betting_pools")
            .update({
                [updateField]: pool[updateField] + netAmount,
                total_pool: pool.total_pool + netAmount,
                total_fees: pool.total_fees + fee,
            })
            .eq("id", pool.id);

        return Response.json({ bet, success: true });
    } catch (error) {
        console.error("[Betting] Place bet error:", error);
        return Response.json({ error: "Failed to place bet" }, { status: 500 });
    }
}

// =============================================================================
// Bot Betting
// =============================================================================

export async function handleGetBotBettingPool(matchId: string, req: Request): Promise<Response> {
    try {
        const supabase = getSupabase();
        const url = new URL(req.url);
        const bettorAddress = url.searchParams.get("address");

        let { data: pool } = await supabase
            .from("betting_pools")
            .select("*")
            .eq("match_id", matchId)
            .eq("match_type", "bot")
            .single();

        if (!pool) {
            const { data: newPool } = await supabase
                .from("betting_pools")
                .insert({
                    match_id: matchId,
                    match_type: "bot",
                    status: "open",
                    player1_total: 0,
                    player2_total: 0,
                    total_pool: 0,
                    total_fees: 0,
                })
                .select()
                .single();
            pool = newPool;
        }

        let onchainReachable = true;
        if (pool) {
            const synced = await syncPoolFromOnChain(pool);
            pool = synced.pool;
            onchainReachable = synced.onchainReachable;
        }

        let userBet = null;
        if (bettorAddress && pool) {
            await reconcileBotBetStatusIfResolved({
                poolId: pool.id,
                bettorAddress,
            });

            const { data: bet } = await supabase
                .from("bets")
                .select("*")
                .eq("pool_id", pool.id)
                .eq("bettor_address", bettorAddress)
                .single();
            userBet = bet;

            const conciseSnapshot = {
                matchId,
                poolId: pool.id,
                poolStatus: pool.status,
                poolWinner: pool.winner,
                onchainPoolId: pool.onchain_pool_id,
                onchainStatus: pool.onchain_status,
                betStatus: userBet?.status ?? null,
                betOn: userBet?.bet_on ?? null,
                revealed: userBet?.revealed ?? null,
                hasClaimTx: Boolean(userBet?.claim_tx_id),
            };
            const snapshotStr = JSON.stringify(conciseSnapshot);
            const snapshotKey = `${matchId}:${bettorAddress}`;
            const previousSnapshot = lastBotPoolSnapshotLog.get(snapshotKey);
            if (previousSnapshot !== snapshotStr) {
                console.log("[BotBetting][Pool]", conciseSnapshot);
                lastBotPoolSnapshotLog.set(snapshotKey, snapshotStr);
            }
        }

        const canAcceptBets = Boolean(
            pool
            && pool.status === "open"
            && (!pool.onchain_pool_id || (pool.onchain_status === "open" && onchainReachable))
        );

        return Response.json({ pool, userBet, canAcceptBets, onchainReachable });
    } catch (error) {
        console.error("[BotBetting] Pool error:", error);
        return Response.json({ error: "Failed to get betting pool" }, { status: 500 });
    }
}

export async function handlePlaceBotBet(req: Request): Promise<Response> {
    try {
        const body = await req.json();
        const { matchId, betOn, amount, bettorAddress, onchainPoolId, txId, commitmentHash, revealSalt } = body;

        const activeMatch = getActiveMatch();
        if (activeMatch && activeMatch.id !== matchId) {
            console.warn("[BotBetting][Place] Rejected stale match bet", {
                requestedMatchId: matchId,
                activeMatchId: activeMatch.id,
                bettorAddress,
            });
            return Response.json(
                {
                    error: "Match expired. Please refresh and bet on the current bot match.",
                    activeMatchId: activeMatch.id,
                },
                { status: 409 }
            );
        }

        if (!matchId || !betOn || !amount || !bettorAddress) {
            return Response.json({ error: "Missing required fields" }, { status: 400 });
        }

        if (bettorAddress === "anonymous" || typeof bettorAddress !== "string" || !bettorAddress.startsWith("G")) {
            return Response.json({ error: "Connect a valid Stellar wallet before betting" }, { status: 400 });
        }

        if (!onchainPoolId || !txId || !commitmentHash || !revealSalt) {
            return Response.json({ error: "Missing on-chain bet proof fields" }, { status: 400 });
        }

        const supabase = getSupabase();

        let { data: pool } = await supabase
            .from("betting_pools")
            .select("*")
            .eq("match_id", matchId)
            .eq("match_type", "bot")
            .single();

        if (!pool) {
            const { data: newPool } = await supabase
                .from("betting_pools")
                .insert({
                    match_id: matchId,
                    match_type: "bot",
                    status: "open",
                    player1_total: 0,
                    player2_total: 0,
                    total_pool: 0,
                    total_fees: 0,
                })
                .select()
                .single();
            pool = newPool;
        }

        if (pool && !pool.onchain_pool_id) {
            const { data: updatedPool } = await supabase
                .from("betting_pools")
                .update({
                    onchain_pool_id: Number(onchainPoolId),
                    onchain_status: "open",
                })
                .eq("id", pool.id)
                .select()
                .single();
            if (updatedPool) pool = updatedPool;
        }

        if (pool?.onchain_pool_id) {
            const synced = await syncPoolFromOnChain(pool);
            pool = synced.pool;

            if (!synced.onchainReachable) {
                return Response.json({ error: "On-chain pool status is syncing. Try again in a moment." }, { status: 503 });
            }
        }

        if (!pool || pool.status !== "open") {
            return Response.json({ error: "Betting is closed" }, { status: 400 });
        }

        if (pool.onchain_pool_id && pool.onchain_status && pool.onchain_status !== "open") {
            return Response.json({ error: "Betting is closed for this pool" }, { status: 400 });
        }

        if (pool.onchain_pool_id && Number(onchainPoolId) !== Number(pool.onchain_pool_id)) {
            return Response.json(
                {
                    error: "Pool ID changed. Refresh and retry.",
                    onchainPoolId: Number(pool.onchain_pool_id),
                },
                { status: 409 }
            );
        }

        const { data: existingBet } = await supabase
            .from("bets")
            .select("id")
            .eq("pool_id", pool.id)
            .eq("bettor_address", bettorAddress)
            .single();

        if (existingBet) {
            return Response.json({ error: "Already placed a bet" }, { status: 400 });
        }

        const fee = Math.floor(amount / 100);
        const netAmount = amount;

        const { data: bet, error: betError } = await supabase
            .from("bets")
            .insert({
                pool_id: pool.id,
                bettor_address: bettorAddress,
                bet_on: betOn,
                amount,
                fee_paid: fee,
                net_amount: netAmount,
                status: "confirmed",
                tx_id: txId,
                commit_tx_id: txId,
                commitment_hash: commitmentHash,
                reveal_salt: revealSalt,
                revealed: false,
            })
            .select()
            .single();

        if (betError) {
            return Response.json({ error: "Failed to place bet" }, { status: 500 });
        }

        const updateField = betOn === "player1" ? "player1_total" : "player2_total";
        await supabase
            .from("betting_pools")
            .update({
                [updateField]: pool[updateField] + netAmount,
                total_pool: pool.total_pool + netAmount,
                total_fees: pool.total_fees + fee,
            })
            .eq("id", pool.id);

        return Response.json({ bet, success: true });
    } catch (error) {
        console.error("[BotBetting] Place bet error:", error);
        return Response.json({ error: "Failed to place bet" }, { status: 500 });
    }
}

export async function handleRevealBotBet(req: Request): Promise<Response> {
    try {
        const { matchId, bettorAddress, revealTxId } = await req.json();
        if (!matchId || !bettorAddress || !revealTxId) {
            return Response.json({ error: "Missing required fields" }, { status: 400 });
        }

        const supabase = getSupabase();
        const { data: pool } = await supabase
            .from("betting_pools")
            .select("id")
            .eq("match_id", matchId)
            .eq("match_type", "bot")
            .single();

        if (!pool) return Response.json({ error: "Pool not found" }, { status: 404 });

        const { error } = await supabase
            .from("bets")
            .update({ revealed: true, reveal_tx_id: revealTxId })
            .eq("pool_id", pool.id)
            .eq("bettor_address", bettorAddress);

        if (error) return Response.json({ error: "Failed to mark reveal" }, { status: 500 });

        await reconcileBotBetStatusIfResolved({
            poolId: pool.id,
            bettorAddress,
        });

        const { data: betAfterReveal } = await supabase
            .from("bets")
            .select("status,bet_on,revealed,reveal_tx_id,claim_tx_id")
            .eq("pool_id", pool.id)
            .eq("bettor_address", bettorAddress)
            .single();

        console.log("[BotBetting][Reveal] Reveal marked", {
            matchId,
            poolId: pool.id,
            bettorAddress,
            revealTxId,
            betStatus: betAfterReveal?.status ?? null,
            betOn: betAfterReveal?.bet_on ?? null,
            revealed: betAfterReveal?.revealed ?? null,
            claimTxId: betAfterReveal?.claim_tx_id ?? null,
        });

        return Response.json({ success: true });
    } catch (error) {
        console.error("[BotBetting] Reveal bet error:", error);
        return Response.json({ error: "Failed to reveal bet" }, { status: 500 });
    }
}

export async function handleClaimBotBet(req: Request): Promise<Response> {
    try {
        const { matchId, bettorAddress, claimTxId, payoutAmount } = await req.json();
        if (!matchId || !bettorAddress || !claimTxId) {
            return Response.json({ error: "Missing required fields" }, { status: 400 });
        }

        const supabase = getSupabase();
        const { data: pool } = await supabase
            .from("betting_pools")
            .select("id")
            .eq("match_id", matchId)
            .eq("match_type", "bot")
            .single();

        if (!pool) return Response.json({ error: "Pool not found" }, { status: 404 });

        console.log("[BotBetting][Claim] Claim request", {
            matchId,
            poolId: pool.id,
            bettorAddress,
            claimTxId,
            payoutAmount,
        });

        await reconcileBotBetStatusIfResolved({
            poolId: pool.id,
            bettorAddress,
        });

        const { data: currentBet } = await supabase
            .from("bets")
            .select("status,revealed")
            .eq("pool_id", pool.id)
            .eq("bettor_address", bettorAddress)
            .single();

        if (!currentBet) {
            return Response.json({ error: "Bet not found" }, { status: 404 });
        }

        if (!currentBet.revealed || currentBet.status !== "won") {
            console.warn("[BotBetting][Claim] Bet not claimable", {
                matchId,
                poolId: pool.id,
                bettorAddress,
                status: currentBet.status,
                revealed: currentBet.revealed,
            });
            return Response.json({ error: "Bet is not claimable yet" }, { status: 400 });
        }

        const updatePayload: Record<string, unknown> = {
            claim_tx_id: claimTxId,
            status: "won",
        };
        if (payoutAmount !== undefined && payoutAmount !== null && payoutAmount !== "") {
            updatePayload.payout_amount = Number(payoutAmount);
            updatePayload.onchain_payout_amount = Number(payoutAmount);
        }

        const { error } = await supabase
            .from("bets")
            .update(updatePayload)
            .eq("pool_id", pool.id)
            .eq("bettor_address", bettorAddress);

        if (error) return Response.json({ error: "Failed to mark claim" }, { status: 500 });

        console.log("[BotBetting][Claim] Claim recorded", {
            matchId,
            poolId: pool.id,
            bettorAddress,
            claimTxId,
            payoutAmount: updatePayload.payout_amount ?? null,
        });

        return Response.json({ success: true });
    } catch (error) {
        console.error("[BotBetting] Claim bet error:", error);
        return Response.json({ error: "Failed to claim bet" }, { status: 500 });
    }
}

export async function handleGetUnresolvedBotBets(req: Request): Promise<Response> {
    try {
        const supabase = getSupabase();
        const url = new URL(req.url);
        const bettorAddress = url.searchParams.get("address");

        if (!bettorAddress) {
            return Response.json({ error: "address is required" }, { status: 400 });
        }

        const { data: bets } = await supabase
            .from("bets")
            .select("id,pool_id,bet_on,reveal_salt,revealed,claim_tx_id,status")
            .eq("bettor_address", bettorAddress)
            .is("claim_tx_id", null)
            .not("reveal_salt", "is", null)
            .limit(50);

        if (!bets || bets.length === 0) {
            return Response.json({ unresolved: [] });
        }

        const poolIds = Array.from(new Set(bets.map((bet) => bet.pool_id).filter(Boolean)));
        const { data: pools } = await supabase
            .from("betting_pools")
            .select("id,match_id,match_type,status,winner,onchain_pool_id,onchain_status")
            .in("id", poolIds)
            .eq("match_type", "bot")
            .not("onchain_pool_id", "is", null);

        const poolById = new Map((pools || []).map((pool) => [pool.id, pool]));

        const unresolved = (bets || [])
            .map((bet) => {
                const pool = poolById.get(bet.pool_id);
                if (!pool) return null;

                const isSettled = pool.status === "resolved" || pool.onchain_status === "settled";
                const shouldReveal = isSettled && !bet.revealed;
                const shouldClaim = isSettled
                    && !!pool.winner
                    && bet.bet_on === pool.winner
                    && !bet.claim_tx_id;

                if (!shouldReveal && !shouldClaim) return null;

                return {
                    betId: bet.id,
                    matchId: pool.match_id,
                    poolId: pool.id,
                    onchainPoolId: Number(pool.onchain_pool_id),
                    betOn: bet.bet_on,
                    revealSalt: bet.reveal_salt,
                    revealed: bet.revealed,
                    claimTxId: bet.claim_tx_id,
                    status: bet.status,
                    poolStatus: pool.status,
                    onchainStatus: pool.onchain_status,
                    poolWinner: pool.winner,
                    shouldReveal,
                    shouldClaim,
                };
            })
            .filter(Boolean);

        return Response.json({ unresolved });
    } catch (error) {
        console.error("[BotBetting] Unresolved bets error:", error);
        return Response.json({ error: "Failed to get unresolved bets" }, { status: 500 });
    }
}

export async function handleGetBotBetHistory(req: Request): Promise<Response> {
    try {
        const supabase = getSupabase();
        const url = new URL(req.url);
        const bettorAddress = url.searchParams.get("address");
        const limitParam = url.searchParams.get("limit");
        const offsetParam = url.searchParams.get("offset");

        if (!bettorAddress) {
            return Response.json({ success: false, error: "Address parameter is required" }, { status: 400 });
        }

        const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10), 1), 50) : 10;
        const offset = offsetParam ? Math.max(parseInt(offsetParam, 10), 0) : 0;

        const { data: betsData, error: betsError } = await supabase
            .from("bets")
            .select("id,pool_id,bet_on,amount,fee_paid,net_amount,payout_amount,status,created_at,tx_id,claim_tx_id")
            .eq("bettor_address", bettorAddress)
            .order("created_at", { ascending: false })
            .range(offset, offset + limit - 1);

        if (betsError) {
            console.error("[BotBetHistory] Failed to fetch bets:", betsError);
            return Response.json({ success: false, error: "Failed to fetch bet history" }, { status: 500 });
        }

        const { count: totalCount, error: countError } = await supabase
            .from("bets")
            .select("id", { count: "exact", head: true })
            .eq("bettor_address", bettorAddress);

        if (countError) {
            console.error("[BotBetHistory] Failed to count bets:", countError);
        }

        const poolIds = Array.from(new Set((betsData || []).map((bet) => bet.pool_id).filter(Boolean)));
        let poolById = new Map<string, {
            id: string;
            match_id: string;
            match_type: string;
            winner: "player1" | "player2" | null;
        }>();

        if (poolIds.length > 0) {
            const { data: poolsData, error: poolsError } = await supabase
                .from("betting_pools")
                .select("id,match_id,match_type,winner")
                .in("id", poolIds)
                .eq("match_type", "bot");

            if (poolsError) {
                console.error("[BotBetHistory] Failed to fetch pools:", poolsError);
            } else {
                poolById = new Map((poolsData || []).map((pool) => [pool.id, pool]));
            }
        }

        const activeMatch = getActiveMatch();
        const reconstructedMatchMeta = new Map<string, {
            bot1Name: string;
            bot2Name: string;
            bot1CharacterId: string;
            bot2CharacterId: string;
        }>();

        const history = (betsData || [])
            .map((bet) => {
                const pool = poolById.get(bet.pool_id);
                if (!pool) return null;

                const activeMetadata = activeMatch && activeMatch.id === pool.match_id
                    ? {
                        bot1Name: activeMatch.bot1Name,
                        bot2Name: activeMatch.bot2Name,
                        bot1CharacterId: activeMatch.bot1CharacterId,
                        bot2CharacterId: activeMatch.bot2CharacterId,
                    }
                    : null;

                let fallbackMetadata = reconstructedMatchMeta.get(pool.match_id);
                if (!fallbackMetadata) {
                    const simulated = simulateBotMatch(pool.match_id);
                    fallbackMetadata = {
                        bot1Name: simulated.bot1Name,
                        bot2Name: simulated.bot2Name,
                        bot1CharacterId: simulated.bot1CharacterId,
                        bot2CharacterId: simulated.bot2CharacterId,
                    };
                    reconstructedMatchMeta.set(pool.match_id, fallbackMetadata);
                }

                return {
                    id: bet.id,
                    matchId: pool.match_id,
                    matchType: "bot" as const,
                    player1Name: activeMetadata?.bot1Name || fallbackMetadata.bot1Name,
                    player2Name: activeMetadata?.bot2Name || fallbackMetadata.bot2Name,
                    player1CharacterId: activeMetadata?.bot1CharacterId || fallbackMetadata.bot1CharacterId,
                    player2CharacterId: activeMetadata?.bot2CharacterId || fallbackMetadata.bot2CharacterId,
                    betOn: bet.bet_on,
                    amount: String(bet.amount ?? 0),
                    feeAmount: String(bet.fee_paid ?? 0),
                    netAmount: String(bet.net_amount ?? 0),
                    payoutAmount: bet.payout_amount == null ? null : String(bet.payout_amount),
                    status: bet.status,
                    winner: pool.winner,
                    createdAt: bet.created_at,
                    paidAt: null,
                    txId: bet.tx_id || "",
                    payoutTxId: bet.claim_tx_id || null,
                };
            })
            .filter(Boolean);

        const { data: allBotBets } = await supabase
            .from("bets")
            .select("amount,payout_amount,status,pool_id")
            .eq("bettor_address", bettorAddress);

        const allBotPoolIds = Array.from(new Set((allBotBets || []).map((bet) => bet.pool_id).filter(Boolean)));
        let allBotPools = new Set<string>();

        if (allBotPoolIds.length > 0) {
            const { data: allPoolsData } = await supabase
                .from("betting_pools")
                .select("id")
                .in("id", allBotPoolIds)
                .eq("match_type", "bot");

            allBotPools = new Set((allPoolsData || []).map((pool) => pool.id));
        }

        const botOnlyBets = (allBotBets || []).filter((bet) => allBotPools.has(bet.pool_id));

        const stats = {
            totalBets: botOnlyBets.length,
            wonBets: botOnlyBets.filter((bet) => bet.status === "won").length,
            lostBets: botOnlyBets.filter((bet) => bet.status === "lost").length,
            pendingBets: botOnlyBets.filter((bet) => bet.status === "pending" || bet.status === "confirmed").length,
            totalWagered: botOnlyBets.reduce((sum, bet) => sum + BigInt(bet.amount || 0), BigInt(0)).toString(),
            totalWon: botOnlyBets
                .filter((bet) => bet.status === "won" && bet.payout_amount != null)
                .reduce((sum, bet) => sum + BigInt(bet.payout_amount || 0), BigInt(0))
                .toString(),
        };

        return Response.json({
            success: true,
            history,
            stats,
            pagination: {
                limit,
                offset,
                total: totalCount || 0,
                hasMore: offset + limit < (totalCount || 0),
            },
        });
    } catch (error) {
        console.error("[BotBetHistory] Error:", error);
        return Response.json({ success: false, error: "Internal server error" }, { status: 500 });
    }
}
