/**
 * Stellar Contract Service (Server-side)
 *
 * Handles on-chain interactions with the Veilstar Brawl Soroban contract.
 * The new contract is a fighting-game-native design:
 *   - start_match  → registers match with Game Hub
 *   - submit_move  → records each combat move + transfers 0.0001 XLM per move
 *   - end_match    → reports winner to Game Hub
 *   - sweep_treasury → forwards XLM above 10 XLM reserve to treasury wallet
 *
 * Uses dev wallet secret keys to sign transactions on behalf of players.
 */

import {
    Keypair,
    StrKey,
    TransactionBuilder,
    hash,
    rpc,
    contract,
    Address,
    authorizeEntry,
    xdr as xdrLib,
} from "@stellar/stellar-sdk";
import { createHash } from "node:crypto";
import { Buffer } from "buffer";
import { readFile } from "node:fs/promises";
import type { PowerSurgeCardId } from "./power-surge";
import { ensureEnvLoaded } from "./env";

ensureEnvLoaded();

// =============================================================================
// CONFIG
// =============================================================================

const RPC_URL = process.env.VITE_SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = process.env.VITE_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015";
const CONTRACT_ID = process.env.VITE_VEILSTAR_BRAWL_CONTRACT_ID || "";
const ADMIN_SECRET = process.env.VITE_DEV_ADMIN_SECRET || process.env.VITE_DEV_PLAYER1_SECRET || "";
const PLAYER1_SECRET = process.env.VITE_DEV_PLAYER1_SECRET || "";
const PLAYER2_SECRET = process.env.VITE_DEV_PLAYER2_SECRET || "";
const FEE_PAYER_SECRETS_RAW =
    process.env.STELLAR_FEE_PAYER_SECRETS || process.env.VITE_DEV_FEE_PAYER_SECRETS || process.env.VITE_FEE_PAYER_SECRETS || "";

// Points committed per match (0.01 points in 7-decimal format)
const MATCH_POINTS = BigInt(100_000); // 0.01 points

// Move type mapping — must match the contract's MoveType enum
const MOVE_TYPE_MAP: Record<string, number> = {
    punch: 0,
    kick: 1,
    block: 2,
    special: 3,
};

const POWER_SURGE_CARD_CODE_MAP: Record<PowerSurgeCardId, number> = {
    "dag-overclock": 0,
    "block-fortress": 1,
    "tx-storm": 2,
    "mempool-congest": 3,
    "blue-set-heal": 4,
    "orphan-smasher": 5,
    "10bps-barrage": 6,
    "pruned-rage": 7,
    "sompi-shield": 8,
    "hash-hurricane": 9,
    "ghost-dag": 10,
    "finality-fist": 11,
    "bps-blitz": 12,
    "vaultbreaker": 13,
    "chainbreaker": 14,
};

// =============================================================================
// KEYPAIRS
// =============================================================================

function getKeypair(secretKey: string): Keypair | null {
    if (!secretKey) return null;
    try {
        return Keypair.fromSecret(secretKey);
    } catch {
        return null;
    }
}

function getAdminKeypair(): Keypair | null {
    return getKeypair(ADMIN_SECRET);
}

function getAnyConfiguredPublicKey(): string | null {
    const admin = getAdminKeypair();
    if (admin) return admin.publicKey();

    const feePayers = getFeePayerKeypairs();
    if (feePayers.length > 0) return feePayers[0]!.publicKey();

    const p1 = getKeypair(PLAYER1_SECRET);
    if (p1) return p1.publicKey();

    const p2 = getKeypair(PLAYER2_SECRET);
    if (p2) return p2.publicKey();

    return null;
}

function parseSecretList(raw: string): string[] {
    return String(raw || "")
        .split(/[\s,]+/g)
        .map((s) => s.trim())
        .filter(Boolean);
}

function getFeePayerKeypairs(): Keypair[] {
    const secrets = parseSecretList(FEE_PAYER_SECRETS_RAW);
    const keypairs: Keypair[] = [];
    for (const secret of secrets) {
        const kp = getKeypair(secret);
        if (kp) keypairs.push(kp);
    }
    return keypairs;
}

function pickFeePayerPublicKey(seed: string): string | null {
    const pool = getFeePayerKeypairs();
    if (pool.length === 0) return null;
    const digest = createHash("sha256").update(seed).digest();
    const idx = digest.readUInt32BE(0) % pool.length;
    return pool[idx]!.publicKey();
}

function pickFeePayerKeypair(seed: string): Keypair | null {
    const pub = pickFeePayerPublicKey(seed);
    return pub ? getFeePayerKeypairForPublicKey(pub) : null;
}

function getFeePayerKeypairForPublicKey(publicKey: string): Keypair | null {
    const pool = getFeePayerKeypairs();
    for (const kp of pool) {
        if (kp.publicKey() === publicKey) return kp;
    }
    return null;
}

function extractTxSourceAccount(transactionXdr: string): string | null {
    try {
        const envelope = xdrLib.TransactionEnvelope.fromXDR(transactionXdr, "base64");
        const envelopeType = envelope.switch().name;
        const tx = envelopeType === "envelopeTypeTxFeeBump"
            ? envelope.feeBump().tx().innerTx().v1().tx()
            : envelope.v1().tx();
        const source = tx.sourceAccount();
        const sourceType = source.switch().name;
        if (sourceType === "keyTypeEd25519") {
            return StrKey.encodeEd25519PublicKey(source.ed25519());
        }
        if (sourceType === "keyTypeMuxedEd25519") {
            return StrKey.encodeEd25519PublicKey(source.med25519().ed25519());
        }
        return null;
    } catch {
        return null;
    }
}

async function createFeePayerContractClient(feePayerKeypair: Keypair, contractIdOverride?: string): Promise<contract.Client> {
    return createContractClient(feePayerKeypair.publicKey(), createSigner(feePayerKeypair), contractIdOverride);
}

async function createReadOnlyContractClientWithPublicKey(publicKey: string, contractIdOverride?: string): Promise<contract.Client> {
    const contractId = resolveContractId(contractIdOverride);
    const spec = await getContractSpec(contractId);
    return new contract.Client(spec, {
        contractId,
        networkPassphrase: NETWORK_PASSPHRASE,
        rpcUrl: RPC_URL,
        publicKey,
    });
}

function getKeypairForAddress(address: string): Keypair | null {
    const p1 = getKeypair(PLAYER1_SECRET);
    const p2 = getKeypair(PLAYER2_SECRET);

    if (p1 && p1.publicKey() === address) return p1;
    if (p2 && p2.publicKey() === address) return p2;
    return null;
}

function addressKey(address: string): string {
    return Address.fromString(address).toScAddress().toXDR("base64");
}

function createSigner(keypair: Keypair): Pick<contract.ClientOptions, "signTransaction" | "signAuthEntry"> {
    return {
        signTransaction: async (txXdr: string, opts?: any) => {
            const tx = TransactionBuilder.fromXDR(txXdr, opts?.networkPassphrase || NETWORK_PASSPHRASE);
            tx.sign(keypair);
            return { signedTxXdr: tx.toXDR(), signerAddress: keypair.publicKey() };
        },
        signAuthEntry: async (preimageXdr: string) => {
            const preimageBytes = Buffer.from(preimageXdr, "base64");
            const payload = hash(preimageBytes);
            const signatureBytes = keypair.sign(payload);
            return {
                signedAuthEntry: Buffer.from(signatureBytes).toString("base64"),
                signerAddress: keypair.publicKey(),
            };
        },
    };
}

// =============================================================================
// CONTRACT CLIENT
// =============================================================================

const CONTRACT_SPEC_CACHE = new Map<string, contract.Spec>();
const CONTRACT_SPEC_LOADING = new Map<string, Promise<contract.Spec>>();

function resolveContractId(contractIdOverride?: string): string {
    const contractId = (contractIdOverride || CONTRACT_ID || "").trim();
    if (!contractId) {
        throw new Error("Stellar contract not configured (missing CONTRACT_ID)");
    }
    return contractId;
}

async function getContractSpec(contractIdOverride?: string): Promise<contract.Spec> {
    const contractId = resolveContractId(contractIdOverride);

    const cachedSpec = CONTRACT_SPEC_CACHE.get(contractId);
    if (cachedSpec) return cachedSpec;

    const pendingSpec = CONTRACT_SPEC_LOADING.get(contractId);
    if (pendingSpec) return pendingSpec;

    const loadingPromise = (async () => {
        try {
            const server = new rpc.Server(RPC_URL);
            const wasm = await server.getContractWasmByContractId(contractId);
            const spec = contract.Spec.fromWasm(wasm);
            CONTRACT_SPEC_CACHE.set(contractId, spec);
            return spec;
        } catch (err) {
            CONTRACT_SPEC_LOADING.delete(contractId);
            throw err;
        }
    })();

    CONTRACT_SPEC_LOADING.set(contractId, loadingPromise);
    return loadingPromise;
}

async function createContractClient(
    publicKey: string,
    signer: Pick<contract.ClientOptions, "signTransaction" | "signAuthEntry">,
    contractIdOverride?: string,
): Promise<contract.Client> {
    const contractId = resolveContractId(contractIdOverride);
    const spec = await getContractSpec(contractId);
    return new contract.Client(spec, {
        contractId,
        networkPassphrase: NETWORK_PASSPHRASE,
        rpcUrl: RPC_URL,
        publicKey,
        ...signer,
    });
}

// =============================================================================
// LEDGER UTILS
// =============================================================================

