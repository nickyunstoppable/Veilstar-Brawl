import { getSupabase } from "../../lib/supabase";
import { broadcastGameEvent } from "../../lib/matchmaker";
import { verifyNoirProof } from "../../lib/zk-proof";
import { isValidMove } from "../../lib/round-resolver";
import { GAME_CONSTANTS, type MoveType } from "../../lib/game-types";
import { isPowerSurgeCardId, type PowerSurgeCardId } from "../../lib/power-surge";
import { resolveTurn } from "../../lib/combat-resolver";
import { isOnChainRegistrationConfigured, prepareZkCommitOnChain, setZkGateRequiredOnChain, setZkVerifierContractOnChain, setZkVerifierVkIdOnChain, submitSignedZkCommitOnChain, submitZkCommitOnChain, submitZkVerificationOnChain } from "../../lib/stellar-contract";

const PRIVATE_ROUNDS_ENABLED = (process.env.ZK_PRIVATE_ROUNDS ?? "true") !== "false";
const ZK_ONCHAIN_COMMIT_GATE = (process.env.ZK_ONCHAIN_COMMIT_GATE ?? "true") !== "false";
const ZK_GROTH16_VERIFIER_CONTRACT_ID = (process.env.ZK_GROTH16_VERIFIER_CONTRACT_ID || "").trim();
const ZK_GROTH16_VK_ID = (process.env.ZK_GROTH16_VK_ID || "").trim();
const privateRoundResolveLocks = new Set<string>();
const RESOLVE_LOCK_STALE_SECONDS = Number(process.env.ZK_RESOLVE_LOCK_STALE_SECONDS ?? "45");
const RESOLVE_LOCK_OWNER = `${process.env.FLY_ALLOC_ID || process.env.HOSTNAME || "local"}:${process.pid}`;
const onChainSetupCache = new Map<string, {
    gateEnabled?: boolean;
    verifierConfigured?: boolean;
    vkConfigured?: boolean;
}>();

interface CommitPrivateRoundBody {
    clientTraceId?: string;
    address?: string;
    roundNumber?: number;
    turnNumber?: number;
    commitment?: string;
    proof?: string;
    publicInputs?: unknown;
    transcriptHash?: string;
    encryptedPlan?: string;
    onChainCommitTxHash?: string;
    signedAuthEntryXdr?: string;
    transactionXdr?: string;
}

interface PrepareCommitPrivateRoundBody {
    clientTraceId?: string;
    address?: string;
    roundNumber?: number;
    turnNumber?: number;
    commitment?: string;
}

interface ResolvePrivateRoundBody {
    address?: string;
    roundNumber?: number;
    turnNumber?: number;
    move?: MoveType;
    movePlan?: MoveType[];
    surgeCardId?: PowerSurgeCardId | null;
    proof?: string;
    publicInputs?: unknown;
    transcriptHash?: string;
    expectedWinnerAddress?: string;
}

interface PrivateRoundPlanPayload {
    move?: MoveType;
    movePlan?: MoveType[];
    surgeCardId?: PowerSurgeCardId | null;
}

const PRIVATE_ROUND_PLAN_TURNS = 10;

type ResolveLockState = "acquired" | "in_progress" | "resolved";

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableSetupError(raw: string): boolean {
    return /TRY_AGAIN_LATER|txBadSeq|\bDUPLICATE\b|temporar|timeout|network failed|Sending the transaction to the network failed/i.test(raw);
}

async function runSetupWithRetry(
    label: string,
    fn: () => Promise<{ success: boolean; error?: string | null }>,
    maxAttempts: number = 4,
): Promise<{ success: boolean; error?: string | null }> {
    let lastError: string | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const result = await fn();
        if (result.success) {
            return { success: true };
        }

        const errorText = String(result.error || "");
        lastError = errorText;
        if (!isRetryableSetupError(errorText) || attempt === maxAttempts) {
            return { success: false, error: errorText };
        }

        const backoffMs = 200 * attempt;
        console.warn(`[ZK Round Commit] Retryable setup error for ${label} (attempt ${attempt}/${maxAttempts}) - retrying in ${backoffMs}ms: ${errorText}`);
        await sleep(backoffMs);
    }

    return { success: false, error: lastError };
}

async function getResolvedRoundIdFromCommits(
    matchId: string,
    roundNumber: number,
): Promise<string | null> {
    const supabase = getSupabase();
    const { data } = await supabase
        .from("round_private_commits")
        .select("resolved_round_id")
        .eq("match_id", matchId)
        .eq("round_number", roundNumber)
        .not("resolved_round_id", "is", null)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

    return (data as any)?.resolved_round_id || null;
}

async function acquireDistributedResolveLock(
    matchId: string,
    roundNumber: number,
): Promise<{ state: ResolveLockState; resolvedRoundId?: string | null; useInMemoryFallback?: boolean }> {
    const supabase = getSupabase();
    const nowIso = new Date().toISOString();

    const { error: insertError } = await supabase
        .from("round_resolution_locks")
        .insert({
            match_id: matchId,
            round_number: roundNumber,
            lock_owner: RESOLVE_LOCK_OWNER,
            lock_acquired_at: nowIso,
            resolved_round_id: null,
            resolved_at: null,
            updated_at: nowIso,
        });

    if (!insertError) {
        return { state: "acquired" };
    }

    // If migration has not been applied yet, fallback to in-memory lock to avoid hard break.
    if ((insertError as any)?.code === "42P01") {
        return { state: "acquired", useInMemoryFallback: true };
    }

    // Unique conflict means another resolver already created/holds a lock row.
    if ((insertError as any)?.code !== "23505") {
        throw new Error(`Failed to acquire distributed resolve lock: ${insertError.message}`);
    }

    const { data: existing, error: existingError } = await supabase
        .from("round_resolution_locks")
        .select("resolved_round_id, lock_acquired_at")
        .eq("match_id", matchId)
        .eq("round_number", roundNumber)
        .maybeSingle();

    if (existingError) {
        throw new Error(`Failed to read distributed resolve lock: ${existingError.message}`);
    }

    const existingResolvedRoundId = (existing as any)?.resolved_round_id || null;
    if (existingResolvedRoundId) {
        return { state: "resolved", resolvedRoundId: existingResolvedRoundId };
    }

    const staleBeforeIso = new Date(Date.now() - Math.max(1, RESOLVE_LOCK_STALE_SECONDS) * 1000).toISOString();
    const { data: takeover, error: takeoverError } = await supabase
        .from("round_resolution_locks")
        .update({
            lock_owner: RESOLVE_LOCK_OWNER,
            lock_acquired_at: nowIso,
            updated_at: nowIso,
        })
        .eq("match_id", matchId)
        .eq("round_number", roundNumber)
        .is("resolved_round_id", null)
        .lt("lock_acquired_at", staleBeforeIso)
        .select("match_id")
        .maybeSingle();

    if (takeoverError) {
        throw new Error(`Failed to attempt stale resolve lock takeover: ${takeoverError.message}`);
    }

    if (takeover?.match_id) {
        return { state: "acquired" };
    }

    return { state: "in_progress" };
}

