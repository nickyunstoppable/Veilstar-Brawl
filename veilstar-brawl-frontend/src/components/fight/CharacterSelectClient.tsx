/**
 * CharacterSelectClient — React wrapper that embeds the Phaser CharacterSelectScene
 * Handles match data fetching and EventBus bridging for character selection.
 * After both players confirm, the Phaser scene auto-transitions to FightScene.
 */

import React, { useEffect, useRef, useState, useCallback } from "react";
import { PhaserGame } from "@/game/PhaserGame";
import { EventBus } from "@/game/EventBus";
import { useWallet } from "@/hooks/useWallet";
import { useOnChainRegistration } from "@/hooks/useOnChainRegistration";
import { commitPrivateRoundPlan, provePrivateRoundPlan, resolvePrivateRound } from "@/lib/zkPrivateRoundClient";

import { getSupabaseClient } from "@/lib/supabase/client";
import type { RealtimeChannel } from "@supabase/supabase-js";
import type { CharacterSelectSceneConfig } from "@/game/scenes/CharacterSelectScene";

interface CharacterSelectClientProps {
    matchId: string;
    onMatchEnd?: (result: {
        isWinner: boolean;
        ratingChanges?: unknown;
        onChainSessionId?: number;
        onChainTxHash?: string;
        contractId?: string;
    }) => void;
    onExit?: () => void;
}

const API_BASE = import.meta.env.VITE_API_BASE_URL || "";
const USE_OFFCHAIN_ACTIONS = (import.meta.env.VITE_ZK_OFFCHAIN_ACTIONS ?? "true") !== "false";
const PRIVATE_ROUNDS_ENABLED = (import.meta.env.VITE_ZK_PRIVATE_ROUNDS ?? "false") === "true";
const STROOPS_PER_XLM = 10_000_000;

interface StakeGateState {
    required: boolean;
    stakeAmountStroops: string;
    feeBps: number;
    myConfirmed: boolean;
    opponentConfirmed: boolean;
    bothConfirmed: boolean;
    pendingRegistration: boolean;
    stakeDeadlineAtMs?: number;
    isSubmitting: boolean;
    error: string | null;
}

interface PrivateRoundPlanState {
    moveType?: string;
    surgeCardId?: string;
    sharedRoundProof?: string;
    commitment?: string;
    proofPublicInputs?: string;
    nonce?: string;
    fatalError?: string;
    commitSubmitted?: boolean;
    revealSubmitted?: boolean;
    inFlight?: boolean;
    walletSignedMessage?: string;
    walletSignature?: string;
    moveSigned?: boolean;
    surgeSigned?: boolean;
}

function parseStroops(raw: unknown): bigint {
    try {
        if (!raw) return 0n;
        return BigInt(String(raw));
    } catch {
        return 0n;
    }
}

function calcStakeFee(stakeAmountStroops: bigint, feeBps: number): bigint {
    return ((stakeAmountStroops * BigInt(feeBps)) + 9999n) / 10000n;
}

function toXlmDisplay(stroops: bigint): string {
    const xlm = Number(stroops) / STROOPS_PER_XLM;
    if (!Number.isFinite(xlm)) return "0";
    return xlm.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

function getStakeFailureMessage(rawError: unknown): string {
    const raw = String(rawError || "");

    if (/txBadSeq|TRY_AGAIN_LATER|temporar|timeout|network failed|Sending the transaction to the network failed/i.test(raw)) {
        return "Your transaction was not confirmed yet due to a network sequencing race. It is safe to retry: duplicate stake deposits are rejected on-chain, so you cannot be charged twice for the same player stake.";
    }

    if (/StakeAlreadyPaid|Contract,\s*#9/i.test(raw)) {
        return "Your stake is already recorded on-chain. Waiting for the status to sync.";
    }

    if (/StakeNotConfigured|Contract,\s*#8/i.test(raw)) {
        return "Stake setup is still syncing on-chain. Please retry in a moment.";
    }

    if (/MatchNotFound|Contract,\s*#1|registration not complete/i.test(raw)) {
        return "Match registration is still finalizing on-chain. Please wait a few seconds and retry.";
    }

    return raw || "Stake transaction failed. It is safe to retry; duplicate deposits are blocked on-chain.";
}

async function waitForSubscribed(channel: RealtimeChannel, timeoutMs: number = 2500): Promise<boolean> {
    return new Promise((resolve) => {
        let settled = false;
        const timeout = setTimeout(() => {
            if (!settled) {
                settled = true;
                resolve(false);
            }
        }, timeoutMs);

        channel.subscribe((status) => {
            if (settled) return;
            if (status === "SUBSCRIBED") {
                settled = true;
                clearTimeout(timeout);
                resolve(true);
            }
            if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
                settled = true;
                clearTimeout(timeout);
                resolve(false);
            }
        });
    });
}

/** Broadcast a game event via Supabase Realtime (fallback when channel is not ready) */
async function broadcastGameEvent(matchId: string, event: string, payload: Record<string, unknown>) {
    let channel: RealtimeChannel | null = null;
    try {
        const supabase = getSupabaseClient();
        channel = supabase.channel(`game:${matchId}`, { config: { broadcast: { self: true } } });
        const subscribed = await waitForSubscribed(channel);
        if (!subscribed) {
            throw new Error(`Channel subscribe timeout for game:${matchId}`);
        }
        await channel.send({ type: "broadcast", event, payload });
    } catch (err) {
        console.warn("[CharacterSelectClient] Failed to broadcast:", err);
    } finally {
        if (channel) {
            await getSupabaseClient().removeChannel(channel);
        }
    }
}

function navigateTo(path: string) {
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
}

function localStakeConfirmedStorageKey(matchId: string, address: string): string {
    return `vbb:stake_confirmed:${matchId}:${address}`;
}

