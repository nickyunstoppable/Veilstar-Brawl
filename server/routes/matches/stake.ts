import { getSupabase } from "../../lib/supabase";
import { broadcastGameEvent } from "../../lib/matchmaker";
import { GAME_CONSTANTS } from "../../lib/game-types";
import {
    expireStakeOnChain,
    getOnChainMatchState,
    isClientSignedActionConfigured,
    prepareStakeDepositOnChain,
    setMatchStakeOnChain,
    submitSignedStakeDepositOnChain,
} from "../../lib/stellar-contract";

interface PrepareStakeBody {
    address: string;
}

interface SubmitStakeBody {
    address: string;
    signedAuthEntryXdr?: string;
    transactionXdr?: string;
}

interface ExpireStakeBody {
    address?: string;
}

function parseStroops(raw: unknown): bigint {
    try {
        if (raw === null || raw === undefined || raw === "") return 0n;
        return BigInt(String(raw));
    } catch {
        return 0n;
    }
}

function calcFee(stakeAmountStroops: bigint, feeBps: number): bigint {
    return ((stakeAmountStroops * BigInt(feeBps)) + 9999n) / 10000n;
}

function getStakeStatus(match: any, address: string) {
    const isPlayer1 = match.player1_address === address;
    const isPlayer2 = match.player2_address === address;
    const myConfirmed = isPlayer1
        ? !!match.player1_stake_confirmed_at
        : isPlayer2
            ? !!match.player2_stake_confirmed_at
            : false;
    const opponentConfirmed = isPlayer1
        ? !!match.player2_stake_confirmed_at
        : isPlayer2
            ? !!match.player1_stake_confirmed_at
            : false;

    return {
        isPlayer1,
        isPlayer2,
        myConfirmed,
        opponentConfirmed,
        bothConfirmed: !!match.player1_stake_confirmed_at && !!match.player2_stake_confirmed_at,
    };
}

function unwrapPossibleResult(value: any): any {
    if (!value || typeof value !== "object") return value;

    try {
        if (typeof value.isOk === "function" && typeof value.unwrap === "function" && value.isOk()) {
            return value.unwrap();
        }
    } catch {
        // ignore unwrap errors
    }

    if ("ok" in value) return (value as any).ok;
    if ("value" in value) return (value as any).value;
    if ("result" in value) return (value as any).result;

    return value;
}

function readStakePaidFlags(rawState: any): { player1Paid: boolean; player2Paid: boolean } {
    const state = unwrapPossibleResult(rawState);
    if (!state || typeof state !== "object") {
        return { player1Paid: false, player2Paid: false };
    }

    const player1Paid =
        Boolean((state as any).player1_stake_paid)
        || Boolean((state as any).player1StakePaid);

    const player2Paid =
        Boolean((state as any).player2_stake_paid)
        || Boolean((state as any).player2StakePaid);

    return { player1Paid, player2Paid };
}

async function reconcileStakeConfirmationsFromChain(matchId: string, match: any): Promise<any> {
    const hasStake = parseStroops(match?.stake_amount_stroops) > 0n;
    if (!hasStake) return match;

    const onChainState = await getOnChainMatchState(matchId);
    const paidFlags = readStakePaidFlags(onChainState);

    const needsP1 = paidFlags.player1Paid && !match.player1_stake_confirmed_at;
    const needsP2 = paidFlags.player2Paid && !match.player2_stake_confirmed_at;

    if (!needsP1 && !needsP2) {
        return match;
    }

    const supabase = getSupabase();
    const nowIso = new Date().toISOString();
    const updateData: Record<string, unknown> = {};

    if (needsP1) {
        updateData.player1_stake_confirmed_at = nowIso;
    }
    if (needsP2) {
        updateData.player2_stake_confirmed_at = nowIso;
    }

    const { error } = await supabase
        .from("matches")
        .update(updateData)
        .eq("id", matchId);

    if (error) {
        console.warn("[Stake Reconcile] Failed to persist reconciled stake flags:", error.message);
        return match;
    }

    return {
        ...match,
        player1_stake_confirmed_at: needsP1 ? nowIso : match.player1_stake_confirmed_at,
        player2_stake_confirmed_at: needsP2 ? nowIso : match.player2_stake_confirmed_at,
    };
}

