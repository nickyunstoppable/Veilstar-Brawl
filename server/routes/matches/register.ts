/**
 * On-chain Registration Routes (Client-signed)
 *
 * POST /api/matches/:matchId/register/prepare
 *   → Builds the start_game transaction, returns per-player auth entry XDR
 *
 * POST /api/matches/:matchId/register/auth
 *   → Receives a player's signed auth entry, stores it.
 *     When both arrive, assembles and submits the transaction.
 */

import { getSupabase } from "../../lib/supabase";
import { broadcastGameEvent } from "../../lib/matchmaker";
import { GAME_CONSTANTS } from "../../lib/game-types";
import { createHash } from "node:crypto";
import {
    getConfiguredContractId,
    isOnChainRegistrationConfigured,
    matchIdToSessionId,
    getOnChainMatchStateBySession,
    prepareRegistration,
    setMatchStakeOnChain,
    submitSignedRegistration,
    type PreparedRegistration,
    cancelMatchOnChainWithOptions,
    isStellarConfigured,
} from "../../lib/stellar-contract";

function deterministicSessionCandidate(matchId: string, index: number): number {
    const digest = createHash("sha256").update(`${matchId}:${index}`).digest();
    const value = digest.readUInt32BE(0);
    return (value % 2_147_483_647) + 1;
}

async function reserveUniqueSessionId(matchId: string, preferred: number): Promise<number> {
    const supabase = getSupabase();
    const contractId = getConfiguredContractId() || null;

    const isSessionAvailable = async (sessionId: number): Promise<boolean> => {
        const { data: existing, error: existingError } = await supabase
            .from("matches")
            .select("id")
            .eq("onchain_session_id", sessionId)
            .neq("id", matchId)
            .limit(1);

        if (existingError) {
            throw new Error(`Failed to check reserved on-chain session ids: ${existingError.message}`);
        }

        if ((existing || []).length > 0) return false;

        const onChainState = await getOnChainMatchStateBySession(sessionId, {
            contractId: contractId || undefined,
        });

        return !onChainState;
    };

    const candidates: number[] = [];
    if (Number.isInteger(preferred) && preferred > 0 && preferred <= 2_147_483_647) {
        candidates.push(preferred);
    }

    for (let i = 0; i < 48; i++) {
        candidates.push(deterministicSessionCandidate(matchId, i));
    }

    const seen = new Set<number>();
    for (const sessionId of candidates) {
        if (seen.has(sessionId)) continue;
        seen.add(sessionId);
        if (await isSessionAvailable(sessionId)) {
            return sessionId;
        }
    }

    throw new Error("Unable to reserve a unique on-chain session id after multiple attempts");
}

async function configureStakeIfNeeded(matchId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const supabase = getSupabase();
    const { data: match } = await supabase
        .from("matches")
        .select("stake_amount_stroops")
        .eq("id", matchId)
        .maybeSingle();

    const rawStake = match?.stake_amount_stroops;
    if (!rawStake) return { ok: true };

    let stakeAmountStroops: bigint;
    try {
        stakeAmountStroops = BigInt(rawStake);
    } catch {
        return { ok: false, error: "Invalid stake_amount_stroops in match record" };
    }

    if (stakeAmountStroops <= 0n) return { ok: true };

    const onChainStake = await setMatchStakeOnChain(matchId, stakeAmountStroops);
    if (!onChainStake.success) {
        return { ok: false, error: onChainStake.error || "Failed to configure on-chain stake" };
    }

    return { ok: true };
}

// In-memory store for pending registrations.
// Keyed by matchId → { prepared data, collected signed auth entries }
interface PendingRegistration {
    prepared: PreparedRegistration;
    player1Address: string;
    player2Address: string;
    signedAuthEntries: Record<string, string>; // address → signed XDR
    requiredAuthAddresses: string[];
    submitted: boolean;
}

const pendingRegistrations = new Map<string, PendingRegistration>();

// =============================================================================
// POST /api/matches/:matchId/register/cancel
// =============================================================================