async function markDistributedResolveLockResolved(
    matchId: string,
    roundNumber: number,
    resolvedRoundId: string,
): Promise<void> {
    const supabase = getSupabase();
    const nowIso = new Date().toISOString();

    const { error } = await supabase
        .from("round_resolution_locks")
        .update({
            resolved_round_id: resolvedRoundId,
            resolved_at: nowIso,
            updated_at: nowIso,
        })
        .eq("match_id", matchId)
        .eq("round_number", roundNumber);

    if (error && (error as any)?.code !== "42P01") {
        throw new Error(`Failed to persist distributed resolve completion: ${error.message}`);
    }
}

function privateModeGuard(): Response | null {
    if (!PRIVATE_ROUNDS_ENABLED) {
        return Response.json(
            { error: "ZK private round mode is disabled (set ZK_PRIVATE_ROUNDS=true)" },
            { status: 409 },
        );
    }
    return null;
}

async function getOrCreateRoundTurn(matchId: string, roundNumber: number, turnNumber: number) {
    const supabase = getSupabase();
    const { data: existing } = await supabase
        .from("rounds")
        .select("*")
        .eq("match_id", matchId)
        .eq("round_number", roundNumber)
        .eq("turn_number", turnNumber)
        .limit(1)
        .maybeSingle();

    if (existing) {
        return existing;
    }

    const moveDeadlineAt = new Date(Date.now() + GAME_CONSTANTS.MOVE_TIMER_SECONDS * 1000).toISOString();
    const { data: created, error } = await supabase
        .from("rounds")
        .insert({
            match_id: matchId,
            round_number: roundNumber,
            turn_number: turnNumber,
            move_deadline_at: moveDeadlineAt,
            countdown_seconds: 0,
        })
        .select("*")
        .single();

    if (error || !created) {
        throw new Error("Failed to create round for private commit flow");
    }

    return created;
}

