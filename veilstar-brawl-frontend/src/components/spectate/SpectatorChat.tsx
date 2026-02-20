/**
 * SpectatorChat Component
 * Premium styled real-time chat for spectators with fake message simulation
 */

import React, { useEffect, useRef, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useSpectatorChat, type ChatMessage } from "../../hooks/useSpectatorChat";
import { createFakeChatGenerator, type BotTurnData } from "../../lib/chat/fake-chat-service";
import { twMerge } from "tailwind-merge";

interface SpectatorChatProps {
    matchId: string;
    matchStartTime?: number; // Unix timestamp, defaults to now
    turns?: BotTurnData[]; // Optional turns data for context awareness
    isBotMatch?: boolean;
    player1Name?: string;
    player2Name?: string;
    className?: string; // Optional custom class
    bettingPhaseEndTime?: number; // When betting closes and match starts
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

    // Get username from localStorage (wallet address truncated)
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

        // Check for new fake messages periodically
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

        // Initial check
        checkForMessages();

        // Poll every second
        const interval = setInterval(checkForMessages, 1000);

        return () => clearInterval(interval);
    }, [matchId, matchStartTime, turns, isBotMatch, player1Name, player2Name, addFakeMessage, bettingPhaseEndTime]);

    // Auto-scroll to bottom on new messages
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
            className={twMerge(
                "flex flex-col rounded-xl overflow-hidden border border-cyber-gold/20 bg-black/60 backdrop-blur-md",
                className
            )}
        >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 bg-gradient-to-r from-orange-500/20 via-cyber-gold/10 to-transparent border-b border-cyber-gold/20">
                <div className="flex items-center gap-2">
                    <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
                    <span className="text-cyber-gold font-orbitron text-sm font-bold tracking-wider">
                        LIVE CHAT
                    </span>
                </div>
                <span className="text-gray-500 text-xs font-mono">
                    {state.messages.length} msgs
                </span>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2 scrollbar-thin scrollbar-thumb-cyber-gold/20 scrollbar-track-transparent min-h-[200px] max-h-[400px]">
                <AnimatePresence initial={false}>
                    {state.messages.map((msg) => (
                        <motion.div
                            key={msg.id}
                            initial={{ opacity: 0, y: 10, scale: 0.95 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.9 }}
                            transition={{ duration: 0.2 }}
                            className={`group text-sm ${msg.isFake ? "opacity-90" : ""}`}
                        >
                            <span
                                className="font-bold mr-1.5"
                                style={{ color: msg.color || "#F0B71F" }}
                            >
                                {msg.username}
                            </span>
                            <span className="text-gray-300">{msg.message}</span>
                        </motion.div>
                    ))}
                </AnimatePresence>
                <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <div className="p-3 border-t border-cyber-gold/20 bg-black/40">
                <div className="flex gap-2">
                    <input
                        type="text"
                        value={inputValue}
                        onChange={(e) => setInputValue(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="Send a message..."
                        maxLength={150}
                        className="flex-1 px-3 py-2 rounded-lg bg-gray-900/80 border border-gray-700 text-white text-sm placeholder-gray-500 focus:outline-none focus:border-cyber-gold/50 focus:ring-1 focus:ring-cyber-gold/30 transition-all"
                    />
                    <button
                        onClick={handleSend}
                        disabled={!inputValue.trim()}
                        className="px-4 py-2 rounded-lg bg-gradient-to-r from-orange-500 to-cyber-gold text-black font-bold text-sm hover:from-orange-400 hover:to-yellow-400 disabled:opacity-50 disabled:cursor-not-allowed transition-all transform hover:scale-105 active:scale-95"
                    >
                        <svg
                            className="w-4 h-4"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
                            />
                        </svg>
                    </button>
                </div>
                {!state.isConnected && (
                    <p className="mt-1 text-xs text-yellow-500/80 flex items-center gap-1">
                        <span className="w-1.5 h-1.5 bg-yellow-500 rounded-full animate-pulse" />
                        Connecting to chat...
                    </p>
                )}
            </div>
        </div>
    );
}
