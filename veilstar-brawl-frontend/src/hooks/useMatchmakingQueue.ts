/**
 * useMatchmakingQueue Hook
 * React hook for matchmaking queue with polling fallback
 * Uses API polling for reliability, with optional Realtime for live updates
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { getSupabaseClient } from "@/lib/supabase/client";
import {
    useMatchmakingStore,
    selectIsInQueue,
    selectQueueWaitTime,
    selectPlayerCount,
    type QueuedPlayer,
    type MatchmakingResult,
} from "@/stores/matchmaking-store";
import { useWallet } from "./useWallet";

interface MatchFoundEvent {
    matchId: string;
    player1Address: string;
    player2Address: string;
    selectionDeadlineAt?: string;
}

interface QueueStatusResponse {
    inQueue: boolean;
    queueSize: number;
    matchPending?: boolean;
    matchFound?: MatchFoundEvent;
}

export interface UseMatchmakingQueueReturn {
    isInQueue: boolean;
    isJoining: boolean;
    isMatching: boolean;
    waitTimeSeconds: number;
    playerCount: number;
    playersInQueue: QueuedPlayer[];
    error: string | null;
    matchResult: MatchmakingResult | null;

    joinQueue: () => Promise<void>;
    leaveQueue: () => Promise<void>;

    formatWaitTime: (seconds: number) => string;
}

const QUEUE_CHANNEL = "matchmaking:queue";
const POLL_INTERVAL = 1000;
const API_BASE = import.meta.env.VITE_API_BASE_URL || "";

export function useMatchmakingQueue(): UseMatchmakingQueueReturn {
    const { publicKey: address, isConnected } = useWallet();
    const store = useMatchmakingStore();
    const channelRef = useRef<RealtimeChannel | null>(null);
    const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const [waitTimeSeconds, setWaitTimeSeconds] = useState(0);

    const matchHandledRef = useRef<string | null>(null);
    const navigationPendingRef = useRef(false);
    const isInQueueRef = useRef(false);

    const isInQueue = useMatchmakingStore(selectIsInQueue);
    const playerCount = useMatchmakingStore(selectPlayerCount);

    useEffect(() => {
        isInQueueRef.current = isInQueue;
    }, [isInQueue]);

    useEffect(() => {
        if (!isInQueue || !store.queuedAt) {
            setWaitTimeSeconds(0);
            return;
        }

        const interval = setInterval(() => {
            setWaitTimeSeconds(selectQueueWaitTime(store));
        }, 1000);

        return () => clearInterval(interval);
    }, [isInQueue, store.queuedAt, store]);

    const handleMatchFound = useCallback(async (matchData: MatchFoundEvent) => {
        const { matchId, player1Address, player2Address, selectionDeadlineAt } = matchData;

        if (!address || (player1Address !== address && player2Address !== address)) {
            return;
        }

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

        if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
        }

        try {
            const verifyResponse = await fetch(`${API_BASE}/api/matches/${matchId}/verify`);
            if (!verifyResponse.ok) {
                console.warn("Match verification failed, will retry on next poll");
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

        store.setMatched({
            matchId,
            player1Address,
            player2Address,
            createdAt: new Date(),
            selectionDeadlineAt,
        });
    }, [address, store]);

    const pollQueueStatus = useCallback(async () => {
        if (navigationPendingRef.current) {
            console.log("Skipping poll - navigation pending");
            return;
        }

        if (!address) return;

        if (!isInQueueRef.current) {
            console.log("Skipping poll - not in queue");
            return;
        }

        try {
            const response = await fetch(`${API_BASE}/api/matchmaking/queue?address=${encodeURIComponent(address)}`);

            if (response.ok) {
                const data: QueueStatusResponse = await response.json();

                if (!navigationPendingRef.current) {
                    store.setPlayersInQueue(
                        Array(data.queueSize).fill(null).map((_, i) => ({
                            address: `player-${i}`,
                            displayName: null,
                            rating: 1000,
                            joinedAt: Date.now(),
                        }))
                    );
                }

                if (data.matchPending && !navigationPendingRef.current) {
                    console.log("Match pending - showing matching state");
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

    const setupRealtime = useCallback(() => {
        if (!address) return;

        try {
            const supabase = getSupabaseClient();

            const channel = supabase.channel(QUEUE_CHANNEL)
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

            store.setQueued(Date.now());

            setupRealtime();

            pollIntervalRef.current = setInterval(pollQueueStatus, POLL_INTERVAL);

            pollQueueStatus();
        } catch (error) {
            const message = error instanceof Error ? error.message : "Failed to join queue";
            store.setQueueError(message);
        }
    }, [address, isConnected, store, setupRealtime, pollQueueStatus]);

    const leaveQueue = useCallback(async (): Promise<void> => {
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

    const formatWaitTime = useCallback((seconds: number): string => {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins}:${secs.toString().padStart(2, "0")}`;
    }, []);

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