async function getValidUntilLedger(ttlMinutes: number = 5): Promise<number> {
    const server = new rpc.Server(RPC_URL);
    const latest = await server.getLatestLedger();
    return latest.sequence + Math.ceil(ttlMinutes * 12);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

const STAKE_SUBMISSION_LOCKS = new Map<string, Promise<void>>();
const ADMIN_SUBMISSION_LOCKS = new Map<string, Promise<void>>();
const ADMIN_LOCK_WAIT_WARN_MS = Number(process.env.STELLAR_ADMIN_LOCK_WAIT_WARN_MS ?? "2000");
const STELLAR_TX_SEND_TIMEOUT_MS = Number(process.env.STELLAR_TX_SEND_TIMEOUT_MS ?? "45000");

function truncateLockKey(lockKey: string): string {
    if (lockKey.length <= 72) return lockKey;
    return `${lockKey.slice(0, 48)}…${lockKey.slice(-16)}`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
                timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

async function withStakeSubmissionLock<T>(lockKey: string, fn: () => Promise<T>): Promise<T> {
    const previous = STAKE_SUBMISSION_LOCKS.get(lockKey) || Promise.resolve();

    let release!: () => void;
    const current = new Promise<void>((resolve) => {
        release = resolve;
    });

    STAKE_SUBMISSION_LOCKS.set(lockKey, previous.then(() => current));
    await previous;

    try {
        return await fn();
    } finally {
        release();
        if (STAKE_SUBMISSION_LOCKS.get(lockKey) === current) {
            STAKE_SUBMISSION_LOCKS.delete(lockKey);
        }
    }
}

async function withAdminSubmissionLock<T>(lockKey: string, fn: () => Promise<T>): Promise<T> {
    const previous = ADMIN_SUBMISSION_LOCKS.get(lockKey) || Promise.resolve();
    const waitStartedAt = Date.now();

    let release!: () => void;
    const current = new Promise<void>((resolve) => {
        release = resolve;
    });

    ADMIN_SUBMISSION_LOCKS.set(lockKey, previous.then(() => current));
    await previous;

    const waitedMs = Date.now() - waitStartedAt;
    if (waitedMs >= ADMIN_LOCK_WAIT_WARN_MS) {
        console.warn(`[Stellar][admin-lock] wait=${waitedMs}ms key=${truncateLockKey(lockKey)}`);
    }

    const heldStartedAt = Date.now();
    console.log(`[Stellar][admin-lock] acquired key=${truncateLockKey(lockKey)}`);

    try {
        return await fn();
    } finally {
        const heldMs = Date.now() - heldStartedAt;
        console.log(`[Stellar][admin-lock] released key=${truncateLockKey(lockKey)} held=${heldMs}ms`);
        release();
        if (ADMIN_SUBMISSION_LOCKS.get(lockKey) === current) {
            ADMIN_SUBMISSION_LOCKS.delete(lockKey);
        }
    }
}

function getAdminGlobalLockKey(contractId: string | undefined, adminPublicKey: string): string {
    return `admin:${contractId || CONTRACT_ID}:${adminPublicKey}`;
}

function isTransientSubmissionError(err: any): boolean {
    const message = String(err?.message || "");
    const responseText = String(err?.response?.data || "");
    const combined = `${message}\n${responseText}`;

    return (
        /txBadSeq/i.test(combined) ||
        /TRY_AGAIN_LATER/i.test(combined) ||
        /temporar/i.test(combined) ||
        /timeout/i.test(combined) ||
        /rate\s*limit|too\s*many\s*requests|\b429\b/i.test(combined) ||
        /service\s*unavailable|\b503\b/i.test(combined)
    );
}

function extractTxHashFromSentTx(sentTx: any): string | undefined {
    if (!sentTx) return undefined;

    const candidates: Array<unknown> = [
        sentTx?.hash,
        sentTx?.txHash,
        sentTx?.sendTransactionResponse?.hash,
        sentTx?.sendTransactionResponse?.transactionHash,
        sentTx?.result?.hash,
        sentTx?.result?.transactionHash,
    ];

    const getTransactionResponse = sentTx?.getTransactionResponse;
    if (typeof getTransactionResponse === "function") {
        try {
            const resp = getTransactionResponse.call(sentTx);
            candidates.push(resp?.hash, resp?.transactionHash);
        } catch {
            // ignore callable access errors
        }
    } else if (getTransactionResponse && typeof getTransactionResponse === "object") {
        candidates.push((getTransactionResponse as any).hash, (getTransactionResponse as any).transactionHash);
    }

    for (const value of candidates) {
        if (typeof value === "string" && value.length > 0) {
            return value;
        }
    }

    return undefined;
}

/**
 * Sign + send an assembled transaction, handling the "NoSignatureNeeded" edge case.
 */
async function signAndSendTx(tx: any): Promise<{ sentTx: any; txHash?: string }> {
    const maxAttempts = 4;
    let sentTx: any;
    let lastErr: any;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            try {
                sentTx = await withTimeout(
                    tx.signAndSend(),
                    STELLAR_TX_SEND_TIMEOUT_MS,
                    `signAndSend timed out after ${STELLAR_TX_SEND_TIMEOUT_MS}ms`,
                );
            } catch (err: any) {
                if (err?.message?.includes("NoSignatureNeeded") || err?.message?.includes("read call")) {
                    sentTx = await withTimeout(
                        tx.signAndSend({ force: true }),
                        STELLAR_TX_SEND_TIMEOUT_MS,
                        `signAndSend(force=true) timed out after ${STELLAR_TX_SEND_TIMEOUT_MS}ms`,
                    );
                } else {
                    throw err;
                }
            }

            const txHash = extractTxHashFromSentTx(sentTx);
            if (!txHash) {
                const keys = Object.keys(sentTx || {}).slice(0, 20).join(", ");
                console.warn(`[Stellar] Transaction submitted but tx hash unavailable (response keys: ${keys || "none"})`);
            }
            return { sentTx, txHash };
        } catch (err: any) {
            lastErr = err;
            const shouldRetry = attempt < maxAttempts && isTransientSubmissionError(err);
            if (!shouldRetry) {
                break;
            }

            const backoffMs = 250 * attempt;
            console.warn(`[Stellar] Transient send failure (attempt ${attempt}/${maxAttempts}) — retrying in ${backoffMs}ms`);
            await sleep(backoffMs);
        }
    }

    throw lastErr;
}

// =============================================================================
// PUBLIC API
// =============================================================================

export interface OnChainResult {
    success: boolean;
    txHash?: string;
    error?: string;
    sessionId?: number;
}

export interface SweepFeesResult extends OnChainResult {
    sweptAmountStroops?: string;
}

export interface PreparedPlayerAction {
    sessionId: number;
    transactionXdr: string;
    authEntryXdr: string;
}

/**
 * Check if the Stellar contract integration is configured.
 * Returns false if contract ID or wallet secrets are missing.
 */
export function isStellarConfigured(): boolean {
    return !!(CONTRACT_ID && PLAYER1_SECRET && PLAYER2_SECRET);
}

/**
 * Check if the contract ID alone is configured (enough for client-signed flows).
 */
export function isContractConfigured(): boolean {
    return !!CONTRACT_ID;
}

/**
 * Check if the server can run the client-signed on-chain registration flow.
 * This flow requires a funded fee-payer account to sign and submit the tx envelope.
 */
export function isOnChainRegistrationConfigured(): boolean {
    return !!(CONTRACT_ID && (ADMIN_SECRET || getFeePayerKeypairs().length > 0));
}

/**
 * Check if the server can run client-signed action submissions (move / power-surge).
 * Requires a configured contract and funded admin fee payer.
 */
export function isClientSignedActionConfigured(): boolean {
    return !!(CONTRACT_ID && (ADMIN_SECRET || getFeePayerKeypairs().length > 0));
}

export function getConfiguredContractId(): string {
    return CONTRACT_ID;
}

// =============================================================================
// XDR / error helpers
// =============================================================================

function tryDecodeTxResultXdr(resultXdr: string): string | null {
    try {
        const result = xdrLib.TransactionResult.fromXDR(resultXdr, "base64");
        const txResult = result.result();
        const txCode = txResult.switch().name;
        return txCode;
    } catch {
        return null;
    }
}

function extractResultXdr(err: any): string | undefined {
    return (
        err?.resultXdr ||
        err?.result_xdr ||
        err?.extras?.result_xdr ||
        err?.response?.data?.extras?.result_xdr ||
        err?.response?.data?.extras?.resultXdr ||
        err?.response?.data?.result_xdr
    );
}

function withDecodedResult(err: any, message: string): string {
    const resultXdr = extractResultXdr(err);
    if (!resultXdr) return message;

    const decoded = tryDecodeTxResultXdr(resultXdr);
    return decoded ? `${message} (result=${decoded})` : `${message} (resultXdr=${resultXdr})`;
}

function injectSignedAuthIntoTxEnvelope(
    transactionXdr: string,
    replacementsByAddressKey: Record<string, string | undefined>,
): { updatedXdr: string; replacedCount: number } {
    const envelope = xdrLib.TransactionEnvelope.fromXDR(transactionXdr, "base64");

    // We only expect v1 tx envelopes here (no fee-bump). Handle fee-bump defensively.
    const envelopeType = envelope.switch().name;
    const tx = envelopeType === "envelopeTypeTxFeeBump"
        ? envelope.feeBump().tx().innerTx().v1().tx()
        : envelope.v1().tx();

    let replacedCount = 0;

    const ops = tx.operations();
    for (const op of ops) {
        if (op.body().switch().name !== "invokeHostFunction") continue;

        const invoke = op.body().invokeHostFunctionOp();
        const authList = invoke.auth();

        for (let i = 0; i < authList.length; i++) {
            const entry = authList[i];
            if (entry.credentials().switch().name !== "sorobanCredentialsAddress") continue;
            const entryKey = entry.credentials().address().address().toXDR("base64");
            const signedXdr = replacementsByAddressKey[entryKey];
            if (!signedXdr) continue;
            authList[i] = xdrLib.SorobanAuthorizationEntry.fromXDR(signedXdr, "base64");
            replacedCount++;
        }
    }

    return { updatedXdr: envelope.toXDR("base64"), replacedCount };
}

function countInvokeHostFunctionAuthEntries(transactionXdr: string): number {
    const envelope = xdrLib.TransactionEnvelope.fromXDR(transactionXdr, "base64");
    const envelopeType = envelope.switch().name;
    const tx = envelopeType === "envelopeTypeTxFeeBump"
        ? envelope.feeBump().tx().innerTx().v1().tx()
        : envelope.v1().tx();

    let count = 0;
    for (const op of tx.operations()) {
        if (op.body().switch().name !== "invokeHostFunction") continue;
        count += op.body().invokeHostFunctionOp().auth().length;
    }
    return count;
}

function getPlayerAuthEntryXdr(
    authEntries: xdrLib.SorobanAuthorizationEntry[] | undefined,
    playerAddress: string,
): string {
    if (!authEntries || authEntries.length === 0) {
        throw new Error("Simulation returned no auth entries");
    }

    const playerAddressKey = addressKey(playerAddress);
    for (const entry of authEntries) {
        try {
            if (entry.credentials().switch().name !== "sorobanCredentialsAddress") continue;
            const entryKey = entry.credentials().address().address().toXDR("base64");
            if (entryKey === playerAddressKey) {
                return entry.toXDR("base64");
            }
        } catch {
            // skip non-address entries
        }
    }

    throw new Error(`No auth entry found for player ${playerAddress}`);
}

async function createAdminContractClient(contractIdOverride?: string): Promise<contract.Client> {
    const adminKeypair = getAdminKeypair();
    if (!adminKeypair) {
        throw new Error("Admin keypair not available");
    }

    return createContractClient(adminKeypair.publicKey(), createSigner(adminKeypair), contractIdOverride);
}

