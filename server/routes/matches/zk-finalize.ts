/**
 * ZK Finalize Route
 * POST /api/matches/:matchId/zk/finalize
 *
 * Intended for Option B flow:
 * - Gameplay/actions run off-chain
 * - A final ZK proof is produced off-chain
 * - Server verifies basic payload shape and finalizes on-chain result once
 */

import { getSupabase } from "../../lib/supabase";
import { broadcastGameEvent } from "../../lib/matchmaker";
import {
    getConfiguredContractId,
    getOnChainMatchStateBySession,
    isStellarConfigured,
    matchIdToSessionId,
    reportMatchResultOnChain,
    setGroth16VerificationKeyOnChain,
    setZkVerifierContractOnChain,
    setZkVerifierVkIdOnChain,
    submitZkMatchOutcomeOnChain,
} from "../../lib/stellar-contract";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const PRIVATE_ROUNDS_ENABLED = true;
const ZK_STRICT_FINALIZE = true;
const ZK_REQUIRE_TRANSCRIPT_HASH = (process.env.ZK_REQUIRE_TRANSCRIPT_HASH ?? "true") !== "false";
const ZK_FINALIZE_WAIT_FOR_VERIFICATIONS_MS = Number.parseInt(
    (process.env.ZK_FINALIZE_WAIT_FOR_VERIFICATIONS_MS ?? "30000").trim(),
    10,
);
const ZK_FINALIZE_VERIFICATION_POLL_MS = Number.parseInt(
    (process.env.ZK_FINALIZE_VERIFICATION_POLL_MS ?? "2000").trim(),
    10,
);
const ZK_FINALIZE_BACKGROUND_RETRY = (process.env.ZK_FINALIZE_BACKGROUND_RETRY ?? "true") !== "false";
const ZK_FINALIZE_ENDGAME_RETRY_ATTEMPTS = Number.parseInt(
    (process.env.ZK_FINALIZE_ENDGAME_RETRY_ATTEMPTS ?? "12").trim(),
    10,
);
const ZK_FINALIZE_ENDGAME_RETRY_DELAY_MS = Number.parseInt(
    (process.env.ZK_FINALIZE_ENDGAME_RETRY_DELAY_MS ?? "5000").trim(),
    10,
);

const ZK_GROTH16_VERIFIER_CONTRACT_ID = (process.env.ZK_GROTH16_VERIFIER_CONTRACT_ID || "").trim();

interface FinalizeBody {
    winnerAddress?: string;
    proof?: string;
    publicInputs?: unknown;
    transcriptHash?: string;
    broadcast?: boolean;
}

function isIdempotentOutcomeSubmissionError(errorText: string): boolean {
    const normalized = (errorText || "").toLowerCase();
    return (
        normalized.includes("error(contract, #20)")
        || normalized.includes("zkverificationalreadysubmitted")
        || normalized.includes("error(contract, #3)")
        || normalized.includes("matchalreadyended")
        || normalized.includes("already submitted")
        || normalized.includes("already finalized")
    );
}

const DEFAULT_GROTH16_ROUND_CIRCUIT_DIR = resolve(process.cwd(), "zk_circuits", "veilstar_round_plan_groth16");
const DEFAULT_GROTH16_ROUND_VKEY_PATH = resolve(DEFAULT_GROTH16_ROUND_CIRCUIT_DIR, "artifacts", "verification_key.json");

function normalizeHex32(input: string): string {
    const trimmed = input.trim().toLowerCase();
    if (!/^0x[0-9a-f]+$/.test(trimmed)) {
        throw new Error("Invalid 0x hex string");
    }
    const raw = trimmed.slice(2);
    if (raw.length === 0 || raw.length > 64) {
        throw new Error("Hex value exceeds 32 bytes");
    }
    return `0x${raw.padStart(64, "0")}`;
}

