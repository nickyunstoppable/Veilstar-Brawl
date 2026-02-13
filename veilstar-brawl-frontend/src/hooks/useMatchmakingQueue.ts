/**
 * useMatchmakingQueue Hook
 * React hook for matchmaking queue with polling fallback
 * Uses API polling for reliability, with optional Realtime for live updates
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { getSupabaseClient } from "../lib/supabase/client";
import {
    useMatchmakingStore,
    selectIsInQueue,
    selectQueueWaitTime,
    selectPlayerCount,
    type QueuedPlayer,
    type MatchmakingResult,
} from "../stores/matchmaking-store";
import { useWallet } from "./useWallet";

// =============================================================================
// TYPES
// =============================================================================

/**
 * Matchmaking event types from server.
 */
interface MatchFoundEvent {
    matchId: string;
    player1Address: string;
    player2Address: string;
    selectionDeadlineAt?: string;
}

/**
 * Queue status response from API.
 */
interface QueueStatusResponse {
    inQueue: boolean;
    queueSize: number;
    matchPending?: boolean;
    matchFound?: MatchFoundEvent;
}

interface MatchVerifyResponse {
    match?: {
        id: string;
        status: string;
        created_at?: string;
    };
}

const ACTIVE_MATCH_STATUSES = new Set(["waiting", "character_select", "in_progress"]);

async function parseJsonSafe<T>(response: Response): Promise<T | null> {
    const raw = await response.text();
    if (!raw) return null;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}

/**
 * Hook return type.
 */
export interface UseMatchmakingQueueReturn {
    // State
    isInQueue: boolean;
    isJoining: boolean;
    isMatching: boolean;
    waitTimeSeconds: number;
    playerCount: number;
    playersInQueue: QueuedPlayer[];
    error: string | null;
    matchResult: MatchmakingResult | null;

    // Actions
    joinQueue: () => Promise<void>;
    leaveQueue: () => Promise<void>;

