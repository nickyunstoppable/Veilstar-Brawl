/// <reference path="../../../circomlibjs.d.ts" />

import { getSupabase } from "../../lib/supabase";
import { broadcastGameEvent } from "../../lib/matchmaker";
import { verifyNoirProof } from "../../lib/zk-proof";
import { isValidMove } from "../../lib/round-resolver";
import { GAME_CONSTANTS, type MoveType } from "../../lib/game-types";
import { isPowerSurgeCardId, POWER_SURGE_CARD_IDS, type PowerSurgeCardId } from "../../lib/power-surge";
import { resolveTurn } from "../../lib/combat-resolver";
import { isOnChainRegistrationConfigured, prepareZkCommitOnChain, setGroth16VerificationKeyOnChain, setZkGateRequiredOnChain, setZkVerifierContractOnChain, setZkVerifierVkIdOnChain, submitSignedZkCommitOnChain, submitZkCommitOnChain, submitZkVerificationOnChain } from "../../lib/stellar-contract";
import { buildPoseidon } from "circomlibjs";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const PRIVATE_ROUNDS_ENABLED = true;
const ZK_ONCHAIN_COMMIT_GATE = true;
const ZK_STRICT_FINALIZE = true;
// Gameplay defaults (hackathon-friendly):
// - Always verify at commit (fast integrity gate)
// - Always run on-chain verification asynchronously (never block Phase 3 animation)
// - Do not re-verify at resolve unless a fallback triggers
const ZK_VERIFY_COMMIT_PROOF = true;
const ZK_SYNC_ONCHAIN_VERIFY = false;
const ZK_REVERIFY_ON_RESOLVE = false;
const ZK_GROTH16_VERIFIER_CONTRACT_ID = (process.env.ZK_GROTH16_VERIFIER_CONTRACT_ID || "").trim();
const ZK_GROTH16_VK_ID = (process.env.ZK_GROTH16_VK_ID || "").trim();
const PRIVATE_ROUND_TURN_DELAY_MS = Number(process.env.ZK_PRIVATE_ROUND_TURN_DELAY_MS ?? "1200");
const DEBUG_MATCH_END_FLOW = (process.env.DEBUG_MATCH_END_FLOW ?? "false") === "true";
const privateRoundResolveLocks = new Set<string>();
const RESOLVE_LOCK_STALE_SECONDS = Number(process.env.ZK_RESOLVE_LOCK_STALE_SECONDS ?? "45");
const RESOLVE_LOCK_OWNER = `${process.env.FLY_ALLOC_ID || process.env.HOSTNAME || "local"}:${process.pid}`;
const onChainSetupCache = new Map<string, {
    gateEnabled?: boolean;
    verifierConfigured?: boolean;
    vkConfigured?: boolean;
    vkUploaded?: boolean;
}>();
const onChainSetupInFlight = new Map<string, Promise<{ success: boolean; error?: string | null }>>();

const DEFAULT_GROTH16_ROUND_CIRCUIT_DIR = resolve(process.cwd(), "zk_circuits", "veilstar_round_plan_groth16");
const DEFAULT_GROTH16_ROUND_VKEY_PATH = resolve(DEFAULT_GROTH16_ROUND_CIRCUIT_DIR, "artifacts", "verification_key.json");

let computedGroth16VkIdPromise: Promise<string> | null = null;
async function getGroth16RoundVkIdHex(): Promise<string> {
    if (ZK_GROTH16_VK_ID) {
        return normalizeHex32(ZK_GROTH16_VK_ID);
    }

    if (!computedGroth16VkIdPromise) {
        computedGroth16VkIdPromise = (async () => {
            const vkeyPath = (process.env.ZK_GROTH16_ROUND_VKEY_PATH || "").trim() || DEFAULT_GROTH16_ROUND_VKEY_PATH;
            const raw = await readFile(vkeyPath, "utf8");
            const digestHex = createHash("sha256").update(raw).digest("hex");
            return normalizeHex32(`0x${digestHex}`);
        })();
    }

    return computedGroth16VkIdPromise;
}

function getGroth16RoundVerificationKeyPath(): string {
    return (process.env.ZK_GROTH16_ROUND_VKEY_PATH || "").trim() || DEFAULT_GROTH16_ROUND_VKEY_PATH;
}

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

const BN254_FIELD_PRIME = BigInt("21888242871839275222246405745257275088548364400416034343698204186575808495617");

const MOVE_TO_CODE: Record<string, number> = {
    stunned: 0,
    punch: 1,
    kick: 2,
    block: 3,
    special: 4,
};