interface CancelRegistrationBody {
    address: string;
    reason?: string;
}

export async function handleCancelRegistration(matchId: string, req: Request): Promise<Response> {
    try {
        const body = (await req.json()) as CancelRegistrationBody;
        const address = body.address?.trim();
        const reason = body.reason?.trim() || "auth_timeout";

        if (!address) {
            return Response.json({ error: "Missing 'address'" }, { status: 400 });
        }

        const supabase = getSupabase();
        const { data: match, error: matchError } = await supabase
            .from("matches")
            .select(
                "id,status,player1_address,player2_address,onchain_session_id,onchain_contract_id,onchain_tx_hash,stake_amount_stroops,player1_stake_confirmed_at,player2_stake_confirmed_at",
            )
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
            return Response.json({ success: true, cancelled: false, reason: "match_completed" });
        }

        if (match.status === "cancelled" || match.status === "abandoned") {
            pendingRegistrations.delete(matchId);
            return Response.json({ success: true, cancelled: true, alreadyCancelled: true });
        }

        // Best-effort on-chain cancellation if a session was already registered.
        // If it fails due to missing session, we still cancel off-chain to unblock UX.
        let onChainTxHash: string | null = null;
        let onChainCancelError: string | null = null;
        const hadStakePaid = !!match.player1_stake_confirmed_at || !!match.player2_stake_confirmed_at;

        if (isStellarConfigured()) {
            try {
                const onChainCancel = await cancelMatchOnChainWithOptions(matchId, {
                    sessionId: typeof match.onchain_session_id === "number" ? match.onchain_session_id : undefined,
                    contractId: match.onchain_contract_id || undefined,
                });

                if (onChainCancel.success) {
                    onChainTxHash = onChainCancel.txHash || null;
                } else {
                    onChainCancelError = onChainCancel.error || "unknown";
                    const isMissingSession = /Contract,\s*#1|MatchNotFound/i.test(onChainCancelError);
                    if (!isMissingSession) {
                        console.warn(`[Register/cancel] cancel_match failed for ${matchId}: ${onChainCancelError}`);
                    }
                    // If stake was paid and we can't confirm on-chain cancellation, surface as a failure.
                    if (hadStakePaid && !isMissingSession) {
                        return Response.json(
                            {
                                error: "Failed to cancel match on-chain; stake refund could not be guaranteed",
                                details: onChainCancelError,
                            },
                            { status: 502 },
                        );
                    }
                }
            } catch (err) {
                onChainCancelError = err instanceof Error ? err.message : String(err);
                console.warn(`[Register/cancel] cancel_match threw for ${matchId}: ${onChainCancelError}`);
            }
        }

        await supabase
            .from("matches")
            .update({
                status: "cancelled",
                completed_at: new Date().toISOString(),
                fight_phase: "match_end",
                // If we cancel during registration, clear any recorded stake confirmations.
                player1_stake_confirmed_at: null,
                player2_stake_confirmed_at: null,
            })
            .eq("id", matchId)
            .in("status", ["waiting", "character_select", "in_progress"]);

        pendingRegistrations.delete(matchId);

        const payload = {
            matchId,
            reason,
            message: "Match cancelled (signature window expired).",
            onChainSessionId: typeof match.onchain_session_id === "number" ? match.onchain_session_id : matchIdToSessionId(matchId),
            onChainTxHash: onChainTxHash || match.onchain_tx_hash || null,
            onChainCancelError,
            redirectTo: "/play",
        };

        await broadcastGameEvent(matchId, "match_cancelled", payload);

        return Response.json({ success: true, cancelled: true, ...payload });
    } catch (err) {
        console.error("[Register/cancel] Error:", err);
        return Response.json(
            { error: err instanceof Error ? err.message : "Failed to cancel match" },
            { status: 500 },
        );
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// POST /api/matches/:matchId/register/prepare
// =============================================================================

export async function handlePrepareRegistration(
    matchId: string,
    _req: Request,
): Promise<Response> {
    try {
        if (!isOnChainRegistrationConfigured()) {
            return Response.json(
                { error: "On-chain registration is not configured" },
                { status: 503 },
            );
        }

        const supabase = getSupabase();

        // Fetch match
        const { data: match, error } = await supabase
            .from("matches")
            .select("player1_address, player2_address, status, is_bot_match, onchain_session_id")
            .eq("id", matchId)
            .single();

        if (error || !match) {
            return Response.json({ error: "Match not found" }, { status: 404 });
        }

        if (match.is_bot_match) {
            return Response.json(
                { error: "Bot matches do not require on-chain registration" },
                { status: 400 },
            );
        }

        // Allow preparation during character_select (both chars locked) or in_progress
        if (!["character_select", "in_progress"].includes(match.status)) {
            // For cancelled/abandoned matches, return a skip response instead of an error
            // so the frontend can proceed gracefully (this happens when a race condition
            // cancels the match between matchmaking and registration).
            if (match.status === "cancelled" || match.status === "abandoned") {
                console.warn(`[Register/prepare] Match ${matchId} is ${match.status}, returning skip`);
                return Response.json({
                    skipped: true,
                    reason: `Match was ${match.status}`,
                    sessionId: 0,
                    authEntries: {},
                    requiredAuthAddresses: [],
                });
            }
            return Response.json(
                { error: `Match is in wrong phase: ${match.status}` },
                { status: 400 },
            );
        }

        // Check if already prepared
        const existing = pendingRegistrations.get(matchId);
        if (existing && !existing.submitted) {
            // Return cached preparation
            return Response.json({
                sessionId: existing.prepared.sessionId,
                authEntries: existing.prepared.authEntries,
                requiredAuthAddresses: existing.requiredAuthAddresses,
                transactionXdr: existing.prepared.transactionXdr,
            });
        }

        const reservedSessionId = typeof match.onchain_session_id === "number"
            ? match.onchain_session_id
            : await reserveUniqueSessionId(matchId, matchIdToSessionId(matchId));

        // Prepare the transaction
        const prepared = await prepareRegistration(
            matchId,
            match.player1_address,
            match.player2_address,
            { sessionId: reservedSessionId },
        );

        // Store pending registration
        pendingRegistrations.set(matchId, {
            prepared,
            player1Address: match.player1_address,
            player2Address: match.player2_address,
            signedAuthEntries: {},
            requiredAuthAddresses: prepared.requiredAuthAddresses,
            submitted: false,
        });

        if (prepared.requiredAuthAddresses.length === 0) {
            const result = await submitSignedRegistration(
                matchId,
                match.player1_address,
                match.player2_address,
                {},
                prepared.transactionXdr,
                { sessionId: prepared.sessionId },
            );

            if (!result.success) {
                pendingRegistrations.delete(matchId);
                return Response.json(
                    { error: result.error || "On-chain submission failed" },
                    { status: 500 },
                );
            }

            if (result.sessionId) {
                await supabase
                    .from("matches")
                    .update({
                        onchain_session_id: result.sessionId,
                        onchain_tx_hash: result.txHash || null,
                        onchain_contract_id: getConfiguredContractId() || null,
                    })
                    .eq("id", matchId);
            }

            const stakeConfig = await configureStakeIfNeeded(matchId);
            if (!stakeConfig.ok) {
                pendingRegistrations.delete(matchId);
                return Response.json(
                    { error: stakeConfig.error },
                    { status: 500 },
                );
            }

            await broadcastGameEvent(matchId, "registration_complete", {
                sessionId: result.sessionId,
                txHash: result.txHash,
            });

            pendingRegistrations.delete(matchId);

            return Response.json({
                sessionId: prepared.sessionId,
                authEntries: prepared.authEntries,
                requiredAuthAddresses: prepared.requiredAuthAddresses,
                transactionXdr: prepared.transactionXdr,
                submitted: true,
                txHash: result.txHash,
            });
        }

        return Response.json({
            sessionId: prepared.sessionId,
            authEntries: prepared.authEntries,
            requiredAuthAddresses: prepared.requiredAuthAddresses,
            transactionXdr: prepared.transactionXdr,
        });
    } catch (err) {
        console.error("[Register/prepare] Error:", err);
        return Response.json(
            { error: err instanceof Error ? err.message : "Failed to prepare registration" },
            { status: 500 },
        );
    }
}

// =============================================================================
// POST /api/matches/:matchId/register/auth
// =============================================================================

interface SubmitAuthBody {
    address: string;
    signedAuthEntryXdr: string;
    transactionXdr?: string;
    requiredAuthAddresses?: string[];
}

export async function handleSubmitAuth(
    matchId: string,
    req: Request,
): Promise<Response> {
    try {
        const body = (await req.json()) as SubmitAuthBody;

        if (!body.address || !body.signedAuthEntryXdr) {
            return Response.json(
                { error: "Missing 'address' or 'signedAuthEntryXdr'" },
                { status: 400 },
            );
        }

        let pending = pendingRegistrations.get(matchId);
        if (!pending) {
            // Server may have restarted / hot-reloaded between prepare and auth.
            // If the client includes the prepared tx XDR, reconstruct a pending record.
            if (!body.transactionXdr) {
                return Response.json(
                    { error: "No pending registration found. Call /register/prepare first." },
                    { status: 404 },
                );
            }

            const supabase = getSupabase();
            const { data: match, error } = await supabase
                .from("matches")
                .select("player1_address, player2_address, status, is_bot_match, onchain_session_id")
                .eq("id", matchId)
                .single();

            if (error || !match) {
                return Response.json({ error: "Match not found" }, { status: 404 });
            }

            if (match.is_bot_match) {
                return Response.json(
                    { error: "Bot matches do not require on-chain registration" },
                    { status: 400 },
                );
            }

            if (!["character_select", "in_progress"].includes(match.status)) {
                if (match.status === "cancelled" || match.status === "abandoned") {
                    console.warn(`[Register/auth] Match ${matchId} is ${match.status}, returning skip`);
                    return Response.json({
                        success: true,
                        skipped: true,
                        reason: `Match was ${match.status}`,
                    });
                }
                return Response.json(
                    { error: `Match is in wrong phase: ${match.status}` },
                    { status: 400 },
                );
            }

            const reconstructedRequired =
                body.requiredAuthAddresses && body.requiredAuthAddresses.length > 0
                    ? body.requiredAuthAddresses
                    : [match.player1_address, match.player2_address];

            const reconstructedSessionId = typeof match.onchain_session_id === "number"
                ? match.onchain_session_id
                : await reserveUniqueSessionId(matchId, matchIdToSessionId(matchId));

            pending = {
                prepared: {
                    sessionId: reconstructedSessionId,
                    authEntries: {},
                    requiredAuthAddresses: reconstructedRequired,
                    transactionXdr: body.transactionXdr,
                },
                player1Address: match.player1_address,
                player2Address: match.player2_address,
                signedAuthEntries: {},
                requiredAuthAddresses: reconstructedRequired,
                submitted: false,
            };

            pendingRegistrations.set(matchId, pending);
        }

        if (pending.submitted) {
            return Response.json({
                success: true,
                alreadySubmitted: true,
                message: "Registration already submitted on-chain",
            });
        }

        // Verify the address is a participant
        if (
            body.address !== pending.player1Address &&
            body.address !== pending.player2Address
        ) {
            return Response.json(
                { error: "Address is not a participant in this match" },
                { status: 403 },
            );
        }

        // Store the signed auth entry
        pending.signedAuthEntries[body.address] = body.signedAuthEntryXdr;
        console.log(
            `[Register/auth] Received signed auth from ${body.address.slice(0, 8)}… for match ${matchId.slice(0, 8)}…`,
        );

        // Check if both players have signed
        const required = pending.requiredAuthAddresses.length > 0
            ? pending.requiredAuthAddresses
            : [pending.player1Address, pending.player2Address];

        const hasBoth = required.every((addr) => pending.signedAuthEntries[addr]);

        if (!hasBoth) {
            // Broadcast to notify the other player we've signed
            await broadcastGameEvent(matchId, "registration_auth_received", {
                address: body.address,
            });

            return Response.json({
                success: true,
                bothSigned: false,
                message: "Auth entry received, waiting for opponent",
            });
        }

        // Both signed — assemble and submit
        pending.submitted = true;

        const maxSubmitAttempts = 4;
        let txXdrCandidate = pending.prepared.transactionXdr;
        let result = await submitSignedRegistration(
            matchId,
            pending.player1Address,
            pending.player2Address,
            pending.signedAuthEntries,
            txXdrCandidate,
            { sessionId: pending.prepared.sessionId },
        );

        for (let attempt = 2; attempt <= maxSubmitAttempts; attempt++) {
            if (result.success) break;
            if (!/txBadSeq/i.test(result.error || "")) break;

            try {
                const refreshed = await prepareRegistration(
                    matchId,
                    pending.player1Address,
                    pending.player2Address,
                    { sessionId: pending.prepared.sessionId },
                );

                pending.prepared = refreshed;
                pending.requiredAuthAddresses = refreshed.requiredAuthAddresses;
                txXdrCandidate = refreshed.transactionXdr;
            } catch (refreshErr) {
                const refreshMessage = refreshErr instanceof Error ? refreshErr.message : String(refreshErr);
                result = {
                    success: false,
                    error: `txBadSeq recovery failed while rebuilding tx: ${refreshMessage}`,
                };
                break;
            }

            await sleep(120 * (attempt - 1));

            result = await submitSignedRegistration(
                matchId,
                pending.player1Address,
                pending.player2Address,
                pending.signedAuthEntries,
                txXdrCandidate,
                { sessionId: pending.prepared.sessionId },
            );
        }

        if (!result.success && /txBadSeq/i.test(result.error || "")) {
            const recoveredOnChainState = await getOnChainMatchStateBySession(
                pending.prepared.sessionId,
                { contractId: getConfiguredContractId() || undefined },
            );

            if (recoveredOnChainState) {
                result = {
                    success: true,
                    sessionId: pending.prepared.sessionId,
                };
            }
        }

        // Store on-chain session ID in match metadata
        const supabase = getSupabase();
        if (result.sessionId) {
            await supabase
                .from("matches")
                .update({
                    onchain_session_id: result.sessionId,
                    onchain_tx_hash: result.txHash || null,
                    onchain_contract_id: getConfiguredContractId() || null,
                })
                .eq("id", matchId);
        }

        if (!result.success) {
            // Reset so players can retry
            pending.submitted = false;
            pending.signedAuthEntries = {};

            await broadcastGameEvent(matchId, "registration_failed", {
                error: result.error,
            });

            return Response.json(
                { error: result.error || "On-chain submission failed" },
                { status: 500 },
            );
        }

        const stakeConfig = await configureStakeIfNeeded(matchId);
        if (!stakeConfig.ok) {
            pending.submitted = false;
            pending.signedAuthEntries = {};

            await broadcastGameEvent(matchId, "registration_failed", {
                error: stakeConfig.error,
            });

            return Response.json(
                { error: stakeConfig.error },
                { status: 500 },
            );
        }

        // Broadcast success
        await broadcastGameEvent(matchId, "registration_complete", {
            sessionId: result.sessionId,
            txHash: result.txHash,
        });

        // Clean up
        pendingRegistrations.delete(matchId);

        console.log(
            `[Register/auth] On-chain registration complete for match ${matchId.slice(0, 8)}… TX: ${result.txHash || "n/a"}`,
        );

        return Response.json({
            success: true,
            bothSigned: true,
            sessionId: result.sessionId,
            txHash: result.txHash,
        });
    } catch (err) {
        console.error("[Register/auth] Error:", err);
        return Response.json(
            { error: err instanceof Error ? err.message : "Failed to submit auth" },
            { status: 500 },
        );
    }
}
