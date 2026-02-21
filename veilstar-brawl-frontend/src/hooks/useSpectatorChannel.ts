/**
 * useSpectatorChannel Hook
 * Read-only subscription to game:${matchId} channel for spectating
 * Listens to all game events but never sends any
 */

import { useEffect, useRef, useCallback, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { getSupabaseClient } from "../lib/supabase/client";
import { EventBus } from "../game/EventBus";
import type {
    RoundStartingPayload,
    MoveSubmittedPayload,
    MoveConfirmedPayload,
    RoundResolvedPayload,
    MatchEndedPayload,
    MatchStartingPayload,
    CharacterSelectedPayload,
} from "../types/websocket";

// =============================================================================
// TYPES
// =============================================================================

export interface SpectatorChannelState {
    isConnected: boolean;
    isSubscribed: boolean;
    error: string | null;
}

export interface UseSpectatorChannelOptions {
    matchId: string;
    onRoundStarting?: (payload: RoundStartingPayload) => void;
    onMoveSubmitted?: (payload: MoveSubmittedPayload) => void;
    onMoveConfirmed?: (payload: MoveConfirmedPayload) => void;
    onRoundResolved?: (payload: RoundResolvedPayload) => void;
    onMatchEnded?: (payload: MatchEndedPayload) => void;
    onCharacterSelected?: (payload: CharacterSelectedPayload) => void;
    onMatchStarting?: (payload: MatchStartingPayload) => void;
    onMatchCancelled?: (payload: any) => void;
    onError?: (error: string) => void;
}

export interface UseSpectatorChannelReturn {
    state: SpectatorChannelState;
    subscribe: () => Promise<void>;
    unsubscribe: () => void;
}

// =============================================================================
// HOOK IMPLEMENTATION
// =============================================================================

export function useSpectatorChannel(options: UseSpectatorChannelOptions): UseSpectatorChannelReturn {
    const {
        matchId,
        onRoundStarting,
        onMoveSubmitted,
        onMoveConfirmed,
        onRoundResolved,
        onMatchEnded,
        onCharacterSelected,
        onMatchStarting,
        onMatchCancelled,
        onError,
    } = options;

    const channelRef = useRef<RealtimeChannel | null>(null);

    const [state, setState] = useState<SpectatorChannelState>({
        isConnected: false,
        isSubscribed: false,
        error: null,
    });

    // ===========================================================================
    // EVENT HANDLERS (Spectator mode - receive only, no presence tracking)
    // ===========================================================================

    const handleRoundStarting = useCallback(
        (payload: RoundStartingPayload) => {
            console.log("[SpectatorChannel] round_starting:", payload);
            EventBus.emit("game:roundStarting", payload);
            onRoundStarting?.(payload);
        },
        [onRoundStarting]
    );

    const handleMoveSubmitted = useCallback(
        (payload: MoveSubmittedPayload) => {
            console.log("[SpectatorChannel] move_submitted:", payload);
            EventBus.emit("game:moveSubmitted", payload);
            onMoveSubmitted?.(payload);
        },
        [onMoveSubmitted]
    );

    const handleMoveConfirmed = useCallback(
        (payload: MoveConfirmedPayload) => {
            console.log("[SpectatorChannel] move_confirmed:", payload);
            EventBus.emit("game:moveConfirmed", payload);
            onMoveConfirmed?.(payload);
        },
        [onMoveConfirmed]
    );

    const handleRoundResolved = useCallback(
        (payload: RoundResolvedPayload) => {
            console.log("[SpectatorChannel] round_resolved:", payload);
            EventBus.emit("game:roundResolved", payload);
            onRoundResolved?.(payload);
        },
        [onRoundResolved]
    );

    const handleMatchEnded = useCallback(
        (payload: MatchEndedPayload) => {
            console.log("[SpectatorChannel] match_ended:", payload);
            EventBus.emit("game:matchEnded", payload);
            onMatchEnded?.(payload);
        },
        [onMatchEnded]
    );

    const handleCharacterSelected = useCallback(
        (payload: CharacterSelectedPayload) => {
            console.log("[SpectatorChannel] character_selected:", payload);

            // Emit events for both players since spectator watches both
            if (payload.locked && payload.characterId) {
                EventBus.emit("spectator:characterConfirmed", {
                    player: payload.player,
                    characterId: payload.characterId,
                });
            } else {
                EventBus.emit("spectator:characterSelected", {
                    player: payload.player,
                    characterId: payload.characterId,
                });
            }

            EventBus.emit("game:characterSelected", payload);
            onCharacterSelected?.(payload);
        },
        [onCharacterSelected]
    );

    const handleMatchStarting = useCallback(
        (payload: MatchStartingPayload) => {
            console.log("[SpectatorChannel] match_starting:", payload);

            const countdown = Math.max(0, Math.ceil((payload.startsAt - Date.now()) / 1000));
            EventBus.emit("match_starting", {
                countdown,
                startsAt: payload.startsAt,
                player1CharacterId: payload.player1.characterId,
                player2CharacterId: payload.player2.characterId,
            });

            EventBus.emit("game:matchStarting", payload);
            onMatchStarting?.(payload);
        },
        [onMatchStarting]
    );

    const handleMatchCancelled = useCallback(
        (payload: any) => {
            console.log("[SpectatorChannel] match_cancelled:", payload);
            onMatchCancelled?.(payload);
        },
        [onMatchCancelled]
    );

    // ===========================================================================
    // CHANNEL MANAGEMENT
    // ===========================================================================

    const subscribe = useCallback(async () => {
        if (channelRef.current) {
            console.log("[SpectatorChannel] Already subscribed");
            return;
        }

        try {
            const supabase = getSupabaseClient();
            const channelName = `game:${matchId}`;

            console.log("[SpectatorChannel] Subscribing to:", channelName);

            const channel = supabase.channel(channelName);

            // Set up broadcast event listeners (no presence for spectators)
            channel
                .on("broadcast", { event: "round_starting" }, ({ payload }) => {
                    handleRoundStarting(payload as RoundStartingPayload);
                })
                .on("broadcast", { event: "move_submitted" }, ({ payload }) => {
                    handleMoveSubmitted(payload as MoveSubmittedPayload);
                })
                .on("broadcast", { event: "move_confirmed" }, ({ payload }) => {
                    handleMoveConfirmed(payload as MoveConfirmedPayload);
                })
                .on("broadcast", { event: "round_resolved" }, ({ payload }) => {
                    handleRoundResolved(payload as RoundResolvedPayload);
                })
                .on("broadcast", { event: "match_ended" }, ({ payload }) => {
                    handleMatchEnded(payload as MatchEndedPayload);
                })
                .on("broadcast", { event: "character_selected" }, ({ payload }) => {
                    handleCharacterSelected(payload as CharacterSelectedPayload);
                })
                .on("broadcast", { event: "match_starting" }, ({ payload }) => {
                    handleMatchStarting(payload as MatchStartingPayload);
                })
                .on("broadcast", { event: "match_cancelled" }, ({ payload }) => {
                    handleMatchCancelled(payload);
                })
                .on("broadcast", { event: "fight_state_update" }, ({ payload }) => {
                    console.log("[SpectatorChannel] fight_state_update received:", payload);
                    EventBus.emit("game:fightStateUpdate", payload);
                })
                .on("broadcast", { event: "power_surge_selected" }, ({ payload }) => {
                    console.log("[SpectatorChannel] power_surge_selected received:", payload);
                    EventBus.emit("game:powerSurgeSelected", payload);
                })
                .on("broadcast", { event: "power_surge_cards" }, ({ payload }) => {
                    console.log("[SpectatorChannel] power_surge_cards received:", payload);
                    EventBus.emit("game:powerSurgeCards", payload);
                });

            // Subscribe to the channel
            await channel.subscribe((status) => {
                console.log("[SpectatorChannel] Subscription status:", status);

                if (status === "SUBSCRIBED") {
                    setState({
                        isConnected: true,
                        isSubscribed: true,
                        error: null,
                    });
                } else if (status === "CHANNEL_ERROR") {
                    const error = "Failed to connect to game channel";
                    setState((prev) => ({ ...prev, error }));
                    onError?.(error);
                } else if (status === "CLOSED") {
                    setState({
                        isConnected: false,
                        isSubscribed: false,
                        error: null,
                    });
                }
            });

            channelRef.current = channel;
        } catch (error) {
            console.error("[SpectatorChannel] Subscription error:", error);
            const errorMessage =
                error instanceof Error ? error.message : "Unknown error";
            setState((prev) => ({ ...prev, error: errorMessage }));
            onError?.(errorMessage);
        }
    }, [
        matchId,
        handleRoundStarting,
        handleMoveSubmitted,
        handleMoveConfirmed,
        handleRoundResolved,
        handleMatchEnded,
        handleCharacterSelected,
        handleMatchStarting,
        handleMatchCancelled,
        onError,
    ]);

    const unsubscribe = useCallback(() => {
        if (channelRef.current) {
            console.log("[SpectatorChannel] Unsubscribing");
            channelRef.current.unsubscribe();
            channelRef.current = null;

            setState({
                isConnected: false,
                isSubscribed: false,
                error: null,
            });
        }
    }, []);

    // ===========================================================================
    // LIFECYCLE
    // ===========================================================================

    useEffect(() => {
        if (matchId && !channelRef.current) {
            subscribe();
        }

        return () => {
            if (channelRef.current) {
                console.log("[SpectatorChannel] Cleanup: Unsubscribing");
                channelRef.current.unsubscribe();
                channelRef.current = null;
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [matchId]);

    return {
        state,
        subscribe,
        unsubscribe,
    };
}
