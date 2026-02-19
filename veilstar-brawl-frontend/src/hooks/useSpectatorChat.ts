/**
 * useSpectatorChat Hook
 * Real-time synchronized chat for spectators using Supabase Realtime broadcast
 */

import { useEffect, useRef, useCallback, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { getSupabaseClient } from "../lib/supabase/client";

// =============================================================================
// TYPES
// =============================================================================

export interface ChatMessage {
    id: string;
    username: string;
    message: string;
    timestamp: number;
    isFake?: boolean;
    color?: string;
}

export interface SpectatorChatState {
    messages: ChatMessage[];
    isConnected: boolean;
    error: string | null;
}

export interface UseSpectatorChatOptions {
    matchId: string;
    username?: string;
}

export interface UseSpectatorChatReturn {
    state: SpectatorChatState;
    sendMessage: (message: string) => void;
    addFakeMessage: (message: ChatMessage) => void;
}

// =============================================================================
// HOOK IMPLEMENTATION
// =============================================================================

export function useSpectatorChat(options: UseSpectatorChatOptions): UseSpectatorChatReturn {
    const { matchId, username = "Spectator" } = options;

    const channelRef = useRef<RealtimeChannel | null>(null);
    const [state, setState] = useState<SpectatorChatState>({
        messages: [],
        isConnected: false,
        error: null,
    });

    // Generate unique message ID
    const generateMessageId = useCallback(() => {
        return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    }, []);

    // Handle incoming chat message
    const handleChatMessage = useCallback((payload: ChatMessage) => {
        setState((prev) => {
            // Avoid duplicates
            if (prev.messages.some((m) => m.id === payload.id)) {
                return prev;
            }
            // Keep last 100 messages
            const newMessages = [...prev.messages, payload].slice(-100);
            return { ...prev, messages: newMessages };
        });
    }, []);

    // Add fake message (for fake chat service)
    const addFakeMessage = useCallback((message: ChatMessage) => {
        setState((prev) => {
            const newMessages = [...prev.messages, message].slice(-100);
            return { ...prev, messages: newMessages };
        });
    }, []);

    // Send message
    const sendMessage = useCallback(
        async (message: string) => {
            if (!channelRef.current || !message.trim()) return;

            const chatMessage: ChatMessage = {
                id: generateMessageId(),
                username,
                message: message.trim(),
                timestamp: Date.now(),
                isFake: false,
            };

            try {
                await channelRef.current.send({
                    type: "broadcast",
                    event: "chat_message",
                    payload: chatMessage,
                });

                // Also add to local state immediately for responsiveness
                handleChatMessage(chatMessage);
            } catch (error) {
                console.error("[SpectatorChat] Error sending message:", error);
            }
        },
        [username, generateMessageId, handleChatMessage]
    );

    // Subscribe to chat channel
    useEffect(() => {
        if (!matchId) return;

        const supabase = getSupabaseClient();
        const channelName = `chat:${matchId}`;

        console.log("[SpectatorChat] Subscribing to:", channelName);

        const channel = supabase.channel(channelName);

        channel
            .on("broadcast", { event: "chat_message" }, ({ payload }) => {
                handleChatMessage(payload as ChatMessage);
            })
            .subscribe((status) => {
                console.log("[SpectatorChat] Subscription status:", status);

                if (status === "SUBSCRIBED") {
                    setState((prev) => ({
                        ...prev,
                        isConnected: true,
                        error: null,
                    }));
                } else if (status === "CHANNEL_ERROR") {
                    setState((prev) => ({
                        ...prev,
                        error: "Failed to connect to chat",
                    }));
                } else if (status === "CLOSED") {
                    setState((prev) => ({
                        ...prev,
                        isConnected: false,
                    }));
                }
            });

        channelRef.current = channel;

        return () => {
            console.log("[SpectatorChat] Cleanup: Unsubscribing");
            if (channelRef.current) {
                channelRef.current.unsubscribe();
                channelRef.current = null;
            }
        };
    }, [matchId, handleChatMessage]);

    return {
        state,
        sendMessage,
        addFakeMessage,
    };
}
