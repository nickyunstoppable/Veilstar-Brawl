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

// =============================================================================
// CONFIG
// =============================================================================

const RPC_URL = process.env.VITE_SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = process.env.VITE_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015";
const CONTRACT_ID = process.env.VITE_VEILSTAR_BRAWL_CONTRACT_ID || "";
const ADMIN_SECRET = process.env.VITE_DEV_PLAYER1_SECRET || ""; // Admin = Player 1 dev wallet
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

/**
 * The contract spec for the new fighting-game contract.
 * Generated from the deployed WASM via `stellar contract inspect`.
 */
const CONTRACT_SPEC_XDR = [
    "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAABgAAAAAAAAANTWF0Y2hOb3RGb3VuZAAAAAAAAAEAAAAAAAAACU5vdFBsYXllcgAAAAAAAAIAAAAAAAAAEU1hdGNoQWxyZWFkeUVuZGVkAAAAAAAAAwAAAAAAAAASTVhdGNoTm90SW5Qcm9ncmVzcwAAAAAABAAAAAAAAAAUSW5zdWZmaWNpZW50QmFsYW5jZQAAAAUAAAAAAAAADk5vdGhpbmdUb1N3ZWVwAAAAAAAG=",
    "AAAAAQAAAAAAAAAAAAAABU1hdGNoAAAAAAAACAAAAAAAAAAHcGxheWVyMQAAAAATAAAAAAAAAA1wbGF5ZXIxX21vdmVzAAAAAAAABAAAAAAAAAAOcGxheWVyMV9wb2ludHMAAAAAAAsAAAAAAAAAB3BsYXllcjIAAAAAEwAAAAAAAAANcGxheWVyMl9tb3ZlcwAAAAAAAAQAAAAAAAAADnBsYXllcjJfcG9pbnRzAAAAAAALAAAAAAAAABN0b3RhbF94bG1fY29sbGVjdGVkAAAAAAsAAAAAAAAABndpbm5lcgAAAAAD6AAAABM=",
    "AAAAAgAAAAAAAAAAAAAAB0RhdGFLZXkAAAAABQAAAAEAAAAAAAAABU1hdGNoAAAAAAAAAQAAAAQAAAAAAAAAAAAAAA5HYW1lSHViQWRkcmVzcwAAAAAAAAAAAAAAAAAFQWRtaW4AAAAAAAAAAAAAAAAAAA9UcmVhc3VyeUFkZHJlc3MAAAAAAAAAAAAAAAAIWGxtVG9rZW4=",
    "AAAAAwAAAAAAAAAAAAAACE1vdmVUeXBlAAAABAAAAAAAAAAFUHVuY2gAAAAAAAAAAAAAAAAAAABLaWNrAAAAAQAAAAAAAAAFQmxvY2sAAAAAAAACAAAAAAAAAAdTcGVjaWFsAAAAAAM=",
    "AAAAAAAAAAAAAAAHZ2V0X2h1YgAAAAAAAAAAAQAAABM=",
    "AAAAAAAAAAAAAAAHc2V0X2h1YgAAAAABAAAAAAAAAAduZXdfaHViAAAAABMAAAAA",
    "AAAAAAAAAHFVcGRhdGUgdGhlIGNvbnRyYWN0IFdBU00gaGFzaCAodXBncmFkZSBjb250cmFjdCkKCiMgQXJndW1lbnRzCiogYG5ld193YXNtX2hhc2hgIC0gVGhlIGhhc2ggb2YgdGhlIG5ldyBXQVNNIGJpbmFyeQAAAAAAAAd1cGdyYWRlAAAAAAEAAAAAAAAADW5ld193YXNtX2hhc2gAAAAAAAPuAAAAIAAAAAA=",
    "AAAAAAAAAEtFbmQgYSBtYXRjaCBhbmQgcmVwb3J0IHRvIEdhbWUgSHViLgpPbmx5IGFkbWluIGNhbiBmaW5hbGlzZSBhIG1hdGNoIHJlc3VsdC4AAAAACWVuZF9tYXRjaAAAAAAAAAIAAAAAAAAACnNlc3Npb25faWQAAAAAAAQAAAAAAAAAC3BsYXllcjFfd29uAAAAAAEAAAABAAAD6QAAAAIAAAAD",
    "AAAAAAAAAAAAAAAJZ2V0X2FkbWluAAAAAAAAAAAAAAEAAAAT",
    "AAAAAAAAABBHZXQgbWF0Y2ggc3RhdGUuAAAACWdldF9tYXRjaAAAAAAAAAEAAAAAAAAACnNlc3Npb25faWQAAAAAAAQAAAABAAAD6QAAB9AAAAAFTWF0Y2gAAAAAAAAD",
    "AAAAAAAAAAAAAAAJc2V0X2FkbWluAAAAAAAAAQAAAAAAAAAJbmV3X2FkbWluAAAAAAAAEwAAAAA=",
    "AAAAAAAAADJTdGFydCBhIG5ldyBtYXRjaCDigJMgY2FsbHMgR2FtZSBIdWIgYHN0YXJ0X2dhbWVgLgAAAAAAC3N0YXJ0X21hdGNoAAAAAAUAAAAAAAAACnNlc3Npb25faWQAAAAAAAQAAAAAAAAAB3BsYXllcjEAAAAAEwAAAAAAAAAHcGxheWVyMgAAAAATAAAAAAAAAA5wbGF5ZXIxX3BvaW50cwAAAAAACwAAAAAAAAAOcGxheWVyMl9wb2ludHMAAAAAAAsAAAABAAAD6QAAAAIAAAAD",
    "AAAAAAAAAEVSZWNvcmQgYSBjb21iYXQgbW92ZSBvbi1jaGFpbiBhbmQgY29sbGVjdCAwLjAwMDEgWExNIGZyb20gdGhlIHBsYXllci4AAAAAAAALc3VibWl0X21vdmUAAAAABAAAAAAAAAAKc2Vzc2lvbl9pZAAAAAAABAAAAAAAAAAGcGxheWVyAAAAAAATAAAAAAAAAAltb3ZlX3R5cGUAAAAAAAfQAAAACE1vdmVUeXBlAAAAAAAAAAR0dXJuAAAABAAAAAEAAAPpAAAAAgAAAAM=",
    "AAAAAAAAAAAAAAAMZ2V0X3RyZWFzdXJ5AAAAAAAAAAEAAAAT",
    "AAAAAAAAAAAAAAAMc2V0X3RyZWFzdXJ5AAAAAQAAAAAAAAAMbmV3X3RyZWFzdXJ5AAAAEwAAAAA=",
    "AAAAAAAAAPJJbml0aWFsaXNlIHRoZSBjb250cmFjdC4KCiMgQXJndW1lbnRzCiogYGFkbWluYCAgICDikIwgYWRtaW4gd2FsbGV0IChjYW4gc3dlZXAsIHVwZ3JhZGUsIGV0Yy4pCiogYGdhbWVfaHViYCAg4pCMIEdhbWUgSHViIGNvbnRyYWN0IGFkZHJlc3MKKiBgdHJlYXN1cnlgICDikIwgd2FsbGV0IHRoYXQgcmVjZWl2ZXMgc3dlcHQgWExNCiogYHhsbV90b2tlbmAg4pCMIFNBQyBjb250cmFjdCBhZGRyZXNzIGZvciBuYXRpdmUgWExNAAAAAAANX19jb25zdHJ1Y3RvcgAAAAAAAAQAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAAIZ2FtZV9odWIAAAATAAAAAAAAAAh0cmVhc3VyeQAAABMAAAAAAAAACXhsbV90b2tlbgAAAAAAABMAAAAA",
    "AAAAAAAAAEpUcmFuc2ZlciBhY2N1bXVsYXRlZCBYTE0gdG8gdGhlIHRyZWFzdXJ5IHdhbGxldCwga2VlcGluZyBhIDEwIFhMTSByZXNlcnZlLgAAAAAADnN3ZWVwX3RyZWFzdXJ5AAAAAAAAAAAAAQAAA+kAAAALAAAAAw==",
];

