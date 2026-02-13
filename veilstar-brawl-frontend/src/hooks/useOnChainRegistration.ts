/**
 * useOnChainRegistration — handles the client-side signing flow for on-chain match registration.
 *
 * After both characters are locked the server broadcasts `match_starting` with
 * `requiresOnChainRegistration: true`.  This hook:
 *   1. Calls POST /api/matches/:matchId/register/prepare  → gets the unsigned auth entry XDR
 *   2. Signs the auth entry via Freighter (StellarWalletsKit.signAuthEntry)
 *   3. Calls POST /api/matches/:matchId/register/auth     → sends the signed entry back
 *   4. Once both players sign, the server assembles and submits the tx
 *
 * Exposes a simple `registerOnChain(matchId)` async function + status state.
 */

import { useCallback, useState, useRef } from "react";
import { useWalletStore } from "../store/walletSlice";
import { signAuthEntry as freighterSignAuthEntry } from "@stellar/freighter-api";
import { NETWORK_PASSPHRASE } from "../utils/constants";
import { authorizeEntry, Address, xdr, hash, rpc } from "@stellar/stellar-sdk";
import { RPC_URL } from "../utils/constants";
import { Buffer } from "buffer";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "";

function registrationCacheKey(matchId: string): string {
    return `vbb:onchain_registration:${matchId}`;
}

async function parseJsonSafe<T>(response: Response): Promise<T | null> {
    const raw = await response.text();
    if (!raw) return null;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}

export type RegistrationStatus =
    | "idle"
    | "preparing"
    | "signing"
    | "waiting_for_opponent"
    | "submitting"
    | "complete"
    | "error"
    | "skipped";