let poseidonPromise: Promise<any> | null = null;
async function getPoseidon(): Promise<any> {
    if (!poseidonPromise) {
        poseidonPromise = buildPoseidon();
    }
    return poseidonPromise;
}

function toFieldBigint(text: string): bigint {
    const digestHex = createHash("sha256").update(text).digest("hex");
    return BigInt(`0x${digestHex}`) % BN254_FIELD_PRIME;
}

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

function parsePublicInputsFirstAsHex32(publicInputs: unknown): string {
    const decodeMaybeBase64 = (value: unknown): Buffer | null => {
        if (typeof value !== "string") return null;
        const text = value.trim();
        if (!text.startsWith("base64:")) return null;
        return Buffer.from(text.slice("base64:".length), "base64");
    };

    const parseArrayFirst = (arr: unknown[]): string => {
        if (arr.length < 1) {
            throw new Error("publicInputs must have at least 1 element");
        }
        const first = arr[0];
        if (typeof first === "string") {
            const t = first.trim();
            if (/^0x[0-9a-fA-F]+$/.test(t)) return normalizeHex32(t);
            if (/^[0-9]+$/.test(t)) {
                const n = BigInt(t);
                return normalizeHex32(`0x${n.toString(16)}`);
            }
        }
        if (typeof first === "number" && Number.isFinite(first) && Number.isInteger(first) && first >= 0) {
            return normalizeHex32(`0x${BigInt(first).toString(16)}`);
        }
        throw new Error("publicInputs[0] must be a hex or decimal scalar");
    };

    if (Array.isArray(publicInputs)) {
        return parseArrayFirst(publicInputs);
    }

    if (typeof publicInputs === "string") {
        const decoded = decodeMaybeBase64(publicInputs);
        if (decoded) {
            const asText = decoded.toString("utf8").trim();
            if (asText.startsWith("[")) {
                const parsed = JSON.parse(asText);
                if (!Array.isArray(parsed)) throw new Error("publicInputs base64 JSON must decode to array");
                return parseArrayFirst(parsed);
            }

            if (decoded.length === 0) throw new Error("publicInputs base64 payload is empty");
            if (decoded.length < 32) throw new Error("publicInputs base64 payload must include at least 32 bytes");
            return normalizeHex32(`0x${decoded.subarray(0, 32).toString("hex")}`);
        }

        const trimmed = publicInputs.trim();
        if (trimmed.startsWith("[")) {
            const parsed = JSON.parse(trimmed);
            if (!Array.isArray(parsed)) throw new Error("publicInputs JSON must be an array");
            return parseArrayFirst(parsed);
        }
    }

    throw new Error("Unsupported publicInputs format");
}

function toSurgeCode(cardId?: PowerSurgeCardId | null): bigint {
    if (!cardId) return 0n;
    const idx = POWER_SURGE_CARD_IDS.indexOf(cardId);
    if (idx < 0) return 0n;
    return BigInt(idx + 1);
}

async function computeRoundPlanCommitmentHex(params: {
    matchId: string;
    roundNumber: number;
    turnNumber: number;
    playerAddress: string;
    surgeCardId?: PowerSurgeCardId | null;
    nonceDecimal: string;
    movePlan: MoveType[];
}): Promise<string> {
    const poseidon = await getPoseidon();

    if (!Number.isInteger(params.roundNumber) || params.roundNumber < 1) throw new Error("roundNumber must be >= 1");
    if (!Number.isInteger(params.turnNumber) || params.turnNumber < 1) throw new Error("turnNumber must be >= 1");
    if (!Array.isArray(params.movePlan) || params.movePlan.length !== PRIVATE_ROUND_PLAN_TURNS) {
        throw new Error(`movePlan must have exactly ${PRIVATE_ROUND_PLAN_TURNS} moves`);
    }

    const nonce = BigInt(params.nonceDecimal);
    const matchIdField = toFieldBigint(params.matchId);
    const playerField = toFieldBigint(params.playerAddress);
    const surgeCode = toSurgeCode(params.surgeCardId ?? null);

    const moveCodes = params.movePlan.map((move) => {
        const code = MOVE_TO_CODE[String(move)] ?? MOVE_TO_CODE.block;
        return BigInt(code);
    });

    const preimage: bigint[] = [
        matchIdField,
        BigInt(params.roundNumber),
        BigInt(params.turnNumber),
        playerField,
        surgeCode,
        nonce,
        ...moveCodes,
    ];

    const out = poseidon(preimage);
    const asBigint: bigint = poseidon.F.toObject(out);
    return normalizeHex32(`0x${asBigint.toString(16)}`);
}