let CONTRACT_SPEC: contract.Spec | null = null;

function getContractSpec(): contract.Spec {
    if (!CONTRACT_SPEC) {
        CONTRACT_SPEC = new contract.Spec(CONTRACT_SPEC_XDR);
    }
    return CONTRACT_SPEC;
}

function createContractClient(publicKey: string, signer: Pick<contract.ClientOptions, "signTransaction" | "signAuthEntry">): contract.Client {
    return new contract.Client(getContractSpec(), {
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

/**
 * Sign + send an assembled transaction, handling the "NoSignatureNeeded" edge case.
 */
async function signAndSendTx(tx: any): Promise<{ sentTx: any; txHash?: string }> {
    let sentTx: any;
    try {
        sentTx = await tx.signAndSend();
    } catch (err: any) {
        if (err?.message?.includes("NoSignatureNeeded") || err?.message?.includes("read call")) {
            sentTx = await tx.signAndSend({ force: true });
        } else {
            throw err;
        }
    }
    const txResponse = sentTx.getTransactionResponse;
    const txHash = txResponse && "hash" in txResponse ? (txResponse as any).hash : undefined;
    return { sentTx, txHash };
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

        const buildClient = createContractClient(p2Keypair.publicKey(), createSigner(p2Keypair));

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

    // Build a contract client with no signer — we only need to simulate
    const spec = getContractSpec();
    const readOnlyClient = new contract.Client(spec, {
        contractId: CONTRACT_ID,
        networkPassphrase: NETWORK_PASSPHRASE,
        rpcUrl: RPC_URL,
        publicKey: player1Address, // tx source; either player works
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

    for (const entry of authEntries) {
        try {
            if (entry.credentials().switch().name !== "sorobanCredentialsAddress") continue;
            const addr = Address.fromScAddress(entry.credentials().address().address()).toString();
            if (addr === player1Address || addr === player2Address) {
                perPlayer[addr] = entry.toXDR("base64");
            }
        } catch {
            // skip non-address entries
        }
    }

    if (!perPlayer[player1Address] || !perPlayer[player2Address]) {
        throw new Error("Could not extract auth entries for both players from simulation");
    }

    const transactionXdr = tx.toXDR();

    console.log(`[Stellar] Prepared registration for session ${sessionId} — awaiting player signatures`);

    return { sessionId, authEntries: perPlayer, transactionXdr };
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

        const spec = getContractSpec();
        const client = new contract.Client(spec, {
            contractId: CONTRACT_ID,
            networkPassphrase: NETWORK_PASSPHRASE,
            rpcUrl: RPC_URL,
            publicKey: player1Address,
            ...createSigner(adminKeypair),
        });

        // Import the original transaction
        const tx = client.txFromXDR(transactionXdr);

        // Replace stubbed auth entries with signed ones
        const simAuth = tx.simulationData?.result?.auth;
        if (simAuth) {
            for (let i = 0; i < simAuth.length; i++) {
                const entry = simAuth[i];
                try {
                    if (entry.credentials().switch().name !== "sorobanCredentialsAddress") continue;
                    const addr = Address.fromScAddress(entry.credentials().address().address()).toString();
                    const signed = signedAuthEntries[addr];
                    if (signed) {
                        simAuth[i] = xdrLib.SorobanAuthorizationEntry.fromXDR(signed, "base64");
                    }
                } catch {
                    // skip
                }
            }
        }

        // Re-simulate, then sign envelope + submit
        await tx.simulate();
        const { txHash } = await signAndSendTx(tx);

        console.log(`[Stellar] Client-signed registration submitted. Session: ${sessionId}, TX: ${txHash || "n/a"}`);
        return { success: true, txHash, sessionId };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
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
        const client = createContractClient(keypair.publicKey(), createSigner(keypair));
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

        const client = createContractClient(adminKeypair.publicKey(), createSigner(adminKeypair));
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
        const client = new contract.Client(getContractSpec(), {
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
