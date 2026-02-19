/**
 * SpectatorChat Component
 * Real-time chat for spectators with fake message simulation
 */

import React, { useEffect, useRef, useState, useCallback } from "react";
import { useSpectatorChat, type ChatMessage } from "../../hooks/useSpectatorChat";
import { createFakeChatGenerator, type BotTurnData } from "../../lib/chat/fake-chat-service";

interface SpectatorChatProps {
    matchId: string;
    matchStartTime?: number;
    turns?: BotTurnData[];
    isBotMatch?: boolean;
    player1Name?: string;
    player2Name?: string;
    className?: string;
    bettingPhaseEndTime?: number;
}

export function SpectatorChat({
    matchId,
    matchStartTime,
    turns,
    isBotMatch = true,
    player1Name,
    player2Name,
    className = "",
    bettingPhaseEndTime
}: SpectatorChatProps) {
    const [inputValue, setInputValue] = useState("");
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const processedFakeIdsRef = useRef<Set<string>>(new Set());

    // Get username from wallet address
    const getUsername = useCallback(() => {
        try {
            const addr = localStorage.getItem("stellar_address");
            if (addr) {
                return addr.slice(0, 8) + "...";
            }
        } catch {
            // Ignore
        }
        return "Anon_" + Math.random().toString(36).slice(2, 6);
    }, []);

    const { state, sendMessage, addFakeMessage } = useSpectatorChat({
        matchId,
        username: getUsername(),
    });

    // Fake chat simulation
    useEffect(() => {
        const startTime = matchStartTime || Date.now();
        const generator = createFakeChatGenerator({
            matchId,
            matchStartTime: startTime,
            turns: turns || [],
            isBotMatch,
            player1Name,
            player2Name,
            minIntervalMs: 2000,
            maxIntervalMs: 6000,
            bettingPhaseEndTime,
        });

        const checkForMessages = () => {
            const now = Date.now();
            const messages = generator.getMessagesUntil(now);

            for (const msg of messages) {
                if (!processedFakeIdsRef.current.has(msg.id)) {
                    processedFakeIdsRef.current.add(msg.id);
                    addFakeMessage(msg);
                }
            }
        };

        checkForMessages();
        const interval = setInterval(checkForMessages, 1000);
        return () => clearInterval(interval);
    }, [matchId, matchStartTime, turns, isBotMatch, player1Name, player2Name, addFakeMessage, bettingPhaseEndTime]);

    // Auto-scroll
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [state.messages]);

    const handleSend = () => {
        if (inputValue.trim()) {
            sendMessage(inputValue);
            setInputValue("");
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    return (
        <div
            className={`spectator-chat ${className}`}
            style={{
                display: "flex",
                flexDirection: "column",
                borderRadius: "12px",
                overflow: "hidden",
                border: "1px solid rgba(139, 92, 246, 0.2)",
                background: "rgba(0, 0, 0, 0.6)",
                backdropFilter: "blur(12px)",
            }}
        >
            {/* Header */}
            <div
                style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "10px 16px",
                    background: "linear-gradient(to right, rgba(139, 92, 246, 0.2), rgba(59, 130, 246, 0.1), transparent)",
                    borderBottom: "1px solid rgba(139, 92, 246, 0.2)",
                }}
            >
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <div
                        style={{
                            width: "8px",
                            height: "8px",
                            background: "#22c55e",
                            borderRadius: "50%",
                            animation: "pulse 2s infinite",
                        }}
                    />
                    <span
                        style={{
                            color: "#a78bfa",
                            fontFamily: "'Orbitron', sans-serif",
                            fontSize: "12px",
                            fontWeight: 700,
                            letterSpacing: "0.1em",
                        }}
                    >
                        LIVE CHAT
                    </span>
                </div>
                <span style={{ color: "#6b7280", fontSize: "11px", fontFamily: "monospace" }}>
                    {state.messages.length} msgs
                </span>
            </div>

            {/* Messages */}
            <div
                style={{
                    flex: 1,
                    overflowY: "auto",
                    padding: "8px 12px",
                    display: "flex",
                    flexDirection: "column",
                    gap: "6px",
                    minHeight: "200px",
                    maxHeight: "400px",
                }}
            >
                {state.messages.map((msg) => (
                    <div
                        key={msg.id}
                        style={{
                            fontSize: "13px",
                            opacity: msg.isFake ? 0.9 : 1,
                            animation: "fadeIn 0.2s ease-in",
                        }}
                    >
                        <span
                            style={{
                                fontWeight: 700,
                                marginRight: "6px",
                                color: msg.color || "#a78bfa",
                            }}
                        >
                            {msg.username}
                        </span>
                        <span style={{ color: "#d1d5db" }}>{msg.message}</span>
                    </div>
                ))}
                <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <div
                style={{
                    padding: "12px",
                    borderTop: "1px solid rgba(139, 92, 246, 0.2)",
                    background: "rgba(0, 0, 0, 0.4)",
                }}
            >
                <div style={{ display: "flex", gap: "8px" }}>
                    <input
                        type="text"
                        value={inputValue}
                        onChange={(e) => setInputValue(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="Send a message..."
                        maxLength={150}
                        style={{
                            flex: 1,
                            padding: "8px 12px",
                            borderRadius: "8px",
                            background: "rgba(17, 24, 39, 0.8)",
                            border: "1px solid #374151",
                            color: "#fff",
                            fontSize: "13px",
                            outline: "none",
                        }}
                    />
                    <button
                        onClick={handleSend}
                        disabled={!inputValue.trim()}
                        style={{
                            padding: "8px 16px",
                            borderRadius: "8px",
                            background: "linear-gradient(to right, #8b5cf6, #6366f1)",
                            color: "#fff",
                            fontWeight: 700,
                            fontSize: "13px",
                            border: "none",
                            cursor: inputValue.trim() ? "pointer" : "not-allowed",
                            opacity: inputValue.trim() ? 1 : 0.5,
                            transition: "all 0.2s",
                        }}
                    >
                        <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                        </svg>
                    </button>
                </div>
                {!state.isConnected && (
                    <p style={{ marginTop: "4px", fontSize: "11px", color: "rgba(234, 179, 8, 0.8)", display: "flex", alignItems: "center", gap: "4px" }}>
                        <span style={{ width: "6px", height: "6px", background: "#eab308", borderRadius: "50%" }} />
                        Connecting to chat...
                    </p>
                )}
            </div>
        </div>
    );
}