function getGroth16RoundVerificationKeyPath(): string {
    return (process.env.ZK_GROTH16_ROUND_VKEY_PATH || "").trim() || DEFAULT_GROTH16_ROUND_VKEY_PATH;
}

let computedGroth16VkIdPromise: Promise<string> | null = null;
async function getGroth16VkIdHexForFinalize(): Promise<string> {
    const explicit = (
        process.env.ZK_GROTH16_VK_ID
        || process.env.ZK_VERIFIER_VK_ID
        || ""
    ).trim();

    if (explicit) return normalizeHex32(explicit);

    if (!computedGroth16VkIdPromise) {
        computedGroth16VkIdPromise = (async () => {
            const vkeyPath = getGroth16RoundVerificationKeyPath();
            const raw = await readFile(vkeyPath, "utf8");
            const digestHex = createHash("sha256").update(raw).digest("hex");
            return normalizeHex32(`0x${digestHex}`);
        })();
    }

    return computedGroth16VkIdPromise;
}

let vkUploadAttempted = false;
let vkUploadInFlight: Promise<void> | null = null;
async function ensureGroth16VerificationKeyUploaded(vkIdHex: string): Promise<void> {
    const verifierContractId = (process.env.ZK_GROTH16_VERIFIER_CONTRACT_ID || "").trim();
    if (!verifierContractId) return;

    // Avoid duplicate uploads if multiple finalize calls arrive concurrently.
    if (vkUploadAttempted) return;
    if (vkUploadInFlight) return vkUploadInFlight;

    const vkeyPath = getGroth16RoundVerificationKeyPath();

    vkUploadInFlight = (async () => {
        const res = await setGroth16VerificationKeyOnChain(verifierContractId, vkIdHex, vkeyPath);
        if (!res.success) {
            throw new Error(res.error || "Failed to upload Groth16 verification key");
        }
        vkUploadAttempted = true;
    })().finally(() => {
        vkUploadInFlight = null;
    });

    return vkUploadInFlight;
}

async function ensureOnChainZkVerifierConfigured(params: { contractId?: string; vkIdHex: string }): Promise<void> {
    // Keep finalize robust even if gameplay setup was skipped or partially failed.
    // - set_zk_verifier_contract: required for on-chain verification
    // - set_zk_verifier_vk_id: required by submit_zk_match_outcome
    if (!isStellarConfigured()) return;

    if (ZK_GROTH16_VERIFIER_CONTRACT_ID) {
        const res = await setZkVerifierContractOnChain(ZK_GROTH16_VERIFIER_CONTRACT_ID, { contractId: params.contractId });
        if (!res.success) {
            throw new Error(res.error || "Failed to configure on-chain verifier contract");
        }
    }

    const vkRes = await setZkVerifierVkIdOnChain(params.vkIdHex, { contractId: params.contractId });
    if (!vkRes.success) {
        throw new Error(vkRes.error || "Failed to configure on-chain verifier vk id");
    }
}