export async function handleCommitPrivateRoundPlan(matchId: string, req: Request): Promise<Response> {
    try {
        const guard = privateModeGuard();
        if (guard) return guard;

        const body = await req.json() as CommitPrivateRoundBody;
        const clientTraceId = (body.clientTraceId || "").trim() || null;
        const address = body.address?.trim();
        const commitment = body.commitment?.trim();
        const proof = body.proof?.trim();
        const roundNumber = Number(body.roundNumber ?? 1);
        const turnNumber = Number(body.turnNumber ?? 1);

        console.log(
            `[ZK Round Commit] Request match=${matchId} round=${roundNumber} turn=${turnNumber} trace=${clientTraceId || "n/a"} player=${address?.slice(0, 6) || "n/a"}…${address?.slice(-4) || "n/a"} signedAuth=${body.signedAuthEntryXdr ? "yes" : "no"} txXdr=${body.transactionXdr ? "yes" : "no"}`,
        );

        if (
            !address
            || !commitment
            || !proof
            || !Number.isInteger(roundNumber)
            || roundNumber < 1
            || !Number.isInteger(turnNumber)
            || turnNumber < 1
        ) {
            return Response.json(
                { error: "Missing/invalid address, roundNumber, turnNumber, commitment, or proof" },
                { status: 400 },
            );
        }

        if (!/^0x[0-9a-fA-F]+$/.test(commitment)) {
            return Response.json({ error: "Invalid commitment format" }, { status: 400 });
        }

        if (!body.transcriptHash?.trim()) {
            return Response.json({ error: "Commit payload is missing transcriptHash/nonce" }, { status: 400 });
        }

        const parsedCommitPlan = parseStoredPlan(body.encryptedPlan);
        if (!parsedCommitPlan.move || !isValidMove(parsedCommitPlan.move)) {
            return Response.json({ error: "Commit payload must include a valid move in encryptedPlan" }, { status: 400 });
        }

        if (parsedCommitPlan.surgeCardId && !isPowerSurgeCardId(parsedCommitPlan.surgeCardId)) {
            return Response.json({ error: "Commit payload contains invalid surgeCardId" }, { status: 400 });
        }

        const supabase = getSupabase();
        const { data: match, error: matchError } = await supabase
            .from("matches")
            .select("id, status, player1_address, player2_address, onchain_contract_id, onchain_session_id")
            .eq("id", matchId)
            .single();

        if (matchError || !match) {
            return Response.json({ error: "Match not found" }, { status: 404 });
        }

        const isParticipant = address === match.player1_address || address === match.player2_address;
        if (!isParticipant) {
            return Response.json({ error: "Not a participant in this match" }, { status: 403 });
        }

        const isPlayer1 = address === match.player1_address;
        const opponentAddress = isPlayer1 ? match.player2_address : match.player1_address;

        const { data: stunSnapshot } = await supabase
            .from("fight_state_snapshots")
            .select("player1_is_stunned, player2_is_stunned")
            .eq("match_id", matchId)
            .maybeSingle();

        const opponentIsStunned = isPlayer1
            ? Boolean(stunSnapshot?.player2_is_stunned)
            : Boolean(stunSnapshot?.player1_is_stunned);

        if (match.status !== "in_progress") {
            return Response.json(
                { error: `Match is not in progress (status: ${match.status})` },
                { status: 400 },
            );
        }

        const verification = await verifyNoirProof({
            proof,
            publicInputs: body.publicInputs,
            transcriptHash: body.transcriptHash,
            matchId,
            winnerAddress: address,
        });

        if (!verification.ok) {
            return Response.json({ error: "Commit proof verification failed" }, { status: 400 });
        }

        if ((process.env.ZK_STRICT_FINALIZE ?? "true") !== "false" && verification.backend === "disabled") {
            return Response.json({ error: "Strict ZK mode requires proof verification to be enabled" }, { status: 409 });
        }

        console.log(`[ZK Round Commit] Proof verified match=${matchId} round=${roundNumber} backend=${verification.backend}`);

        let onChainCommitTxHash = body.onChainCommitTxHash || null;
        let onChainVerificationTxHash: string | null = null;
        const strictMode = (process.env.ZK_STRICT_FINALIZE ?? "true") !== "false";

        if (ZK_ONCHAIN_COMMIT_GATE) {
            if (strictMode && !isOnChainRegistrationConfigured()) {
                return Response.json(
                    { error: "On-chain ZK commit gate requires admin contract configuration" },
                    { status: 503 },
                );
            }

            const onChainSessionId = typeof (match as any).onchain_session_id === "number"
                ? (match as any).onchain_session_id
                : null;

            if (strictMode && onChainSessionId === null) {
                return Response.json(
                    { error: "On-chain ZK commit gate requires persisted onchain_session_id from registration" },
                    { status: 409 },
                );
            }

            if (isOnChainRegistrationConfigured()) {
                const setupKey = String(match.onchain_contract_id || "default");
                const setupState = onChainSetupCache.get(setupKey) || {};

                if (!setupState.gateEnabled) {
                    const gateEnableResult = await runSetupWithRetry(
                        "set_zk_gate_required",
                        () => setZkGateRequiredOnChain(true, {
                            contractId: match.onchain_contract_id || undefined,
                        }),
                    );

                    if (!gateEnableResult.success && strictMode) {
                        return Response.json(
                            {
                                error: "Failed to enable on-chain ZK gate",
                                details: gateEnableResult.error || null,
                            },
                            { status: 502 },
                        );
                    }

                    if (gateEnableResult.success) {
                        setupState.gateEnabled = true;
                        onChainSetupCache.set(setupKey, setupState);
                    }
                }

                const onChainCommit = body.signedAuthEntryXdr && body.transactionXdr
                    ? await submitSignedZkCommitOnChain(
                        matchId,
                        address,
                        roundNumber,
                        turnNumber,
                        commitment,
                        body.signedAuthEntryXdr,
                        body.transactionXdr,
                        {
                            contractId: match.onchain_contract_id || undefined,
                            sessionId: onChainSessionId ?? undefined,
                        },
                    )
                    : await submitZkCommitOnChain(
                        matchId,
                        address,
                        roundNumber,
                        turnNumber,
                        commitment,
                        {
                            contractId: match.onchain_contract_id || undefined,
                            sessionId: onChainSessionId ?? undefined,
                        },
                    );

                console.log(
                    `[ZK Round Commit] On-chain commit result match=${matchId} round=${roundNumber} trace=${clientTraceId || "n/a"} success=${onChainCommit.success} tx=${onChainCommit.txHash || "n/a"} strict=${strictMode} error=${onChainCommit.error || "n/a"}`,
                );

                if (!onChainCommit.success && strictMode && !body.signedAuthEntryXdr) {
                    const commitError = String(onChainCommit.error || "");
                    if (/No keypair for|Stellar contract not configured|Auth|require_auth/i.test(commitError)) {
                    return Response.json(
                        {
                            error: "On-chain ZK commitment requires wallet auth entry signing",
                            details: commitError || "Call /api/matches/:matchId/zk/round/commit/prepare and resubmit commit with signedAuthEntryXdr + transactionXdr",
                        },
                        { status: 409 },
                    );
                    }
                }

                if (!onChainCommit.success && strictMode) {
                    return Response.json(
                        {
                            error: "On-chain ZK commitment transaction failed",
                            details: onChainCommit.error || null,
                        },
                        { status: 502 },
                    );
                }

                if (onChainCommit.success && onChainCommit.txHash) {
                    onChainCommitTxHash = onChainCommit.txHash;
                }

                if (!ZK_GROTH16_VERIFIER_CONTRACT_ID) {
                    if (strictMode) {
                        return Response.json(
                            { error: "ZK_GROTH16_VERIFIER_CONTRACT_ID is required in strict mode" },
                            { status: 503 },
                        );
                    }
                } else {
                    if (!setupState.verifierConfigured) {
                        const setVerifierResult = await runSetupWithRetry(
                            "set_zk_verifier_contract",
                            () => setZkVerifierContractOnChain(
                                ZK_GROTH16_VERIFIER_CONTRACT_ID,
                                { contractId: match.onchain_contract_id || undefined },
                            ),
                        );

                        if (!setVerifierResult.success && strictMode) {
                            return Response.json(
                                {
                                    error: "Failed to configure on-chain verifier contract",
                                    details: setVerifierResult.error || null,
                                },
                                { status: 502 },
                            );
                        }

                        if (setVerifierResult.success) {
                            setupState.verifierConfigured = true;
                            onChainSetupCache.set(setupKey, setupState);
                        }
                    }
                }

                if (!ZK_GROTH16_VK_ID) {
                    if (strictMode) {
                        return Response.json(
                            { error: "ZK_GROTH16_VK_ID is required in strict mode" },
                            { status: 503 },
                        );
                    }
                } else {
                    if (!setupState.vkConfigured) {
                        const setVkIdResult = await runSetupWithRetry(
                            "set_zk_verifier_vk_id",
                            () => setZkVerifierVkIdOnChain(
                                ZK_GROTH16_VK_ID,
                                { contractId: match.onchain_contract_id || undefined },
                            ),
                        );

                        if (!setVkIdResult.success && strictMode) {
                            return Response.json(
                                {
                                    error: "Failed to configure on-chain verifier vk id",
                                    details: setVkIdResult.error || null,
                                },
                                { status: 502 },
                            );
                        }

                        if (setVkIdResult.success) {
                            setupState.vkConfigured = true;
                            onChainSetupCache.set(setupKey, setupState);
                        }
                    }
                }

                const onChainVerification = await submitZkVerificationOnChain(
                    matchId,
                    address,
                    roundNumber,
                    turnNumber,
                    commitment,
                    ZK_GROTH16_VK_ID,
                    proof,
                    body.publicInputs,
                    {
                        contractId: match.onchain_contract_id || undefined,
                        sessionId: onChainSessionId ?? undefined,
                    },
                );

                if (!onChainVerification.success && strictMode) {
                    return Response.json(
                        {
                            error: "On-chain ZK verification failed",
                            details: onChainVerification.error || null,
                        },
                        { status: 502 },
                    );
                }

                if (onChainVerification.success && onChainVerification.txHash) {
                    onChainVerificationTxHash = onChainVerification.txHash;
                }
            }
        }

        const { error: upsertError } = await supabase
            .from("round_private_commits")
            .upsert(
                {
                    match_id: matchId,
                    round_number: roundNumber,
                    player_address: address,
                    commitment,
                    encrypted_plan: body.encryptedPlan || null,
                    proof_public_inputs: body.publicInputs ?? null,
                    transcript_hash: body.transcriptHash ?? null,
                    onchain_commit_tx_hash: onChainCommitTxHash,
                    verified_at: new Date().toISOString(),
                    resolved_at: null,
                    resolved_round_id: null,
                    updated_at: new Date().toISOString(),
                },
                { onConflict: "match_id,round_number,player_address" },
            );

        if (upsertError) {
            return Response.json(
                { error: `Failed to persist private round commitment: ${upsertError.message}` },
                { status: 500 },
            );
        }

        const { data: commits } = await supabase
            .from("round_private_commits")
            .select("player_address, encrypted_plan")
            .eq("match_id", matchId)
            .eq("round_number", roundNumber)
            .is("resolved_round_id", null);

        const alreadyCommitted = new Set((commits || []).map((row: any) => row.player_address));
        if (opponentIsStunned && !alreadyCommitted.has(opponentAddress)) {
            await supabase
                .from("round_private_commits")
                .upsert(
                    {
                        match_id: matchId,
                        round_number: roundNumber,
                        player_address: opponentAddress,
                        commitment: `auto-stunned:${matchId}:${roundNumber}:${opponentAddress}`,
                        encrypted_plan: JSON.stringify({
                            move: "stunned",
                            movePlan: Array(PRIVATE_ROUND_PLAN_TURNS).fill("stunned"),
                            surgeCardId: null,
                        }),
                        proof_public_inputs: null,
                        transcript_hash: null,
                        onchain_commit_tx_hash: null,
                        verified_at: new Date().toISOString(),
                        resolved_at: null,
                        resolved_round_id: null,
                        updated_at: new Date().toISOString(),
                    },
                    { onConflict: "match_id,round_number,player_address" },
                );
        }

        const { data: commitsAfterAuto } = await supabase
            .from("round_private_commits")
            .select("player_address, encrypted_plan")
            .eq("match_id", matchId)
            .eq("round_number", roundNumber)
            .is("resolved_round_id", null);

        const committedPlayers = new Set((commitsAfterAuto || []).map((row: any) => row.player_address));
        const player1Committed = committedPlayers.has(match.player1_address);
        const player2Committed = committedPlayers.has(match.player2_address);
        const bothCommitted = player1Committed && player2Committed;

        if (!bothCommitted) {
            console.warn(
                `[ZK Round Commit] Waiting for opponent commit match=${matchId} round=${roundNumber} trace=${clientTraceId || "n/a"} p1Committed=${player1Committed} p2Committed=${player2Committed}`,
            );
        }

        await broadcastGameEvent(matchId, "round_plan_committed", {
            matchId,
            roundNumber,
            committedBy: address,
            player1Committed,
            player2Committed,
            bothCommitted,
        });

        if (bothCommitted) {
            await broadcastGameEvent(matchId, "round_plan_ready", {
                matchId,
                roundNumber,
            });

            console.log(`[ZK Round Commit] Both players committed match=${matchId} round=${roundNumber}`);
        }

        return Response.json({
            success: true,
            clientTraceId,
            roundNumber,
            player1Committed,
            player2Committed,
            bothCommitted,
            onChainCommitTxHash,
            onChainVerificationTxHash,
            zkVerification: {
                backend: verification.backend,
                command: verification.command,
            },
        });
    } catch (err) {
        console.error("[ZK Round Commit] Error:", err);
        return Response.json(
            { error: err instanceof Error ? err.message : "Failed to commit private round plan" },
            { status: 500 },
        );
    }
}