export async function handlePrepareStakeDeposit(
    matchId: string,
    req: Request,
): Promise<Response> {
    try {
        if (!isClientSignedActionConfigured()) {
            return Response.json(
                { error: "On-chain stake signing is not configured" },
                { status: 503 },
            );
        }

        const body = await req.json() as PrepareStakeBody;
        if (!body.address) {
            return Response.json(
                { error: "Missing 'address' in request body" },
                { status: 400 },
            );
        }

        const supabase = getSupabase();
        const { data: match, error: matchError } = await supabase
            .from("matches")
            .select("id,player1_address,player2_address,status,stake_amount_stroops,stake_fee_bps,player1_stake_confirmed_at,player2_stake_confirmed_at")
            .eq("id", matchId)
            .single();

        if (matchError) {
            console.error("[Stake Prepare] Failed to load match:", matchError);
            return Response.json({ error: "Failed to load match for stake prepare", details: matchError.message }, { status: 500 });
        }

        if (!match) {
            return Response.json({ error: "Match not found" }, { status: 404 });
        }

        let effectiveMatch = match;

        try {
            effectiveMatch = await reconcileStakeConfirmationsFromChain(matchId, match);
        } catch (reconcileError) {
            console.warn("[Stake Prepare] Reconcile skipped:", reconcileError instanceof Error ? reconcileError.message : String(reconcileError));
        }

        const stakeStatus = getStakeStatus(effectiveMatch, body.address);
        if (!stakeStatus.isPlayer1 && !stakeStatus.isPlayer2) {
            return Response.json(
                { error: "You are not a participant in this match" },
                { status: 403 },
            );
        }

        if (effectiveMatch.status !== "character_select") {
            return Response.json(
                { error: `Stake deposit is only allowed in character_select (status: ${effectiveMatch.status})` },
                { status: 400 },
            );
        }

        if (!effectiveMatch.stake_amount_stroops) {
            return Response.json(
                { error: "This match does not require stake deposit" },
                { status: 400 },
            );
        }

        let stakeAmountStroops: bigint;
        try {
            stakeAmountStroops = BigInt(effectiveMatch.stake_amount_stroops);
        } catch {
            return Response.json(
                { error: "Invalid stake amount on match" },
                { status: 500 },
            );
        }

        if (stakeAmountStroops <= 0n) {
            return Response.json(
                { error: "Invalid stake amount on match" },
                { status: 500 },
            );
        }

        if (stakeStatus.myConfirmed) {
            return Response.json(
                {
                    success: true,
                    alreadyConfirmed: true,
                    myConfirmed: true,
                    opponentConfirmed: stakeStatus.opponentConfirmed,
                    bothConfirmed: stakeStatus.bothConfirmed,
                },
                { status: 200 },
            );
        }

        const feeBps = Number(effectiveMatch.stake_fee_bps || 10);
        const feeStroops = calcFee(stakeAmountStroops, feeBps);
        const requiredDepositStroops = stakeAmountStroops + feeStroops;

        let prepared;
        try {
            prepared = await prepareStakeDepositOnChain(matchId, body.address);
        } catch (prepareError) {
            const message = prepareError instanceof Error ? prepareError.message : String(prepareError);
            if (/Contract,\s*#8|StakeNotConfigured/i.test(message)) {
                console.warn(`[Stake Prepare] Stake not configured on-chain for match ${matchId.slice(0, 8)}…, attempting auto-configure and retry`);

                const setStake = await setMatchStakeOnChain(matchId, stakeAmountStroops);
                if (!setStake.success) {
                    const setStakeError = setStake.error || "";

                    // Reconcile with chain state first: in concurrent flows one configure may succeed
                    // while the other observes a transient/sequence error.
                    let chainHasStakeConfigured = false;
                    try {
                        const onChainState = await getOnChainMatchState(matchId);
                        const state = unwrapPossibleResult(onChainState);
                        const configuredStake =
                            parseStroops((state as any)?.stake_amount_stroops)
                            || parseStroops((state as any)?.stakeAmountStroops);
                        chainHasStakeConfigured = configuredStake > 0n;
                    } catch {
                        chainHasStakeConfigured = false;
                    }

                    if (!chainHasStakeConfigured) {
                        if (/Contract,\s*#1|MatchNotFound/i.test(setStakeError)) {
                            return Response.json(
                                { error: "On-chain registration not complete yet. Wait for both players to finish registration signatures first." },
                                { status: 409 },
                            );
                        }

                        return Response.json(
                            {
                                error: "Failed to configure on-chain stake before deposit",
                                details: setStakeError || null,
                            },
                            { status: 502 },
                        );
                    }

                    console.warn(`[Stake Prepare] Configure call failed but on-chain stake is already configured for match ${matchId.slice(0, 8)}…, continuing`);
                }

                prepared = await prepareStakeDepositOnChain(matchId, body.address);
            }

            if (/MatchNotFound|Contract,#1|match not found|MissingValue/i.test(message)) {
                return Response.json(
                    { error: "On-chain registration not complete yet. Wait for both players to finish registration signatures first." },
                    { status: 409 },
                );
            }
            if (!prepared) {
                throw prepareError;
            }
        }

        return Response.json({
            success: true,
            sessionId: prepared.sessionId,
            transactionXdr: prepared.transactionXdr,
            authEntryXdr: prepared.authEntryXdr,
            stakeAmountStroops: stakeAmountStroops.toString(),
            feeStroops: feeStroops.toString(),
            requiredDepositStroops: requiredDepositStroops.toString(),
            myConfirmed: stakeStatus.myConfirmed,
            opponentConfirmed: stakeStatus.opponentConfirmed,
            bothConfirmed: stakeStatus.bothConfirmed,
        });
    } catch (err) {
        console.error("[Stake Prepare] Error:", err);
        return Response.json(
            { error: err instanceof Error ? err.message : "Failed to prepare stake deposit" },
            { status: 500 },
        );
    }
}

