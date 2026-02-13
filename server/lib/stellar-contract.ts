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
    TransactionBuilder,
    hash,
    rpc,
    contract,
    Address,
    authorizeEntry,
    xdr as xdrLib,
} from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
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

let CONTRACT_SPEC: contract.Spec | null = null;
let CONTRACT_SPEC_LOADING: Promise<contract.Spec> | null = null;

async function getContractSpec(): Promise<contract.Spec> {
    if (CONTRACT_SPEC) return CONTRACT_SPEC;
    if (CONTRACT_SPEC_LOADING) return CONTRACT_SPEC_LOADING;

    CONTRACT_SPEC_LOADING = (async () => {
        try {
            if (!CONTRACT_ID) {
                throw new Error("Stellar contract not configured (missing CONTRACT_ID)");
            }

            const server = new rpc.Server(RPC_URL);
            const wasm = await server.getContractWasmByContractId(CONTRACT_ID);
            const spec = contract.Spec.fromWasm(wasm);
            CONTRACT_SPEC = spec;
            return spec;
        } catch (err) {
            CONTRACT_SPEC_LOADING = null;
            throw err;
        }
    })();

    return CONTRACT_SPEC_LOADING;
}

async function createContractClient(
    publicKey: string,
    signer: Pick<contract.ClientOptions, "signTransaction" | "signAuthEntry">
): Promise<contract.Client> {
    const spec = await getContractSpec();
    return new contract.Client(spec, {
        contractId: CONTRACT_ID,
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

function isTransientSubmissionError(err: any): boolean {
    const message = String(err?.message || "");
    const responseText = String(err?.response?.data || "");
    const combined = `${message}\n${responseText}`;

    return (
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
                sentTx = await tx.signAndSend();
            } catch (err: any) {
                if (err?.message?.includes("NoSignatureNeeded") || err?.message?.includes("read call")) {
                    sentTx = await tx.signAndSend({ force: true });
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
    return !!(CONTRACT_ID && ADMIN_SECRET);
}

/**
 * Check if the server can run client-signed action submissions (move / power-surge).
 * Requires a configured contract and funded admin fee payer.
 */
export function isClientSignedActionConfigured(): boolean {
    return !!(CONTRACT_ID && ADMIN_SECRET);
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

async function createAdminContractClient(): Promise<contract.Client> {
    const adminKeypair = getAdminKeypair();
    if (!adminKeypair) {
        throw new Error("Admin keypair not available");
    }

    return createContractClient(adminKeypair.publicKey(), createSigner(adminKeypair));
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
): Promise<PreparedRegistration> {
    if (!CONTRACT_ID) {
        throw new Error("Stellar contract not configured (missing CONTRACT_ID)");
    }

    const sessionId = matchIdToSessionId(matchId);

    // Use admin as fee-payer/tx source for this server-submitted flow.
    // If we used a player as tx source, we would also need the player's envelope signature.
    const adminKeypair = getAdminKeypair();
    if (!adminKeypair) {
        throw new Error("On-chain registration requires ADMIN_SECRET (fee payer) to be configured");
    }

    // Build a contract client with no signer — we only need to simulate
    const spec = await getContractSpec();
    const readOnlyClient = new contract.Client(spec, {
        contractId: CONTRACT_ID,
        networkPassphrase: NETWORK_PASSPHRASE,
        rpcUrl: RPC_URL,
        publicKey: adminKeypair.publicKey(),
    });

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
): Promise<OnChainResult> {
    if (!CONTRACT_ID) {
        return { success: false, error: "Stellar contract not configured" };
    }

    const sessionId = matchIdToSessionId(matchId);

    try {
        console.log(`[Stellar] Submitting client-signed registration (sessionId: ${sessionId})`);

        // Use the admin keypair (or any funded account) to sign the transaction envelope
        const adminKeypair = getAdminKeypair();
        if (!adminKeypair) {
            return { success: false, error: "Admin keypair not available for tx submission", sessionId };
        }

        const spec = await getContractSpec();
        const client = new contract.Client(spec, {
            contractId: CONTRACT_ID,
            networkPassphrase: NETWORK_PASSPHRASE,
            rpcUrl: RPC_URL,
            publicKey: adminKeypair.publicKey(),
            ...createSigner(adminKeypair),
        });

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

    const adminClient = await createAdminContractClient();
    const tx = await (adminClient as any).submit_move({
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
        const adminClient = await createAdminContractClient();
        const { updatedXdr, replacedCount } = injectSignedAuthIntoTxEnvelope(transactionXdr, {
            [addressKey(playerAddress)]: signedAuthEntryXdr,
        });

        if (replacedCount === 0) {
            return { success: false, error: "Signed auth entry did not match transaction auth entries", sessionId };
        }

        const tx = adminClient.txFromXDR(updatedXdr);
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

    const adminClient = await createAdminContractClient();
    const tx = await (adminClient as any).submit_power_surge({
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
        const adminClient = await createAdminContractClient();
        const { updatedXdr, replacedCount } = injectSignedAuthIntoTxEnvelope(transactionXdr, {
            [addressKey(playerAddress)]: signedAuthEntryXdr,
        });

        if (replacedCount === 0) {
            return { success: false, error: "Signed auth entry did not match transaction auth entries", sessionId };
        }

        const tx = adminClient.txFromXDR(updatedXdr);
        await tx.simulate();
        const { txHash } = await signAndSendTx(tx);

        return { success: true, txHash, sessionId };
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
): Promise<OnChainResult> {
    if (!isStellarConfigured()) {
        return { success: false, error: "Stellar contract not configured" };
    }

    const sessionId = matchIdToSessionId(matchId);
    const player1Won = winnerAddress === player1Address;

    const adminKeypair = getAdminKeypair();
    if (!adminKeypair) {
        return { success: false, error: "Admin keypair not available", sessionId };
    }

    try {
        console.log(`[Stellar] Reporting match result on-chain (sessionId: ${sessionId})`);

        const client = await createContractClient(adminKeypair.publicKey(), createSigner(adminKeypair));
        const tx = await (client as any).end_game({
            session_id: sessionId,
            player1_won: player1Won,
        });
        const { txHash } = await signAndSendTx(tx);

        console.log(`[Stellar] Match result reported. Session: ${sessionId}, TX: ${txHash || "n/a"}`);
        return { success: true, txHash, sessionId };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[Stellar] Failed to report match result on-chain:`, message);
        return { success: false, error: message, sessionId };
    }
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
        const spec = await getContractSpec();
        const client = new contract.Client(spec, {
            contractId: CONTRACT_ID,
            networkPassphrase: NETWORK_PASSPHRASE,
            rpcUrl: RPC_URL,
        });

        const tx = await (client as any).get_match({ session_id: sessionId });
        return tx.result;
    } catch {
        return null;
    }
}