export function CharacterSelectClient({ matchId, onMatchEnd, onExit }: CharacterSelectClientProps) {
    const { publicKey, walletType, networkPassphrase } = useWallet();
    const {
        status: registrationStatus,
        error: registrationError,
        registerOnChain,
    } = useOnChainRegistration();
    const [sceneConfig, setSceneConfig] = useState<CharacterSelectSceneConfig | null>(null);
    const [stakeGate, setStakeGate] = useState<StakeGateState | null>(null);
    const [stakeClockNowMs, setStakeClockNowMs] = useState<number>(Date.now());
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const channelRef = useRef<RealtimeChannel | null>(null);

    // Scene-ready handshake
    const sceneReadyRef = useRef(false);
    const startedTimerRef = useRef(false);
    const readyRolesRef = useRef<Set<string>>(new Set());
    const syncedOpponentCharacterRef = useRef<string | null>(null);
    const syncedOpponentBanRef = useRef<string | null>(null);
    const moveSubmittedRef = useRef(false);
    const currentRoundRef = useRef(1);
    const currentTurnRef = useRef(1);
    const privateRoundPlansRef = useRef<Record<number, PrivateRoundPlanState>>({});



    const onMatchEndRef = useRef(onMatchEnd);
    const onExitRef = useRef(onExit);
    const registrationTriggeredRef = useRef(false);
    const registrationCompleteRef = useRef(false);
    const localStakeConfirmedRef = useRef(false);
    const stakeExpireTriggeredRef = useRef(false);
    const stakeErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const stakeSubmitInFlightRef = useRef(false);
    const [stakeSubmitLocked, setStakeSubmitLocked] = useState(false);
    useEffect(() => {
        onMatchEndRef.current = onMatchEnd;
        onExitRef.current = onExit;
    }, [onMatchEnd, onExit]);

    useEffect(() => {
        registrationTriggeredRef.current = false;
        registrationCompleteRef.current = false;
        localStakeConfirmedRef.current = false;
        stakeExpireTriggeredRef.current = false;
        stakeSubmitInFlightRef.current = false;
        setStakeSubmitLocked(false);

        if (stakeErrorTimerRef.current) {
            clearTimeout(stakeErrorTimerRef.current);
            stakeErrorTimerRef.current = null;
        }
    }, [matchId]);

    useEffect(() => {
        if (!stakeGate?.required || stakeGate.bothConfirmed) return;

        const timer = setInterval(() => {
            setStakeClockNowMs(Date.now());
        }, 1000);

        return () => clearInterval(timer);
    }, [stakeGate?.bothConfirmed, stakeGate?.required]);

    useEffect(() => {
        if (!publicKey || !matchId) return;
        try {
            const raw = sessionStorage.getItem(localStakeConfirmedStorageKey(matchId, publicKey));
            if (raw === "1") {
                localStakeConfirmedRef.current = true;
                setStakeGate((prev) => prev ? { ...prev, myConfirmed: true } : prev);
            }
        } catch {
            // ignore sessionStorage access issues
        }
    }, [matchId, publicKey]);

    useEffect(() => {
        const stakeError = stakeGate?.error;
        if (!stakeError) return;

        if (stakeErrorTimerRef.current) {
            clearTimeout(stakeErrorTimerRef.current);
        }

        stakeErrorTimerRef.current = setTimeout(() => {
            setStakeGate((prev) => prev ? { ...prev, error: null } : prev);
            stakeErrorTimerRef.current = null;
        }, 10000);

        return () => {
            if (stakeErrorTimerRef.current) {
                clearTimeout(stakeErrorTimerRef.current);
                stakeErrorTimerRef.current = null;
            }
        };
    }, [stakeGate?.error]);

    useEffect(() => {
        if (!publicKey || !stakeGate?.required || !stakeGate.pendingRegistration) return;
        if (registrationTriggeredRef.current) return;

        registrationTriggeredRef.current = true;
        registerOnChain(matchId).catch((err) => {
            console.error("[CharacterSelectClient] Registration signing failed:", err);
            registrationTriggeredRef.current = false;
        });
    }, [matchId, publicKey, registerOnChain, stakeGate?.pendingRegistration, stakeGate?.required]);

    useEffect(() => {
        if (registrationStatus === "complete" || registrationStatus === "skipped") {
            registrationCompleteRef.current = true;
            setStakeGate((prev) => prev
                ? {
                    ...prev,
                    pendingRegistration: false,
                    error: null,
                }
                : prev,
            );
        }

        if (registrationStatus === "error") {
            setStakeGate((prev) => prev
                ? {
                    ...prev,
                    pendingRegistration: true,
                    error: registrationError || "On-chain registration failed",
                }
                : prev,
            );
            registrationTriggeredRef.current = false;
        }
    }, [registrationError, registrationStatus]);

    const signStakeAuthEntry = useCallback(async (authEntryXdr: string, address: string): Promise<string> => {
        if (walletType !== "wallet") {
            throw new Error("Wallet signing is required for stake deposit");
        }

        const { signAuthEntry } = await import("@stellar/freighter-api");
        const { authorizeEntry, rpc, xdr } = await import("@stellar/stellar-sdk");
        const { Buffer } = await import("buffer");

        const rpcUrl = import.meta.env.VITE_SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
        const effectivePassphrase = networkPassphrase || "Test SDF Network ; September 2015";

        const server = new rpc.Server(rpcUrl);
        const latestLedger = await server.getLatestLedger();
        const validUntilLedger = latestLedger.sequence + 60;

        const unsignedEntry = xdr.SorobanAuthorizationEntry.fromXDR(authEntryXdr, "base64");

        const signedEntry = await authorizeEntry(
            unsignedEntry,
            async (preimage) => {
                const result = await signAuthEntry(preimage.toXDR("base64"), { address });
                if (result.error) {
                    throw new Error(result.error.message || "Auth entry signing failed");
                }

                const signed = result?.signedAuthEntry ?? (result as any)?.result;
                if (!signed) {
                    throw new Error("Wallet signature was cancelled");
                }

                return Buffer.from(signed, "base64");
            },
            validUntilLedger,
            effectivePassphrase,
        );

        return signedEntry.toXDR("base64");
    }, [networkPassphrase, walletType]);

    const handleSubmitStakeDeposit = useCallback(async () => {
        if (!publicKey || !stakeGate?.required || stakeGate.myConfirmed) return;
        if (stakeSubmitInFlightRef.current) return;

        stakeSubmitInFlightRef.current = true;
        setStakeSubmitLocked(true);
        setStakeGate((prev) => prev ? { ...prev, isSubmitting: true, error: null } : prev);

        try {
            const prepareRes = await fetch(`${API_BASE}/api/matches/${matchId}/stake/prepare`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ address: publicKey }),
            });

            const prepareJson = await prepareRes.json().catch(() => ({}));

            if (!prepareRes.ok) {
                throw new Error(getStakeFailureMessage(prepareJson?.details || prepareJson?.error || "Failed to prepare stake deposit"));
            }

            if (prepareJson?.alreadyConfirmed) {
                localStakeConfirmedRef.current = true;
                try {
                    sessionStorage.setItem(localStakeConfirmedStorageKey(matchId, publicKey), "1");
                } catch {
                    // ignore
                }
                setStakeGate((prev) => prev
                    ? {
                        ...prev,
                        myConfirmed: true,
                        opponentConfirmed: !!prepareJson?.opponentConfirmed,
                        bothConfirmed: !!prepareJson?.bothConfirmed,
                        pendingRegistration: false,
                        isSubmitting: false,
                        error: null,
                    }
                    : prev,
                );
                return;
            }

            if (!prepareJson?.authEntryXdr || !prepareJson?.transactionXdr) {
                throw new Error("Stake prepare did not return auth entry or transaction");
            }

            const signedAuthEntryXdr = await signStakeAuthEntry(prepareJson.authEntryXdr, publicKey);

            const submitRes = await fetch(`${API_BASE}/api/matches/${matchId}/stake/submit`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    address: publicKey,
                    signedAuthEntryXdr,
                    transactionXdr: prepareJson.transactionXdr,
                }),
            });

            const submitJson = await submitRes.json().catch(() => ({}));

            if (!submitRes.ok) {
                throw new Error(getStakeFailureMessage(submitJson?.details || submitJson?.error || "Failed to submit stake deposit"));
            }

            localStakeConfirmedRef.current = true;
            try {
                sessionStorage.setItem(localStakeConfirmedStorageKey(matchId, publicKey), "1");
            } catch {
                // ignore
            }
            setStakeGate((prev) => prev
                ? {
                    ...prev,
                    myConfirmed: true,
                    opponentConfirmed: !!submitJson?.opponentConfirmed,
                    bothConfirmed: !!submitJson?.bothConfirmed,
                    pendingRegistration: false,
                    isSubmitting: false,
                    error: null,
                }
                : prev,
            );
        } catch (err) {
            setStakeGate((prev) => prev
                ? {
                    ...prev,
                    isSubmitting: false,
                    error: err instanceof Error ? err.message : "Failed to submit stake deposit",
                }
                : prev,
            );
        } finally {
            stakeSubmitInFlightRef.current = false;
            setStakeSubmitLocked(false);
            setStakeGate((prev) => prev ? { ...prev, isSubmitting: false } : prev);
        }
    }, [matchId, publicKey, signStakeAuthEntry, stakeGate?.myConfirmed, stakeGate?.required]);

    useEffect(() => {
        if (!publicKey || !stakeGate?.required || stakeGate.bothConfirmed) return;

        const deadlineAtMs = stakeGate.stakeDeadlineAtMs;
        if (!deadlineAtMs || stakeClockNowMs < deadlineAtMs || stakeExpireTriggeredRef.current) return;

        stakeExpireTriggeredRef.current = true;

        fetch(`${API_BASE}/api/matches/${matchId}/stake/expire`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ address: publicKey }),
        })
            .then((res) => res.json().catch(() => ({})))
            .then((json) => {
                if (json?.cancelled) {
                    navigateTo("/play");
                    return;
                }

                // If backend says deadline not reached yet (clock skew), allow retry trigger.
                if (json?.reason === "deadline_not_reached") {
                    stakeExpireTriggeredRef.current = false;
                }
            })
            .catch(() => {
                stakeExpireTriggeredRef.current = false;
            });
    }, [matchId, publicKey, stakeClockNowMs, stakeGate?.bothConfirmed, stakeGate?.required, stakeGate?.stakeDeadlineAtMs]);

    // Fetch match data and build scene config
    useEffect(() => {
        if (!matchId || !publicKey) return;

        const fetchMatch = async () => {
            try {
                const res = await fetch(`${API_BASE}/api/matches/${matchId}`);
                if (!res.ok) {
                    setError("Match not found");
                    setLoading(false);
                    return;
                }
                const data = await res.json();
                const match = data.match;

                const isHost = match.player1_address === publicKey;
                const hasStake = parseStroops(match.stake_amount_stroops) > 0n;
                const myConfirmed = isHost
                    ? !!match.player1_stake_confirmed_at
                    : !!match.player2_stake_confirmed_at;
                const opponentConfirmed = isHost
                    ? !!match.player2_stake_confirmed_at
                    : !!match.player1_stake_confirmed_at;
                const effectiveMyConfirmed = localStakeConfirmedRef.current || myConfirmed;
                const bothConfirmed = effectiveMyConfirmed && opponentConfirmed;
                if (effectiveMyConfirmed) {
                    localStakeConfirmedRef.current = true;
                    try {
                        sessionStorage.setItem(localStakeConfirmedStorageKey(matchId, publicKey), "1");
                    } catch {
                        // ignore
                    }
                }

                const deadlineAtMs = match.stake_deadline_at
                    ? new Date(match.stake_deadline_at).getTime()
                    : undefined;
                setStakeGate((prev) => {
                    const shouldRequireStake = hasStake || !!prev?.required;
                    if (!shouldRequireStake) return null;

                    const nextStakeAmount = hasStake
                        ? String(match.stake_amount_stroops)
                        : (prev?.stakeAmountStroops ?? "0");
                    const nextFeeBps = hasStake
                        ? Number(match.stake_fee_bps || 10)
                        : (prev?.feeBps ?? 10);

                    return {
                        required: true,
                        stakeAmountStroops: nextStakeAmount,
                        feeBps: nextFeeBps,
                        myConfirmed: prev?.myConfirmed || effectiveMyConfirmed || localStakeConfirmedRef.current,
                        opponentConfirmed,
                        bothConfirmed,
                        pendingRegistration: !match.onchain_session_id,
                        stakeDeadlineAtMs: deadlineAtMs ?? prev?.stakeDeadlineAtMs,
                        isSubmitting: prev?.isSubmitting ?? false,
                        error: prev?.error ?? null,
                    };
                });

                const playerBanId = isHost
                    ? (match.player1_ban_id ?? match.player1_ban_character_id ?? null)
                    : (match.player2_ban_id ?? match.player2_ban_character_id ?? null);
                const opponentBanId = isHost
                    ? (match.player2_ban_id ?? match.player2_ban_character_id ?? null)
                    : (match.player1_ban_id ?? match.player1_ban_character_id ?? null);

                const config: CharacterSelectSceneConfig = {
                    matchId,
                    playerAddress: publicKey,
                    opponentAddress: isHost ? match.player2_address : match.player1_address,
                    isHost,
                    selectionTimeLimit: 25,
                    // Timer is started by a client handshake once BOTH players are in-scene.
                    // Avoid using server deadlines here to prevent starting at 0 after pre-scene signing.
                    selectionDeadlineAt: undefined,
                    existingPlayerCharacter: isHost ? match.player1_character_id : match.player2_character_id,
                    existingOpponentCharacter: isHost ? match.player2_character_id : match.player1_character_id,
                    existingPlayerBan: playerBanId,
                    existingOpponentBan: opponentBanId,
                };

                setSceneConfig(config);
                setLoading(false);
            } catch (err) {
                console.error("[CharacterSelectClient] Error fetching match:", err);
                setError("Failed to load match");
                setLoading(false);
            }
        };

        fetchMatch();
    }, [matchId, publicKey]);

    // Subscribe to Supabase Realtime for opponent events on game:${matchId}
    useEffect(() => {
        if (!sceneConfig || !publicKey) return;

        let channel: RealtimeChannel | null = null;

        try {
            const supabase = getSupabaseClient();

            if (channelRef.current) {
                supabase.removeChannel(channelRef.current);
                channelRef.current = null;
            }

            channel = supabase
                .channel(`game:${matchId}`, { config: { broadcast: { self: true } } })
                .on("broadcast", { event: "character_selected" }, (payload) => {
                    const data = payload.payload as { player: string; characterId: string };
                    // Only forward opponent's selection, not our own
                    const myRole = sceneConfig.isHost ? "player1" : "player2";
                    if (data.player !== myRole) {
                        syncedOpponentCharacterRef.current = data.characterId;
                        EventBus.emit("opponent_character_confirmed", {
                            characterId: data.characterId,
                        });
                    }
                })
                .on("broadcast", { event: "ban_confirmed" }, (payload) => {
                    const data = payload.payload as { player: string; characterId: string };
                    syncedOpponentBanRef.current = data.characterId;
                    EventBus.emit("game:banConfirmed", {
                        characterId: data.characterId,
                        player: data.player,
                    });
                })
                .on("broadcast", { event: "match_starting" }, (payload) => {
                    const data = payload.payload as {
                        countdownSeconds: number;
                        player1CharacterId?: string;
                        player2CharacterId?: string;
                        requiresOnChainRegistration?: boolean;
                    };

                    EventBus.emit("match_starting", {
                        countdown: data.countdownSeconds,
                        player1CharacterId: data.player1CharacterId,
                        player2CharacterId: data.player2CharacterId,
                        requiresOnChainRegistration: data.requiresOnChainRegistration ?? false,
                    });
                })
                .on("broadcast", { event: "registration_complete" }, (payload) => {
                    EventBus.emit("registration_complete", payload.payload);
                    registrationCompleteRef.current = true;
                    setStakeGate((prev) => prev
                        ? {
                            ...prev,
                            pendingRegistration: false,
                            error: null,
                        }
                        : prev,
                    );
                })
                .on("broadcast", { event: "stake_confirmed" }, (payload) => {
                    const data = payload.payload as { player?: string; bothConfirmed?: boolean };
                    const myRole = sceneConfig.isHost ? "player1" : "player2";
                    const confirmedRole = data?.player;

                    if (confirmedRole === myRole || !!data?.bothConfirmed) {
                        localStakeConfirmedRef.current = true;
                        if (publicKey) {
                            try {
                                sessionStorage.setItem(localStakeConfirmedStorageKey(matchId, publicKey), "1");
                            } catch {
                                // ignore
                            }
                        }
                    }

                    setStakeGate((prev) => {
                        if (!prev?.required) return prev;
                        const myConfirmed = prev.myConfirmed || confirmedRole === myRole;
                        const opponentConfirmed = prev.opponentConfirmed || (!!confirmedRole && confirmedRole !== myRole);
                        const bothConfirmed = !!data?.bothConfirmed || (myConfirmed && opponentConfirmed);
                        return {
                            ...prev,
                            myConfirmed,
                            opponentConfirmed,
                            bothConfirmed,
                            pendingRegistration: false,
                            isSubmitting: false,
                            error: null,
                        };
                    });
                })
                .on("broadcast", { event: "stake_ready" }, () => {
                    localStakeConfirmedRef.current = true;
                    if (publicKey) {
                        try {
                            sessionStorage.setItem(localStakeConfirmedStorageKey(matchId, publicKey), "1");
                        } catch {
                            // ignore
                        }
                    }
                    setStakeGate((prev) => prev
                        ? {
                            ...prev,
                            bothConfirmed: true,
                            myConfirmed: true,
                            opponentConfirmed: true,
                            pendingRegistration: false,
                            isSubmitting: false,
                            error: null,
                        }
                        : prev,
                    );
                })
                .on("broadcast", { event: "scene_ready" }, (payload) => {
                    const data = payload.payload as { role?: string };
                    const role = data?.role;
                    if (!role) return;

                    readyRolesRef.current.add(role);

                    // Once both roles are ready, start the timer inside Phaser.
                    if (!startedTimerRef.current && readyRolesRef.current.has("player1") && readyRolesRef.current.has("player2")) {
                        startedTimerRef.current = true;
                        EventBus.emit("selection_timer:start", { matchId });
                    }
                })
                .on("broadcast", { event: "match_cancelled" }, () => {
                    console.log("[CharacterSelectClient] Match cancelled");
                    navigateTo("/play");
                })
                .on("broadcast", { event: "player_disconnected" }, (payload) => {
                    EventBus.emit("opponent_disconnected", payload.payload);
                    EventBus.emit("game:playerDisconnected", payload.payload);
                })
                .on("broadcast", { event: "player_reconnected" }, (payload) => {
                    EventBus.emit("opponent_reconnected", payload.payload);
                    EventBus.emit("game:playerReconnected", payload.payload);
                })
                // FightScene events (forwarded via EventBus so FightScene can receive them)
                .on("broadcast", { event: "round_starting" }, (payload) => {
                    moveSubmittedRef.current = false;
                    EventBus.emit("game:roundStarting", payload.payload);
                })
                .on("broadcast", { event: "move_submitted" }, (payload) => {
                    EventBus.emit("game:moveSubmitted", payload.payload);
                })
                .on("broadcast", { event: "move_confirmed" }, (payload) => {
                    const data = payload.payload as { txId?: string; onChainTxHash?: string };
                    EventBus.emit("game:moveConfirmed", {
                        ...payload.payload,
                        txId: data.txId || data.onChainTxHash,
                    });
                })
                .on("broadcast", { event: "round_resolved" }, (payload) => {
                    EventBus.emit("game:roundResolved", payload.payload);
                })
                .on("broadcast", { event: "round_plan_committed" }, (payload) => {
                    EventBus.emit("game:privateRoundCommitted", payload.payload);
                })
                .on("broadcast", { event: "round_plan_revealed" }, (payload) => {
                    EventBus.emit("game:privateRoundCommitted", payload.payload);
                })
                .on("broadcast", { event: "match_ended" }, (payload) => {
                    EventBus.emit("game:matchEnded", payload.payload);
                })
                .on("broadcast", { event: "move_rejected" }, (payload) => {
                    EventBus.emit("game:moveRejected", payload.payload);
                })
                .on("broadcast", { event: "fight_state_update" }, (payload) => {
                    EventBus.emit("game:fightStateUpdate", payload.payload);
                })
                .on("broadcast", { event: "power_surge_selected" }, (payload) => {
                    const data = payload.payload as { txId?: string; onChainTxHash?: string };
                    EventBus.emit("game:powerSurgeSelected", {
                        ...payload.payload,
                        txId: data.txId || data.onChainTxHash,
                    });
                })
                .on("broadcast", { event: "power_surge_cards" }, (payload) => {
                    EventBus.emit("game:powerSurgeCards", payload.payload);
                })
                .on("broadcast", { event: "chat_message" }, (payload) => {
                    EventBus.emit("game:chatMessage", payload.payload);
                })
                .on("broadcast", { event: "sticker_displayed" }, (payload) => {
                    EventBus.emit("game:stickerMessage", payload.payload);
                })
                .subscribe((status) => {
                    if (status === "SUBSCRIBED") {
                        EventBus.emit("channel_ready", { matchId });
                    }
                });

            channelRef.current = channel;
        } catch (err) {
            console.warn("[CharacterSelectClient] Failed to set up Realtime:", err);
        }

        return () => {
            if (channel) {
                channel.unsubscribe();
                getSupabaseClient().removeChannel(channel);
            }
            if (channelRef.current === channel) {
                channelRef.current = null;
            }
        };
    }, [sceneConfig, matchId, publicKey]);

    // Treat tab visibility and unload as disconnect/reconnect lifecycle signals.
    useEffect(() => {
        if (!publicKey || !sceneConfig) return;

        const sendDisconnectBeacon = () => {
            try {
                const payload = JSON.stringify({ address: publicKey, action: "disconnect" });
                const blob = new Blob([payload], { type: "application/json" });
                navigator.sendBeacon(`${API_BASE}/api/matches/${matchId}/disconnect`, blob);
            } catch {
                // best effort
            }
        };

        const sendReconnect = () => {
            fetch(`${API_BASE}/api/matches/${matchId}/disconnect`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ address: publicKey, action: "reconnect" }),
            }).catch((err) => {
                console.warn("[CharacterSelectClient] Reconnect on visibility failed:", err);
            });
        };

        const handleBeforeUnload = () => {
            sendDisconnectBeacon();
        };

        const handleVisibilityChange = () => {
            if (document.visibilityState === "hidden") {
                sendDisconnectBeacon();
            } else if (document.visibilityState === "visible") {
                sendReconnect();
            }
        };

        window.addEventListener("beforeunload", handleBeforeUnload);
        document.addEventListener("visibilitychange", handleVisibilityChange);

        return () => {
            window.removeEventListener("beforeunload", handleBeforeUnload);
            document.removeEventListener("visibilitychange", handleVisibilityChange);

            fetch(`${API_BASE}/api/matches/${matchId}/disconnect`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ address: publicKey, action: "disconnect" }),
                keepalive: true,
            }).catch(() => {
                // best effort
            });
        };
    }, [matchId, publicKey, sceneConfig]);

    // Poll match row as fallback for missed realtime events (selection + ban state sync)
    useEffect(() => {
        if (!sceneConfig || !publicKey) return;

        let mounted = true;
        const myRole = sceneConfig.isHost ? "player1" : "player2";

        const poll = async () => {
            if (!mounted) return;
            try {
                const res = await fetch(`${API_BASE}/api/matches/${matchId}`);
                if (!res.ok) return;
                const data = await res.json();
                const match = data?.match;
                if (!match) return;

                const hasStake = parseStroops(match.stake_amount_stroops) > 0n;
                if (hasStake || stakeGate?.required) {
                    const myConfirmed = myRole === "player1"
                        ? !!match.player1_stake_confirmed_at
                        : !!match.player2_stake_confirmed_at;
                    const opponentConfirmed = myRole === "player1"
                        ? !!match.player2_stake_confirmed_at
                        : !!match.player1_stake_confirmed_at;
                    const effectiveMyConfirmed = localStakeConfirmedRef.current || myConfirmed;
                    const bothConfirmed = effectiveMyConfirmed && opponentConfirmed;
                    if (effectiveMyConfirmed) {
                        localStakeConfirmedRef.current = true;
                        try {
                            sessionStorage.setItem(localStakeConfirmedStorageKey(matchId, publicKey), "1");
                        } catch {
                            // ignore
                        }
                    }

                    setStakeGate((prev) => {
                        const previous = prev?.required ? prev : null;
                        const stakeAmount = hasStake
                            ? String(match.stake_amount_stroops)
                            : (previous?.stakeAmountStroops ?? "0");
                        const feeBps = hasStake
                            ? Number(match.stake_fee_bps || 10)
                            : (previous?.feeBps ?? 10);
                        return {
                            required: true,
                            stakeAmountStroops: stakeAmount,
                            feeBps,
                            myConfirmed: previous?.myConfirmed || effectiveMyConfirmed || localStakeConfirmedRef.current,
                            opponentConfirmed,
                            bothConfirmed,
                            pendingRegistration: !match.onchain_session_id && !registrationCompleteRef.current,
                            stakeDeadlineAtMs: match.stake_deadline_at
                                ? new Date(match.stake_deadline_at).getTime()
                                : previous?.stakeDeadlineAtMs,
                            isSubmitting: previous?.isSubmitting ?? false,
                            error: previous?.error ?? null,
                        };
                    });
                } else {
                    setStakeGate(null);
                }

                const opponentCharacterId = myRole === "player1"
                    ? match.player2_character_id
                    : match.player1_character_id;

                if (opponentCharacterId && syncedOpponentCharacterRef.current !== opponentCharacterId) {
                    syncedOpponentCharacterRef.current = opponentCharacterId;
                    EventBus.emit("opponent_character_confirmed", { characterId: opponentCharacterId });
                }

                const opponentBanId = myRole === "player1"
                    ? (match.player2_ban_id ?? match.player2_ban_character_id ?? null)
                    : (match.player1_ban_id ?? match.player1_ban_character_id ?? null);

                if (opponentBanId && syncedOpponentBanRef.current !== opponentBanId) {
                    syncedOpponentBanRef.current = opponentBanId;
                    EventBus.emit("game:banConfirmed", {
                        player: myRole === "player1" ? "player2" : "player1",
                        characterId: opponentBanId,
                    });
                }
            } catch {
                // polling fallback best-effort
            }
        };

        poll();
        const interval = setInterval(poll, 1200);
        return () => {
            mounted = false;
            clearInterval(interval);
        };
    }, [sceneConfig, publicKey, matchId, stakeGate?.required]);

    // Listen for EventBus events to send selections to server
    useEffect(() => {
        if (!sceneConfig) return;

        const myRole = sceneConfig.isHost ? "player1" : "player2";

        const handleSendChat = async (data: unknown) => {
            const payload = data as { message?: string };
            const message = payload?.message?.trim();
            if (!message || !publicKey) return;

            const chatPayload = {
                sender: myRole,
                senderAddress: publicKey,
                message,
                timestamp: Date.now(),
            };

            try {
                if (channelRef.current) {
                    await channelRef.current.send({
                        type: "broadcast",
                        event: "chat_message",
                        payload: chatPayload,
                    });
                } else {
                    await broadcastGameEvent(matchId, "chat_message", chatPayload as Record<string, unknown>);
                }
            } catch (err) {
                console.error("[CharacterSelectClient] Failed to send chat message:", err);
            }
        };

        const handleSendSticker = async (data: unknown) => {
            const payload = data as { stickerId?: string };
            const stickerId = payload?.stickerId;
            if (!stickerId || !publicKey) return;

            const stickerPayload = {
                sender: myRole,
                senderAddress: publicKey,
                stickerId,
                timestamp: Date.now(),
            };

            try {
                if (channelRef.current) {
                    await channelRef.current.send({
                        type: "broadcast",
                        event: "sticker_displayed",
                        payload: stickerPayload,
                    });
                } else {
                    await broadcastGameEvent(matchId, "sticker_displayed", stickerPayload as Record<string, unknown>);
                }
            } catch (err) {
                console.error("[CharacterSelectClient] Failed to send sticker:", err);
            }
        };

        // When the Phaser scene is ready, broadcast a scene_ready handshake.
        // Re-send a few times to handle timing (opponent subscribing late).
        const handleSceneReady = async () => {
            if (sceneReadyRef.current) return;
            sceneReadyRef.current = true;

            readyRolesRef.current.add(myRole);

            const sendReady = async () => {
                try {
                    if (channelRef.current) {
                        await channelRef.current.send({
                            type: "broadcast",
                            event: "scene_ready",
                            payload: { role: myRole },
                        });
                    } else {
                        await broadcastGameEvent(matchId, "scene_ready", { role: myRole });
                    }
                } catch (err) {
                    console.warn("[CharacterSelectClient] Failed to broadcast scene_ready:", err);
                }
            };

            // Send immediately, then retry for ~5s to improve reliability
            sendReady();
            let tries = 0;
            const interval = setInterval(() => {
                tries += 1;
                if (startedTimerRef.current || tries >= 10) {
                    clearInterval(interval);
                    return;
                }
                sendReady();
            }, 500);
        };

        const handleSelectionConfirmed = async (data: unknown) => {
            const { characterId } = data as { characterId: string };
            try {
                const payload = {
                    player: sceneConfig.isHost ? "player1" : "player2",
                    characterId,
                    locked: true,
                };

                if (channelRef.current) {
                    await channelRef.current.send({
                        type: "broadcast",
                        event: "character_selected",
                        payload,
                    });
                } else {
                    await broadcastGameEvent(matchId, "character_selected", payload);
                }

                const res = await fetch(`${API_BASE}/api/matches/${matchId}/select`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ address: publicKey, characterId }),
                });

                if (!res.ok) {
                    console.error("[CharacterSelectClient] Failed to submit selection:", await res.text());
                }
            } catch (err) {
                console.error("[CharacterSelectClient] Failed to submit selection:", err);
            }
        };

        const handleBanConfirmed = async (data: unknown) => {
            const { characterId } = data as { characterId: string };
            const payload = {
                player: sceneConfig.isHost ? "player1" : "player2",
                characterId,
            };

            try {
                // 1) Instant realtime update for opponent (KaspaClash parity)
                if (channelRef.current) {
                    await channelRef.current.send({
                        type: "broadcast",
                        event: "ban_confirmed",
                        payload,
                    });
                } else {
                    await broadcastGameEvent(matchId, "ban_confirmed", payload);
                }

                // 2) Persist on server for reconnect/reload recovery
                const res = await fetch(`${API_BASE}/api/matches/${matchId}/ban`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        address: publicKey,
                        characterId,
                    }),
                });

                if (!res.ok) {
                    console.error("[CharacterSelectClient] Failed to submit ban:", await res.text());
                }
            } catch (err) {
                console.error("[CharacterSelectClient] Failed to submit/broadcast ban:", err);
            }
        };

        const handleMatchResult = (data: unknown) => {
            const payload = data as {
                isWinner: boolean;
                ratingChanges?: unknown;
                onChainSessionId?: number;
                onChainTxHash?: string;
                contractId?: string;
            };
            onMatchEndRef.current?.(payload);
        };

        const signActionMessage = async (
            message: string,
            address: string,
            options?: { forceWalletSignature?: boolean }
        ): Promise<{ signature?: string; signedMessage?: string }> => {
            const forceWalletSignature = options?.forceWalletSignature === true;

            if (USE_OFFCHAIN_ACTIONS && !forceWalletSignature) {
                return {};
            }

            if (walletType !== "wallet") {
                if (forceWalletSignature) {
                    throw new Error("Wallet signature required for private ZK commit. Connect a supported wallet.");
                }
                return {};
            }

            const { signMessage } = await import("@stellar/freighter-api");
            const result = await signMessage(message, {
                address,
                networkPassphrase: networkPassphrase || undefined,
            });

            if (result.error) {
                throw new Error(result.error.message || "Wallet signature failed");
            }

            if (!result.signedMessage) {
                throw new Error("Wallet signature was cancelled");
            }

            const signature = typeof result.signedMessage === "string"
                ? result.signedMessage
                : JSON.stringify(result.signedMessage);

            return {
                signature,
                signedMessage: message,
            };
        };

        const signSorobanAuthEntry = async (authEntryXdr: string, address: string): Promise<string> => {
            if (walletType !== "wallet") {
                throw new Error("Wallet signing is required for on-chain actions");
            }

            const { signAuthEntry } = await import("@stellar/freighter-api");
            const { authorizeEntry, rpc, xdr } = await import("@stellar/stellar-sdk");
            const { Buffer } = await import("buffer");

            const rpcUrl = import.meta.env.VITE_SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
            const effectivePassphrase = networkPassphrase || "Test SDF Network ; September 2015";

            const server = new rpc.Server(rpcUrl);
            const latestLedger = await server.getLatestLedger();
            const validUntilLedger = latestLedger.sequence + 60;

            const unsignedEntry = xdr.SorobanAuthorizationEntry.fromXDR(authEntryXdr, "base64");

            const signedEntry = await authorizeEntry(
                unsignedEntry,
                async (preimage) => {
                    const result = await signAuthEntry(preimage.toXDR("base64"), { address });
                    if (result.error) {
                        throw new Error(result.error.message || "Auth entry signing failed");
                    }

                    const signed = result?.signedAuthEntry ?? (result as any)?.result;
                    if (!signed) {
                        throw new Error("Wallet signature was cancelled");
                    }

                    return Buffer.from(signed, "base64");
                },
                validUntilLedger,
                effectivePassphrase,
            );

            return signedEntry.toXDR("base64");
        };

        const isRetryableOnChainError = (raw: string): boolean => {
            return /txBadSeq|TRY_AGAIN_LATER/i.test(raw);
        };

        const maybeCommitAndRevealPrivateRound = async (params: {
            matchId: string;
            playerRole: string;
            address: string;
            roundNumber: number;
            turnNumber: number;
        }) => {
            if (!PRIVATE_ROUNDS_ENABLED) return;

            const roundPlan = privateRoundPlansRef.current[params.roundNumber] || {};
            privateRoundPlansRef.current[params.roundNumber] = roundPlan;

            if (roundPlan.inFlight) return;
            if (roundPlan.fatalError) {
                EventBus.emit("game:moveError", { error: roundPlan.fatalError });
                return;
            }
            if (!roundPlan.moveType || !roundPlan.surgeCardId) {
                EventBus.emit("game:moveInFlight", {
                    player: params.playerRole,
                    cancelled: true,
                });
                EventBus.emit("game:moveError", {
                    error: !roundPlan.surgeCardId
                        ? "Power Surge selection is required before submitting a move"
                        : "Move selection is missing",
                });
                return;
            }

            roundPlan.inFlight = true;

            try {
                let sharedRoundProof = roundPlan.sharedRoundProof;
                let commitment = roundPlan.commitment;
                let proofPublicInputs = roundPlan.proofPublicInputs;
                let nonce = roundPlan.nonce;

                if (!sharedRoundProof || !commitment) {
                    const proveRes = await provePrivateRoundPlan(params.matchId, {
                        address: params.address,
                        roundNumber: params.roundNumber,
                        turnNumber: params.turnNumber,
                        move: roundPlan.moveType as "punch" | "kick" | "block" | "special" | "stunned",
                        surgeCardId: roundPlan.surgeCardId,
                        nonce,
                    });

                    commitment = proveRes.commitment;
                    sharedRoundProof = proveRes.proof;
                    proofPublicInputs = proveRes.publicInputs;
                    nonce = proveRes.nonce;
                    roundPlan.commitment = commitment;
                    roundPlan.sharedRoundProof = sharedRoundProof;
                    roundPlan.proofPublicInputs = proofPublicInputs;
                    roundPlan.nonce = nonce;
                }

                const encryptedPlan = btoa(JSON.stringify({
                    move: roundPlan.moveType,
                    surgeCardId: roundPlan.surgeCardId,
                }));

                if (!roundPlan.walletSignature || !roundPlan.walletSignedMessage) {
                    const signPayload = JSON.stringify({
                        type: "zk_private_round_commit",
                        matchId: params.matchId,
                        roundNumber: params.roundNumber,
                        turnNumber: params.turnNumber,
                        move: roundPlan.moveType,
                        surgeCardId: roundPlan.surgeCardId,
                        commitment,
                        timestamp: Date.now(),
                    });

                    const signed = await signActionMessage(signPayload, params.address);
                    roundPlan.walletSignature = signed.signature;
                    roundPlan.walletSignedMessage = signed.signedMessage;
                }

                if (!roundPlan.commitSubmitted) {
                    const commitRes = await commitPrivateRoundPlan(params.matchId, {
                        address: params.address,
                        roundNumber: params.roundNumber,
                        commitment,
                        proof: sharedRoundProof,
                        publicInputs: proofPublicInputs,
                        transcriptHash: nonce,
                        encryptedPlan,
                    });

                    roundPlan.commitSubmitted = true;

                    EventBus.emit("game:privateRoundCommitted", {
                        matchId: params.matchId,
                        roundNumber: params.roundNumber,
                        player1Committed: !!commitRes?.player1Committed,
                        player2Committed: !!commitRes?.player2Committed,
                        bothCommitted: !!commitRes?.bothCommitted,
                    });

                    moveSubmittedRef.current = true;
                    EventBus.emit("game:moveConfirmed", {
                        player: params.playerRole,
                        txId: commitRes?.onChainCommitTxHash,
                        onChainTxHash: commitRes?.onChainCommitTxHash,
                    });
                }

                if (!roundPlan.revealSubmitted) {
                    try {
                        await resolvePrivateRound(params.matchId, {
                            address: params.address,
                            roundNumber: params.roundNumber,
                            move: roundPlan.moveType as "punch" | "kick" | "block" | "special" | "stunned",
                            surgeCardId: roundPlan.surgeCardId,
                            proof: sharedRoundProof,
                            publicInputs: proofPublicInputs,
                            transcriptHash: nonce,
                        });
                        roundPlan.revealSubmitted = true;
                    } catch (revealErr) {
                        const revealMessage = revealErr instanceof Error ? revealErr.message : String(revealErr);
                        if (/both players have not committed yet/i.test(revealMessage)) {
                            console.log("[CharacterSelectClient] Private reveal deferred until both commits are present");
                        } else {
                            throw revealErr;
                        }
                    }
                }
            } catch (err) {
                console.error("[CharacterSelectClient] Private round commit/reveal failed:", err);
                const errorMessage = err instanceof Error ? err.message : "Private round commit failed";
                if (/ZK verification is enabled|ZK_VK_PATH|ZK_VERIFY_CMD/i.test(errorMessage)) {
                    roundPlan.fatalError = "Backend ZK is not configured. Set ZK_VK_PATH or ZK_VK_BASE64 on the server.";
                }
                EventBus.emit("game:moveInFlight", {
                    player: params.playerRole,
                    cancelled: true,
                });
                EventBus.emit("game:moveError", {
                    error: roundPlan.fatalError || errorMessage,
                });
            } finally {
                roundPlan.inFlight = false;
            }
        };

        const handleSubmitMove = async (data: unknown) => {
            const payload = data as {
                matchId: string;
                roundNumber: number;
                turnNumber: number;
                move: string;
                message: string;
                playerRole: string;
                playerAddress: string;
            };
            try {
                const signPayload = JSON.stringify({
                    type: "move",
                    matchId: payload.matchId,
                    roundNumber: payload.roundNumber,
                    turnNumber: payload.turnNumber,
                    move: payload.move,
                    playerAddress: payload.playerAddress,
                    timestamp: Date.now(),
                });
                const signed = await signActionMessage(signPayload, payload.playerAddress);

                let signedAuthEntryXdr: string | undefined;
                let transactionXdr: string | undefined;

                if (!USE_OFFCHAIN_ACTIONS) {
                    const prepareRes = await fetch(`${API_BASE}/api/matches/${payload.matchId}/move/prepare`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            address: payload.playerAddress,
                            move: payload.move,
                        }),
                    });

                    if (!prepareRes.ok) {
                        const prepareErrorText = await prepareRes.text();
                        throw new Error(prepareErrorText || "Move prepare failed");
                    }

                    const prepareJson = await prepareRes.json() as { authEntryXdr?: string; transactionXdr?: string };
                    if (!prepareJson?.authEntryXdr || !prepareJson?.transactionXdr) {
                        throw new Error("Move prepare did not return auth entry or transaction");
                    }

                    signedAuthEntryXdr = await signSorobanAuthEntry(prepareJson.authEntryXdr, payload.playerAddress);
                    transactionXdr = prepareJson.transactionXdr;
                }

                const res = await fetch(`${API_BASE}/api/matches/${payload.matchId}/move`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        address: payload.playerAddress,
                        move: payload.move,
                        roundNumber: payload.roundNumber,
                        turnNumber: payload.turnNumber,
                        signature: signed.signature,
                        signedMessage: signed.signedMessage,
                        signedAuthEntryXdr,
                        transactionXdr,
                    }),
                });
                if (!res.ok) {
                    console.error("[CharacterSelectClient] Move submission failed:", await res.text());
                    EventBus.emit("game:moveError", { error: "Move submission failed" });
                    return;
                }

                const result = await res.json().catch(() => null) as { onChainTxHash?: string } | null;
                const txId = result?.onChainTxHash;
                EventBus.emit("game:moveConfirmed", {
                    player: payload.playerRole,
                    txId,
                    onChainTxHash: txId,
                });
            } catch (err) {
                console.error("[CharacterSelectClient] Failed to submit move:", err);
                EventBus.emit("game:moveError", {
                    error: err instanceof Error ? err.message : "Move signing failed",
                });
            }
        };

        const handleGameSubmitMove = async (data: unknown) => {
            const payload = data as {
                matchId: string;
                moveType: string;
                playerRole: string;
            };

            try {
                const address = publicKey;
                if (!address) return;

                EventBus.emit("game:moveInFlight", { player: payload.playerRole });

                if (PRIVATE_ROUNDS_ENABLED) {
                    const roundNumber = currentRoundRef.current || 1;
                    const turnNumber = currentTurnRef.current || 1;
                    const plan = privateRoundPlansRef.current[roundNumber] || {};

                    if (!plan.moveSigned) {
                        await signActionMessage(
                            JSON.stringify({
                                type: "zk_private_move_select",
                                matchId: payload.matchId,
                                roundNumber,
                                move: payload.moveType,
                                playerAddress: address,
                                timestamp: Date.now(),
                            }),
                            address,
                            { forceWalletSignature: walletType === "wallet" },
                        );
                        plan.moveSigned = true;
                    }

                    plan.moveType = payload.moveType;
                    privateRoundPlansRef.current[roundNumber] = plan;

                    await maybeCommitAndRevealPrivateRound({
                        matchId: payload.matchId,
                        playerRole: payload.playerRole,
                        address,
                        roundNumber,
                        turnNumber,
                    });

                    return;
                }

                const signPayload = JSON.stringify({
                    type: "move",
                    matchId: payload.matchId,
                    move: payload.moveType,
                    playerAddress: address,
                    timestamp: Date.now(),
                });
                const signed = await signActionMessage(signPayload, address);

                let signedAuthEntryXdr: string | undefined;
                let transactionXdr: string | undefined;

                if (!USE_OFFCHAIN_ACTIONS) {
                    const prepareRes = await fetch(`${API_BASE}/api/matches/${payload.matchId}/move/prepare`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            address,
                            move: payload.moveType,
                        }),
                    });

                    if (!prepareRes.ok) {
                        const prepareErrorText = await prepareRes.text();
                        throw new Error(prepareErrorText || "Move prepare failed");
                    }

                    const prepareJson = await prepareRes.json() as { authEntryXdr?: string; transactionXdr?: string };
                    if (!prepareJson?.authEntryXdr || !prepareJson?.transactionXdr) {
                        throw new Error("Move prepare did not return auth entry or transaction");
                    }

                    signedAuthEntryXdr = await signSorobanAuthEntry(prepareJson.authEntryXdr, address);
                    transactionXdr = prepareJson.transactionXdr;
                }

                const res = await fetch(`${API_BASE}/api/matches/${payload.matchId}/move`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        address,
                        move: payload.moveType,
                        signature: signed.signature,
                        signedMessage: signed.signedMessage,
                        signedAuthEntryXdr,
                        transactionXdr,
                    }),
                });

                if (!res.ok) {
                    console.error("[CharacterSelectClient] game:submitMove failed:", await res.text());
                    EventBus.emit("game:moveInFlight", { player: payload.playerRole, cancelled: true });
                    EventBus.emit("game:moveError", { error: "Move submission failed" });
                    return;
                }

                const result = await res.json().catch(() => null) as { onChainTxHash?: string } | null;
                const txId = result?.onChainTxHash;
                moveSubmittedRef.current = true;
                EventBus.emit("game:moveConfirmed", {
                    player: payload.playerRole,
                    txId,
                    onChainTxHash: txId,
                });
            } catch (err) {
                console.error("[CharacterSelectClient] Failed to submit game:submitMove:", err);
                EventBus.emit("game:moveInFlight", {
                    player: payload.playerRole,
                    cancelled: true,
                });
                EventBus.emit("game:moveError", {
                    error: err instanceof Error ? err.message : "Move signing failed",
                });
            }
        };

        const handleTransactionRejection = async (id: string, address: string): Promise<void> => {
            try {
                const response = await fetch(`${API_BASE}/api/matches/${id}/reject`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ address }),
                });

                if (!response.ok) {
                    console.error("[CharacterSelectClient] Failed to record rejection:", await response.text());
                    EventBus.emit("game:moveError", { error: "Failed to record rejection" });
                    return;
                }

                const rejectResult = await response.json().catch(() => null) as {
                    status?: string;
                    message?: string;
                    redirectTo?: string;
                } | null;

                if (!rejectResult) return;

                if (rejectResult.status === "match_cancelled") {
                    EventBus.emit("game:matchCancelled", {
                        matchId: id,
                        reason: "both_rejected",
                        message: rejectResult.message || "Both players rejected transactions.",
                        redirectTo: rejectResult.redirectTo || "/play",
                    });
                } else if (rejectResult.status === "waiting") {
                    EventBus.emit("game:rejectionWaiting", {
                        message: rejectResult.message || "Waiting for opponent...",
                    });
                }
            } catch (error) {
                console.error("[CharacterSelectClient] Error recording rejection:", error);
            }
        };

        const handleSurrender = async () => {
            if (!publicKey) return;

            try {
                const response = await fetch(`${API_BASE}/api/matches/${matchId}/forfeit`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ address: publicKey }),
                });

                if (!response.ok) {
                    console.error("[CharacterSelectClient] Surrender failed:", await response.text());
                    EventBus.emit("game:moveError", { error: "Surrender failed" });
                }
            } catch (error) {
                console.error("[CharacterSelectClient] Surrender error:", error);
                EventBus.emit("game:moveError", { error: "Surrender cancelled or failed" });
            }
        };

        const handleCancelRequest = async () => {
            if (!publicKey) return;
            await handleTransactionRejection(matchId, publicKey);
        };

        const handleRoundStarting = () => {
            moveSubmittedRef.current = false;
        };

        const handlePrivateRoundStarting = (data: unknown) => {
            const payload = data as { roundNumber?: number; turnNumber?: number };
            const roundNumber = Number(payload?.roundNumber ?? 1);
            const turnNumber = Number(payload?.turnNumber ?? 1);
            if (Number.isInteger(roundNumber) && roundNumber > 0) {
                currentRoundRef.current = roundNumber;
                currentTurnRef.current = Number.isInteger(turnNumber) && turnNumber > 0 ? turnNumber : 1;
                const existing = privateRoundPlansRef.current[roundNumber] || {};
                privateRoundPlansRef.current[roundNumber] = {
                    surgeCardId: existing.surgeCardId,
                    surgeSigned: existing.surgeSigned,
                    moveType: undefined,
                    sharedRoundProof: undefined,
                    commitment: undefined,
                    proofPublicInputs: undefined,
                    nonce: undefined,
                    commitSubmitted: false,
                    revealSubmitted: false,
                    inFlight: false,
                    walletSignedMessage: undefined,
                    walletSignature: undefined,
                    moveSigned: false,
                    fatalError: existing.fatalError,
                };
            }
            handleRoundStarting();
        };

        const handlePrivateRoundCommitEvent = async (data: unknown) => {
            if (!PRIVATE_ROUNDS_ENABLED || !publicKey) return;

            const payload = data as {
                matchId?: string;
                roundNumber?: number;
                player1Committed?: boolean;
                player2Committed?: boolean;
                bothCommitted?: boolean;
            };

            const bothCommitted = !!payload?.bothCommitted
                || (!!payload?.player1Committed && !!payload?.player2Committed);

            if (!bothCommitted) return;

            const roundNumber = Number(payload?.roundNumber ?? currentRoundRef.current ?? 1);
            const plan = privateRoundPlansRef.current[roundNumber];
            if (!plan?.commitSubmitted || plan.revealSubmitted || plan.inFlight) return;

            await maybeCommitAndRevealPrivateRound({
                matchId: payload?.matchId || matchId,
                playerRole: sceneConfig.isHost ? "player1" : "player2",
                address: publicKey,
                roundNumber,
                turnNumber: currentTurnRef.current || 1,
            });
        };

        const handleTimerExpired = async () => {
            if (PRIVATE_ROUNDS_ENABLED) {
                return;
            }

            if (!publicKey) return;

            try {
                const response = await fetch(`${API_BASE}/api/matches/${matchId}/move-timeout`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ address: publicKey }),
                });

                if (!response.ok) {
                    console.error("[CharacterSelectClient] move-timeout failed:", await response.text());
                    return;
                }

                const result = await response.json().catch(() => null) as {
                    data?: { result?: string; reason?: string };
                } | null;

                if (result?.data?.result === "match_cancelled") {
                    EventBus.emit("game:matchCancelled", {
                        matchId,
                        reason: "both_timeout",
                        message: result.data.reason || "Both players failed to submit moves in time.",
                        redirectTo: "/play",
                    });
                }
            } catch (error) {
                console.error("[CharacterSelectClient] move-timeout error:", error);
            }
        };

        const handleClaimTimeoutVictory = async (data: unknown) => {
            const payload = data as { matchId?: string };
            const id = payload?.matchId || matchId;
            if (!publicKey) return;

            try {
                const response = await fetch(`${API_BASE}/api/matches/${id}/timeout`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ address: publicKey }),
                });

                if (!response.ok) {
                    console.error("[CharacterSelectClient] timeout claim failed:", await response.text());
                    return;
                }

                const result = await response.json().catch(() => null) as {
                    data?: {
                        result?: string;
                        message?: string;
                        redirectTo?: string;
                        matchEndedPayload?: unknown;
                    };
                } | null;

                if (!result?.data) return;

                if (result.data.result === "win" && result.data.matchEndedPayload) {
                    EventBus.emit("game:matchEnded", result.data.matchEndedPayload);
                } else if (result.data.result === "cancelled") {
                    EventBus.emit("game:matchCancelled", {
                        matchId: id,
                        reason: "both_disconnected",
                        message: result.data.message || "Both players disconnected.",
                        redirectTo: result.data.redirectTo || "/play",
                    });
                }
            } catch (error) {
                console.error("[CharacterSelectClient] timeout claim error:", error);
            }
        };

        const handleRequestRoundState = async (data: unknown) => {
            const payload = data as { matchId?: string };
            const id = payload?.matchId || matchId;

            try {
                const res = await fetch(`${API_BASE}/api/matches/${id}`);
                if (!res.ok) return;
                const json = await res.json();
                const row = json?.fightState;
                if (!row) {
                    EventBus.emit("game:roundStarting", {
                        roundNumber: 1,
                        turnNumber: 1,
                        player1Health: 100,
                        player2Health: 100,
                        player1Energy: 0,
                        player2Energy: 0,
                        player1GuardMeter: 0,
                        player2GuardMeter: 0,
                        player1IsStunned: false,
                        player2IsStunned: false,
                        moveDeadlineAt: Date.now() + 20000,
                        countdownEndsAt: Date.now() + 3000,
                    });
                    return;
                }

                EventBus.emit("game:roundStarting", {
                    roundNumber: row.current_round ?? 1,
                    turnNumber: row.current_turn ?? 1,
                    player1Health: row.player1_health ?? 100,
                    player2Health: row.player2_health ?? 100,
                    player1Energy: row.player1_energy ?? 0,
                    player2Energy: row.player2_energy ?? 0,
                    player1GuardMeter: row.player1_guard_meter ?? 0,
                    player2GuardMeter: row.player2_guard_meter ?? 0,
                    player1IsStunned: !!row.player1_is_stunned,
                    player2IsStunned: !!row.player2_is_stunned,
                    moveDeadlineAt: row.move_deadline_at ? new Date(row.move_deadline_at).getTime() : Date.now() + 20000,
                    countdownEndsAt: row.countdown_ends_at ? new Date(row.countdown_ends_at).getTime() : Date.now() + 3000,
                });
            } catch (err) {
                console.error("[CharacterSelectClient] Failed to handle fight:requestRoundState:", err);
            }
        };

        const handleForfeit = async (data: unknown) => {
            const payload = data as { matchId: string; playerRole: string };
            try {
                await fetch(`${API_BASE}/api/matches/${payload.matchId}/forfeit`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        address: publicKey,
                        playerRole: payload.playerRole,
                    }),
                });
            } catch (err) {
                console.error("[CharacterSelectClient] Failed to forfeit:", err);
            }
        };

        const handleSelectPowerSurge = async (data: unknown) => {
            const payload = data as {
                matchId: string;
                roundNumber: number;
                playerRole: string;
                playerAddress: string;
                cardId: string;
            };

            try {
                if (PRIVATE_ROUNDS_ENABLED) {
                    const roundNumber = Number(payload.roundNumber || currentRoundRef.current || 1);
                    const plan = privateRoundPlansRef.current[roundNumber] || {};

                    if (!plan.surgeSigned) {
                        await signActionMessage(
                            JSON.stringify({
                                type: "zk_private_surge_select",
                                matchId: payload.matchId,
                                roundNumber,
                                cardId: payload.cardId,
                                playerAddress: payload.playerAddress,
                                timestamp: Date.now(),
                            }),
                            payload.playerAddress,
                            { forceWalletSignature: walletType === "wallet" },
                        );
                        plan.surgeSigned = true;
                    }

                    plan.surgeCardId = payload.cardId;
                    privateRoundPlansRef.current[roundNumber] = plan;

                    const selectedPayload = {
                        player: payload.playerRole,
                        cardId: payload.cardId,
                        roundNumber,
                    };

                    try {
                        if (channelRef.current) {
                            await channelRef.current.send({
                                type: "broadcast",
                                event: "power_surge_selected",
                                payload: selectedPayload,
                            });
                        }
                    } catch (broadcastErr) {
                        console.warn("[CharacterSelectClient] Failed private power_surge_selected broadcast:", broadcastErr);
                    }

                    EventBus.emit("game:powerSurgeSelected", {
                        ...selectedPayload,
                    });

                    await maybeCommitAndRevealPrivateRound({
                        matchId: payload.matchId,
                        playerRole: payload.playerRole,
                        address: payload.playerAddress,
                        roundNumber,
                        turnNumber: currentTurnRef.current || 1,
                    });

                    return;
                }

                const signPayload = JSON.stringify({
                    type: "power_surge",
                    matchId: payload.matchId,
                    roundNumber: payload.roundNumber,
                    cardId: payload.cardId,
                    playerAddress: payload.playerAddress,
                    timestamp: Date.now(),
                });
                const signed = await signActionMessage(signPayload, payload.playerAddress);

                const submitPowerSurgeOnce = async () => {
                    let signedAuthEntryXdr: string | undefined;
                    let transactionXdr: string | undefined;

                    if (!USE_OFFCHAIN_ACTIONS) {
                        const prepareRes = await fetch(`${API_BASE}/api/matches/${payload.matchId}/power-surge/prepare`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                                address: payload.playerAddress,
                                roundNumber: payload.roundNumber,
                                cardId: payload.cardId,
                            }),
                        });

                        if (!prepareRes.ok) {
                            const prepareErrorText = await prepareRes.text();
                            throw new Error(prepareErrorText || "Power surge prepare failed");
                        }

                        const prepareJson = await prepareRes.json() as { authEntryXdr?: string; transactionXdr?: string };
                        if (!prepareJson?.authEntryXdr || !prepareJson?.transactionXdr) {
                            throw new Error("Power surge prepare did not return auth entry or transaction");
                        }

                        signedAuthEntryXdr = await signSorobanAuthEntry(prepareJson.authEntryXdr, payload.playerAddress);
                        transactionXdr = prepareJson.transactionXdr;
                    }

                    const selectRes = await fetch(`${API_BASE}/api/matches/${payload.matchId}/power-surge/select`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            address: payload.playerAddress,
                            roundNumber: payload.roundNumber,
                            cardId: payload.cardId,
                            signature: signed.signature,
                            signedMessage: signed.signedMessage,
                            signedAuthEntryXdr,
                            transactionXdr,
                        }),
                    });

                    return selectRes;
                };

                let res = await submitPowerSurgeOnce();

                if (!res.ok) {
                    const firstErrorText = await res.text();
                    if (isRetryableOnChainError(firstErrorText)) {
                        console.warn("[CharacterSelectClient] Retryable on-chain error detected for power surge, retrying once...");
                        res = await submitPowerSurgeOnce();
                    } else {
                        console.error("[CharacterSelectClient] Power surge selection failed:", firstErrorText);
                        EventBus.emit("game:powerSurgeError", {
                            player: payload.playerRole,
                            cardId: payload.cardId,
                            roundNumber: payload.roundNumber,
                            error: firstErrorText || "Power surge selection failed",
                        });
                        return;
                    }
                }

                if (!res.ok) {
                    const retryErrorText = await res.text();
                    console.error("[CharacterSelectClient] Power surge selection failed after retry:", retryErrorText);
                    EventBus.emit("game:powerSurgeError", {
                        player: payload.playerRole,
                        cardId: payload.cardId,
                        roundNumber: payload.roundNumber,
                        error: retryErrorText || "Power surge selection failed",
                    });
                    return;
                }

                const result = await res.json().catch(() => null) as { onChainTxHash?: string } | null;
                const txId = result?.onChainTxHash;

                const selectedPayload = {
                    player: payload.playerRole,
                    cardId: payload.cardId,
                    roundNumber: payload.roundNumber,
                    txId,
                    onChainTxHash: txId,
                };

                // Optimistic fallback broadcast so opponent sees the selection even if
                // server-side broadcast is delayed or dropped.
                try {
                    if (channelRef.current) {
                        await channelRef.current.send({
                            type: "broadcast",
                            event: "power_surge_selected",
                            payload: selectedPayload,
                        });
                    }
                } catch (broadcastErr) {
                    console.warn("[CharacterSelectClient] Failed fallback power_surge_selected broadcast:", broadcastErr);
                }

                EventBus.emit("game:powerSurgeSelected", {
                    ...selectedPayload,
                });
            } catch (err) {
                console.error("[CharacterSelectClient] Failed to submit power surge selection:", err);
                EventBus.emit("game:powerSurgeError", {
                    player: payload.playerRole,
                    cardId: payload.cardId,
                    roundNumber: payload.roundNumber,
                    error: err instanceof Error ? err.message : "Power surge signing failed",
                });
            }
        };

        EventBus.on("selection_confirmed", handleSelectionConfirmed);
        EventBus.on("game:sendBanConfirmed", handleBanConfirmed);
        EventBus.on("game:sendChat", handleSendChat);
        EventBus.on("game:sendSticker", handleSendSticker);
        EventBus.on("fight:matchResult", handleMatchResult);
        EventBus.on("fight:submitMove", handleSubmitMove);
        EventBus.on("game:submitMove", handleGameSubmitMove);
        EventBus.on("fight:forfeit", handleForfeit);
        EventBus.on("fight:selectPowerSurge", handleSelectPowerSurge);
        EventBus.on("fight:requestRoundState", handleRequestRoundState);
        EventBus.on("request-surrender", handleSurrender);
        EventBus.on("request-cancel", handleCancelRequest);
        EventBus.on("game:timerExpired", handleTimerExpired);
        EventBus.on("game:claimTimeoutVictory", handleClaimTimeoutVictory);
        EventBus.on("game:roundStarting", handlePrivateRoundStarting);
        EventBus.on("game:privateRoundCommitted", handlePrivateRoundCommitEvent);
        EventBus.on("character_select_ready", handleSceneReady);

        return () => {
            EventBus.off("selection_confirmed", handleSelectionConfirmed);
            EventBus.off("game:sendBanConfirmed", handleBanConfirmed);
            EventBus.off("game:sendChat", handleSendChat);
            EventBus.off("game:sendSticker", handleSendSticker);
            EventBus.off("fight:matchResult", handleMatchResult);
            EventBus.off("fight:submitMove", handleSubmitMove);
            EventBus.off("game:submitMove", handleGameSubmitMove);
            EventBus.off("fight:forfeit", handleForfeit);
            EventBus.off("fight:selectPowerSurge", handleSelectPowerSurge);
            EventBus.off("fight:requestRoundState", handleRequestRoundState);
            EventBus.off("request-surrender", handleSurrender);
            EventBus.off("request-cancel", handleCancelRequest);
            EventBus.off("game:timerExpired", handleTimerExpired);
            EventBus.off("game:claimTimeoutVictory", handleClaimTimeoutVictory);
            EventBus.off("game:roundStarting", handlePrivateRoundStarting);
            EventBus.off("game:privateRoundCommitted", handlePrivateRoundCommitEvent);
            EventBus.off("character_select_ready", handleSceneReady);
        };
    }, [sceneConfig, matchId, publicKey]);

    if (loading) {
        return (
            <div className="fixed inset-0 bg-black flex items-center justify-center z-50">
                <div className="text-center">
                    <div className="w-12 h-12 border-4 border-cyber-gold border-t-transparent rounded-full animate-spin mx-auto mb-4" />
                    <p className="text-cyber-gold font-orbitron tracking-widest text-sm">
                        LOADING MATCH...
                    </p>
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="fixed inset-0 bg-black flex items-center justify-center z-50">
                <div className="text-center bg-black/40 border border-red-500/30 rounded-[20px] p-10 max-w-md">
                    <h2 className="text-2xl font-bold text-red-500 font-orbitron mb-4">ERROR</h2>
                    <p className="text-cyber-gray text-sm mb-6">{error}</p>
                    <button
                        onClick={() => navigateTo("/play")}
                        className="w-full bg-transparent border border-white/10 text-cyber-gray font-orbitron hover:bg-white/5 py-3 rounded-xl text-sm"
                    >
                        BACK TO ARENA
                    </button>
                </div>
            </div>
        );
    }

    const stakeAmountStroops = stakeGate?.required ? parseStroops(stakeGate.stakeAmountStroops) : 0n;
    const stakeFeeStroops = stakeGate?.required ? calcStakeFee(stakeAmountStroops, stakeGate.feeBps) : 0n;
    const requiredDepositStroops = stakeAmountStroops + stakeFeeStroops;
    const myStakeConfirmed = !!stakeGate?.myConfirmed || localStakeConfirmedRef.current;
    const shouldBlockForStake = !!stakeGate?.required && !stakeGate.bothConfirmed;
    const stakeSubmitBusy = stakeGate?.isSubmitting || stakeSubmitLocked;
    const stakeTimeLeftSeconds = stakeGate?.stakeDeadlineAtMs
        ? Math.max(0, Math.ceil((stakeGate.stakeDeadlineAtMs - stakeClockNowMs) / 1000))
        : null;

    if (shouldBlockForStake) {
        return (
            <div className="fixed inset-0 bg-black flex items-center justify-center z-50 p-4">
                <div className="w-full max-w-lg bg-black/60 border border-cyber-gold/30 rounded-[20px] p-8">
                    <h2 className="text-2xl font-bold text-cyber-gold font-orbitron mb-2">STAKE DEPOSIT REQUIRED</h2>
                    <p className="text-cyber-gray text-sm mb-6">
                        Both players must confirm their stake on-chain before character selection begins.
                    </p>

                    <div className="bg-cyber-gold/10 border border-cyber-gold/30 rounded-xl p-4 mb-4">
                        <p className="text-cyber-gold font-orbitron font-bold">
                            Stake: {toXlmDisplay(stakeAmountStroops)} XLM per player
                        </p>
                        <p className="text-cyber-gray text-xs mt-1">
                            Deposit now: {toXlmDisplay(requiredDepositStroops)} XLM ({toXlmDisplay(stakeAmountStroops)} + {toXlmDisplay(stakeFeeStroops)} fee)
                        </p>
                        <p className="text-green-400 text-xs mt-1">
                            Winner payout: {toXlmDisplay(stakeAmountStroops * 2n)} XLM
                        </p>
                    </div>

                    <div className="space-y-2 mb-5 text-sm">
                        {stakeTimeLeftSeconds !== null && (
                            <p className="text-cyber-gray text-xs">
                                Deposit window: <span className={stakeTimeLeftSeconds <= 10 ? "text-red-400" : "text-cyber-gold"}>{stakeTimeLeftSeconds}s</span>
                            </p>
                        )}
                        <p className={myStakeConfirmed ? "text-green-400" : "text-cyber-gray"}>
                            {myStakeConfirmed ? "✓" : "○"} Your stake confirmed
                        </p>
                        <p className={stakeGate.opponentConfirmed ? "text-green-400" : "text-cyber-gray"}>
                            {stakeGate.opponentConfirmed ? "✓" : "○"} Opponent stake confirmed
                        </p>
                    </div>

                    {stakeGate.pendingRegistration && (
                        <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-3 mb-4">
                            <p className="text-yellow-400 text-sm">
                                {registrationStatus === "preparing" && "Preparing on-chain registration transaction..."}
                                {registrationStatus === "signing" && "Check your wallet and sign the match registration."}
                                {registrationStatus === "waiting_for_opponent" && "Waiting for opponent wallet signature on registration..."}
                                {(registrationStatus === "idle" || registrationStatus === "complete" || registrationStatus === "skipped" || registrationStatus === "error") &&
                                    "Waiting for on-chain match registration to complete before stake deposit."}
                            </p>
                        </div>
                    )}

                    {stakeGate.error && (
                        <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-4">
                            <div className="flex items-start justify-between gap-3">
                                <div>
                                    <p className="text-red-400 text-sm font-orbitron">TRANSACTION ERROR</p>
                                    <p className="text-red-300 text-xs mt-1 break-words">{stakeGate.error}</p>
                                    <p className="text-cyber-gray text-[11px] mt-2">This message auto-hides in ~10s.</p>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => setStakeGate((prev) => prev ? { ...prev, error: null } : prev)}
                                    className="text-cyber-gray hover:text-white text-xs border border-white/10 rounded-md px-2 py-1"
                                >
                                    DISMISS
                                </button>
                            </div>
                        </div>
                    )}

                    <div className="bg-cyber-blue/10 border border-cyber-blue/30 rounded-xl p-3 mb-4">
                        <p className="text-cyber-blue text-xs">
                            If a stake transaction fails or times out, retrying is safe. The contract blocks duplicate stake deposits for the same player, so you cannot pay twice for one match.
                        </p>
                    </div>

                    <button
                        onClick={handleSubmitStakeDeposit}
                        disabled={stakeSubmitBusy || myStakeConfirmed || stakeGate.pendingRegistration}
                        className="w-full bg-gradient-cyber text-white border-0 font-orbitron hover:opacity-90 py-3 rounded-xl text-sm disabled:opacity-50"
                    >
                        {myStakeConfirmed
                            ? (stakeGate.opponentConfirmed ? "WAITING FOR MATCH..." : "WAITING FOR OPPONENT...")
                            : stakeSubmitBusy
                                ? "AWAITING WALLET CONFIRMATION..."
                                : `CONFIRM ${toXlmDisplay(requiredDepositStroops)} XLM STAKE`}
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="fixed inset-0 z-50 bg-black overflow-hidden">
            {/* Header bar */}
            <div className="absolute top-0 left-0 right-0 z-10 hidden xl:flex justify-between items-center p-4 bg-gradient-to-b from-black/80 to-transparent pointer-events-none">
                <span className="text-2xl font-bold font-orbitron text-white tracking-wider drop-shadow-[0_0_10px_rgba(240,183,31,0.5)]">
                    VEILSTAR<span className="text-cyber-gold"> BRAWL</span>
                </span>
                <span className="text-cyber-gray text-xs font-orbitron tracking-widest">
                    Match: <span className="text-cyber-gold">{matchId.slice(0, 8)}...</span>
                </span>
            </div>


            <PhaserGame
                currentScene="CharacterSelectScene"
                sceneConfig={sceneConfig as unknown as Record<string, unknown>}
            />
        </div>
    );
}

export default CharacterSelectClient;
