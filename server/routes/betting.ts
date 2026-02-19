/**
 * Betting API Routes
 * Handles PvP and bot match betting
 */

import { getSupabase } from "../lib/supabase";
import { createOnChainBotPool, isZkBettingConfigured } from "../lib/zk-betting-contract";

const onchainPoolCreateInFlight = new Set<string>();

// =============================================================================
// PvP Betting
// =============================================================================

export async function handleGetBettingPool(matchId: string, req: Request): Promise<Response> {
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

        if (pool && !pool.onchain_pool_id && isZkBettingConfigured()) {
            const poolKey = String(pool.id);
            if (!onchainPoolCreateInFlight.has(poolKey)) {
                onchainPoolCreateInFlight.add(poolKey);
                void (async () => {
                    try {
                        const nowTs = Math.floor(Date.now() / 1000);
                        const created = await createOnChainBotPool(matchId, nowTs + 30);
                        await supabase
                            .from("betting_pools")
                            .update({
                                onchain_pool_id: created.poolId,
                                onchain_status: "open",
                                onchain_last_tx_id: created.txHash || null,
                            })
                            .eq("id", pool.id)
                            .is("onchain_pool_id", null);
                    } catch (err) {
                        console.error("[BotBetting] Failed to create on-chain pool:", err);
                    } finally {
                        onchainPoolCreateInFlight.delete(poolKey);
                    }
                })();
            }
        }

        let userBet = null;
        if (bettorAddress && pool) {
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
        console.error("[BotBetting] Pool error:", error);
        return Response.json({ error: "Failed to get betting pool" }, { status: 500 });
    }
}

export async function handlePlaceBotBet(req: Request): Promise<Response> {
    try {
        const body = await req.json();
        const { matchId, betOn, amount, bettorAddress, onchainPoolId, txId, commitmentHash, revealSalt } = body;

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

        if (!pool || pool.status !== "open") {
            return Response.json({ error: "Betting is closed" }, { status: 400 });
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
        return Response.json({ success: true });
    } catch (error) {
        console.error("[BotBetting] Claim bet error:", error);
        return Response.json({ error: "Failed to claim bet" }, { status: 500 });
    }
}