function sleep(ms: number): Promise<void> {
    if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function toNumber(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "bigint") return Number(value);
    if (typeof value === "string") {
        const parsed = Number.parseInt(value, 10);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function readOnChainVerifiedCounts(state: any): { p1: number | null; p2: number | null } {
    if (!state || typeof state !== "object") return { p1: null, p2: null };

    const p1 = toNumber(
        state.player1_zk_verified
        ?? state.player1ZkVerified
        ?? state.player1_zkVerified,
    );
    const p2 = toNumber(
        state.player2_zk_verified
        ?? state.player2ZkVerified
        ?? state.player2_zkVerified,
    );

    return { p1, p2 };
}

async function waitForOnChainZkVerifications(options: {
    sessionId: number;
    contractId?: string;
    timeoutMs: number;
    pollMs: number;
}): Promise<{ ok: boolean; waitedMs: number; lastState: any | null; counts: { p1: number | null; p2: number | null } }> {
    const startedAt = Date.now();
    let waitedMs = 0;
    let lastState: any | null = null;
    let counts = { p1: null as number | null, p2: null as number | null };

    while (waitedMs <= options.timeoutMs) {
        lastState = await getOnChainMatchStateBySession(options.sessionId, {
            contractId: options.contractId || undefined,
        });
        counts = readOnChainVerifiedCounts(lastState);

        if ((counts.p1 ?? 0) > 0 && (counts.p2 ?? 0) > 0) {
            return { ok: true, waitedMs, lastState, counts };
        }

        if (waitedMs >= options.timeoutMs) break;
        await sleep(options.pollMs);
        waitedMs = Date.now() - startedAt;
    }

    return { ok: false, waitedMs, lastState, counts };
}

async function backgroundRetryEndGame(params: {
    matchId: string;
    sessionId: number;
    contractId?: string;
    player1Address: string;
    player2Address: string;
    winnerAddress: string;
}): Promise<void> {
    if (!ZK_FINALIZE_BACKGROUND_RETRY) return;

    console.log(`[ZK Finalize] backgroundRetryEndGame scheduled match=${params.matchId} session=${params.sessionId}`);

    const attempts = Number.isFinite(ZK_FINALIZE_ENDGAME_RETRY_ATTEMPTS)
        ? Math.max(1, ZK_FINALIZE_ENDGAME_RETRY_ATTEMPTS)
        : 12;
    const baseDelayMs = Number.isFinite(ZK_FINALIZE_ENDGAME_RETRY_DELAY_MS)
        ? Math.max(250, ZK_FINALIZE_ENDGAME_RETRY_DELAY_MS)
        : 5000;

    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            console.log(`[ZK Finalize] backgroundRetryEndGame attempt=${attempt}/${attempts} match=${params.matchId}`);
            const waitResult = await waitForOnChainZkVerifications({
                sessionId: params.sessionId,
                contractId: params.contractId,
                timeoutMs: 0,
                pollMs: 0,
            });

            if (!waitResult.ok) {
                console.log(
                    `[ZK Finalize] backgroundRetryEndGame waiting verifications match=${params.matchId} p1=${waitResult.counts.p1 ?? "?"} p2=${waitResult.counts.p2 ?? "?"}`,
                );
                await broadcastGameEvent(params.matchId, "zk_progress", {
                    matchId: params.matchId,
                    stage: "onchain_endgame_waiting_verifications",
                    message: `Waiting for on-chain verifications (p1=${waitResult.counts.p1 ?? "?"}, p2=${waitResult.counts.p2 ?? "?"})...`,
                    color: "#f97316",
                });

                await sleep(baseDelayMs);
                continue;
            }

            const onChainResult = await reportMatchResultOnChain(
                params.matchId,
                params.player1Address,
                params.player2Address,
                params.winnerAddress,
                {
                    sessionId: params.sessionId,
                    contractId: params.contractId,
                },
            );

            if (!onChainResult.success) {
                console.warn(
                    `[ZK Finalize] backgroundRetryEndGame end_game failed match=${params.matchId} attempt=${attempt}/${attempts}: ${onChainResult.error || "unknown"}`,
                );
                await broadcastGameEvent(params.matchId, "zk_progress", {
                    matchId: params.matchId,
                    stage: "onchain_endgame_failed",
                    message: `On-chain end_game failed (attempt ${attempt}/${attempts}).`,
                    color: "#ef4444",
                    details: onChainResult.error || null,
                });

                await sleep(baseDelayMs);
                continue;
            }

            const txHash = onChainResult.txHash || null;
            if (txHash) {
                const supabase = getSupabase();
                const { error: persistError } = await supabase
                    .from("matches")
                    .update({ onchain_result_tx_hash: txHash })
                    .eq("id", params.matchId);

                if (persistError) {
                    console.warn(
                        `[ZK Finalize] Failed to persist onchain_result_tx_hash (non-fatal) match=${params.matchId}: ${persistError.message}`,
                    );
                }
            }

            console.log(`[ZK Finalize] backgroundRetryEndGame end_game OK match=${params.matchId} tx=${txHash || "n/a"}`);

            await broadcastGameEvent(params.matchId, "zk_progress", {
                matchId: params.matchId,
                stage: "onchain_endgame_ok",
                message: "On-chain end_game confirmed.",
                color: "#22c55e",
                onChainTxHash: txHash,
            });

            return;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[ZK Finalize] backgroundRetryEndGame error match=${params.matchId} attempt=${attempt}/${attempts}: ${msg}`);
            await sleep(baseDelayMs);
        }
    }

    console.warn(`[ZK Finalize] backgroundRetryEndGame exhausted match=${params.matchId} attempts=${attempts}`);
}

function stableStringify(value: unknown): string {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value);
    }

    if (Array.isArray(value)) {
        return `[${value.map((item) => stableStringify(item)).join(",")}]`;
    }

    const entries = Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`).join(",")}}`;
}

async function computeTranscriptHash(matchId: string): Promise<string> {
    const supabase = getSupabase();

    const { data: match } = await supabase
        .from("matches")
        .select("id, status, winner_address, player1_address, player2_address")
        .eq("id", matchId)
        .single();

    const { data: rounds } = await supabase
        .from("rounds")
        .select("id, round_number, turn_number, player1_move, player2_move")
        .eq("match_id", matchId)
        .order("round_number", { ascending: true })
        .order("turn_number", { ascending: true });

    const roundIds = (rounds || []).map((round: any) => round.id);
    const { data: moves } = roundIds.length > 0
        ? await supabase
            .from("moves")
            .select("*")
            .in("round_id", roundIds)
        : { data: [] as any[] };

    const { data: surges } = await supabase
        .from("power_surges")
        .select("*")
        .eq("match_id", matchId)
        .order("round_number", { ascending: true });

    const transcript = {
        match,
        rounds: rounds || [],
        moves: moves || [],
        powerSurges: surges || [],
    };

    return createHash("sha256").update(stableStringify(transcript)).digest("hex");
}

export async function handleFinalizeWithZkProof(matchId: string, req: Request): Promise<Response> {
    try {
        console.log(`[ZK Finalize] Request received for match ${matchId}`);
        const body = await req.json() as FinalizeBody;
        const winnerAddress = body.winnerAddress?.trim();
        const proof = body.proof?.trim();

        if (!winnerAddress || !proof) {
            return Response.json(
                { error: "Missing 'winnerAddress' or 'proof'" },
                { status: 400 },
            );
        }

        const strictFinalize = PRIVATE_ROUNDS_ENABLED && ZK_STRICT_FINALIZE;
        if ((strictFinalize || ZK_REQUIRE_TRANSCRIPT_HASH) && !body.transcriptHash?.trim()) {
            return Response.json(
                { error: "Missing 'transcriptHash' for ZK finalize" },
                { status: 400 },
            );
        }

        if (body.transcriptHash?.trim()) {
            const expectedTranscriptHash = await computeTranscriptHash(matchId);
            if (body.transcriptHash.trim() !== expectedTranscriptHash) {
                return Response.json(
                    {
                        error: "Transcript hash mismatch",
                        details: {
                            expected: expectedTranscriptHash,
                            received: body.transcriptHash.trim(),
                        },
                    },
                    { status: 409 },
                );
            }
        }

        let vkIdHex: string;
        try {
            vkIdHex = await getGroth16VkIdHexForFinalize();
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return Response.json(
                { error: `Missing/invalid finalize verifier key id: ${msg}` },
                { status: 500 },
            );
        }

        const supabase = getSupabase();
        const { data: match, error } = await supabase
            .from("matches")
            .select("id, status, room_code, player1_address, player2_address, player1_rounds_won, player2_rounds_won, onchain_session_id, onchain_contract_id")
            .eq("id", matchId)
            .single();

        if (error || !match) {
            return Response.json({ error: "Match not found" }, { status: 404 });
        }

        const isWinnerPlayer1 = winnerAddress === match.player1_address;
        const isWinnerPlayer2 = winnerAddress === match.player2_address;

        if (!isWinnerPlayer1 && !isWinnerPlayer2) {
            return Response.json(
                { error: "winnerAddress must be one of the match participants" },
                { status: 400 },
            );
        }

        console.log(
            `[ZK Finalize] Winner accepted for match ${matchId}: ${winnerAddress.slice(0, 6)}…${winnerAddress.slice(-4)}`,
        );

        if (match.status !== "completed") {
            await supabase
                .from("matches")
                .update({
                    status: "completed",
                    winner_address: winnerAddress,
                    completed_at: new Date().toISOString(),
                    fight_phase: "match_end",
                })
                .eq("id", matchId)
                .in("status", ["in_progress", "character_select"]);
        }

        let onChainTxHash: string | null = null;
        let onChainOutcomeTxHash: string | null = null;
        let onChainResultPending = false;
        let onChainResultError: string | null = null;
        let onChainSessionId = typeof match.onchain_session_id === "number"
            ? match.onchain_session_id
            : null;
        let onChainContractId = (match.onchain_contract_id || getConfiguredContractId() || "").trim();

        if (isStellarConfigured()) {
            // Ensure verifier has the VK stored under the vk_id we’re about to use.
            try {
                await ensureGroth16VerificationKeyUploaded(vkIdHex);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (strictFinalize) {
                    return Response.json(
                        { error: `Failed to upload Groth16 verification key: ${msg}` },
                        { status: 502 },
                    );
                }
                console.warn(`[ZK Finalize] Groth16 VK upload skipped/failed (non-strict): ${msg}`);
            }

            if (onChainSessionId === null) {
                const recoveredSessionId = matchIdToSessionId(matchId);
                const recoveredContractId = onChainContractId || getConfiguredContractId() || "";
                const recoveredState = await getOnChainMatchStateBySession(recoveredSessionId, {
                    contractId: recoveredContractId || undefined,
                });

                if (!recoveredState) {
                    return Response.json(
                        {
                            error: "On-chain lifecycle mismatch: match is missing persisted onchain_session_id from start_game",
                            details: {
                                attemptedRecoverySessionId: recoveredSessionId,
                                attemptedRecoveryContractId: recoveredContractId || null,
                            },
                        },
                        { status: 409 },
                    );
                }

                onChainSessionId = recoveredSessionId;
                onChainContractId = recoveredContractId;

                await supabase
                    .from("matches")
                    .update({
                        onchain_session_id: recoveredSessionId,
                        onchain_contract_id: recoveredContractId || null,
                    })
                    .eq("id", matchId);

                console.log(
                    `[ZK Finalize] Recovered on-chain metadata for ${matchId}: session=${recoveredSessionId}, contract=${recoveredContractId || "n/a"}`,
                );
            }

            const onChainState = await getOnChainMatchStateBySession(onChainSessionId, {
                contractId: onChainContractId || undefined,
            });

            if (!onChainState) {
                return Response.json(
                    {
                        error: "On-chain lifecycle mismatch: start_game session not found on configured contract",
                        details: {
                            onChainSessionId,
                            onChainContractId: onChainContractId || null,
                        },
                    },
                    { status: 409 },
                );
            }

            console.log(`[ZK Finalize] Submitting on-chain match outcome proof for match ${matchId}`);
            const outcomeProofResult = await submitZkMatchOutcomeOnChain(
                matchId,
                winnerAddress,
                vkIdHex,
                proof,
                body.publicInputs,
                {
                    contractId: onChainContractId || undefined,
                    sessionId: onChainSessionId,
                },
            );

            if (!outcomeProofResult.success) {
                const outcomeError = String(outcomeProofResult.error || "");
                if (isIdempotentOutcomeSubmissionError(outcomeError)) {
                    console.warn(
                        `[ZK Finalize] submit_zk_match_outcome returned idempotent error for ${matchId}; continuing as already-submitted (${outcomeError.slice(0, 220)})`,
                    );
                } else {
                    return Response.json(
                        {
                            error: "On-chain match outcome proof transaction failed",
                            details: outcomeProofResult.error || null,
                        },
                        { status: 502 },
                    );
                }
            }
            onChainOutcomeTxHash = outcomeProofResult.txHash || null;

            // Best-effort persistence so the public match page can show the outcome-proof tx.
            // Not all deployments may have this column yet, so do not fail finalize if it errors.
            if (onChainOutcomeTxHash) {
                try {
                    const { error: outcomePersistError } = await supabase
                        .from("matches")
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        .update({ onchain_outcome_tx_hash: onChainOutcomeTxHash } as any)
                        .eq("id", matchId);

                    if (outcomePersistError) {
                        console.warn(
                            `[ZK Finalize] Failed to persist onchain_outcome_tx_hash (non-fatal) match=${matchId}: ${outcomePersistError.message}`,
                        );
                    }
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    console.warn(`[ZK Finalize] Persist onchain_outcome_tx_hash threw (non-fatal) match=${matchId}: ${msg}`);
                }
            }

            // end_game requires BOTH players to have at least one on-chain verification submitted when ZK gate is enabled.
            // Verification submission is async during gameplay for UX, so finalize waits briefly for it to land.
            const waitResult = await waitForOnChainZkVerifications({
                sessionId: onChainSessionId,
                contractId: onChainContractId || undefined,
                timeoutMs: Number.isFinite(ZK_FINALIZE_WAIT_FOR_VERIFICATIONS_MS) ? ZK_FINALIZE_WAIT_FOR_VERIFICATIONS_MS : 30000,
                pollMs: Number.isFinite(ZK_FINALIZE_VERIFICATION_POLL_MS) ? ZK_FINALIZE_VERIFICATION_POLL_MS : 2000,
            });

            if (!waitResult.ok) {
                // Try end_game anyway as a best-effort improvement: some contract deployments
                // may accept end_game before verifications are observed, and we prefer to
                // capture the tx hash for the public match page.
                try {
                    const onChainResult = await reportMatchResultOnChain(
                        matchId,
                        match.player1_address,
                        match.player2_address,
                        winnerAddress,
                        {
                            sessionId: onChainSessionId,
                            contractId: onChainContractId || undefined,
                        },
                    );

                    if (onChainResult.success && onChainResult.txHash) {
                        onChainTxHash = onChainResult.txHash;
                        const { error: persistError } = await supabase
                            .from("matches")
                            .update({ onchain_result_tx_hash: onChainTxHash })
                            .eq("id", matchId);

                        if (persistError) {
                            console.warn(
                                `[ZK Finalize] Failed to persist onchain_result_tx_hash (non-fatal) match=${matchId}: ${persistError.message}`,
                            );
                        }

                        console.log(`[ZK Finalize] end_game accepted even though verifications not observed match=${matchId} tx=${onChainTxHash}`);
                    } else {
                        onChainResultPending = true;
                        onChainResultError = `Waiting for on-chain submit_zk_verification (p1=${waitResult.counts.p1 ?? "?"}, p2=${waitResult.counts.p2 ?? "?"})`;
                        console.warn(
                            `[ZK Finalize] Skipping end_game for now (verifications not yet observed) match=${matchId} waitedMs=${waitResult.waitedMs} p1=${waitResult.counts.p1 ?? "?"} p2=${waitResult.counts.p2 ?? "?"}`,
                        );

                        void backgroundRetryEndGame({
                            matchId,
                            sessionId: onChainSessionId,
                            contractId: onChainContractId || undefined,
                            player1Address: match.player1_address,
                            player2Address: match.player2_address,
                            winnerAddress,
                        });
                    }
                } catch (err) {
                    onChainResultPending = true;
                    const msg = err instanceof Error ? err.message : String(err);
                    onChainResultError = `end_game attempt threw; waiting for verifications (p1=${waitResult.counts.p1 ?? "?"}, p2=${waitResult.counts.p2 ?? "?"})`;
                    console.warn(`[ZK Finalize] end_game best-effort attempt threw match=${matchId}: ${msg}`);

                    void backgroundRetryEndGame({
                        matchId,
                        sessionId: onChainSessionId,
                        contractId: onChainContractId || undefined,
                        player1Address: match.player1_address,
                        player2Address: match.player2_address,
                        winnerAddress,
                    });
                }
            } else {
                console.log(`[ZK Finalize] Reporting on-chain result for match ${matchId}`);
                const onChainResult = await reportMatchResultOnChain(
                    matchId,
                    match.player1_address,
                    match.player2_address,
                    winnerAddress,
                    {
                        sessionId: onChainSessionId,
                        contractId: onChainContractId || undefined,
                    },
                );

                if (!onChainResult.success) {
                    // Treat as non-fatal: the proof was submitted, and the off-chain match is completed.
                    // This prevents strict ZK finalize from wedging the match-end UX.
                    onChainResultPending = true;
                    onChainResultError = onChainResult.error || "On-chain end_game failed";
                    console.warn(`[ZK Finalize] end_game failed (will remain pending) match=${matchId}: ${onChainResultError}`);

                    void backgroundRetryEndGame({
                        matchId,
                        sessionId: onChainSessionId,
                        contractId: onChainContractId || undefined,
                        player1Address: match.player1_address,
                        player2Address: match.player2_address,
                        winnerAddress,
                    });
                } else {
                    onChainTxHash = onChainResult.txHash || null;

                    console.log(`[ZK Finalize] On-chain finalize complete for match ${matchId}, tx=${onChainTxHash || "n/a"}`);

                    if (onChainTxHash) {
                        const { error: persistError } = await supabase
                            .from("matches")
                            .update({ onchain_result_tx_hash: onChainTxHash })
                            .eq("id", matchId);

                        if (persistError) {
                            console.warn(
                                `[ZK Finalize] Failed to persist onchain_result_tx_hash (non-fatal) match=${matchId}: ${persistError.message}`,
                            );
                        }
                    }
                }
            }
        }
        else if (strictFinalize) {
            return Response.json(
                { error: "Strict trustless finalize requires Stellar on-chain integration" },
                { status: 409 },
            );
        }

        if (body.broadcast !== false) {
            await broadcastGameEvent(matchId, "match_ended", {
                matchId,
                winner: isWinnerPlayer1 ? "player1" : "player2",
                winnerAddress,
                reason: "zk_proof",
                player1RoundsWon: match.player1_rounds_won,
                player2RoundsWon: match.player2_rounds_won,
                isPrivateRoom: !!match.room_code,
                onChainSessionId: onChainSessionId ?? matchIdToSessionId(matchId),
                onChainTxHash,
                onChainOutcomeTxHash,
                onChainResultPending,
                onChainResultError,
                zkProofSubmitted: true,
                transcriptHash: body.transcriptHash || null,
                proofPublicInputs: body.publicInputs || null,
            });

            console.log(`[ZK Finalize] Broadcasted match_ended for ${matchId} (reason=zk_proof)`);
        }

        return Response.json({
            success: true,
            onChainTxHash,
            onChainOutcomeTxHash,
            onChainSessionId: onChainSessionId ?? matchIdToSessionId(matchId),
            onChainResultPending,
            onChainResultError,
            zkProofAccepted: true,
            zkVerification: {
                backend: "onchain-groth16",
                command: "submit_zk_match_outcome",
            },
        });
    } catch (err) {
        console.error("[ZK Finalize] Error:", err);
        return Response.json(
            { error: err instanceof Error ? err.message : "Failed to finalize with ZK proof" },
            { status: 500 },
        );
    }
}