export function useOnChainRegistration() {
    const [status, setStatus] = useState<RegistrationStatus>("idle");
    const [error, setError] = useState<string | null>(null);
    const [txHash, setTxHash] = useState<string | null>(null);
    const { publicKey } = useWalletStore();

    // Prevent double-invocation
    const busyRef = useRef(false);

    const registerOnChain = useCallback(
        async (matchId: string): Promise<boolean> => {
            if (!publicKey) {
                setStatus("error");
                setError("Wallet not connected");
                return false;
            }

            if (busyRef.current) return false;
            busyRef.current = true;

            try {
                // Step 1: Ask the server to prepare the transaction
                setStatus("preparing");
                setError(null);

                const prepRes = await fetch(
                    `${API_BASE}/api/matches/${matchId}/register/prepare`,
                    { method: "POST" },
                );

                if (!prepRes.ok) {
                    const body = await parseJsonSafe<{ error?: string }>(prepRes);
                    throw new Error(body?.error || `Prepare failed (${prepRes.status})`);
                }

                const preparedJson = await parseJsonSafe<{
                    sessionId: number;
                    authEntries: Record<string, string>;
                    requiredAuthAddresses?: string[];
                    transactionXdr?: string;
                    submitted?: boolean;
                    txHash?: string;
                }>(prepRes);

                if (!preparedJson) {
                    throw new Error("Registration prepare returned empty/non-JSON response");
                }

                const {
                    authEntries,
                    requiredAuthAddresses,
                    submitted,
                    txHash: preparedTxHash,
                    transactionXdr,
                    skipped: serverSkipped,
                } = preparedJson as {
                    sessionId: number;
                    authEntries: Record<string, string>;
                    requiredAuthAddresses?: string[];
                    transactionXdr?: string;
                    submitted?: boolean;
                    txHash?: string;
                    skipped?: boolean;
                };

                // If the server says registration was skipped (match cancelled/abandoned),
                // treat as complete so the frontend proceeds gracefully.
                if (serverSkipped) {
                    console.warn("[useOnChainRegistration] Server skipped registration (match may have been cancelled)");
                    setStatus("complete");
                    return true;
                }

                if (transactionXdr) {
                    try {
                        localStorage.setItem(
                            registrationCacheKey(matchId),
                            JSON.stringify({
                                transactionXdr,
                                requiredAuthAddresses: requiredAuthAddresses ?? null,
                            }),
                        );
                    } catch {
                        // ignore
                    }
                }

                if (submitted) {
                    setStatus("complete");
                    if (preparedTxHash) setTxHash(preparedTxHash);
                    return true;
                }

                if (requiredAuthAddresses && !requiredAuthAddresses.includes(publicKey)) {
                    setStatus("skipped");
                    return true;
                }

                // Find our auth entry
                const myAuthEntryXdr = authEntries[publicKey];
                if (!myAuthEntryXdr) {
                    throw new Error("Server did not return an auth entry for this wallet");
                }

                // Step 2: Sign the auth entry via Freighter
                setStatus("signing");

                // Calculate a valid expiration ledger (~5 min from now)
                const server = new rpc.Server(RPC_URL);
                const latestLedger = await server.getLatestLedger();
                const validUntilLedger = latestLedger.sequence + 60; // ~5 min

                // Parse the unsigned auth entry (as prepared by the server simulation)
                const unsignedEntry = xdr.SorobanAuthorizationEntry.fromXDR(
                    myAuthEntryXdr,
                    "base64",
                );

                // Use authorizeEntry which handles the correct signature format:
                // scvVec([scvMap({public_key: bytes(32), signature: bytes(64)})])
                const signedEntry = await authorizeEntry(
                    unsignedEntry,
                    async (preimage) => {
                        const preimageXdr = preimage.toXDR("base64");
                        console.log("[Registration] Calling Freighter signAuthEntry for", publicKey.slice(0, 8));

                        const result = await freighterSignAuthEntry(preimageXdr, {
                            address: publicKey,
                        });

                        console.log("[Registration] Freighter signAuthEntry result:", JSON.stringify(result));

                        const signedAuth = result?.signedAuthEntry ?? (result as any)?.result;
                        if (!signedAuth) {
                            throw new Error(
                                `Wallet returned empty signature. Full response: ${JSON.stringify(result)}`
                            );
                        }

                        // Return raw signature bytes — authorizeEntry wraps them correctly
                        return Buffer.from(signedAuth, "base64");
                    },
                    validUntilLedger,
                    NETWORK_PASSPHRASE,
                );

                const signedAuthEntryXdr = signedEntry.toXDR("base64");

                // Persist signed entry so the user can refresh and still re-submit if needed.
                try {
                    const existing = localStorage.getItem(registrationCacheKey(matchId));
                    const parsed = existing ? JSON.parse(existing) : {};
                    localStorage.setItem(
                        registrationCacheKey(matchId),
                        JSON.stringify({
                            ...parsed,
                            signedAuthEntryXdr,
                            address: publicKey,
                        }),
                    );
                } catch {
                    // ignore
                }

                // Step 3: Send the signed auth entry to the server
                setStatus("waiting_for_opponent");

                const authRes = await fetch(
                    `${API_BASE}/api/matches/${matchId}/register/auth`,
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            address: publicKey,
                            signedAuthEntryXdr,
                            transactionXdr,
                            requiredAuthAddresses,
                        }),
                    },
                );

                if (!authRes.ok) {
                    const body = await parseJsonSafe<{ error?: string }>(authRes);
                    throw new Error(body?.error || `Auth submission failed (${authRes.status})`);
                }

                const authResult = await parseJsonSafe<{ bothSigned?: boolean; txHash?: string }>(authRes);
                if (!authResult) {
                    throw new Error("Registration auth returned empty/non-JSON response");
                }

                if (authResult.bothSigned) {
                    // Server assembled and submitted the tx
                    setStatus("complete");
                    setTxHash(authResult.txHash || null);
                } else {
                    // Waiting for the other player — the `registration_complete`
                    // broadcast will tell us when it's done (handled by CharacterSelectClient)
                    setStatus("waiting_for_opponent");
                }

                return true;
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                console.error("[useOnChainRegistration] Error:", message);
                setStatus("error");
                setError(message);
                return false;
            } finally {
                busyRef.current = false;
            }
        },
        [publicKey],
    );

    const markComplete = useCallback((hash?: string) => {
        setStatus("complete");
        if (hash) setTxHash(hash);
    }, []);

    const markSkipped = useCallback(() => {
        setStatus("skipped");
    }, []);

    return {
        status,
        error,
        txHash,
        registerOnChain,
        markComplete,
        markSkipped,
    };
}