/**
 * Generate a deterministic session ID from a match UUID.
 * Maps the first 4 bytes of the match UUID to a u32.
 */
export function matchIdToSessionId(matchId: string): number {
    const clean = matchId.replace(/-/g, "");
    const bytes = Buffer.from(clean.slice(0, 8), "hex");
    // Use unsigned 32-bit integer (contract expects u32)
    return bytes.readUInt32BE(0);
}

/**
 * Register a match on-chain by calling `start_game()`.
 * This calls Game Hub's `start_game` to record the session.
 */
export async function registerMatchOnChain(
    matchId: string,
    player1Address: string,
    player2Address: string,
): Promise<OnChainResult> {
    if (!isStellarConfigured()) {
        return { success: false, error: "Stellar contract not configured" };
    }

    const p1Keypair = getKeypairForAddress(player1Address);
    const p2Keypair = getKeypairForAddress(player2Address);

    if (!p1Keypair || !p2Keypair) {
        return {
            success: false,
            error: `Cannot sign for players: ${!p1Keypair ? player1Address : ""} ${!p2Keypair ? player2Address : ""}`.trim(),
        };
    }

    const sessionId = matchIdToSessionId(matchId);

    try {
        console.log(`[Stellar] Registering match on-chain (sessionId: ${sessionId})`);

        const buildClient = await createContractClient(p2Keypair.publicKey(), createSigner(p2Keypair));

        const tx = await (buildClient as any).start_game({
            session_id: sessionId,
            player1: player1Address,
            player2: player2Address,
            player1_points: MATCH_POINTS,
            player2_points: MATCH_POINTS,
        });

        // Sign auth entries for both players
        const validUntil = await getValidUntilLedger(5);

        const authEntries = tx.simulationData?.result?.auth;
        if (authEntries) {
            for (let i = 0; i < authEntries.length; i++) {
                const entry = authEntries[i];
                try {
                    if (entry.credentials().switch().name !== "sorobanCredentialsAddress") continue;

                    const entryAddr = Address.fromScAddress(entry.credentials().address().address()).toString();
                    const keypair = getKeypairForAddress(entryAddr);
                    if (!keypair) continue;

                    const signer = createSigner(keypair);
                    const signed = await authorizeEntry(
                        entry,
                        async (preimage) => {
                            const result = await signer.signAuthEntry!(preimage.toXDR("base64"), {
                                networkPassphrase: NETWORK_PASSPHRASE,
                                address: entryAddr,
                            });
                            return Buffer.from(result.signedAuthEntry, "base64");
                        },
                        validUntil,
                        NETWORK_PASSPHRASE,
                    );
                    authEntries[i] = signed;
                } catch {
                    // Skip non-player auth entries
                }
            }
        }

        // Re-simulate after signing auth entries, then sign + send
        await tx.simulate();
        const { txHash } = await signAndSendTx(tx);

        console.log(`[Stellar] Match registered. Session: ${sessionId}, TX: ${txHash || "n/a"}`);
        return { success: true, txHash, sessionId };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[Stellar] Failed to register match on-chain:`, message);
        return { success: false, error: message, sessionId };
    }
}

// =============================================================================
// Client-signed registration: prepare → collect → submit
// =============================================================================

export interface PreparedRegistration {
    sessionId: number;
    /** Per-player unsigned auth entry XDR (base64) keyed by player address */
    authEntries: Record<string, string>;
    /** Players that must sign auth entries for this transaction */
    requiredAuthAddresses: string[];
    /** Full transaction XDR before auth signing (base64) */
    transactionXdr: string;
}

/**
 * Build and simulate the `start_game` transaction on the server,
 * then return the per-player auth entry XDR that each client must sign.
 * No private keys of the players are needed here.
 */
export async function prepareRegistration(
    matchId: string,
    player1Address: string,
    player2Address: string,
    options?: { sessionId?: number },
): Promise<PreparedRegistration> {
    if (!CONTRACT_ID) {
        throw new Error("Stellar contract not configured (missing CONTRACT_ID)");
    }

    const sessionId = options?.sessionId ?? matchIdToSessionId(matchId);

    // Use a funded fee-payer as tx source for this server-submitted flow.
    // Players only sign Soroban auth entries; the server signs the tx envelope with the fee payer.
    const feePayerPublicKey =
        pickFeePayerPublicKey(`register:${matchId}:${player1Address}:${player2Address}`) || getAdminKeypair()?.publicKey();
    if (!feePayerPublicKey) {
        throw new Error("On-chain registration requires STELLAR_FEE_PAYER_SECRETS (recommended) or ADMIN_SECRET (fallback)");
    }

    // Build a contract client with no signer — we only need to simulate
    const readOnlyClient = await createReadOnlyContractClientWithPublicKey(feePayerPublicKey);

    const tx = await (readOnlyClient as any).start_game({
        session_id: sessionId,
        player1: player1Address,
        player2: player2Address,
        player1_points: MATCH_POINTS,
        player2_points: MATCH_POINTS,
    });

    const authEntries = tx.simulationData?.result?.auth;
    if (!authEntries || authEntries.length === 0) {
        throw new Error("Simulation returned no auth entries");
    }

    // Map each auth entry to the player address it belongs to
    const perPlayer: Record<string, string> = {};
    const requiredAuth: string[] = [];
    const player1Key = addressKey(player1Address);
    const player2Key = addressKey(player2Address);

    for (const entry of authEntries) {
        try {
            if (entry.credentials().switch().name !== "sorobanCredentialsAddress") continue;
            const entryKey = entry.credentials().address().address().toXDR("base64");
            if (entryKey === player1Key) {
                perPlayer[player1Address] = entry.toXDR("base64");
                requiredAuth.push(player1Address);
            } else if (entryKey === player2Key) {
                perPlayer[player2Address] = entry.toXDR("base64");
                requiredAuth.push(player2Address);
            }
        } catch {
            // skip non-address entries
        }
    }

    if (requiredAuth.length === 0) {
        console.warn("[Stellar] No player auth entries required by simulation; proceeding without client signatures");
    } else if (requiredAuth.length === 1) {
        console.warn(`[Stellar] Only one player auth entry required by simulation: ${requiredAuth[0]}`);
    }

    const transactionXdr = tx.toXDR();

    // Sanity-check: the tx XDR must carry the stubbed auth entries that clients sign.
    if (requiredAuth.length > 0) {
        const embeddedAuthCount = countInvokeHostFunctionAuthEntries(transactionXdr);
        if (embeddedAuthCount === 0) {
            throw new Error(
                "Prepared transaction XDR contains 0 auth entries; cannot run client-signed auth injection flow",
            );
        }
    }

    console.log(`[Stellar] Prepared registration for session ${sessionId} — awaiting player signatures`);

    return { sessionId, authEntries: perPlayer, requiredAuthAddresses: requiredAuth, transactionXdr };
}

/**
 * Take both signed auth entries, inject them into the transaction, and submit.
 */
export async function submitSignedRegistration(
    matchId: string,
    player1Address: string,
    player2Address: string,
    signedAuthEntries: Record<string, string>,
    transactionXdr: string,
    options?: { sessionId?: number },
): Promise<OnChainResult> {
    if (!CONTRACT_ID) {
        return { success: false, error: "Stellar contract not configured" };
    }

    const sessionId = options?.sessionId ?? matchIdToSessionId(matchId);

    try {
        console.log(`[Stellar] Submitting client-signed registration (sessionId: ${sessionId})`);

        const txSource = extractTxSourceAccount(transactionXdr) || "";
        const feePayerKeypair = (txSource && getFeePayerKeypairForPublicKey(txSource)) || getAdminKeypair();
        if (!feePayerKeypair) {
            return {
                success: false,
                error: "No fee payer available. Configure STELLAR_FEE_PAYER_SECRETS (recommended) or ADMIN_SECRET (fallback).",
                sessionId,
            };
        }

        const client = await createFeePayerContractClient(feePayerKeypair);

        // Inject signed auth entries into the transaction envelope itself.
        // This must happen before re-simulation/submission.
        const replacementsByKey: Record<string, string | undefined> = {
            [addressKey(player1Address)]: signedAuthEntries[player1Address],
            [addressKey(player2Address)]: signedAuthEntries[player2Address],
        };

        const { updatedXdr, replacedCount } = injectSignedAuthIntoTxEnvelope(transactionXdr, replacementsByKey);
        if (Object.keys(signedAuthEntries).length > 0 && replacedCount === 0) {
            console.warn(
                `[Stellar] Warning: received signed auth entries but replaced 0 entries in tx envelope (sessionId: ${sessionId})`,
            );
        }

        // Import the updated transaction
        const tx = client.txFromXDR(updatedXdr);

        // Re-simulate, then sign envelope + submit
        await tx.simulate();
        const { txHash } = await signAndSendTx(tx);

        console.log(`[Stellar] Client-signed registration submitted. Session: ${sessionId}, TX: ${txHash || "n/a"}`);
        return { success: true, txHash, sessionId };
    } catch (err: any) {
        const baseMessage = err instanceof Error ? err.message : String(err);
        const message = withDecodedResult(err, baseMessage);
        console.error(`[Stellar] Failed to submit client-signed registration:`, message);
        return { success: false, error: message, sessionId };
    }
}

// =============================================================================
// submit_move — called for every combat move
// =============================================================================

/**
 * Record a combat move on-chain and transfer 0.0001 XLM from the player.
 * Called server-side after each move is submitted.
 */
export async function submitMoveOnChain(
    matchId: string,
    playerAddress: string,
    moveType: string,
    turn: number,
): Promise<OnChainResult> {
    if (!isStellarConfigured()) {
        return { success: false, error: "Stellar contract not configured" };
    }

    const keypair = getKeypairForAddress(playerAddress);
    if (!keypair) {
        return { success: false, error: `No keypair for ${playerAddress}` };
    }

    const sessionId = matchIdToSessionId(matchId);
    const moveVal = MOVE_TYPE_MAP[moveType];
    if (moveVal === undefined) {
        return { success: false, error: `Unknown move type: ${moveType}` };
    }

    try {
        const client = await createContractClient(keypair.publicKey(), createSigner(keypair));
        const tx = await (client as any).submit_move({
            session_id: sessionId,
            player: playerAddress,
            move_type: moveVal,
            turn,
        });
        const { txHash } = await signAndSendTx(tx);

        console.log(`[Stellar] Move recorded: ${moveType} by ${playerAddress.slice(0, 8)}… turn=${turn}, TX: ${txHash || "n/a"}`);
        return { success: true, txHash, sessionId };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[Stellar] Failed to submit move on-chain:`, message);
        return { success: false, error: message, sessionId };
    }
}

