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

// Channel is per-player: matchmaking:${address} — matches server broadcast pattern
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

            // Stop polling immediately
            if (pollIntervalRef.current) {
                clearInterval(pollIntervalRef.current);
                pollIntervalRef.current = null;
            }

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
            } catch (error) {
                console.warn("Match verification error:", error);
                matchHandledRef.current = null;
                navigationPendingRef.current = false;
                return;
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
                const data: QueueStatusResponse = await response.json();

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

            const playerChannel = `matchmaking:${address}`;
            const channel = supabase
                .channel(playerChannel)
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
            store.joinQueue();

            const response = await fetch(`${API_BASE}/api/matchmaking/queue`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ address }),
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error?.message || "Failed to join queue");
            }

            const result = await response.json();

            // Check if immediately matched
            if (result.matchFound) {
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