export async function handleSubmitStakeDeposit(
    matchId: string,
    req: Request,
): Promise<Response> {
    try {
        if (!isClientSignedActionConfigured()) {
            return Response.json(
                { error: "On-chain stake signing is not configured" },
                { status: 503 },
            );
        }

        const body = await req.json() as SubmitStakeBody;
        if (!body.address || !body.signedAuthEntryXdr || !body.transactionXdr) {
            return Response.json(
                { error: "Missing 'address', 'signedAuthEntryXdr', or 'transactionXdr' in request body" },
                { status: 400 },
            );
        }

        const supabase = getSupabase();
        const { data: match, error: matchError } = await supabase
            .from("matches")
            .select("id,player1_address,player2_address,status,stake_amount_stroops,player1_stake_confirmed_at,player2_stake_confirmed_at,selection_deadline_at")
            .eq("id", matchId)
            .single();

        if (matchError || !match) {
            return Response.json({ error: "Match not found" }, { status: 404 });
        }

        const stakeStatus = getStakeStatus(match, body.address);
        if (!stakeStatus.isPlayer1 && !stakeStatus.isPlayer2) {
            return Response.json(
                { error: "You are not a participant in this match" },
                { status: 403 },
            );
        }

        if (match.status !== "character_select") {
            return Response.json(
                { error: `Stake deposit is only allowed in character_select (status: ${match.status})` },
                { status: 400 },
            );
        }

        if (!match.stake_amount_stroops) {
            return Response.json(
                { error: "This match does not require stake deposit" },
                { status: 400 },
            );
        }

        if (stakeStatus.myConfirmed) {
            return Response.json({
                success: true,
                alreadyConfirmed: true,
                myConfirmed: true,
                opponentConfirmed: stakeStatus.opponentConfirmed,
                bothConfirmed: stakeStatus.bothConfirmed,
                selectionDeadlineAt: match.selection_deadline_at,
            });
        }

        const onChainResult = await submitSignedStakeDepositOnChain(
            matchId,
            body.address,
            body.signedAuthEntryXdr,
            body.transactionXdr,
        );

        let effectiveTxHash = onChainResult.txHash || null;

        if (!onChainResult.success) {
            const onChainError = onChainResult.error || "";
            const isAlreadyPaid = /Contract,\s*#9|StakeAlreadyPaid/i.test(onChainError);
            const isTransient = /TRY_AGAIN_LATER|timeout|temporar|txBadSeq|network|429|503/i.test(onChainError);

            let reconciledPaid = false;
            if (isAlreadyPaid || isTransient) {
                try {
                    const onChainState = await getOnChainMatchState(matchId);
                    const paidFlags = readStakePaidFlags(onChainState);
                    reconciledPaid = stakeStatus.isPlayer1 ? paidFlags.player1Paid : paidFlags.player2Paid;
                } catch {
                    reconciledPaid = false;
                }
            }

            if (!reconciledPaid) {
                return Response.json(
                    {
                        error: "On-chain stake transaction failed",
                        details: onChainResult.error || null,
                    },
                    { status: 502 },
                );
            }
        }

        const nowIso = new Date().toISOString();
        const updateData: Record<string, unknown> = stakeStatus.isPlayer1
            ? {
                player1_stake_tx_id: effectiveTxHash,
                player1_stake_confirmed_at: nowIso,
            }
            : {
                player2_stake_tx_id: effectiveTxHash,
                player2_stake_confirmed_at: nowIso,
            };

        const { error: updateError } = await supabase
            .from("matches")
            .update(updateData)
            .eq("id", matchId);

        if (updateError) {
            return Response.json(
                { error: "Stake transaction succeeded on-chain but failed to persist match state" },
                { status: 500 },
            );
        }

        const { data: refreshed } = await supabase
            .from("matches")
            .select("id,player1_stake_confirmed_at,player2_stake_confirmed_at,selection_deadline_at")
            .eq("id", matchId)
            .single();

        const playerRole = stakeStatus.isPlayer1 ? "player1" : "player2";
        const bothConfirmed = !!refreshed?.player1_stake_confirmed_at && !!refreshed?.player2_stake_confirmed_at;

        let selectionDeadlineAt = refreshed?.selection_deadline_at ?? null;
        if (bothConfirmed && !selectionDeadlineAt) {
            selectionDeadlineAt = new Date(
                Date.now() + GAME_CONSTANTS.CHARACTER_SELECT_SECONDS * 1000,
            ).toISOString();

            await supabase
                .from("matches")
                .update({ selection_deadline_at: selectionDeadlineAt })
                .eq("id", matchId)
                .is("selection_deadline_at", null);
        }

        await broadcastGameEvent(matchId, "stake_confirmed", {
            player: playerRole,
            txHash: effectiveTxHash,
            bothConfirmed,
        });

        if (bothConfirmed) {
            await broadcastGameEvent(matchId, "stake_ready", {
                selectionDeadlineAt,
            });
        }

        return Response.json({
            success: true,
            txHash: effectiveTxHash,
            myConfirmed: true,
            opponentConfirmed: stakeStatus.opponentConfirmed || bothConfirmed,
            bothConfirmed,
            selectionDeadlineAt,
        });
    } catch (err) {
        console.error("[Stake Submit] Error:", err);
        return Response.json(
            { error: err instanceof Error ? err.message : "Failed to submit stake deposit" },
            { status: 500 },
        );
    }
}

