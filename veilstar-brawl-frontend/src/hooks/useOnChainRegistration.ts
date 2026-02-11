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
import { StellarWalletsKit } from "@creit-tech/stellar-wallets-kit/sdk";
import { NETWORK_PASSPHRASE } from "../utils/constants";
import { authorizeEntry, Address, xdr } from "@stellar/stellar-sdk";
import { calculateValidUntilLedger } from "../utils/ledgerUtils";
import { RPC_URL } from "../utils/constants";
import { Buffer } from "buffer";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "";

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
                    const body = await prepRes.json().catch(() => ({}));
                    throw new Error(body.error || `Prepare failed (${prepRes.status})`);
                }

                const { authEntries } = (await prepRes.json()) as {
                    sessionId: number;
                    authEntries: Record<string, string>;
                };

                // Find our auth entry
                const myAuthEntryXdr = authEntries[publicKey];
                if (!myAuthEntryXdr) {
                    throw new Error("Server did not return an auth entry for this wallet");
                }

                // Step 2: Sign the auth entry via Freighter
                setStatus("signing");

                const validUntilLedger = await calculateValidUntilLedger(RPC_URL, 5);

                // Parse the unsigned auth entry
                const unsignedEntry = xdr.SorobanAuthorizationEntry.fromXDR(
                    myAuthEntryXdr,
                    "base64",
                );

                // Use authorizeEntry to properly sign it
                const signedEntry = await authorizeEntry(
                    unsignedEntry,
                    async (preimage) => {
                        const result = await StellarWalletsKit.signAuthEntry(
                            preimage.toXDR("base64"),
                            {
                                networkPassphrase: NETWORK_PASSPHRASE,
                                address: publicKey,
                            },
                        );

                        if (!result.signedAuthEntry) {
                            throw new Error("Wallet returned empty signature");
                        }

                        return Buffer.from(result.signedAuthEntry, "base64");
                    },
                    validUntilLedger,
                    NETWORK_PASSPHRASE,
                );

                const signedAuthEntryXdr = signedEntry.toXDR("base64");

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
                        }),
                    },
                );

                if (!authRes.ok) {
                    const body = await authRes.json().catch(() => ({}));
                    throw new Error(body.error || `Auth submission failed (${authRes.status})`);
                }

                const authResult = await authRes.json();

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