export async function handleResolvePrivateRound(matchId: string, req: Request): Promise<Response> {
    try {
        const guard = privateModeGuard();
        if (guard) return guard;

        const body = await req.json() as ResolvePrivateRoundBody;
        const address = body.address?.trim();
        const roundNumber = Number(body.roundNumber ?? 1);
        const turnNumber = Number(body.turnNumber ?? 1);
        const proof = body.proof?.trim();

        console.log(
            `[ZK Round Resolve] Request match=${matchId} round=${roundNumber} player=${address?.slice(0, 6) || "n/a"}…${address?.slice(-4) || "n/a"}`,
        );

        if (
            !address
            || !Number.isInteger(roundNumber)
            || roundNumber < 1
            || !Number.isInteger(turnNumber)
            || turnNumber < 1
            || !proof
        ) {
            return Response.json(
                { error: "Missing/invalid address, roundNumber, turnNumber, or proof" },
                { status: 400 },
            );
        }

        if (!body.move || !isValidMove(body.move)) {
            return Response.json(
                { error: "Missing or invalid move for private round reveal" },
                { status: 400 },
            );
        }

        const incomingMovePlan = Array.isArray(body.movePlan)
            ? body.movePlan.filter((move): move is MoveType => isValidMove(String(move)))
            : null;
        if (!incomingMovePlan || incomingMovePlan.length !== PRIVATE_ROUND_PLAN_TURNS) {
            return Response.json(
                { error: `Missing/invalid movePlan. Exactly ${PRIVATE_ROUND_PLAN_TURNS} moves are required.` },
                { status: 400 },
            );
        }

        if (body.surgeCardId && !isPowerSurgeCardId(body.surgeCardId)) {
            return Response.json({ error: "Invalid surgeCardId" }, { status: 400 });
        }

        if (!body.transcriptHash?.trim()) {
            return Response.json({ error: "Missing transcriptHash/nonce for resolve" }, { status: 400 });
        }

        const supabase = getSupabase();
        const { data: match, error: matchError } = await supabase
            .from("matches")
            .select("id, status, player1_address, player2_address")
            .eq("id", matchId)
            .single();

        if (matchError || !match) {
            return Response.json({ error: "Match not found" }, { status: 404 });
        }

        if (match.status !== "in_progress") {
            return Response.json(
                { error: `Match is not in progress (status: ${match.status})` },
                { status: 400 },
            );
        }

        const isPlayer1 = address === match.player1_address;
        const isPlayer2 = address === match.player2_address;
        if (!isPlayer1 && !isPlayer2) {
            return Response.json({ error: "Not a participant in this match" }, { status: 403 });
        }

        const { data: submitterCommit, error: submitterCommitError } = await supabase
            .from("round_private_commits")
            .select("commitment, encrypted_plan, proof_public_inputs, transcript_hash")
            .eq("match_id", matchId)
            .eq("round_number", roundNumber)
            .eq("player_address", address)
            .is("resolved_round_id", null)
            .maybeSingle();

        if (submitterCommitError) {
            return Response.json(
                { error: `Failed to load private round commit: ${submitterCommitError.message}` },
                { status: 500 },
            );
        }

        if (!submitterCommit) {
            const resolvedRoundId = await getResolvedRoundIdFromCommits(matchId, roundNumber);
            if (resolvedRoundId) {
                return Response.json({
                    success: true,
                    roundNumber,
                    alreadyResolved: true,
                    resolvedRoundId,
                });
            }

            return Response.json({
                success: true,
                roundNumber,
                awaitingOpponent: true,
                reason: "no_unresolved_commit_for_player",
            });
        }

        const opponentAddress = isPlayer1 ? match.player2_address : match.player1_address;

        const { data: preCommitStunSnapshot } = await supabase
            .from("fight_state_snapshots")
            .select("player1_is_stunned, player2_is_stunned")
            .eq("match_id", matchId)
            .maybeSingle();

        const opponentIsStunnedPreCommit = isPlayer1
            ? Boolean(preCommitStunSnapshot?.player2_is_stunned)
            : Boolean(preCommitStunSnapshot?.player1_is_stunned);

        const { data: stunSnapshot } = await supabase
            .from("fight_state_snapshots")
            .select("player1_is_stunned, player2_is_stunned")
            .eq("match_id", matchId)
            .maybeSingle();

        const committedPlan = parseStoredPlan((submitterCommit as any).encrypted_plan);
        const committedMove = committedPlan.move;
        const committedMovePlan = Array.isArray(committedPlan.movePlan)
            ? committedPlan.movePlan.filter((move): move is MoveType => isValidMove(String(move)))
            : [];
        const committedSurge = committedPlan.surgeCardId ?? null;

        if (committedMovePlan.length !== PRIVATE_ROUND_PLAN_TURNS) {
            return Response.json(
                { error: `Committed private plan is missing a valid ${PRIVATE_ROUND_PLAN_TURNS}-move plan` },
                { status: 409 },
            );
        }

        const resolvedSurge = body.surgeCardId || null;
        if (committedMove && isValidMove(committedMove) && committedMove !== body.move) {
            return Response.json({ error: "Reveal move does not match committed private plan" }, { status: 409 });
        }

        for (let index = 0; index < PRIVATE_ROUND_PLAN_TURNS; index += 1) {
            if (committedMovePlan[index] !== incomingMovePlan[index]) {
                return Response.json({ error: "Reveal movePlan does not match committed private plan" }, { status: 409 });
            }
        }

        if ((committedSurge || null) !== resolvedSurge) {
            return Response.json({ error: "Reveal surge card does not match committed private plan" }, { status: 409 });
        }

        const committedTranscriptHash = String((submitterCommit as any).transcript_hash || "").trim();
        const incomingTranscriptHash = String(body.transcriptHash || "").trim();
        if (!committedTranscriptHash || committedTranscriptHash !== incomingTranscriptHash) {
            return Response.json({ error: "Reveal transcript hash does not match committed transcript hash" }, { status: 409 });
        }

        const committedPublicInputs = canonicalJson((submitterCommit as any).proof_public_inputs);
        const incomingPublicInputs = canonicalJson(body.publicInputs);
        if (committedPublicInputs && incomingPublicInputs && committedPublicInputs !== incomingPublicInputs) {
            return Response.json({ error: "Reveal public inputs do not match committed proof public inputs" }, { status: 409 });
        }

        const { data: commits } = await supabase
            .from("round_private_commits")
            .select("player_address, encrypted_plan")
            .eq("match_id", matchId)
            .eq("round_number", roundNumber)
            .is("resolved_round_id", null);

        const existingCommitters = new Set((commits || []).map((row: any) => row.player_address));
        if (opponentIsStunnedPreCommit && !existingCommitters.has(opponentAddress)) {
            await supabase
                .from("round_private_commits")
                .upsert(
                    {
                        match_id: matchId,
                        round_number: roundNumber,
                        player_address: opponentAddress,
                        commitment: `auto-stunned:${matchId}:${roundNumber}:${opponentAddress}`,
                        encrypted_plan: JSON.stringify({
                            move: "stunned",
                            movePlan: Array(PRIVATE_ROUND_PLAN_TURNS).fill("stunned"),
                            surgeCardId: null,
                        }),
                        proof_public_inputs: null,
                        transcript_hash: null,
                        onchain_commit_tx_hash: null,
                        verified_at: new Date().toISOString(),
                        resolved_at: null,
                        resolved_round_id: null,
                        updated_at: new Date().toISOString(),
                    },
                    { onConflict: "match_id,round_number,player_address" },
                );
        }

        const { data: commitsAfterAuto } = await supabase
            .from("round_private_commits")
            .select("player_address, encrypted_plan")
            .eq("match_id", matchId)
            .eq("round_number", roundNumber)
            .is("resolved_round_id", null);

        const roundForTimeout = await getOrCreateRoundTurn(matchId, roundNumber, turnNumber);
        const roundDeadlineMs = roundForTimeout?.move_deadline_at
            ? new Date(roundForTimeout.move_deadline_at).getTime()
            : 0;
        const isDeadlinePassed = roundDeadlineMs > 0 && Date.now() > roundDeadlineMs;

        let committedPlayers = new Set((commitsAfterAuto || []).map((row: any) => row.player_address));

        if ((!committedPlayers.has(match.player1_address) || !committedPlayers.has(match.player2_address)) && isDeadlinePassed) {
            const missingAddress = committedPlayers.has(match.player1_address)
                ? match.player2_address
                : match.player1_address;

            await supabase
                .from("round_private_commits")
                .upsert(
                    {
                        match_id: matchId,
                        round_number: roundNumber,
                        player_address: missingAddress,
                        commitment: `auto-timeout:${matchId}:${roundNumber}:${missingAddress}`,
                        encrypted_plan: JSON.stringify({
                            move: "stunned",
                            movePlan: Array(PRIVATE_ROUND_PLAN_TURNS).fill("stunned"),
                            surgeCardId: null,
                        }),
                        proof_public_inputs: null,
                        transcript_hash: null,
                        onchain_commit_tx_hash: null,
                        verified_at: new Date().toISOString(),
                        resolved_at: null,
                        resolved_round_id: null,
                        updated_at: new Date().toISOString(),
                    },
                    { onConflict: "match_id,round_number,player_address" },
                );

            const { data: commitsAfterTimeout } = await supabase
                .from("round_private_commits")
                .select("player_address")
                .eq("match_id", matchId)
                .eq("round_number", roundNumber)
                .is("resolved_round_id", null);

            committedPlayers = new Set((commitsAfterTimeout || []).map((row: any) => row.player_address));
            console.warn(
                `[ZK Round Resolve] Auto-timeout commit inserted match=${matchId} round=${roundNumber} missing=${missingAddress}`,
            );
        }

        if (!committedPlayers.has(match.player1_address) || !committedPlayers.has(match.player2_address)) {
            return Response.json({
                success: true,
                roundNumber,
                awaitingOpponent: true,
                reason: "awaiting_both_commits",
                player1Committed: committedPlayers.has(match.player1_address),
                player2Committed: committedPlayers.has(match.player2_address),
            });
        }

        const verification = await verifyNoirProof({
            proof,
            publicInputs: body.publicInputs,
            transcriptHash: body.transcriptHash,
            matchId,
            winnerAddress: body.expectedWinnerAddress?.trim() || address,
        });

        if (!verification.ok) {
            return Response.json({ error: "Round resolution proof verification failed" }, { status: 400 });
        }

        if ((process.env.ZK_STRICT_FINALIZE ?? "true") !== "false" && verification.backend === "disabled") {
            return Response.json({ error: "Strict ZK mode requires proof verification to be enabled" }, { status: 409 });
        }

        console.log(`[ZK Round Resolve] Proof verified match=${matchId} round=${roundNumber} backend=${verification.backend}`);

        await supabase
            .from("round_private_commits")
            .update({
                updated_at: new Date().toISOString(),
            })
            .eq("match_id", matchId)
            .eq("round_number", roundNumber)
            .eq("player_address", address)
            .is("resolved_round_id", null);

        const { data: revealRows } = await supabase
            .from("round_private_commits")
            .select("player_address, encrypted_plan, resolved_at")
            .eq("match_id", matchId)
            .eq("round_number", roundNumber)
            .is("resolved_round_id", null);

        const parsePlan = (raw: unknown): { move?: MoveType; movePlan?: MoveType[]; surgeCardId?: PowerSurgeCardId | null } => parseStoredPlan(raw);

        const byAddress = new Map<string, { move?: MoveType; movePlan?: MoveType[]; surgeCardId?: PowerSurgeCardId | null }>();
        for (const row of revealRows || []) {
            byAddress.set(row.player_address, parsePlan((row as any).encrypted_plan));
        }

        const p1RawPlan = byAddress.get(match.player1_address) || {};
        const p2RawPlan = byAddress.get(match.player2_address) || {};

        const fallbackStunnedPlan = Array(PRIVATE_ROUND_PLAN_TURNS).fill("stunned") as MoveType[];
        const p1Plan = {
            ...p1RawPlan,
            movePlan: (Array.isArray(p1RawPlan.movePlan) && p1RawPlan.movePlan.length === PRIVATE_ROUND_PLAN_TURNS)
                ? p1RawPlan.movePlan
                : (stunSnapshot?.player1_is_stunned ? fallbackStunnedPlan : undefined),
        };
        const p2Plan = {
            ...p2RawPlan,
            movePlan: (Array.isArray(p2RawPlan.movePlan) && p2RawPlan.movePlan.length === PRIVATE_ROUND_PLAN_TURNS)
                ? p2RawPlan.movePlan
                : (stunSnapshot?.player2_is_stunned ? fallbackStunnedPlan : undefined),
        };

        const p1Revealed = !!(p1Plan.movePlan && p1Plan.movePlan.length === PRIVATE_ROUND_PLAN_TURNS);
        const p2Revealed = !!(p2Plan.movePlan && p2Plan.movePlan.length === PRIVATE_ROUND_PLAN_TURNS);
        const bothRevealed = p1Revealed && p2Revealed;

        await broadcastGameEvent(matchId, "round_plan_revealed", {
            matchId,
            roundNumber,
            revealedBy: address,
            player1Revealed: p1Revealed,
            player2Revealed: p2Revealed,
            bothRevealed,
        });

        if (!bothRevealed) {
            console.log(`[ZK Round Resolve] Waiting for opponent reveal match=${matchId} round=${roundNumber}`);
            return Response.json({
                success: true,
                roundNumber,
                awaitingOpponent: true,
                player1Revealed: p1Revealed,
                player2Revealed: p2Revealed,
                zkVerification: {
                    backend: verification.backend,
                    command: verification.command,
                },
            });
        }

        const existingResolvedRoundId = await getResolvedRoundIdFromCommits(matchId, roundNumber);
        if (existingResolvedRoundId) {
            return Response.json({
                success: true,
                roundNumber,
                alreadyResolved: true,
                resolvedRoundId: existingResolvedRoundId,
                zkVerification: {
                    backend: verification.backend,
                    command: verification.command,
                },
            });
        }

        const resolveLockResult = await acquireDistributedResolveLock(matchId, roundNumber);
        if (resolveLockResult.state === "resolved") {
            return Response.json({
                success: true,
                roundNumber,
                alreadyResolved: true,
                resolvedRoundId: resolveLockResult.resolvedRoundId || null,
                zkVerification: {
                    backend: verification.backend,
                    command: verification.command,
                },
            });
        }

        if (resolveLockResult.state === "in_progress") {
            console.log(`[ZK Round Resolve] Resolver lock active match=${matchId} round=${roundNumber}`);
            return Response.json({
                success: true,
                roundNumber,
                awaitingResolver: true,
                resolver: "in_progress",
                zkVerification: {
                    backend: verification.backend,
                    command: verification.command,
                },
            });
        }

        const resolveLockKey = `${matchId}:${roundNumber}`;
        const useInMemoryFallback = !!resolveLockResult.useInMemoryFallback;
        if (useInMemoryFallback) {
            if (privateRoundResolveLocks.has(resolveLockKey)) {
                console.log(`[ZK Round Resolve] Resolver lock active (fallback) match=${matchId} round=${roundNumber}`);
                return Response.json({
                    success: true,
                    roundNumber,
                    awaitingResolver: true,
                    resolver: "in_progress",
                    zkVerification: {
                        backend: verification.backend,
                        command: verification.command,
                    },
                });
            }

            privateRoundResolveLocks.add(resolveLockKey);
        }

        try {

            const { error: powerSurgeSyncError } = await supabase
                .from("power_surges")
                .upsert(
                    {
                        match_id: matchId,
                        round_number: roundNumber,
                        player1_card_id: p1Plan.surgeCardId || null,
                        player2_card_id: p2Plan.surgeCardId || null,
                        updated_at: new Date().toISOString(),
                    },
                    { onConflict: "match_id,round_number" },
                );

            if (powerSurgeSyncError) {
                console.warn(
                    `[ZK Round Resolve] Non-fatal power_surges sync error match=${matchId} round=${roundNumber}: ${powerSurgeSyncError.message}`,
                );
            }

            let finalResolution: any = null;
            let finalResolvedRoundId: string | null = null;
            let carryP1Stunned = Boolean(stunSnapshot?.player1_is_stunned);
            let carryP2Stunned = Boolean(stunSnapshot?.player2_is_stunned);

            for (let turn = 1; turn <= PRIVATE_ROUND_PLAN_TURNS; turn += 1) {
                const round = await getOrCreateRoundTurn(matchId, roundNumber, turn);
                const plannedP1Move = p1Plan.movePlan?.[turn - 1] || "block";
                const plannedP2Move = p2Plan.movePlan?.[turn - 1] || "block";

                const p1Move = carryP1Stunned ? "stunned" : plannedP1Move;
                const p2Move = carryP2Stunned ? "stunned" : plannedP2Move;

                if (p1Move !== plannedP1Move || p2Move !== plannedP2Move) {
                    console.log(
                        `[ZK Round Resolve] Stun override applied match=${matchId} round=${roundNumber} turn=${turn} carry=(${carryP1Stunned},${carryP2Stunned}) planned=(${plannedP1Move},${plannedP2Move}) effective=(${p1Move},${p2Move})`,
                    );
                }

                await supabase
                    .from("rounds")
                    .update({
                        player1_move: p1Move,
                        player2_move: p2Move,
                    })
                    .eq("id", round.id);

                await supabase
                    .from("fight_state_snapshots")
                    .update({
                        player1_has_submitted_move: true,
                        player2_has_submitted_move: true,
                        updated_at: new Date().toISOString(),
                    })
                    .eq("match_id", matchId);

                const resolution = await resolveTurn(matchId, round.id, {
                    suppressNextTurnBroadcastOnly: true,
                });
                finalResolution = resolution;
                finalResolvedRoundId = round.id;

                const resolvedCarryP1 = typeof resolution.player1IsStunnedNext === "boolean"
                    ? resolution.player1IsStunnedNext
                    : undefined;
                const resolvedCarryP2 = typeof resolution.player2IsStunnedNext === "boolean"
                    ? resolution.player2IsStunnedNext
                    : undefined;

                const { data: postTurnStunSnapshot } = await supabase
                    .from("fight_state_snapshots")
                    .select("player1_is_stunned, player2_is_stunned")
                    .eq("match_id", matchId)
                    .maybeSingle();

                carryP1Stunned = resolvedCarryP1 ?? Boolean(postTurnStunSnapshot?.player1_is_stunned);
                carryP2Stunned = resolvedCarryP2 ?? Boolean(postTurnStunSnapshot?.player2_is_stunned);

                console.log(
                    `[ZK Round Resolve] Auto turn resolved match=${matchId} round=${roundNumber} turn=${turn} roundId=${round.id} matchWinner=${resolution.matchWinner || "n/a"} nextCarry=(${carryP1Stunned},${carryP2Stunned})`,
                );

                if (resolution.isRoundOver || resolution.isMatchOver) {
                    break;
                }

                await sleep(2600);
            }

            if (!finalResolution || !finalResolvedRoundId) {
                throw new Error("Private round auto-resolution failed to produce a turn result");
            }

            await supabase
                .from("round_private_commits")
                .update({
                    resolved_at: new Date().toISOString(),
                    resolved_round_id: finalResolvedRoundId,
                    updated_at: new Date().toISOString(),
                })
                .eq("match_id", matchId)
                .eq("round_number", roundNumber)
                .is("resolved_round_id", null);

            await markDistributedResolveLockResolved(matchId, roundNumber, finalResolvedRoundId);

            return Response.json({
                success: true,
                roundNumber,
                resolution: finalResolution,
                zkVerification: {
                    backend: verification.backend,
                    command: verification.command,
                },
            });
        } finally {
            if (useInMemoryFallback) {
                privateRoundResolveLocks.delete(resolveLockKey);
            }
        }
    } catch (err) {
        console.error("[ZK Round Resolve] Error:", err);
        return Response.json(
            { error: err instanceof Error ? err.message : "Failed to resolve private round" },
            { status: 500 },
        );
    }
}