export async function handleExpireStakeDepositWindow(
    matchId: string,
    req: Request,
): Promise<Response> {
    try {
        const body = await req.json().catch(() => ({} as ExpireStakeBody)) as ExpireStakeBody;
        const requesterAddress = body.address?.trim();

        const supabase = getSupabase();
        const { data: match, error: matchError } = await supabase
            .from("matches")
            .select("id,status,player1_address,player2_address,stake_amount_stroops,stake_deadline_at,player1_stake_confirmed_at,player2_stake_confirmed_at")
            .eq("id", matchId)
            .single();

        if (matchError || !match) {
            return Response.json({ error: "Match not found" }, { status: 404 });
        }

        const isParticipant = requesterAddress
            ? requesterAddress === match.player1_address || requesterAddress === match.player2_address
            : true;
        if (!isParticipant) {
            return Response.json({ error: "You are not a participant in this match" }, { status: 403 });
        }

        if (!match.stake_amount_stroops || parseStroops(match.stake_amount_stroops) <= 0n) {
            return Response.json({ success: true, cancelled: false, reason: "no_stake_required" });
        }

        if (match.status === "cancelled" || match.status === "completed") {
            return Response.json({ success: true, cancelled: false, reason: `match_${match.status}` });
        }

        const deadlineMs = match.stake_deadline_at ? new Date(match.stake_deadline_at).getTime() : 0;
        if (!deadlineMs || Date.now() < deadlineMs) {
            return Response.json({
                success: true,
                cancelled: false,
                reason: "deadline_not_reached",
                remainingMs: Math.max(0, deadlineMs - Date.now()),
            });
        }

        const player1Paid = !!match.player1_stake_confirmed_at;
        const player2Paid = !!match.player2_stake_confirmed_at;
        const refundedAddress = player1Paid && !player2Paid
            ? match.player1_address
            : player2Paid && !player1Paid
                ? match.player2_address
                : null;

        const onChainExpire = await expireStakeOnChain(matchId);
        if (!onChainExpire.success) {
            return Response.json(
                {
                    error: "Failed to expire stake window on-chain",
                    details: onChainExpire.error || null,
                },
                { status: 502 },
            );
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
            .in("status", ["waiting", "character_select", "in_progress"]);

        await broadcastGameEvent(matchId, "match_cancelled", {
            matchId,
            reason: refundedAddress ? "stake_timeout_one_refunded" : "stake_timeout_both_unpaid",
            refundedAddress,
            message: refundedAddress
                ? "Stake window expired. Match cancelled and deposited stake refunded on-chain."
                : "Stake window expired. Match cancelled.",
            redirectTo: "/play",
        });

        return Response.json({
            success: true,
            cancelled: true,
            refundedAddress,
            onChainTxHash: onChainExpire.txHash || null,
        });
    } catch (err) {
        console.error("[Stake Expire] Error:", err);
        return Response.json(
            { error: err instanceof Error ? err.message : "Failed to expire stake deposit window" },
            { status: 500 },
        );
    }
}