type ResolveLockState = "acquired" | "in_progress" | "resolved";

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function debugMatchEndLog(message: string, extra?: unknown): void {
    if (!DEBUG_MATCH_END_FLOW) return;
    if (extra === undefined) {
        console.log(`[TERMDBG][ZK Round Resolve] ${message}`);
        return;
    }
    console.log(`[TERMDBG][ZK Round Resolve] ${message}`, extra);
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

async function runOnChainSetup(params: {
    setupKey: string;
    contractId?: string;
    strictMode: boolean;
}): Promise<{ success: boolean; error?: string | null }> {
    const { setupKey, contractId, strictMode } = params;
    const setupState = onChainSetupCache.get(setupKey) || {};

    if (!setupState.gateEnabled) {
        const gateEnableResult = await runSetupWithRetry(
            "set_zk_gate_required",
            () => setZkGateRequiredOnChain(true, { contractId }),
        );

        if (!gateEnableResult.success && strictMode) {
            return {
                success: false,
                error: `Failed to enable on-chain ZK gate: ${gateEnableResult.error || "unknown"}`,
            };
        }

        if (gateEnableResult.success) {
            setupState.gateEnabled = true;
            onChainSetupCache.set(setupKey, setupState);
        }
    }

    if (!ZK_GROTH16_VERIFIER_CONTRACT_ID) {
        if (strictMode) {
            return {
                success: false,
                error: "ZK_GROTH16_VERIFIER_CONTRACT_ID is required in strict mode",
            };
        }
    } else if (!setupState.verifierConfigured) {
        const setVerifierResult = await runSetupWithRetry(
            "set_zk_verifier_contract",
            () => setZkVerifierContractOnChain(
                ZK_GROTH16_VERIFIER_CONTRACT_ID,
                { contractId },
            ),
        );

        if (!setVerifierResult.success && strictMode) {
            return {
                success: false,
                error: `Failed to configure on-chain verifier contract: ${setVerifierResult.error || "unknown"}`,
            };
        }

        if (setVerifierResult.success) {
            setupState.verifierConfigured = true;
            onChainSetupCache.set(setupKey, setupState);
        }
    }

    let vkIdHex: string | null = null;
    try {
        vkIdHex = await getGroth16RoundVkIdHex();
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (strictMode) {
            return { success: false, error: `Failed to compute Groth16 vk id: ${msg}` };
        }
    }

    if (vkIdHex) {
        if (!setupState.vkUploaded) {
            const vkeyPath = getGroth16RoundVerificationKeyPath();
            const setVkOnVerifierResult = await runSetupWithRetry(
                "set_verification_key",
                () => setGroth16VerificationKeyOnChain(
                    ZK_GROTH16_VERIFIER_CONTRACT_ID,
                    vkIdHex as string,
                    vkeyPath,
                ),
            );

            if (!setVkOnVerifierResult.success && strictMode) {
                return {
                    success: false,
                    error: `Failed to upload Groth16 verification key: ${setVkOnVerifierResult.error || "unknown"}`,
                };
            }

            if (setVkOnVerifierResult.success) {
                setupState.vkUploaded = true;
                onChainSetupCache.set(setupKey, setupState);
            }
        }

        if (!setupState.vkConfigured) {
            const setVkIdResult = await runSetupWithRetry(
                "set_zk_verifier_vk_id",
                () => setZkVerifierVkIdOnChain(
                    vkIdHex as string,
                    { contractId },
                ),
            );

            if (!setVkIdResult.success && strictMode) {
                return {
                    success: false,
                    error: `Failed to configure on-chain verifier vk id: ${setVkIdResult.error || "unknown"}`,
                };
            }

            if (setVkIdResult.success) {
                setupState.vkConfigured = true;
                onChainSetupCache.set(setupKey, setupState);
            }
        }
    } else if (strictMode) {
        return {
            success: false,
            error: "Missing Groth16 verifier key id (set ZK_GROTH16_VK_ID or ensure verification_key.json is available)",
        };
    }

    return { success: true };
}

async function ensureOnChainSetupSingleFlight(params: {
    setupKey: string;
    contractId?: string;
    strictMode: boolean;
}): Promise<{ success: boolean; error?: string | null }> {
    const existing = onChainSetupInFlight.get(params.setupKey);
    if (existing) {
        return existing;
    }

    const promise = runOnChainSetup(params)
        .finally(() => {
            onChainSetupInFlight.delete(params.setupKey);
        });

    onChainSetupInFlight.set(params.setupKey, promise);
    return promise;
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

        let commitmentNormalized: string;
        try {
            commitmentNormalized = normalizeHex32(commitment);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return Response.json({ error: `Invalid commitment: ${msg}` }, { status: 400 });
        }

        if (!body.transcriptHash?.trim()) {
            return Response.json({ error: "Commit payload is missing transcriptHash/nonce" }, { status: 400 });
        }

        // For Groth16 calldata mode we must have public inputs so we can bind proof↔commitment server-side
        // (on-chain already enforces it, but this closes DB/UX loopholes and gives earlier feedback).
        if (ZK_ONCHAIN_COMMIT_GATE && (body.publicInputs === undefined || body.publicInputs === null)) {
            return Response.json({ error: "Commit payload is missing publicInputs" }, { status: 400 });
        }

        const parsedCommitPlan = parseStoredPlan(body.encryptedPlan);
        if (!parsedCommitPlan.move || !isValidMove(parsedCommitPlan.move)) {
            return Response.json({ error: "Commit payload must include a valid move in encryptedPlan" }, { status: 400 });
        }

        // The Groth16 circuit commits to a full 10-turn move plan; require it at commit time.
        const parsedMovePlan = Array.isArray(parsedCommitPlan.movePlan)
            ? parsedCommitPlan.movePlan.filter((move): move is MoveType => isValidMove(String(move)))
            : [];
        if (parsedMovePlan.length !== PRIVATE_ROUND_PLAN_TURNS) {
            return Response.json(
                { error: `Commit payload must include movePlan with exactly ${PRIVATE_ROUND_PLAN_TURNS} moves in encryptedPlan` },
                { status: 400 },
            );
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

        await broadcastZkProgress({
            matchId,
            roundNumber,
            turnNumber,
            stage: "commit_received",
            message: "Commit received. Validating private round payload...",
            playerAddress: address,
            color: "#f97316",
        });

        let verification: Awaited<ReturnType<typeof verifyNoirProof>> | null = null;
        if (ZK_VERIFY_COMMIT_PROOF) {
            await broadcastZkProgress({
                matchId,
                roundNumber,
                turnNumber,
                stage: "commit_verify_started",
                message: "Verifying commit proof...",
                playerAddress: address,
                color: "#f97316",
            });

            verification = await verifyNoirProof({
                proof,
                publicInputs: body.publicInputs,
                transcriptHash: body.transcriptHash,
                matchId,
                winnerAddress: address,
            });

            if (!verification.ok) {
                return Response.json({ error: "Commit proof verification failed" }, { status: 400 });
            }

            if (ZK_STRICT_FINALIZE && verification.backend === "disabled") {
                return Response.json({ error: "Strict ZK mode requires proof verification to be enabled" }, { status: 409 });
            }

            console.log(`[ZK Round Commit] Proof verified match=${matchId} round=${roundNumber} backend=${verification.backend}`);
            await broadcastZkProgress({
                matchId,
                roundNumber,
                turnNumber,
                stage: "commit_verify_ok",
                message: `Commit proof verified (${verification.backend}).`,
                playerAddress: address,
            });
        } else {
            console.log(`[ZK Round Commit] Commit proof verification deferred to resolve match=${matchId} round=${roundNumber}`);
            await broadcastZkProgress({
                matchId,
                roundNumber,
                turnNumber,
                stage: "commit_verify_deferred",
                message: "Commit proof verification deferred to resolve stage.",
                playerAddress: address,
            });
        }

        // Ensure the public input commitment matches the submitted commitment.
        // This prevents storing/relaying mismatched (commitment,proof,publicInputs) tuples.
        if (body.publicInputs !== undefined && body.publicInputs !== null) {
            try {
                const publicCommitment = parsePublicInputsFirstAsHex32(body.publicInputs);
                if (publicCommitment !== commitmentNormalized) {
                    return Response.json(
                        {
                            error: "Commitment mismatch (publicInputs[0] != commitment)",
                            details: {
                                commitment: commitmentNormalized,
                                publicInputs0: publicCommitment,
                            },
                        },
                        { status: 409 },
                    );
                }
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return Response.json({ error: `Invalid publicInputs: ${msg}` }, { status: 400 });
            }
        }

        let onChainCommitTxHash = body.onChainCommitTxHash || null;
        let onChainVerificationTxHash: string | null = null;

        const { error: upsertError } = await supabase
            .from("round_private_commits")
            .upsert(
                {
                    match_id: matchId,
                    round_number: roundNumber,
                    player_address: address,
                    commitment: commitmentNormalized,
                    encrypted_plan: body.encryptedPlan || null,
                    proof_public_inputs: body.publicInputs ?? null,
                    transcript_hash: body.transcriptHash ?? null,
                    onchain_commit_tx_hash: onChainCommitTxHash,
                    verified_at: verification ? new Date().toISOString() : null,
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

        // Fire-and-forget on-chain commit + verification for best UX:
        // - Do NOT block Phase 3 on chain confirmation.
        // - Enforcement happens at match finalize for rewards/ELO.
        if (ZK_ONCHAIN_COMMIT_GATE && isOnChainRegistrationConfigured()) {
            const strictMode = ZK_STRICT_FINALIZE;
            const onChainSessionId = typeof (match as any).onchain_session_id === "number"
                ? (match as any).onchain_session_id
                : null;

            void (async () => {
                try {
                    await broadcastZkProgress({
                        matchId,
                        roundNumber,
                        turnNumber,
                        stage: "onchain_setup",
                        message: "Preparing on-chain ZK gate...",
                        playerAddress: address,
                        color: "#f97316",
                    });

                    const setupKey = String(match.onchain_contract_id || "default");
                    const setupResult = await ensureOnChainSetupSingleFlight({
                        setupKey,
                        contractId: match.onchain_contract_id || undefined,
                        strictMode,
                    });

                    if (!setupResult.success) {
                        console.error(
                            `[ZK Round Commit] Async on-chain setup failed match=${matchId} round=${roundNumber}: ${setupResult.error || "unknown"}`,
                        );
                        await broadcastZkProgress({
                            matchId,
                            roundNumber,
                            turnNumber,
                            stage: "onchain_setup_failed",
                            message: "On-chain ZK setup failed (async).",
                            playerAddress: address,
                            color: "#ef4444",
                        });
                        return;
                    }

                    await broadcastZkProgress({
                        matchId,
                        roundNumber,
                        turnNumber,
                        stage: "onchain_commit_submitting",
                        message: "Submitting commitment on-chain (async)...",
                        playerAddress: address,
                        color: "#f97316",
                    });

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
                        `[ZK Round Commit] Async on-chain commit result match=${matchId} round=${roundNumber} trace=${clientTraceId || "n/a"} success=${onChainCommit.success} tx=${onChainCommit.txHash || "n/a"} error=${onChainCommit.error || "n/a"}`,
                    );

                    if (!onChainCommit.success) {
                        await broadcastZkProgress({
                            matchId,
                            roundNumber,
                            turnNumber,
                            stage: "onchain_commit_failed",
                            message: "On-chain commitment failed (async).",
                            playerAddress: address,
                            color: "#ef4444",
                        });
                        return;
                    }

                    if (onChainCommit.txHash) {
                        try {
                            const supabase = getSupabase();
                            await supabase
                                .from("round_private_commits")
                                .update({
                                    onchain_commit_tx_hash: onChainCommit.txHash,
                                    updated_at: new Date().toISOString(),
                                })
                                .eq("match_id", matchId)
                                .eq("round_number", roundNumber)
                                .eq("player_address", address);
                        } catch (dbErr) {
                            const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
                            console.error(`[ZK Round Commit] Failed to persist async commit tx hash: ${msg}`);
                        }

                        await broadcastZkProgress({
                            matchId,
                            roundNumber,
                            turnNumber,
                            stage: "onchain_commit_ok",
                            message: "On-chain commitment confirmed (async).",
                            playerAddress: address,
                        });
                    }

                    // Verification is always async here for gameplay UX.
                    await broadcastZkProgress({
                        matchId,
                        roundNumber,
                        turnNumber,
                        stage: "onchain_verify_submitting",
                        message: "Submitting on-chain proof verification (async)...",
                        playerAddress: address,
                        color: "#f97316",
                    });

                    const onChainVerification = await submitZkVerificationOnChain(
                        matchId,
                        address,
                        roundNumber,
                        turnNumber,
                        commitment,
                        await getGroth16RoundVkIdHex(),
                        proof,
                        body.publicInputs,
                        {
                            contractId: match.onchain_contract_id || undefined,
                            sessionId: onChainSessionId ?? undefined,
                        },
                    );

                    console.log(
                        `[ZK Round Commit] Async on-chain verification result match=${matchId} round=${roundNumber} player=${address} success=${onChainVerification.success} tx=${onChainVerification.txHash || "n/a"} error=${onChainVerification.error || "n/a"}`,
                    );

                    if (!onChainVerification.success) {
                        console.error(
                            `[ZK Round Commit] Async on-chain verification failed match=${matchId} round=${roundNumber} player=${address}: ${onChainVerification.error || "unknown"}`,
                        );
                        await broadcastZkProgress({
                            matchId,
                            roundNumber,
                            turnNumber,
                            stage: "onchain_verify_failed",
                            message: "On-chain verification failed (async).",
                            playerAddress: address,
                            color: "#ef4444",
                        });
                        return;
                    }

                    if (onChainVerification.txHash) {
                        await broadcastZkProgress({
                            matchId,
                            roundNumber,
                            turnNumber,
                            stage: "onchain_verify_ok",
                            message: "On-chain verification confirmed (async).",
                            playerAddress: address,
                        });
                    }
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    console.error(
                        `[ZK Round Commit] Async on-chain commit/verify exception match=${matchId} round=${roundNumber} player=${address}: ${msg}`,
                    );
                    await broadcastZkProgress({
                        matchId,
                        roundNumber,
                        turnNumber,
                        stage: "onchain_async_exception",
                        message: "On-chain submission threw an exception (async).",
                        playerAddress: address,
                        color: "#ef4444",
                    });
                }
            })();
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
            await broadcastZkProgress({
                matchId,
                roundNumber,
                turnNumber,
                stage: "awaiting_opponent_commit",
                message: "Commit accepted. Waiting for opponent commitment...",
                playerAddress: address,
            });
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

            await broadcastZkProgress({
                matchId,
                roundNumber,
                turnNumber,
                stage: "both_commits_ready",
                message: "Both commitments locked. Proceed to reveal.",
                playerAddress: address,
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
                backend: verification?.backend || "deferred_to_resolve",
                command: verification?.command || null,
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
            .select("commitment, encrypted_plan, proof_public_inputs, transcript_hash, verified_at")
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

        // Recompute Poseidon commitment from the revealed plan and committed nonce.
        // This binds the DB-stored encrypted plan → revealed plan → ZK commitment (single public input).
        try {
            const expectedCommitment = await computeRoundPlanCommitmentHex({
                matchId,
                roundNumber,
                turnNumber,
                playerAddress: address,
                surgeCardId: resolvedSurge,
                nonceDecimal: incomingTranscriptHash,
                movePlan: incomingMovePlan,
            });

            const storedCommitment = normalizeHex32(String((submitterCommit as any).commitment || ""));
            if (storedCommitment !== expectedCommitment) {
                return Response.json(
                    {
                        error: "Reveal does not match committed Poseidon commitment",
                        details: {
                            storedCommitment,
                            expectedCommitment,
                        },
                    },
                    { status: 409 },
                );
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return Response.json({ error: `Failed to validate reveal commitment binding: ${msg}` }, { status: 400 });
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
            await broadcastZkProgress({
                matchId,
                roundNumber,
                turnNumber,
                stage: "awaiting_both_commits",
                message: "Waiting for both commitments before reveal can finalize...",
                playerAddress: address,
            });
            return Response.json({
                success: true,
                roundNumber,
                awaitingOpponent: true,
                reason: "awaiting_both_commits",
                player1Committed: committedPlayers.has(match.player1_address),
                player2Committed: committedPlayers.has(match.player2_address),
            });
        }

        const strictMode = ZK_STRICT_FINALIZE;
        let verificationBackend = "commit_verified";
        let verificationCommand: string | null = null;
        let shouldRunResolveVerification = ZK_REVERIFY_ON_RESOLVE;

        if (!shouldRunResolveVerification && ZK_VERIFY_COMMIT_PROOF) {
            const submitterVerifiedAt = (submitterCommit as any)?.verified_at;
            if (!submitterVerifiedAt) {
                shouldRunResolveVerification = true;
                console.warn(
                    `[ZK Round Resolve] Missing commit verification marker for submitter; falling back to resolve verification match=${matchId} round=${roundNumber}`,
                );
            } else {
                const { data: verificationRows } = await supabase
                    .from("round_private_commits")
                    .select("player_address, verified_at")
                    .eq("match_id", matchId)
                    .eq("round_number", roundNumber)
                    .is("resolved_round_id", null);

                const verifiedMap = new Map((verificationRows || []).map((row: any) => [row.player_address, row.verified_at]));
                const p1Verified = !!verifiedMap.get(match.player1_address);
                const p2Verified = !!verifiedMap.get(match.player2_address);

                if (strictMode && (!p1Verified || !p2Verified)) {
                    shouldRunResolveVerification = true;
                    console.warn(
                        `[ZK Round Resolve] One or both commits unverified; falling back to resolve verification match=${matchId} round=${roundNumber} p1Verified=${p1Verified} p2Verified=${p2Verified}`,
                    );
                }
            }
        }

        if (shouldRunResolveVerification) {
            await broadcastZkProgress({
                matchId,
                roundNumber,
                turnNumber,
                stage: "resolve_verify_started",
                message: "Running resolve-time proof verification...",
                playerAddress: address,
                color: "#f97316",
            });

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

            if (strictMode && verification.backend === "disabled") {
                return Response.json({ error: "Strict ZK mode requires proof verification to be enabled" }, { status: 409 });
            }

            verificationBackend = verification.backend;
            verificationCommand = verification.command;
            console.log(`[ZK Round Resolve] Proof verified at resolve match=${matchId} round=${roundNumber} backend=${verification.backend}`);
            await broadcastZkProgress({
                matchId,
                roundNumber,
                turnNumber,
                stage: "resolve_verify_ok",
                message: `Resolve proof verified (${verification.backend}).`,
                playerAddress: address,
            });
        } else {
            console.log(`[ZK Round Resolve] Using verified commit proof match=${matchId} round=${roundNumber}`);
            await broadcastZkProgress({
                matchId,
                roundNumber,
                turnNumber,
                stage: "resolve_verify_reuse",
                message: "Using previously verified commit proof.",
                playerAddress: address,
            });
        }

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
            await broadcastZkProgress({
                matchId,
                roundNumber,
                turnNumber,
                stage: "awaiting_opponent_reveal",
                message: "Reveal accepted. Waiting for opponent reveal...",
                playerAddress: address,
            });
            return Response.json({
                success: true,
                roundNumber,
                awaitingOpponent: true,
                player1Revealed: p1Revealed,
                player2Revealed: p2Revealed,
                zkVerification: {
                    backend: verificationBackend,
                    command: verificationCommand,
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
                    backend: verificationBackend,
                    command: verificationCommand,
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
                    backend: verificationBackend,
                    command: verificationCommand,
                },
            });
        }

        if (resolveLockResult.state === "in_progress") {
            console.log(`[ZK Round Resolve] Resolver lock active match=${matchId} round=${roundNumber}`);
            await broadcastZkProgress({
                matchId,
                roundNumber,
                turnNumber,
                stage: "awaiting_resolver",
                message: "Another resolver is finalizing this round...",
                playerAddress: address,
            });
            return Response.json({
                success: true,
                roundNumber,
                awaitingResolver: true,
                resolver: "in_progress",
                zkVerification: {
                    backend: verificationBackend,
                    command: verificationCommand,
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
                        backend: verificationBackend,
                        command: verificationCommand,
                    },
                });
            }

            privateRoundResolveLocks.add(resolveLockKey);
        }

        try {
            await broadcastZkProgress({
                matchId,
                roundNumber,
                turnNumber,
                stage: "phase3_start",
                message: "Both reveals verified. Starting Phase 3 simulation...",
                playerAddress: address,
            });

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
                await broadcastZkProgress({
                    matchId,
                    roundNumber,
                    turnNumber: turn,
                    stage: "phase3_turn_resolving",
                    message: `Resolving private turn ${turn}/${PRIVATE_ROUND_PLAN_TURNS}...`,
                    playerAddress: address,
                });

                const round = await getOrCreateRoundTurn(matchId, roundNumber, turn);
                const plannedP1Move = p1Plan.movePlan?.[turn - 1] || "block";
                const plannedP2Move = p2Plan.movePlan?.[turn - 1] || "block";

                const p1Move = carryP1Stunned ? "stunned" : plannedP1Move;
                const p2Move = carryP2Stunned ? "stunned" : plannedP2Move;

                debugMatchEndLog(`turn=${turn} planned=(${plannedP1Move},${plannedP2Move}) effective=(${p1Move},${p2Move}) carry=(${carryP1Stunned},${carryP2Stunned}) match=${matchId} round=${roundNumber}`);

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
                    zkOutcome: {
                        verified: true,
                        backend: verificationBackend,
                        proofScope: "round_plan",
                    },
                });

                const resolutionSuccess = (resolution as any)?.success !== false;

                debugMatchEndLog(`turn=${turn} resolveTurn returned`, {
                    success: (resolution as any)?.success,
                    isRoundOver: resolution.isRoundOver,
                    isMatchOver: resolution.isMatchOver,
                    roundWinner: resolution.roundWinner,
                    matchWinner: resolution.matchWinner,
                    error: resolution.error,
                });

                if (!resolutionSuccess) {
                    const { data: latestMatch, error: latestMatchError } = await supabase
                        .from("matches")
                        .select("status, format, fight_phase, winner_address, player1_rounds_won, player2_rounds_won")
                        .eq("id", matchId)
                        .maybeSingle();

                    if (latestMatchError) {
                        throw new Error(`Private round turn ${turn} failed and match state could not be verified: ${latestMatchError.message}`);
                    }

                    const p1Rounds = Number((latestMatch as any)?.player1_rounds_won ?? 0);
                    const p2Rounds = Number((latestMatch as any)?.player2_rounds_won ?? 0);
                    const roundsToWin = (latestMatch as any)?.format === "best_of_5" ? 3 : 2;
                    const dbWinnerAddress = String((latestMatch as any)?.winner_address || "").trim();
                    const dbMatchOver =
                        (latestMatch as any)?.status === "completed"
                        || (latestMatch as any)?.fight_phase === "match_end"
                        || p1Rounds >= roundsToWin
                        || p2Rounds >= roundsToWin;

                    debugMatchEndLog(`turn=${turn} resolve error fallback DB check`, {
                        status: (latestMatch as any)?.status,
                        fightPhase: (latestMatch as any)?.fight_phase,
                        p1Rounds,
                        p2Rounds,
                        roundsToWin,
                        dbMatchOver,
                    });

                    if (dbMatchOver) {
                        const dbMatchWinner = dbWinnerAddress
                            ? (dbWinnerAddress === match.player1_address ? "player1" : dbWinnerAddress === match.player2_address ? "player2" : null)
                            : (p1Rounds >= roundsToWin ? "player1" : p2Rounds >= roundsToWin ? "player2" : null);

                        finalResolution = {
                            ...resolution,
                            success: true,
                            isMatchOver: true,
                            matchWinner: dbMatchWinner,
                        };
                        finalResolvedRoundId = round.id;

                        console.warn(
                            `[ZK Round Resolve] Turn ${turn} returned error payload, but DB shows match_end; stopping plan playback match=${matchId} round=${roundNumber} score=${p1Rounds}-${p2Rounds}`,
                        );
                        break;
                    }

                    throw new Error(
                        `Private round turn ${turn} resolve failed: ${resolution.error || "unknown error"}`,
                    );
                }

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

                await sleep(Math.max(0, PRIVATE_ROUND_TURN_DELAY_MS));
            }

            if (!finalResolution || !finalResolvedRoundId) {
                throw new Error("Private round auto-resolution failed to produce a turn result");
            }

            debugMatchEndLog(`loop complete match=${matchId} round=${roundNumber}`, {
                finalResolvedRoundId,
                isRoundOver: finalResolution.isRoundOver,
                isMatchOver: finalResolution.isMatchOver,
                roundWinner: finalResolution.roundWinner,
                matchWinner: finalResolution.matchWinner,
                error: finalResolution.error,
            });

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

            await broadcastZkProgress({
                matchId,
                roundNumber,
                stage: "phase3_complete",
                message: "Phase 3 complete. Broadcasting final round result.",
                playerAddress: address,
            });

            return Response.json({
                success: true,
                roundNumber,
                resolution: finalResolution,
                zkVerification: {
                    backend: verificationBackend,
                    command: verificationCommand,
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
        const strictMode = ZK_STRICT_FINALIZE;

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

async function broadcastZkProgress(params: {
    matchId: string;
    roundNumber: number;
    stage: string;
    message: string;
    playerAddress?: string;
    turnNumber?: number;
    color?: string;
}): Promise<void> {
    const { matchId, roundNumber, stage, message, playerAddress, turnNumber, color } = params;
    try {
        await broadcastGameEvent(matchId, "zk_progress", {
            matchId,
            roundNumber,
            turnNumber: typeof turnNumber === "number" ? turnNumber : null,
            stage,
            message,
            playerAddress: playerAddress || null,
            color: color || "#22c55e",
            at: Date.now(),
        });
    } catch (err) {
        // Best-effort: ZK progress UX must never block gameplay or chain-critical logic.
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[ZK Progress] Broadcast failed stage=${stage} match=${matchId} round=${roundNumber}: ${msg}`);
    }
}