function canonicalJson(value: unknown): string {
    if (value === undefined) return "";
    if (value === null) return "null";
    if (typeof value === "string") return value.trim();
    return JSON.stringify(value);
}

function parseStoredPlan(raw: unknown): PrivateRoundPlanPayload {
    if (!raw || typeof raw !== "string") return {};

    const parseJsonPlan = (jsonText: string) => {
        const parsed = JSON.parse(jsonText) as PrivateRoundPlanPayload;
        const movePlan = Array.isArray((parsed as any).movePlan)
            ? (parsed as any).movePlan.filter((value: unknown): value is MoveType => isValidMove(String(value)))
            : undefined;
        return {
            move: parsed.move,
            movePlan,
            surgeCardId: parsed.surgeCardId ?? null,
        };
    };

    try {
        return parseJsonPlan(raw);
    } catch {
        try {
            const decoded = Buffer.from(raw, "base64").toString("utf8");
            return parseJsonPlan(decoded);
        } catch {
            return {};
        }
    }
}

export async function handlePreparePrivateRoundCommit(matchId: string, req: Request): Promise<Response> {
    try {
        const guard = privateModeGuard();
        if (guard) return guard;

        const body = await req.json() as PrepareCommitPrivateRoundBody;
        const clientTraceId = (body.clientTraceId || "").trim() || null;
        const address = body.address?.trim();
        const commitment = body.commitment?.trim();
        const roundNumber = Number(body.roundNumber ?? 1);
        const turnNumber = Number(body.turnNumber ?? 1);
        const strictMode = (process.env.ZK_STRICT_FINALIZE ?? "true") !== "false";

        if (!address || !commitment || !Number.isInteger(roundNumber) || roundNumber < 1 || !Number.isInteger(turnNumber) || turnNumber < 1) {
            return Response.json(
                { error: "Missing/invalid address, roundNumber, turnNumber, or commitment" },
                { status: 400 },
            );
        }

        if (!/^0x[0-9a-fA-F]+$/.test(commitment)) {
            return Response.json({ error: "Invalid commitment format" }, { status: 400 });
        }

        console.log(
            `[ZK Round Commit Prepare] Request match=${matchId} round=${roundNumber} turn=${turnNumber} trace=${clientTraceId || "n/a"} player=${address.slice(0, 6)}…${address.slice(-4)}`,
        );

        const supabase = getSupabase();
        const { data: match, error: matchError } = await supabase
            .from("matches")
            .select("id, status, player1_address, player2_address, onchain_contract_id, onchain_session_id")
            .eq("id", matchId)
            .single();

        if (matchError || !match) {
            return Response.json({ error: "Match not found" }, { status: 404 });
        }

        if (match.status !== "in_progress") {
            return Response.json(
                { error: `Match is not in progress (status: ${match.status})` },
                { status: 400 },
            );
        }

        if (address !== match.player1_address && address !== match.player2_address) {
            return Response.json({ error: "Not a participant in this match" }, { status: 403 });
        }

        const onChainSessionId = typeof (match as any).onchain_session_id === "number"
            ? (match as any).onchain_session_id
            : null;

        if (strictMode && onChainSessionId === null) {
            return Response.json(
                { error: "On-chain ZK commit gate requires persisted onchain_session_id from registration" },
                { status: 409 },
            );
        }

        const prepared = await prepareZkCommitOnChain(
            matchId,
            address,
            roundNumber,
            turnNumber,
            commitment,
            {
                contractId: match.onchain_contract_id || undefined,
                sessionId: onChainSessionId ?? undefined,
            },
        );

        return Response.json({
            success: true,
            clientTraceId,
            sessionId: prepared.sessionId,
            authEntryXdr: prepared.authEntryXdr,
            transactionXdr: prepared.transactionXdr,
        });
    } catch (err) {
        console.error("[ZK Round Commit Prepare] Error:", err);
        return Response.json(
            { error: err instanceof Error ? err.message : "Failed to prepare private round commit" },
            { status: 500 },
        );
    }
}