/**
 * Record a power surge card pick on-chain.
 */
export async function submitPowerSurgeOnChain(
    matchId: string,
    playerAddress: string,
    roundNumber: number,
    cardId: PowerSurgeCardId,
): Promise<OnChainResult> {
    if (!isStellarConfigured()) {
        return { success: false, error: "Stellar contract not configured" };
    }

    const keypair = getKeypairForAddress(playerAddress);
    if (!keypair) {
        return { success: false, error: `No keypair for ${playerAddress}` };
    }

    const sessionId = matchIdToSessionId(matchId);
    const cardCode = POWER_SURGE_CARD_CODE_MAP[cardId];
    if (cardCode === undefined) {
        return { success: false, error: `Unknown power surge card: ${cardId}` };
    }

    try {
        const client = await createContractClient(keypair.publicKey(), createSigner(keypair));
        const tx = await (client as any).submit_power_surge({
            session_id: sessionId,
            player: playerAddress,
            round: roundNumber,
            card_code: cardCode,
        });
        const { txHash } = await signAndSendTx(tx);

        console.log(
            `[Stellar] Power surge recorded: ${cardId} by ${playerAddress.slice(0, 8)}… round=${roundNumber}, TX: ${txHash || "n/a"}`,
        );
        return { success: true, txHash, sessionId };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[Stellar] Failed to submit power surge on-chain:`, message);
        return { success: false, error: message, sessionId };
    }
}

/**
 * Prepare a move transaction where the player must sign a Soroban auth entry.
 * Server uses admin as fee payer and submits only after client returns signed auth entry.
 */
export async function prepareMoveOnChain(
    matchId: string,
    playerAddress: string,
    moveType: string,
    turn: number,
): Promise<PreparedPlayerAction> {
    if (!isClientSignedActionConfigured()) {
        throw new Error("Client-signed action flow is not configured");
    }

    const sessionId = matchIdToSessionId(matchId);
    const moveVal = MOVE_TYPE_MAP[moveType];
    if (moveVal === undefined) {
        throw new Error(`Unknown move type: ${moveType}`);
    }

    const feePayerPublicKey =
        pickFeePayerPublicKey(`move:${matchId}:${playerAddress}:${turn}:${moveType}`) || getAdminKeypair()?.publicKey();
    if (!feePayerPublicKey) {
        throw new Error("Client-signed action flow requires either STELLAR_FEE_PAYER_SECRETS or ADMIN_SECRET");
    }

    const readOnlyClient = await createReadOnlyContractClientWithPublicKey(feePayerPublicKey);
    const tx = await (readOnlyClient as any).submit_move({
        session_id: sessionId,
        player: playerAddress,
        move_type: moveVal,
        turn,
    });

    const authEntryXdr = getPlayerAuthEntryXdr(tx.simulationData?.result?.auth, playerAddress);
    const transactionXdr = tx.toXDR();

    return { sessionId, transactionXdr, authEntryXdr };
}

/**
 * Prepare a private round ZK commit transaction where the player must sign auth.
 */
export async function prepareZkCommitOnChain(
    matchId: string,
    playerAddress: string,
    roundNumber: number,
    turnNumber: number,
    commitmentHex: string,
    options?: { contractId?: string; sessionId?: number },
): Promise<PreparedPlayerAction> {
    if (!isClientSignedActionConfigured()) {
        throw new Error("Client-signed action flow is not configured");
    }

    if (!Number.isInteger(roundNumber) || roundNumber < 1 || !Number.isInteger(turnNumber) || turnNumber < 1) {
        throw new Error("roundNumber and turnNumber must be positive integers");
    }

    const sessionId = options?.sessionId ?? matchIdToSessionId(matchId);
    const commitmentBytes = normalizeCommitmentHexToBytes32(commitmentHex);

    const contractId = options?.contractId || undefined;
    const feePayerPublicKey =
        pickFeePayerPublicKey(`zkcommit:${contractId || CONTRACT_ID}:${matchId}:${playerAddress}:${roundNumber}:${turnNumber}`) ||
        getAdminKeypair()?.publicKey();
    if (!feePayerPublicKey) {
        throw new Error("Client-signed action flow requires either STELLAR_FEE_PAYER_SECRETS or ADMIN_SECRET");
    }

    const readOnlyClient = await createReadOnlyContractClientWithPublicKey(feePayerPublicKey, contractId);
    const submitZkCommit = (readOnlyClient as any).submit_zk_commit;
    if (typeof submitZkCommit !== "function") {
        throw new Error("Deployed contract does not expose submit_zk_commit");
    }

    const tx = await submitZkCommit({
        session_id: sessionId,
        player: playerAddress,
        round: roundNumber,
        turn: turnNumber,
        commitment: commitmentBytes,
    });

    const authEntryXdr = getPlayerAuthEntryXdr(tx.simulationData?.result?.auth, playerAddress);
    const transactionXdr = tx.toXDR();

    return { sessionId, transactionXdr, authEntryXdr };
}

/**
 * Submit a previously prepared private round ZK commit transaction with signed auth.
 */
export async function submitSignedZkCommitOnChain(
    matchId: string,
    playerAddress: string,
    roundNumber: number,
    turnNumber: number,
    commitmentHex: string,
    signedAuthEntryXdr: string,
    transactionXdr: string,
    options?: { contractId?: string; sessionId?: number },
): Promise<OnChainResult> {
    if (!isClientSignedActionConfigured()) {
        return { success: false, error: "Client-signed action flow is not configured" };
    }

    const sessionId = options?.sessionId ?? matchIdToSessionId(matchId);

    const txSource = extractTxSourceAccount(transactionXdr) || "";
    const feePayerKeypair = (txSource && getFeePayerKeypairForPublicKey(txSource)) || getAdminKeypair();
    if (!feePayerKeypair) {
        return {
            success: false,
            error: "No fee payer available. Configure STELLAR_FEE_PAYER_SECRETS (recommended) or ADMIN_SECRET (fallback).",
            sessionId,
        };
    }

    if (!Number.isInteger(roundNumber) || roundNumber < 1 || !Number.isInteger(turnNumber) || turnNumber < 1) {
        return { success: false, error: "roundNumber and turnNumber must be positive integers", sessionId };
    }

    const lockKey = getAdminGlobalLockKey(options?.contractId || undefined, feePayerKeypair.publicKey());
    return withAdminSubmissionLock(lockKey, async () => {
        const playerShort = `${playerAddress.slice(0, 6)}…${playerAddress.slice(-4)}`;
        console.log(
            `[Stellar][submitSignedZkCommitOnChain] start match=${matchId} session=${sessionId} round=${roundNumber} turn=${turnNumber} player=${playerShort} txXdrLen=${transactionXdr?.length || 0} authXdrLen=${signedAuthEntryXdr?.length || 0}`,
        );

        const commitmentBytes = normalizeCommitmentHexToBytes32(commitmentHex);

        const buildFreshCommitXdr = async (): Promise<string> => {
            const feePayerClient = await createFeePayerContractClient(feePayerKeypair, options?.contractId || undefined);
            const submitZkCommit = (feePayerClient as any).submit_zk_commit;
            if (typeof submitZkCommit !== "function") {
                throw new Error("Deployed contract does not expose submit_zk_commit");
            }

            const freshTx = await submitZkCommit({
                session_id: sessionId,
                player: playerAddress,
                round: roundNumber,
                turn: turnNumber,
                commitment: commitmentBytes,
            });

            return freshTx.toXDR();
        };

        const submitWithXdr = async (
            xdrToSubmit: string,
        ): Promise<{ success: boolean; txHash?: string; error?: string; alreadySubmitted?: boolean }> => {
            try {
                const feePayerClient = await createFeePayerContractClient(feePayerKeypair, options?.contractId || undefined);
                const { updatedXdr, replacedCount } = injectSignedAuthIntoTxEnvelope(xdrToSubmit, {
                    [addressKey(playerAddress)]: signedAuthEntryXdr,
                });

                if (replacedCount === 0) {
                    console.warn(
                        `[Stellar][submitSignedZkCommitOnChain] auth injection replacedCount=0 match=${matchId} round=${roundNumber} turn=${turnNumber} player=${playerShort}`,
                    );
                    return { success: false, error: "Signed auth entry did not match transaction auth entries" };
                }

                console.log(
                    `[Stellar][submitSignedZkCommitOnChain] auth injected match=${matchId} round=${roundNumber} turn=${turnNumber} player=${playerShort} replacedCount=${replacedCount}`,
                );

                const tx = feePayerClient.txFromXDR(updatedXdr);
                await withTimeout(
                    tx.simulate(),
                    STELLAR_TX_SEND_TIMEOUT_MS,
                    `tx.simulate() timed out after ${STELLAR_TX_SEND_TIMEOUT_MS}ms`,
                );
                const { txHash } = await signAndSendTx(tx);
                console.log(
                    `[Stellar][submitSignedZkCommitOnChain] send success match=${matchId} round=${roundNumber} turn=${turnNumber} player=${playerShort} txHash=${txHash || "n/a"}`,
                );
                return { success: true, txHash };
            } catch (err: any) {
                const baseMessage = err instanceof Error ? err.message : String(err);
                const decoded = withDecodedResult(err, baseMessage);

                // If a client retries the exact same signed auth entry (same Soroban nonce),
                // Soroban will fail auth with ExistingValue (nonce already exists). This
                // usually means the first submission actually succeeded and consumed the nonce.
                // Treat it as idempotent success so callers can proceed.
                if (/nonce already exists for address|Error\(Auth,\s*ExistingValue\)|\bExistingValue\b/i.test(decoded)) {
                    console.warn(
                        `[Stellar][submitSignedZkCommitOnChain] nonce already exists; treating as already submitted match=${matchId} round=${roundNumber} turn=${turnNumber} player=${playerShort}`,
                    );
                    return { success: true, alreadySubmitted: true };
                }

                console.warn(
                    `[Stellar][submitSignedZkCommitOnChain] send error match=${matchId} round=${roundNumber} turn=${turnNumber} player=${playerShort} error=${decoded}`,
                );
                return { success: false, error: decoded };
            }
        };

        try {
            const maxAttempts = 3;
            let xdrToSubmit = transactionXdr;
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                console.log(
                    `[Stellar][submitSignedZkCommitOnChain] attempt=${attempt}/${maxAttempts} match=${matchId} round=${roundNumber} turn=${turnNumber} player=${playerShort}`,
                );

                const result = await submitWithXdr(xdrToSubmit);
                if (result.success) {
                    return { success: true, txHash: result.txHash, sessionId };
                }

                const errorText = String(result.error || "");

                // NOTE: txBadSeq can happen when the prepared tx envelope becomes stale
                // (admin fee-payer submitted another tx). We can safely rebuild a fresh
                // envelope and re-inject the SAME signed Soroban auth entry because the
                // auth signature is over the auth entry itself (invocation + nonce), not
                // over the fee-payer account sequence.
                const retryable = /txBadSeq|TRY_AGAIN_LATER|temporar|timeout|Sending the transaction to the network failed/i.test(errorText);
                if (!retryable || attempt === maxAttempts) {
                    console.warn(
                        `[Stellar][submitSignedZkCommitOnChain] giving up attempt=${attempt} retryable=${retryable} match=${matchId} round=${roundNumber} turn=${turnNumber} player=${playerShort}`,
                    );
                    return { success: false, error: errorText || "Failed to submit signed zk commit", sessionId };
                }

                await sleep(150 * attempt);
                try {
                    xdrToSubmit = await buildFreshCommitXdr();
                } catch (rebuildErr: any) {
                    const rebuildMsg = rebuildErr instanceof Error ? rebuildErr.message : String(rebuildErr);
                    console.warn(
                        `[Stellar][submitSignedZkCommitOnChain] rebuild fresh tx failed attempt=${attempt} match=${matchId} round=${roundNumber} turn=${turnNumber} player=${playerShort}: ${rebuildMsg}`,
                    );
                    // keep previous xdrToSubmit; next attempt may still succeed if error was transient
                }
            }

            return { success: false, error: "Failed to submit signed zk commit after retries", sessionId };
        } catch (err: any) {
            const baseMessage = err instanceof Error ? err.message : String(err);
            return { success: false, error: withDecodedResult(err, baseMessage), sessionId };
        }
    });
}

/**
 * Submit a previously prepared move transaction with the player's signed auth entry.
 */
export async function submitSignedMoveOnChain(
    matchId: string,
    playerAddress: string,
    signedAuthEntryXdr: string,
    transactionXdr: string,
): Promise<OnChainResult> {
    if (!isClientSignedActionConfigured()) {
        return { success: false, error: "Client-signed action flow is not configured" };
    }

    const sessionId = matchIdToSessionId(matchId);

    try {
        const txSource = extractTxSourceAccount(transactionXdr) || "";
        const feePayerKeypair = (txSource && getFeePayerKeypairForPublicKey(txSource)) || getAdminKeypair();
        if (!feePayerKeypair) {
            return { success: false, error: "No fee payer available for move submission", sessionId };
        }

        const feePayerClient = await createFeePayerContractClient(feePayerKeypair);
        const { updatedXdr, replacedCount } = injectSignedAuthIntoTxEnvelope(transactionXdr, {
            [addressKey(playerAddress)]: signedAuthEntryXdr,
        });

        if (replacedCount === 0) {
            return { success: false, error: "Signed auth entry did not match transaction auth entries", sessionId };
        }

        const tx = feePayerClient.txFromXDR(updatedXdr);
        await tx.simulate();
        const { txHash } = await signAndSendTx(tx);

        return { success: true, txHash, sessionId };
    } catch (err: any) {
        const baseMessage = err instanceof Error ? err.message : String(err);
        return { success: false, error: withDecodedResult(err, baseMessage), sessionId };
    }
}

/**
 * Prepare a power-surge submission transaction where the player must sign auth.
 */
export async function preparePowerSurgeOnChain(
    matchId: string,
    playerAddress: string,
    roundNumber: number,
    cardId: PowerSurgeCardId,
): Promise<PreparedPlayerAction> {
    if (!isClientSignedActionConfigured()) {
        throw new Error("Client-signed action flow is not configured");
    }

    const sessionId = matchIdToSessionId(matchId);
    const cardCode = POWER_SURGE_CARD_CODE_MAP[cardId];
    if (cardCode === undefined) {
        throw new Error(`Unknown power surge card: ${cardId}`);
    }

    const feePayerPublicKey =
        pickFeePayerPublicKey(`powersurge:${matchId}:${playerAddress}:${roundNumber}:${cardId}`) || getAdminKeypair()?.publicKey();
    if (!feePayerPublicKey) {
        throw new Error("Client-signed action flow requires either STELLAR_FEE_PAYER_SECRETS or ADMIN_SECRET");
    }

    const readOnlyClient = await createReadOnlyContractClientWithPublicKey(feePayerPublicKey);
    const tx = await (readOnlyClient as any).submit_power_surge({
        session_id: sessionId,
        player: playerAddress,
        round: roundNumber,
        card_code: cardCode,
    });

    const authEntryXdr = getPlayerAuthEntryXdr(tx.simulationData?.result?.auth, playerAddress);
    const transactionXdr = tx.toXDR();

    return { sessionId, transactionXdr, authEntryXdr };
}

/**
 * Submit a previously prepared power-surge transaction with signed auth entry.
 */
export async function submitSignedPowerSurgeOnChain(
    matchId: string,
    playerAddress: string,
    signedAuthEntryXdr: string,
    transactionXdr: string,
): Promise<OnChainResult> {
    if (!isClientSignedActionConfigured()) {
        return { success: false, error: "Client-signed action flow is not configured" };
    }

    const sessionId = matchIdToSessionId(matchId);

    try {
        const txSource = extractTxSourceAccount(transactionXdr) || "";
        const feePayerKeypair = (txSource && getFeePayerKeypairForPublicKey(txSource)) || getAdminKeypair();
        if (!feePayerKeypair) {
            return { success: false, error: "No fee payer available for power surge submission", sessionId };
        }

        const feePayerClient = await createFeePayerContractClient(feePayerKeypair);
        const { updatedXdr, replacedCount } = injectSignedAuthIntoTxEnvelope(transactionXdr, {
            [addressKey(playerAddress)]: signedAuthEntryXdr,
        });

        if (replacedCount === 0) {
            return { success: false, error: "Signed auth entry did not match transaction auth entries", sessionId };
        }

        const tx = feePayerClient.txFromXDR(updatedXdr);
        await tx.simulate();
        const { txHash } = await signAndSendTx(tx);

        return { success: true, txHash, sessionId };
    } catch (err: any) {
        const baseMessage = err instanceof Error ? err.message : String(err);
        return { success: false, error: withDecodedResult(err, baseMessage), sessionId };
    }
}

/**
 * Prepare a stake-deposit transaction where the player must sign auth.
 */
export async function prepareStakeDepositOnChain(
    matchId: string,
    playerAddress: string,
    options?: { sessionId?: number; contractId?: string },
): Promise<PreparedPlayerAction> {
    if (!isClientSignedActionConfigured()) {
        throw new Error("Client-signed action flow is not configured");
    }

    const sessionId = options?.sessionId ?? matchIdToSessionId(matchId);
    const contractId = options?.contractId || undefined;

    const feePayerPublicKey =
        pickFeePayerPublicKey(`stake:${matchId}:${playerAddress}`) || getAdminKeypair()?.publicKey();
    if (!feePayerPublicKey) {
        throw new Error("Client-signed action flow requires either STELLAR_FEE_PAYER_SECRETS or ADMIN_SECRET");
    }

    const readOnlyClient = await createReadOnlyContractClientWithPublicKey(feePayerPublicKey, contractId);
    const tx = await (readOnlyClient as any).deposit_stake({
        session_id: sessionId,
        player: playerAddress,
    });

    const authEntryXdr = getPlayerAuthEntryXdr(tx.simulationData?.result?.auth, playerAddress);
    const transactionXdr = tx.toXDR();

    return { sessionId, transactionXdr, authEntryXdr };
}

/**
 * Submit a previously prepared stake-deposit transaction with signed auth entry.
 */
export async function submitSignedStakeDepositOnChain(
    matchId: string,
    playerAddress: string,
    signedAuthEntryXdr: string,
    transactionXdr: string,
    options?: { sessionId?: number; contractId?: string },
): Promise<OnChainResult> {
    if (!isClientSignedActionConfigured()) {
        return { success: false, error: "Client-signed action flow is not configured" };
    }

    const sessionId = options?.sessionId ?? matchIdToSessionId(matchId);
    const contractId = options?.contractId || undefined;

    const submitWithTransactionXdr = async (xdrToSubmit: string): Promise<{ txHash?: string; error?: string }> => {
        try {
            const txSource = extractTxSourceAccount(xdrToSubmit) || "";
            const feePayerKeypair = (txSource && getFeePayerKeypairForPublicKey(txSource)) || getAdminKeypair();
            if (!feePayerKeypair) {
                return { error: "No fee payer available for stake submission" };
            }
            const feePayerClient = await createFeePayerContractClient(feePayerKeypair, contractId);
            const { updatedXdr, replacedCount } = injectSignedAuthIntoTxEnvelope(xdrToSubmit, {
                [addressKey(playerAddress)]: signedAuthEntryXdr,
            });

            if (replacedCount === 0) {
                return { error: "Signed auth entry did not match transaction auth entries" };
            }

            const tx = feePayerClient.txFromXDR(updatedXdr);
            await tx.simulate();
            const { txHash } = await signAndSendTx(tx);
            return { txHash };
        } catch (err: any) {
            const baseMessage = err instanceof Error ? err.message : String(err);
            return { error: withDecodedResult(err, baseMessage) };
        }
    };

    const lockKey = `stake:${sessionId}`;

    try {
        return await withStakeSubmissionLock(lockKey, async () => {
            // First attempt with client-provided prepared transaction.
            let candidateXdr = transactionXdr;
            const maxAttempts = 4;

            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                const submitAttempt = await submitWithTransactionXdr(candidateXdr);
                if (!submitAttempt.error) {
                    return { success: true, txHash: submitAttempt.txHash, sessionId };
                }

                if (!/txBadSeq/i.test(submitAttempt.error)) {
                    return { success: false, error: submitAttempt.error, sessionId };
                }

                if (attempt >= maxAttempts) {
                    return { success: false, error: submitAttempt.error, sessionId };
                }

                // Sequence race on shared fee payer. Rebuild with a fresh sequence and retry.
                try {
                    const refreshed = await prepareStakeDepositOnChain(matchId, playerAddress, { sessionId, contractId });
                    candidateXdr = refreshed.transactionXdr;
                    await sleep(100 * attempt);
                } catch (refreshErr: any) {
                    const refreshMessage = refreshErr instanceof Error ? refreshErr.message : String(refreshErr);
                    return { success: false, error: `txBadSeq retry failed: ${refreshMessage}`, sessionId };
                }
            }

            return { success: false, error: "Stake submit retries exhausted", sessionId };
        });
    } catch (err: any) {
        const baseMessage = err instanceof Error ? err.message : String(err);
        return { success: false, error: withDecodedResult(err, baseMessage), sessionId };
    }
}

// =============================================================================
// end_match — called when the server determines a winner
// =============================================================================

/**
 * Report match result on-chain by calling `end_game()`.
 * Only the admin wallet can call this (server acts as admin).
 * This calls Game Hub's `end_game`.
 */
export async function reportMatchResultOnChain(
    matchId: string,
    player1Address: string,
    player2Address: string,
    winnerAddress: string,
    options?: {
        sessionId?: number;
        contractId?: string;
    },
): Promise<OnChainResult> {
    if (!isStellarConfigured()) {
        return { success: false, error: "Stellar contract not configured" };
    }

    const sessionId = options?.sessionId ?? matchIdToSessionId(matchId);
    const contractId = options?.contractId || undefined;
    const player1Won = winnerAddress === player1Address;

    const adminKeypair = getAdminKeypair();
    if (!adminKeypair) {
        return { success: false, error: "Admin keypair not available", sessionId };
    }

    const lockKey = getAdminGlobalLockKey(contractId, adminKeypair.publicKey());
    return withAdminSubmissionLock(lockKey, async () => {
        const maxAttempts = 4;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                console.log(`[Stellar] Reporting match result on-chain (sessionId: ${sessionId}, contract: ${contractId || CONTRACT_ID}, attempt: ${attempt}/${maxAttempts})`);

                const client = await createContractClient(adminKeypair.publicKey(), createSigner(adminKeypair), contractId);
                const tx = await (client as any).end_game({
                    session_id: sessionId,
                    player1_won: player1Won,
                });
                const { txHash } = await signAndSendTx(tx);

                console.log(`[Stellar] Match result reported. Session: ${sessionId}, TX: ${txHash || "n/a"}`);
                return { success: true, txHash, sessionId };
            } catch (err) {
                const baseMessage = err instanceof Error ? err.message : String(err);
                const message = withDecodedResult(err, baseMessage);

                if (!isTransientSubmissionError(err) || attempt >= maxAttempts) {
                    console.error(`[Stellar] Failed to report match result on-chain:`, message);
                    return { success: false, error: message, sessionId };
                }

                await sleep(250 * attempt);
            }
        }

        return { success: false, error: "end_game retries exhausted", sessionId };
    });
}

// =============================================================================
// get_match — query on-chain match state
// =============================================================================

/**
 * Query on-chain match state.
 */
export async function getOnChainMatchState(matchId: string): Promise<any | null> {
    if (!isStellarConfigured()) return null;

    const sessionId = matchIdToSessionId(matchId);

    try {
        const publicKey = getAnyConfiguredPublicKey();
        const client = publicKey
            ? await createReadOnlyContractClientWithPublicKey(publicKey)
            : new contract.Client(await getContractSpec(), {
                contractId: CONTRACT_ID,
                networkPassphrase: NETWORK_PASSPHRASE,
                rpcUrl: RPC_URL,
            });

        const tx = await (client as any).get_match({ session_id: sessionId });
        const result = tx?.result;
        if (!result) return null;

        // get_match returns Result<Match> (Soroban style) which is typically { ok: Match } or { error: ... }.
        if (typeof result === "object") {
            if ("error" in result) return null;
            if ("ok" in result) return (result as any).ok ?? null;
            // Current @stellar/stellar-sdk contract decoding often returns Result wrappers as { value: Match }.
            if ("value" in result) return (result as any).value ?? null;

            // Some builds return a Result-like object with an unwrap() method.
            const maybeUnwrap = (result as any).unwrap;
            if (typeof maybeUnwrap === "function") {
                try {
                    return maybeUnwrap.call(result);
                } catch {
                    return null;
                }
            }

            // Fallback: nested result holder.
            if ("result" in result) {
                const nested = (result as any).result;
                if (nested && typeof nested === "object") {
                    if ("ok" in nested) return (nested as any).ok ?? null;
                    if ("value" in nested) return (nested as any).value ?? null;
                }
            }
        }

        return result ?? null;
    } catch {
        return null;
    }
}

export async function getOnChainMatchStateBySession(
    sessionId: number,
    options?: { contractId?: string },
): Promise<any | null> {
    if (!isStellarConfigured()) return null;

    try {
        const contractId = options?.contractId || undefined;
        const publicKey = getAnyConfiguredPublicKey();
        const client = publicKey
            ? await createReadOnlyContractClientWithPublicKey(publicKey, contractId)
            : new contract.Client(await getContractSpec(contractId), {
                contractId: resolveContractId(contractId),
                networkPassphrase: NETWORK_PASSPHRASE,
                rpcUrl: RPC_URL,
            });

        const tx = await (client as any).get_match({ session_id: sessionId });
        const result = tx?.result;
        if (!result) return null;

        if (typeof result === "object") {
            if ("error" in result) return null;
            if ("ok" in result) return (result as any).ok ?? null;
            if ("value" in result) return (result as any).value ?? null;

            const maybeUnwrap = (result as any).unwrap;
            if (typeof maybeUnwrap === "function") {
                try {
                    return maybeUnwrap.call(result);
                } catch {
                    return null;
                }
            }

            if ("result" in result) {
                const nested = (result as any).result;
                if (nested && typeof nested === "object") {
                    if ("ok" in nested) return (nested as any).ok ?? null;
                    if ("value" in nested) return (nested as any).value ?? null;
                }
            }
        }

        return result ?? null;
    } catch {
        return null;
    }
}

/**
 * Configure stake amount for a match on-chain.
 */
export async function setMatchStakeOnChain(
    matchId: string,
    stakeAmountStroops: bigint,
    options?: { sessionId?: number; contractId?: string },
): Promise<OnChainResult> {
    if (!isOnChainRegistrationConfigured()) {
        return { success: false, error: "Stellar contract not configured for admin submissions" };
    }

    const sessionId = options?.sessionId ?? matchIdToSessionId(matchId);
    const contractId = options?.contractId || undefined;
    const adminKeypair = getAdminKeypair();
    if (!adminKeypair) {
        return { success: false, error: "Admin keypair not available", sessionId };
    }

    try {
        const maxAttempts = 4;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const client = await createContractClient(adminKeypair.publicKey(), createSigner(adminKeypair), contractId);
                const setMatchStake = (client as any).set_match_stake;
                if (typeof setMatchStake !== "function") {
                    return {
                        success: false,
                        error: "Deployed contract does not expose set_match_stake. Redeploy the updated veilstar-brawl contract and restart server.",
                        sessionId,
                    };
                }

                const tx = await setMatchStake({
                    session_id: sessionId,
                    stake_amount_stroops: stakeAmountStroops,
                });
                const { txHash } = await signAndSendTx(tx);
                return { success: true, txHash, sessionId };
            } catch (attemptErr) {
                const attemptMessage = attemptErr instanceof Error ? attemptErr.message : String(attemptErr);
                if (!/txBadSeq/i.test(attemptMessage) || attempt >= maxAttempts) {
                    return { success: false, error: attemptMessage, sessionId };
                }

                await sleep(100 * attempt);
            }
        }

        return { success: false, error: "Stake configuration retries exhausted", sessionId };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: message, sessionId };
    }
}

function normalizeCommitmentHexToBytes32(commitmentHex: string): Buffer {
    const normalized = commitmentHex.trim().toLowerCase();
    if (!/^0x[0-9a-f]+$/.test(normalized)) {
        throw new Error("Invalid commitment hex format");
    }

    const rawHex = normalized.slice(2);
    if (rawHex.length === 0 || rawHex.length > 64) {
        throw new Error("Commitment hex length must be between 1 and 32 bytes");
    }

    const padded = rawHex.padStart(64, "0");
    return Buffer.from(padded, "hex");
}

function normalizeSha256HexToBytes32(inputHex: string, label: string): Buffer {
    const normalized = inputHex.trim().toLowerCase().replace(/^0x/, "");
    if (!/^[0-9a-f]{64}$/.test(normalized)) {
        throw new Error(`${label} must be a 32-byte hex string`);
    }

    return Buffer.from(normalized, "hex");
}

function normalizeHexToBytes32(inputHex: string, label: string): Buffer {
    const normalized = inputHex.trim().toLowerCase().replace(/^0x/, "");
    if (!/^[0-9a-f]{64}$/.test(normalized)) {
        throw new Error(`${label} must be a 32-byte hex string`);
    }

    return Buffer.from(normalized, "hex");
}

function hashUnknownToSha256Hex(value: unknown): string {
    if (value === undefined || value === null) {
        return createHash("sha256").update(Buffer.alloc(0)).digest("hex");
    }

    if (typeof value === "string") {
        const text = value.trim();
        if (text.startsWith("base64:")) {
            const decoded = Buffer.from(text.slice("base64:".length), "base64");
            return createHash("sha256").update(decoded).digest("hex");
        }
        if (/^0x[0-9a-f]+$/i.test(text)) {
            const decoded = Buffer.from(text.slice(2), "hex");
            return createHash("sha256").update(decoded).digest("hex");
        }

        return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
    }

    return createHash("sha256").update(Buffer.from(JSON.stringify(value), "utf8")).digest("hex");
}

export async function setZkGateRequiredOnChain(
    required: boolean,
    options?: { contractId?: string },
): Promise<OnChainResult> {
    if (!isOnChainRegistrationConfigured()) {
        return { success: false, error: "Stellar contract not configured for admin submissions" };
    }

    const contractId = options?.contractId || undefined;
    const adminKeypair = getAdminKeypair();
    if (!adminKeypair) {
        return { success: false, error: "Admin keypair not available" };
    }

    const lockKey = getAdminGlobalLockKey(contractId, adminKeypair.publicKey());
    return withAdminSubmissionLock(lockKey, async () => {
        try {
            const client = await createContractClient(adminKeypair.publicKey(), createSigner(adminKeypair), contractId);
            const setZkGateRequired = (client as any).set_zk_gate_required;
            if (typeof setZkGateRequired !== "function") {
                return {
                    success: false,
                    error: "Deployed contract does not expose set_zk_gate_required. Redeploy the updated veilstar-brawl contract and restart server.",
                };
            }

            const tx = await setZkGateRequired({ required });
            const { txHash } = await signAndSendTx(tx);
            return { success: true, txHash };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (/"status"\s*:\s*"DUPLICATE"|\bDUPLICATE\b/i.test(message)) {
                return { success: true };
            }
            return { success: false, error: message };
        }
    });
}

export async function submitZkCommitOnChain(
    matchId: string,
    playerAddress: string,
    roundNumber: number,
    turnNumber: number,
    commitmentHex: string,
    options?: { contractId?: string; sessionId?: number },
): Promise<OnChainResult> {
    if (!isStellarConfigured()) {
        return { success: false, error: "Stellar contract not configured" };
    }

    const keypair = getKeypairForAddress(playerAddress);
    if (!keypair) {
        return { success: false, error: `No keypair for ${playerAddress}` };
    }

    if (!Number.isInteger(roundNumber) || roundNumber < 1 || !Number.isInteger(turnNumber) || turnNumber < 1) {
        return { success: false, error: "roundNumber and turnNumber must be positive integers" };
    }

    const sessionId = options?.sessionId ?? matchIdToSessionId(matchId);
    const contractId = options?.contractId || undefined;

    try {
        const commitmentBytes = normalizeCommitmentHexToBytes32(commitmentHex);

        const client = await createContractClient(keypair.publicKey(), createSigner(keypair), contractId);
        const submitZkCommit = (client as any).submit_zk_commit;
        if (typeof submitZkCommit !== "function") {
            return {
                success: false,
                error: "Deployed contract does not expose submit_zk_commit. Redeploy the updated veilstar-brawl contract and restart server.",
                sessionId,
            };
        }

        const tx = await submitZkCommit({
            session_id: sessionId,
            player: playerAddress,
            round: roundNumber,
            turn: turnNumber,
            commitment: commitmentBytes,
        });
        const { txHash } = await signAndSendTx(tx);

        return { success: true, txHash, sessionId };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: message, sessionId };
    }
}

export async function submitZkVerificationOnChain(
    matchId: string,
    playerAddress: string,
    roundNumber: number,
    turnNumber: number,
    commitmentHex: string,
    vkIdHex: string,
    proof: unknown,
    publicInputs: unknown,
    options?: { contractId?: string; sessionId?: number },
): Promise<OnChainResult> {
    if (!isOnChainRegistrationConfigured()) {
        return { success: false, error: "Stellar contract not configured for verifier submissions" };
    }

    if (!Number.isInteger(roundNumber) || roundNumber < 1 || !Number.isInteger(turnNumber) || turnNumber < 1) {
        return { success: false, error: "roundNumber and turnNumber must be positive integers" };
    }

    const sessionId = options?.sessionId ?? matchIdToSessionId(matchId);
    const contractId = options?.contractId || undefined;

    const feePayerKeypair =
        pickFeePayerKeypair(`zkverify:${contractId || CONTRACT_ID}:${matchId}:${playerAddress}:${roundNumber}:${turnNumber}`) ||
        getAdminKeypair();
    if (!feePayerKeypair) {
        return {
            success: false,
            error: "No fee payer available. Configure STELLAR_FEE_PAYER_SECRETS (recommended) or ADMIN_SECRET (fallback).",
            sessionId,
        };
    }

    const lockKey = getAdminGlobalLockKey(contractId, feePayerKeypair.publicKey());
    return withAdminSubmissionLock(lockKey, async () => {
        const maxAttempts = 4;

        // Normalize/validate once outside the retry loop.
        const commitmentBytes = normalizeCommitmentHexToBytes32(commitmentHex);
        const vkIdBytes = normalizeHexToBytes32(vkIdHex, "vkId");

        const rawProofBytes = decodeMaybeBase64(proof);
        if (!rawProofBytes) {
            return { success: false, error: "proof must be base64-encoded bytes", sessionId };
        }

        if (rawProofBytes.length !== 256) {
            return {
                success: false,
                error: `Trustless mode requires Groth16 calldata proof (256 bytes); received ${rawProofBytes.length} bytes`,
                sessionId,
            };
        }

        const publicInputsBytes = normalizePublicInputsToBytes32(publicInputs);
        const proofBytes = rawProofBytes;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const client = await createContractClient(
                    feePayerKeypair.publicKey(),
                    createSigner(feePayerKeypair),
                    contractId,
                );
                const submitZkVerification = (client as any).submit_zk_verification;
                if (typeof submitZkVerification !== "function") {
                    return {
                        success: false,
                        error: "Deployed contract does not expose submit_zk_verification. Redeploy the updated veilstar-brawl contract and restart server.",
                        sessionId,
                    };
                }

                const tx = await submitZkVerification({
                    session_id: sessionId,
                    player: playerAddress,
                    round: roundNumber,
                    turn: turnNumber,
                    commitment: commitmentBytes,
                    vk_id: vkIdBytes,
                    proof: proofBytes,
                    public_inputs: publicInputsBytes,
                });

                const { txHash } = await signAndSendTx(tx);
                return { success: true, txHash, sessionId };
            } catch (err) {
                const baseMessage = err instanceof Error ? err.message : String(err);
                const message = withDecodedResult(err, baseMessage);

                if (!isTransientSubmissionError(err) || attempt >= maxAttempts) {
                    return { success: false, error: message, sessionId };
                }

                await sleep(250 * attempt);
            }
        }

        return { success: false, error: "submit_zk_verification retries exhausted", sessionId };
    });
}

export async function submitZkMatchOutcomeOnChain(
    matchId: string,
    winnerAddress: string,
    vkIdHex: string,
    proof: unknown,
    publicInputs: unknown,
    options?: { contractId?: string; sessionId?: number },
): Promise<OnChainResult> {
    if (!isOnChainRegistrationConfigured()) {
        return { success: false, error: "Stellar contract not configured for verifier submissions" };
    }

    const sessionId = options?.sessionId ?? matchIdToSessionId(matchId);
    const contractId = options?.contractId || undefined;

    const feePayerKeypair =
        pickFeePayerKeypair(`zkoutcome:${contractId || CONTRACT_ID}:${matchId}:${winnerAddress}`) || getAdminKeypair();
    if (!feePayerKeypair) {
        return {
            success: false,
            error: "No fee payer available. Configure STELLAR_FEE_PAYER_SECRETS (recommended) or ADMIN_SECRET (fallback).",
            sessionId,
        };
    }

    const lockKey = getAdminGlobalLockKey(contractId, feePayerKeypair.publicKey());
    return withAdminSubmissionLock(lockKey, async () => {
        const maxAttempts = 4;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const vkIdBytes = normalizeHexToBytes32(vkIdHex, "vkId");

                const proofBytes = decodeMaybeBase64(proof);
                if (!proofBytes) {
                    return { success: false, error: "proof must be base64-encoded bytes", sessionId };
                }

                if (proofBytes.length !== 256) {
                    return {
                        success: false,
                        error: `Trustless mode requires Groth16 calldata proof (256 bytes); received ${proofBytes.length} bytes`,
                        sessionId,
                    };
                }

                const publicInputsBytes = normalizePublicInputsToBytes32(publicInputs);
                if (publicInputsBytes.length === 0) {
                    return { success: false, error: "public inputs cannot be empty", sessionId };
                }

                if (publicInputsBytes.length !== 1) {
                    return {
                        success: false,
                        error: `Trustless mode requires exactly 1 public input (commitment); received ${publicInputsBytes.length}`,
                        sessionId,
                    };
                }

                const client = await createContractClient(
                    feePayerKeypair.publicKey(),
                    createSigner(feePayerKeypair),
                    contractId,
                );
                const submitMatchOutcome = (client as any).submit_zk_match_outcome;
                if (typeof submitMatchOutcome !== "function") {
                    return {
                        success: false,
                        error: "Deployed contract does not expose submit_zk_match_outcome. Redeploy the updated veilstar-brawl contract and restart server.",
                        sessionId,
                    };
                }

                const tx = await submitMatchOutcome({
                    session_id: sessionId,
                    winner: winnerAddress,
                    vk_id: vkIdBytes,
                    proof: proofBytes,
                    public_inputs: publicInputsBytes,
                });
                const { txHash } = await signAndSendTx(tx);

                return { success: true, txHash, sessionId };
            } catch (err) {
                const baseMessage = err instanceof Error ? err.message : String(err);
                const message = withDecodedResult(err, baseMessage);
                if (!isTransientSubmissionError(err) || attempt >= maxAttempts) {
                    return { success: false, error: message, sessionId };
                }

                await sleep(250 * attempt);
            }
        }

        return { success: false, error: "submit_zk_match_outcome retries exhausted", sessionId };
    });
}

function decodeMaybeBase64(value: unknown): Buffer | null {
    if (typeof value !== "string") return null;
    const text = value.trim();
    if (!text.startsWith("base64:")) return null;
    return Buffer.from(text.slice("base64:".length), "base64");
}

function normalizePublicInputsToBytes32(value: unknown): Buffer[] {
    const parseNumberLike = (entry: unknown): Buffer => {
        if (typeof entry === "string") {
            const text = entry.trim();
            if (/^0x[0-9a-fA-F]+$/.test(text)) {
                const raw = text.slice(2);
                if (raw.length > 64) throw new Error("public input hex value exceeds 32 bytes");
                return Buffer.from(raw.padStart(64, "0"), "hex");
            }
            if (/^[0-9]+$/.test(text)) {
                const valueBig = BigInt(text);
                const hex = valueBig.toString(16);
                if (hex.length > 64) throw new Error("public input decimal value exceeds 32 bytes");
                return Buffer.from(hex.padStart(64, "0"), "hex");
            }
        }

        if (typeof entry === "number" && Number.isFinite(entry) && Number.isInteger(entry) && entry >= 0) {
            const hex = BigInt(entry).toString(16);
            if (hex.length > 64) throw new Error("public input number exceeds 32 bytes");
            return Buffer.from(hex.padStart(64, "0"), "hex");
        }

        throw new Error("public inputs must be hex or decimal scalars");
    };

    if (Array.isArray(value)) {
        return value.map(parseNumberLike);
    }

    if (typeof value === "string") {
        const decoded = decodeMaybeBase64(value);
        if (decoded) {
            const asText = decoded.toString("utf8").trim();
            if (asText.startsWith("[")) {
                const parsed = JSON.parse(asText);
                if (!Array.isArray(parsed)) throw new Error("public inputs payload must decode to array");
                return parsed.map(parseNumberLike);
            }

            if (decoded.length === 0) {
                throw new Error("public inputs base64 payload is empty");
            }

            if (decoded.length % 32 !== 0) {
                throw new Error("public inputs base64 must decode to a JSON array or 32-byte packed field elements");
            }

            const chunks: Buffer[] = [];
            for (let offset = 0; offset < decoded.length; offset += 32) {
                chunks.push(decoded.subarray(offset, offset + 32));
            }
            return chunks;
        }

        const trimmed = value.trim();
        if (trimmed.startsWith("[")) {
            const parsed = JSON.parse(trimmed);
            if (!Array.isArray(parsed)) throw new Error("public inputs payload must be array");
            return parsed.map(parseNumberLike);
        }
    }

    throw new Error("Unsupported public inputs format for on-chain verifier");
}

export async function setZkVerifierContractOnChain(
    verifierContractAddress: string,
    options?: { contractId?: string },
): Promise<OnChainResult> {
    if (!isOnChainRegistrationConfigured()) {
        return { success: false, error: "Stellar contract not configured for admin submissions" };
    }

    const contractId = options?.contractId || undefined;
    const adminKeypair = getAdminKeypair();
    if (!adminKeypair) {
        return { success: false, error: "Admin keypair not available" };
    }

    const lockKey = getAdminGlobalLockKey(contractId, adminKeypair.publicKey());
    return withAdminSubmissionLock(lockKey, async () => {
        try {
            const client = await createContractClient(adminKeypair.publicKey(), createSigner(adminKeypair), contractId);
            const setVerifier = (client as any).set_zk_verifier_contract;
            if (typeof setVerifier !== "function") {
                return {
                    success: false,
                    error: "Deployed contract does not expose set_zk_verifier_contract. Redeploy veilstar-brawl and restart server.",
                };
            }

            const tx = await setVerifier({ verifier_contract: verifierContractAddress });
            const { txHash } = await signAndSendTx(tx);
            return { success: true, txHash };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (/"status"\s*:\s*"DUPLICATE"|\bDUPLICATE\b/i.test(message)) {
                return { success: true };
            }
            return { success: false, error: message };
        }
    });
}

export async function setZkVerifierVkIdOnChain(
    vkIdHex: string,
    options?: { contractId?: string },
): Promise<OnChainResult> {
    if (!isOnChainRegistrationConfigured()) {
        return { success: false, error: "Stellar contract not configured for admin submissions" };
    }

    const contractId = options?.contractId || undefined;
    const adminKeypair = getAdminKeypair();
    if (!adminKeypair) {
        return { success: false, error: "Admin keypair not available" };
    }

    const lockKey = getAdminGlobalLockKey(contractId, adminKeypair.publicKey());
    return withAdminSubmissionLock(lockKey, async () => {
        try {
            const vkIdBytes = normalizeHexToBytes32(vkIdHex, "vkId");
            const client = await createContractClient(adminKeypair.publicKey(), createSigner(adminKeypair), contractId);
            const setVkId = (client as any).set_zk_verifier_vk_id;
            if (typeof setVkId !== "function") {
                return {
                    success: false,
                    error: "Deployed contract does not expose set_zk_verifier_vk_id. Redeploy veilstar-brawl and restart server.",
                };
            }

            const tx = await setVkId({ vk_id: vkIdBytes });
            const { txHash } = await signAndSendTx(tx);
            return { success: true, txHash };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (/"status"\s*:\s*"DUPLICATE"|\bDUPLICATE\b/i.test(message)) {
                return { success: true };
            }
            return { success: false, error: message };
        }
    });
}

function fieldToBytes32(value: string, label: string): Buffer {
    const bigint = BigInt(value);
    if (bigint < 0n) {
        throw new Error(`${label} must be non-negative`);
    }

    const hex = bigint.toString(16);
    if (hex.length > 64) {
        throw new Error(`${label} exceeds 32 bytes`);
    }

    return Buffer.from(hex.padStart(64, "0"), "hex");
}

function g1ToBytes64(point: unknown, label: string): Buffer {
    const arr = point as string[];
    if (!Array.isArray(arr) || arr.length < 2) {
        throw new Error(`${label} must be a G1 point array`);
    }

    return Buffer.concat([
        fieldToBytes32(String(arr[0]), `${label}[0]`),
        fieldToBytes32(String(arr[1]), `${label}[1]`),
    ]);
}

function g2ToBytes128(point: unknown, label: string): Buffer {
    const arr = point as string[][];
    if (!Array.isArray(arr) || arr.length < 2 || !Array.isArray(arr[0]) || !Array.isArray(arr[1])) {
        throw new Error(`${label} must be a G2 point array`);
    }

    // snarkjs JSON uses [[x_c0, x_c1], [y_c0, y_c1], ...]
    // Serialize in Solidity/precompile order: x_c1, x_c0, y_c1, y_c0.
    return Buffer.concat([
        fieldToBytes32(String(arr[0][1]), `${label}[0][1]`),
        fieldToBytes32(String(arr[0][0]), `${label}[0][0]`),
        fieldToBytes32(String(arr[1][1]), `${label}[1][1]`),
        fieldToBytes32(String(arr[1][0]), `${label}[1][0]`),
    ]);
}

export async function setGroth16VerificationKeyOnChain(
    verifierContractAddress: string,
    vkIdHex: string,
    verificationKeyJsonPath: string,
): Promise<OnChainResult> {
    if (!isOnChainRegistrationConfigured()) {
        return { success: false, error: "Stellar contract not configured for admin submissions" };
    }

    const adminKeypair = getAdminKeypair();
    if (!adminKeypair) {
        return { success: false, error: "Admin keypair not available" };
    }

    try {
        const raw = await readFile(verificationKeyJsonPath, "utf8");
        const vk = JSON.parse(raw) as Record<string, unknown>;

        const alphaG1 = g1ToBytes64(vk.vk_alpha_1, "vk_alpha_1");
        const betaG2 = g2ToBytes128(vk.vk_beta_2, "vk_beta_2");
        const gammaG2 = g2ToBytes128(vk.vk_gamma_2, "vk_gamma_2");
        const deltaG2 = g2ToBytes128(vk.vk_delta_2, "vk_delta_2");

        const icRaw = vk.IC as unknown[];
        if (!Array.isArray(icRaw) || icRaw.length === 0) {
            return { success: false, error: "verification key IC must be a non-empty array" };
        }
        const ic = icRaw.map((point, index) => g1ToBytes64(point, `IC[${index}]`));

        const vkIdBytes = normalizeHexToBytes32(vkIdHex, "vkId");

        const client = await createContractClient(
            adminKeypair.publicKey(),
            createSigner(adminKeypair),
            verifierContractAddress,
        );

        const setVerificationKey = (client as any).set_verification_key;
        if (typeof setVerificationKey !== "function") {
            return {
                success: false,
                error: "Deployed verifier contract does not expose set_verification_key",
            };
        }

        const tx = await setVerificationKey({
            vk_id: vkIdBytes,
            alpha_g1: alphaG1,
            beta_g2: betaG2,
            gamma_g2: gammaG2,
            delta_g2: deltaG2,
            ic,
        });
        const { txHash } = await signAndSendTx(tx);
        return { success: true, txHash };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: message };
    }
}

/**
 * Sweep accrued protocol fees from contract to configured treasury.
 * Contract enforces the 24h interval.
 */
export async function sweepTreasuryFeesOnChain(): Promise<SweepFeesResult> {
    if (!isOnChainRegistrationConfigured()) {
        return { success: false, error: "Stellar contract not configured for admin submissions" };
    }

    const adminKeypair = getAdminKeypair();
    if (!adminKeypair) {
        return { success: false, error: "Admin keypair not available" };
    }

    try {
        const client = await createContractClient(adminKeypair.publicKey(), createSigner(adminKeypair));
        const sweepTreasury = (client as any).sweep_treasury;
        if (typeof sweepTreasury !== "function") {
            return {
                success: false,
                error: "Deployed contract does not expose sweep_treasury. Redeploy the updated veilstar-brawl contract and restart server.",
            };
        }
        const tx = await sweepTreasury();
        const { txHash } = await signAndSendTx(tx);

        let sweptAmountStroops: string | undefined;
        try {
            const result = tx?.result;
            if (result !== undefined && result !== null) {
                sweptAmountStroops = typeof result === "bigint" ? result.toString() : String(result);
            }
        } catch {
            // ignore result parsing errors
        }

        return { success: true, txHash, sweptAmountStroops };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: message };
    }
}

/**
 * Expire stake deposit window for a session and perform on-chain cancellation/refund logic.
 */
export async function expireStakeOnChain(matchId: string, options?: { sessionId?: number; contractId?: string }): Promise<OnChainResult> {
    if (!isOnChainRegistrationConfigured()) {
        return { success: false, error: "Stellar contract not configured for admin submissions" };
    }

    const sessionId = options?.sessionId ?? matchIdToSessionId(matchId);
    const contractId = options?.contractId || undefined;
    const adminKeypair = getAdminKeypair();
    if (!adminKeypair) {
        return { success: false, error: "Admin keypair not available", sessionId };
    }

    try {
        const client = await createContractClient(adminKeypair.publicKey(), createSigner(adminKeypair), contractId);
        const expireStake = (client as any).expire_stake;
        if (typeof expireStake !== "function") {
            return {
                success: false,
                error: "Deployed contract does not expose expire_stake. Redeploy the updated veilstar-brawl contract and restart server.",
                sessionId,
            };
        }

        const tx = await expireStake({
            session_id: sessionId,
        });
        const { txHash } = await signAndSendTx(tx);

        return { success: true, txHash, sessionId };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: message, sessionId };
    }
}

/**
 * Cancel an active match on-chain and refund paid stakes (if any).
 */
export async function cancelMatchOnChain(matchId: string): Promise<OnChainResult> {
    return cancelMatchOnChainWithOptions(matchId);
}

export async function cancelMatchOnChainWithOptions(
    matchId: string,
    options?: {
        sessionId?: number;
        contractId?: string;
    },
): Promise<OnChainResult> {
    if (!isOnChainRegistrationConfigured()) {
        return { success: false, error: "Stellar contract not configured for admin submissions" };
    }

    const sessionId = options?.sessionId ?? matchIdToSessionId(matchId);
    const contractId = options?.contractId || undefined;
    const adminKeypair = getAdminKeypair();
    if (!adminKeypair) {
        return { success: false, error: "Admin keypair not available", sessionId };
    }

    try {
        const client = await createContractClient(adminKeypair.publicKey(), createSigner(adminKeypair), contractId);
        const cancelMatch = (client as any).cancel_match;
        if (typeof cancelMatch !== "function") {
            return {
                success: false,
                error: "Deployed contract does not expose cancel_match. Redeploy the updated veilstar-brawl contract and restart server.",
                sessionId,
            };
        }

        const tx = await cancelMatch({
            session_id: sessionId,
        });
        const { txHash } = await signAndSendTx(tx);

        return { success: true, txHash, sessionId };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: message, sessionId };
    }
}
