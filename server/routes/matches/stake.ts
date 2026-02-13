import { getSupabase } from "../../lib/supabase";
import { broadcastGameEvent } from "../../lib/matchmaker";
import { GAME_CONSTANTS } from "../../lib/game-types";
import {
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

        let stakeAmountStroops: bigint;
        try {
            stakeAmountStroops = BigInt(match.stake_amount_stroops);
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

        const feeBps = Number(match.stake_fee_bps || 10);
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
                    return Response.json(
                        {
                            error: "Failed to configure on-chain stake before deposit",
                            details: setStake.error || null,
                        },
                        { status: 502 },
                    );
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

        if (!onChainResult.success) {
            return Response.json(
                {
                    error: "On-chain stake transaction failed",
                    details: onChainResult.error || null,
                },
                { status: 502 },
            );
        }

        const nowIso = new Date().toISOString();
        const updateData: Record<string, unknown> = stakeStatus.isPlayer1
            ? {
                player1_stake_tx_id: onChainResult.txHash || null,
                player1_stake_confirmed_at: nowIso,
            }
            : {
                player2_stake_tx_id: onChainResult.txHash || null,
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
            txHash: onChainResult.txHash,
            bothConfirmed,
        });

        if (bothConfirmed) {
            await broadcastGameEvent(matchId, "stake_ready", {
                selectionDeadlineAt,
            });
        }

        return Response.json({
            success: true,
            txHash: onChainResult.txHash,
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