    // Utilities
    formatWaitTime: (seconds: number) => string;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const QUEUE_CHANNEL = "matchmaking:queue";
const POLL_INTERVAL = 1000;

/**
 * API base URL — configurable via env var, defaults to current origin.
 */
const API_BASE = import.meta.env.VITE_API_BASE_URL || "";

// =============================================================================
// HOOK
// =============================================================================

export function useMatchmakingQueue(): UseMatchmakingQueueReturn {
    const { publicKey: address, isConnected } = useWallet();
    const store = useMatchmakingStore();
    const channelRef = useRef<RealtimeChannel | null>(null);
    const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const [waitTimeSeconds, setWaitTimeSeconds] = useState(0);

    // Guards against race conditions
    const matchHandledRef = useRef<string | null>(null);
    const navigationPendingRef = useRef(false);
    const isInQueueRef = useRef(false);
    const joinAttemptStartedAtRef = useRef<number>(0);

    // Derived state
    const isInQueue = useMatchmakingStore(selectIsInQueue);
    const playerCount = useMatchmakingStore(selectPlayerCount);
    const queuedAt = useMatchmakingStore((state) => state.queuedAt);

    // Keep ref in sync with queue state
    useEffect(() => {
        isInQueueRef.current = isInQueue;
    }, [isInQueue]);

    // Timer for wait time (updates every 1s)
    useEffect(() => {
        if (!isInQueue || !queuedAt) {
            setWaitTimeSeconds(0);
            return;
        }

        const updateElapsed = () => {
            setWaitTimeSeconds(Math.floor((Date.now() - queuedAt) / 1000));
        };

        updateElapsed();
        const interval = setInterval(updateElapsed, 1000);

        return () => clearInterval(interval);
    }, [isInQueue, queuedAt]);

    /**
     * Handle match found — navigate to match.
     */
    const handleMatchFound = useCallback(
        async (matchData: MatchFoundEvent) => {
            const { matchId, player1Address, player2Address, selectionDeadlineAt } =
                matchData;

            // Check if this match involves the current player
            if (
                !address ||
                (player1Address !== address && player2Address !== address)
            ) {
                return;
            }

            // Guard against duplicate calls
            if (matchHandledRef.current === matchId) {
                console.log("Match already handled, ignoring duplicate:", matchId);
                return;
            }

            if (navigationPendingRef.current) {
                console.log("Navigation already pending, ignoring:", matchId);
                return;
            }

            console.log("Match found!", matchData);

            matchHandledRef.current = matchId;
            navigationPendingRef.current = true;

            // Verify match exists before navigation
            try {
                const verifyResponse = await fetch(
                    `${API_BASE}/api/matches/${matchId}/verify`
                );
                if (!verifyResponse.ok) {
                    console.warn(
                        "Match verification failed, will retry on next poll"
                    );
                    matchHandledRef.current = null;
                    navigationPendingRef.current = false;
                    return;
                }

                const verifyData = await parseJsonSafe<MatchVerifyResponse>(verifyResponse);
                const verifiedMatch = verifyData?.match;
                const verifiedStatus = verifiedMatch?.status;
                const verifiedCreatedAtMs = verifiedMatch?.created_at
                    ? new Date(verifiedMatch.created_at).getTime()
                    : null;

                if (!verifiedMatch || !verifiedStatus || !ACTIVE_MATCH_STATUSES.has(verifiedStatus)) {
                    console.warn("Verified match is not active, ignoring:", {
                        matchId,
                        status: verifiedStatus,
                    });
                    matchHandledRef.current = null;
                    navigationPendingRef.current = false;
                    return;
                }

                if (
                    joinAttemptStartedAtRef.current > 0 &&
                    verifiedCreatedAtMs !== null &&
                    verifiedCreatedAtMs < joinAttemptStartedAtRef.current
                ) {
                    console.warn("Ignoring stale match created before this quick-match attempt:", {
                        matchId,
                        createdAt: verifiedMatch.created_at,
                        joinedAt: new Date(joinAttemptStartedAtRef.current).toISOString(),
                    });
                    matchHandledRef.current = null;
                    navigationPendingRef.current = false;
                    return;
                }
            } catch (error) {
                console.warn("Match verification error:", error);
                matchHandledRef.current = null;
                navigationPendingRef.current = false;
                return;
            }

            // Stop polling only after successful verification
            if (pollIntervalRef.current) {
                clearInterval(pollIntervalRef.current);
                pollIntervalRef.current = null;
            }

            // Update store state
            store.setMatched({
                matchId,
                player1Address,
                player2Address,
                createdAt: new Date(),
                selectionDeadlineAt,
            });

            // SPA navigation — let the consuming component handle via matchResult
            // (QueuePage watches matchResult and calls navigateTo)
        },
        [address, store]
    );

    /**
     * Poll for queue status and match results.
     */
    const pollQueueStatus = useCallback(async () => {
        if (navigationPendingRef.current) return;
        if (!address) return;
        if (!isInQueueRef.current) return;

        try {
            const response = await fetch(
                `${API_BASE}/api/matchmaking/queue?address=${encodeURIComponent(address)}`
            );

            if (response.ok) {
                const data = await parseJsonSafe<QueueStatusResponse>(response);
                if (!data) {
                    console.warn("Queue poll returned empty/non-JSON response");
                    return;
                }

                if (!navigationPendingRef.current) {
                    store.setPlayersInQueue(
                        Array(data.queueSize)
                            .fill(null)
                            .map((_, i) => ({
                                address: `player-${i}`,
                                displayName: null,
                                rating: 1000,
                                joinedAt: Date.now(),
                            }))
                    );
                }

                if (data.matchPending && !navigationPendingRef.current) {
                    store.setMatching();
                }

                if (data.matchFound) {
                    await handleMatchFound(data.matchFound);
                    return;
                }

                if (data.inQueue === false) {
                    store.leaveQueue();
                    store.setQueueError("Queue state expired. Please join again.");
                }
            }
        } catch (error) {
            console.warn("Queue poll failed:", error);
        }
    }, [address, store, handleMatchFound]);

    /**
     * Set up Realtime subscription for instant match notifications.
     */
    const setupRealtime = useCallback(() => {
        if (!address) return;

        try {
            const supabase = getSupabaseClient();

            const channel = supabase
                .channel(QUEUE_CHANNEL)
                .on("broadcast", { event: "match_found" }, (payload) => {
                    console.log("Realtime match_found event:", payload);
                    if (payload.payload) {
                        handleMatchFound(payload.payload as MatchFoundEvent);
                    }
                })
                .subscribe((status) => {
                    console.log("Realtime subscription status:", status);
                    if (status === "SUBSCRIBED") {
                        channelRef.current = channel;
                    }
                });

            return channel;
        } catch (error) {
            console.warn("Failed to set up realtime:", error);
            return null;
        }
    }, [address, handleMatchFound]);

    /**
     * Join the matchmaking queue.
     */
    const joinQueue = useCallback(async (): Promise<void> => {
        if (!isConnected || !address) {
            store.setQueueError("Wallet not connected");
            return;
        }

        try {
            // Reset stale guards from previous matchmaking attempts
            matchHandledRef.current = null;
            navigationPendingRef.current = false;
            joinAttemptStartedAtRef.current = Date.now();
            store.clearMatchResult();

            store.joinQueue();

            const response = await fetch(`${API_BASE}/api/matchmaking/queue`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ address }),
            });

            if (!response.ok) {
                const error = await parseJsonSafe<{ error?: { message?: string } | string }>(response);
                const message = typeof error?.error === "string"
                    ? error.error
                    : error?.error?.message;
                throw new Error(message || `Failed to join queue (${response.status})`);
            }

            const result = await parseJsonSafe<{ matchFound?: MatchFoundEvent }>(response);
            if (!result) {
                throw new Error("Queue API returned empty/non-JSON response");
            }

            // Check if immediately matched
            if (result.matchFound) {
                // Start fallback listeners first so we can recover if early verification fails
                store.setQueued(Date.now());
                setupRealtime();
                if (!pollIntervalRef.current) {
                    pollIntervalRef.current = setInterval(pollQueueStatus, POLL_INTERVAL);
                }
                pollQueueStatus();

                await handleMatchFound(result.matchFound as MatchFoundEvent);
                return;
            }

            // Mark as queued
            store.setQueued(Date.now());

            // Set up Realtime for instant notifications
            setupRealtime();

            // Start polling as backup
            pollIntervalRef.current = setInterval(pollQueueStatus, POLL_INTERVAL);

            // Initial poll
            pollQueueStatus();
        } catch (error) {
            const message =
                error instanceof Error ? error.message : "Failed to join queue";
            store.setQueueError(message);
        }
    }, [address, isConnected, store, handleMatchFound, setupRealtime, pollQueueStatus]);

    /**
     * Leave the matchmaking queue.
     */
    const leaveQueue = useCallback(async (): Promise<void> => {
        // Clear local state FIRST to stop polling
        store.leaveQueue();

        if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
        }

        matchHandledRef.current = null;
        navigationPendingRef.current = false;
        joinAttemptStartedAtRef.current = 0;

        try {
            const channel = channelRef.current;
            if (channel) {
                await channel.unsubscribe();
                channelRef.current = null;
            }

            if (address) {
                await fetch(`${API_BASE}/api/matchmaking/queue`, {
                    method: "DELETE",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ address }),
                });
            }
        } catch (error) {
            console.error("Error leaving queue:", error);
        }
    }, [address, store]);

    /**
     * Format wait time for display.
     */
    const formatWaitTime = useCallback((seconds: number): string => {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins}:${secs.toString().padStart(2, "0")}`;
    }, []);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (pollIntervalRef.current) {
                clearInterval(pollIntervalRef.current);
            }
            const channel = channelRef.current;
            if (channel) {
                channel.unsubscribe();
            }
        };
    }, []);

    // Leave queue if wallet disconnects
    useEffect(() => {
        if (!isConnected && isInQueue) {
            leaveQueue();
        }
    }, [isConnected, isInQueue, leaveQueue]);

    return {
        isInQueue,
        isJoining: store.queueStatus === "joining",
        isMatching: store.queueStatus === "matching",
        waitTimeSeconds,
        playerCount,
        playersInQueue: store.playersInQueue,
        error: store.error,
        matchResult: store.matchResult,

        joinQueue,
        leaveQueue,
        formatWaitTime,
    };
}

export default useMatchmakingQueue;
