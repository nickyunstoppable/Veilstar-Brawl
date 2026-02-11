/**
 * useGameChannel Hook
 * Manages Supabase Realtime subscription for game:{matchId} channel
 * Handles all game events: round_starting, move_submitted, move_confirmed, round_resolved, match_ended
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
    ChatMessagePayload,
    StickerPayload,
    GamePlayerPresence,
    PlayerRole,
} from "../types/websocket";

// =============================================================================
// TYPES
// =============================================================================

export interface GameChannelState {
    isConnected: boolean;
    isSubscribed: boolean;
    players: Map<string, GamePlayerPresence>;
    error: string | null;
}

export interface UseGameChannelOptions {
    matchId: string;
    playerAddress: string;
    playerRole: PlayerRole;
    onRoundStarting?: (payload: RoundStartingPayload) => void;
    onMoveSubmitted?: (payload: MoveSubmittedPayload) => void;
    onMoveConfirmed?: (payload: MoveConfirmedPayload) => void;
    onRoundResolved?: (payload: RoundResolvedPayload) => void;
    onMatchEnded?: (payload: MatchEndedPayload) => void;
    onCharacterSelected?: (payload: CharacterSelectedPayload) => void;
    onMatchStarting?: (payload: MatchStartingPayload) => void;
    onChatMessage?: (payload: ChatMessagePayload) => void;
    onStickerMessage?: (payload: StickerPayload) => void;
    onPlayerJoin?: (presence: GamePlayerPresence) => void;
    onPlayerLeave?: (address: string) => void;
    onError?: (error: string) => void;
}

export interface UseGameChannelReturn {
    state: GameChannelState;
    subscribe: () => Promise<void>;
    unsubscribe: () => void;
    trackPresence: (isReady: boolean) => Promise<void>;
    sendChatMessage: (message: string) => Promise<void>;
    sendSticker: (stickerId: string) => Promise<void>;
}

// =============================================================================
// HOOK IMPLEMENTATION
// =============================================================================

export function useGameChannel(options: UseGameChannelOptions): UseGameChannelReturn {
    const {
        matchId,
        playerAddress,
        playerRole,
        onRoundStarting,
        onMoveSubmitted,
        onMoveConfirmed,
        onRoundResolved,
        onMatchEnded,
        onCharacterSelected,
        onMatchStarting,
        onChatMessage,
        onStickerMessage,
        onPlayerJoin,
        onPlayerLeave,
        onError,
    } = options;

    const channelRef = useRef<RealtimeChannel | null>(null);

    const [state, setState] = useState<GameChannelState>({
        isConnected: false,
        isSubscribed: false,
        players: new Map(),
        error: null,
    });

    // ===========================================================================
    // EVENT HANDLERS
    // ===========================================================================

    const handleRoundStarting = useCallback(
        (payload: RoundStartingPayload) => {
            console.log(`[GameChannel] round_starting - Round ${payload.roundNumber}, Turn ${payload.turnNumber}`);
            EventBus.emit("game:roundStarting", payload);
            onRoundStarting?.(payload);
        },
        [onRoundStarting]
    );

    const handleMoveSubmitted = useCallback(
        (payload: MoveSubmittedPayload) => {
            console.log("[GameChannel] move_submitted:", payload);
            EventBus.emit("game:moveSubmitted", payload);
            onMoveSubmitted?.(payload);
        },
        [onMoveSubmitted]
    );

    const handleMoveConfirmed = useCallback(
        (payload: MoveConfirmedPayload) => {
            console.log("[GameChannel] move_confirmed:", payload);
            EventBus.emit("game:moveConfirmed", payload);
            onMoveConfirmed?.(payload);
        },
        [onMoveConfirmed]
    );

    const handleRoundResolved = useCallback(
        (payload: RoundResolvedPayload) => {
            console.log(`[GameChannel] round_resolved - isRoundOver: ${payload.isRoundOver}, isMatchOver: ${payload.isMatchOver}`);
            EventBus.emit("game:roundResolved", payload);
            onRoundResolved?.(payload);
        },
        [onRoundResolved]
    );

    const handleMatchEnded = useCallback(
        (payload: MatchEndedPayload) => {
            console.log("[GameChannel] match_ended:", payload);
            EventBus.emit("game:matchEnded", payload);
            onMatchEnded?.(payload);
        },
        [onMatchEnded]
    );

    const handleCharacterSelected = useCallback(
        (payload: CharacterSelectedPayload) => {
            console.log("[GameChannel] character_selected:", payload);

            // Only process opponent's selection
            if (payload.player === playerRole) return;

            if (payload.locked && payload.characterId) {
                EventBus.emit("opponent_character_confirmed", { characterId: payload.characterId });
            } else {
                EventBus.emit("opponent_character_selected", { characterId: payload.characterId });
            }

            EventBus.emit("game:characterSelected", payload);
            onCharacterSelected?.(payload);
        },
        [playerRole, onCharacterSelected]
    );

    const handleMatchStarting = useCallback(
        (payload: MatchStartingPayload) => {
            console.log("[GameChannel] match_starting:", payload);

            const countdown = Math.max(1, Math.ceil((payload.startsAt - Date.now()) / 1000));
            EventBus.emit("match_starting", {
                countdown,
                player1CharacterId: payload.player1.characterId,
                player2CharacterId: payload.player2.characterId,
            });

            EventBus.emit("game:matchStarting", payload);
            onMatchStarting?.(payload);
        },
        [onMatchStarting]
    );

    const handleMoveRejected = useCallback(
        (payload: { player: PlayerRole; rejectedAt: number }) => {
            console.log("[GameChannel] move_rejected:", payload);
            EventBus.emit("game:moveRejected", payload);
        },
        []
    );

    const handleMatchCancelled = useCallback(
        (payload: { matchId: string; reason: string; message: string; redirectTo: string }) => {
            console.log("[GameChannel] match_cancelled:", payload);
            EventBus.emit("game:matchCancelled", payload);
            setTimeout(() => {
                window.location.href = payload.redirectTo;
            }, 2000);
        },
        []
    );

    const handlePlayerDisconnected = useCallback(
        (payload: { player: PlayerRole; address: string; disconnectedAt: number; timeoutSeconds: number }) => {
            console.log("[GameChannel] player_disconnected:", payload);
            EventBus.emit("game:playerDisconnected", payload);
        },
        []
    );

    const handlePlayerReconnected = useCallback(
        (payload: { player: PlayerRole; address: string; reconnectedAt: number }) => {
            console.log("[GameChannel] player_reconnected:", payload);
            EventBus.emit("game:playerReconnected", payload);
        },
        []
    );

    const handleChatMessage = useCallback(
        (payload: ChatMessagePayload) => {
            console.log("[GameChannel] chat_message:", payload);
            EventBus.emit("game:chatMessage", payload);
            onChatMessage?.(payload);
        },
        [onChatMessage]
    );

    const handleStickerMessage = useCallback(
        (payload: StickerPayload) => {
            console.log("[GameChannel] sticker_displayed:", payload);
            EventBus.emit("game:stickerMessage", payload);
            onStickerMessage?.(payload);
        },
        [onStickerMessage]
    );

    // ===========================================================================
    // PRESENCE HANDLERS
    // ===========================================================================

    const handlePresenceSync = useCallback(() => {
        const channel = channelRef.current;
        if (!channel) return;

        const presenceState = channel.presenceState<GamePlayerPresence>();
        const newPlayers = new Map<string, GamePlayerPresence>();

        for (const [, presences] of Object.entries(presenceState)) {
            for (const presence of presences) {
                newPlayers.set(presence.address, presence);
            }
        }

        setState((prev) => {
            if (prev.players.size === newPlayers.size) {
                let isSame = true;
                for (const [address, presence] of newPlayers) {
                    const prevPresence = prev.players.get(address);
                    if (
                        !prevPresence ||
                        prevPresence.role !== presence.role ||
                        prevPresence.isReady !== presence.isReady
                    ) {
                        isSame = false;
                        break;
                    }
                }
                if (isSame) return prev;
            }
            return { ...prev, players: newPlayers };
        });
    }, []);

    const handlePresenceJoin = useCallback(
        (
            _key: string,
            _currentPresences: GamePlayerPresence[],
            newPresences: GamePlayerPresence[]
        ) => {
            for (const presence of newPresences) {
                console.log("[GameChannel] Player joined:", presence.address);
                setState((prev) => {
                    const players = new Map(prev.players);
                    players.set(presence.address, presence);
                    return { ...prev, players };
                });
                onPlayerJoin?.(presence);
            }
        },
        [onPlayerJoin]
    );

    const handlePresenceLeave = useCallback(
        (
            _key: string,
            _currentPresences: GamePlayerPresence[],
            leftPresences: GamePlayerPresence[]
        ) => {
            for (const presence of leftPresences) {
                console.log("[GameChannel] Player left:", presence.address);
                setState((prev) => {
                    const players = new Map(prev.players);
                    players.delete(presence.address);
                    return { ...prev, players };
                });
                onPlayerLeave?.(presence.address);
            }
        },
        [onPlayerLeave]
    );

    // ===========================================================================
    // CHANNEL MANAGEMENT
    // ===========================================================================

    const subscribe = useCallback(async () => {
        if (channelRef.current) {
            console.log("[GameChannel] Already subscribed");
            return;
        }

        try {
            const supabase = getSupabaseClient();
            const channelName = `game:${matchId}`;

            console.log("[GameChannel] Subscribing to:", channelName);

            const channel = supabase.channel(channelName, {
                config: {
                    presence: { key: playerAddress },
                    broadcast: { self: true },
                },
            });

            // Set up broadcast event listeners
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
                .on("broadcast", { event: "move_rejected" }, ({ payload }) => {
                    handleMoveRejected(payload as { player: PlayerRole; rejectedAt: number });
                })
                .on("broadcast", { event: "match_cancelled" }, ({ payload }) => {
                    handleMatchCancelled(payload as { matchId: string; reason: string; message: string; redirectTo: string });
                })
                .on("broadcast", { event: "player_disconnected" }, ({ payload }) => {
                    handlePlayerDisconnected(payload as { player: PlayerRole; address: string; disconnectedAt: number; timeoutSeconds: number });
                })
                .on("broadcast", { event: "player_reconnected" }, ({ payload }) => {
                    handlePlayerReconnected(payload as { player: PlayerRole; address: string; reconnectedAt: number });
                })
                .on("broadcast", { event: "chat_message" }, ({ payload }) => {
                    handleChatMessage(payload as ChatMessagePayload);
                })
                .on("broadcast", { event: "sticker_displayed" }, ({ payload }) => {
                    handleStickerMessage(payload as StickerPayload);
                })
                .on("broadcast", { event: "fight_state_update" }, ({ payload }) => {
                    console.log("[GameChannel] fight_state_update received:", payload);
                    EventBus.emit("game:fightStateUpdate", payload);
                })
                .on("broadcast", { event: "power_surge_selected" }, ({ payload }) => {
                    console.log("[GameChannel] power_surge_selected received:", payload);
                    EventBus.emit("game:powerSurgeSelected", payload);
                })
                .on("broadcast", { event: "power_surge_cards" }, ({ payload }) => {
                    console.log("[GameChannel] power_surge_cards received:", payload);
                    EventBus.emit("game:powerSurgeCards", payload);
                });

            // Set up presence listeners
            channel
                .on("presence", { event: "sync" }, handlePresenceSync)
                .on("presence", { event: "join" }, ({ key, currentPresences, newPresences }) => {
                    handlePresenceJoin(
                        key,
                        currentPresences as unknown as GamePlayerPresence[],
                        newPresences as unknown as GamePlayerPresence[]
                    );
                })
                .on("presence", { event: "leave" }, ({ key, currentPresences, leftPresences }) => {
                    handlePresenceLeave(
                        key,
                        currentPresences as unknown as GamePlayerPresence[],
                        leftPresences as unknown as GamePlayerPresence[]
                    );
                });

            // Subscribe to the channel
            await channel.subscribe((status) => {
                console.log("[GameChannel] Subscription status:", status);

                if (status === "SUBSCRIBED") {
                    setState((prev) => ({
                        ...prev,
                        isConnected: true,
                        isSubscribed: true,
                        error: null,
                    }));

                    channel.track({
                        address: playerAddress,
                        role: playerRole,
                        isReady: false,
                    });
                } else if (status === "CHANNEL_ERROR") {
                    const error = "Failed to connect to game channel";
                    setState((prev) => ({ ...prev, error }));
                    onError?.(error);
                } else if (status === "CLOSED") {
                    setState((prev) => ({
                        ...prev,
                        isConnected: false,
                        isSubscribed: false,
                    }));
                }
            });

            channelRef.current = channel;
        } catch (error) {
            console.error("[GameChannel] Subscription error:", error);
            const errorMessage =
                error instanceof Error ? error.message : "Unknown error";
            setState((prev) => ({ ...prev, error: errorMessage }));
            onError?.(errorMessage);
        }
    }, [
        matchId,
        playerAddress,
        playerRole,
        handleRoundStarting,
        handleMoveSubmitted,
        handleMoveConfirmed,
        handleRoundResolved,
        handleMatchEnded,
        handleCharacterSelected,
        handleMatchStarting,
        handleMoveRejected,
        handleMatchCancelled,
        handlePlayerDisconnected,
        handlePlayerReconnected,
        handleChatMessage,
        handleStickerMessage,
        handlePresenceSync,
        handlePresenceJoin,
        handlePresenceLeave,
        onError,
    ]);

    const unsubscribe = useCallback(() => {
        if (channelRef.current) {
            console.log("[GameChannel] Unsubscribing");
            channelRef.current.unsubscribe();
            channelRef.current = null;

            setState({
                isConnected: false,
                isSubscribed: false,
                players: new Map(),
                error: null,
            });
        }
    }, []);

    const trackPresence = useCallback(
        async (isReady: boolean) => {
            if (channelRef.current) {
                await channelRef.current.track({
                    address: playerAddress,
                    role: playerRole,
                    isReady,
                });
            }
        },
        [playerAddress, playerRole]
    );

    const sendChatMessage = useCallback(
        async (message: string) => {
            if (!channelRef.current) return;

            const payload: ChatMessagePayload = {
                sender: playerRole,
                senderAddress: playerAddress,
                message,
                timestamp: Date.now(),
            };

            try {
                await channelRef.current.send({
                    type: "broadcast",
                    event: "chat_message",
                    payload,
                });
            } catch (error) {
                console.error("[GameChannel] Failed to send chat message:", error);
            }
        },
        [playerRole, playerAddress]
    );

    const sendSticker = useCallback(
        async (stickerId: string) => {
            if (!channelRef.current) return;

            const payload: StickerPayload = {
                sender: playerRole,
                senderAddress: playerAddress,
                stickerId,
                timestamp: Date.now(),
            };

            try {
                await channelRef.current.send({
                    type: "broadcast",
                    event: "sticker_displayed",
                    payload,
                });
            } catch (error) {
                console.error("[GameChannel] Failed to send sticker:", error);
            }
        },
        [playerRole, playerAddress]
    );

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (channelRef.current) {
                channelRef.current.unsubscribe();
                channelRef.current = null;
            }
        };
    }, []);

    return {
        state,
        subscribe,
        unsubscribe,
        trackPresence,
        sendChatMessage,
        sendSticker,
    };
}

export default useGameChannel;
