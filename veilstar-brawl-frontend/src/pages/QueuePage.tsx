/**
 * QueuePage — Fullscreen matchmaking queue
 * Auto-joins queue on mount, shows immersive HUD while searching,
 * navigates to /match/:matchId when match found.
 * Falls back to bot match after 30 seconds.
 */

import React, { useEffect, useState, useCallback } from "react";
import MatchmakingHUD from "@/components/matchmaking/MatchmakingHUD";
import { useMatchmakingQueue } from "@/hooks/useMatchmakingQueue";
import { useWallet } from "@/hooks/useWallet";

const BOT_MATCH_TIMEOUT_SECONDS = 30;

function navigateTo(path: string) {
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
}

export default function QueuePage() {
    const { publicKey, isConnected } = useWallet();
    const {
        isInQueue,
        isJoining,
        isMatching,
        waitTimeSeconds,
        playerCount,
        error,
        matchResult,
        joinQueue,
        leaveQueue,
    } = useMatchmakingQueue();

    const [hasStarted, setHasStarted] = useState(false);
    const [isCreatingBotMatch, setIsCreatingBotMatch] = useState(false);

    // Auto-join queue on mount if wallet connected
    useEffect(() => {
        if (isConnected && !isInQueue && !hasStarted && !isJoining) {
            setHasStarted(true);
            joinQueue();
        }
    }, [isConnected, isInQueue, hasStarted, isJoining, joinQueue]);

    // Navigate to match when matched with real player
    useEffect(() => {
        if (matchResult) {
            navigateTo(`/match/${matchResult.matchId}`);
        }
    }, [matchResult]);

    // After 30s in queue, create bot match as fallback
    useEffect(() => {
        if (
            isInQueue &&
            waitTimeSeconds >= BOT_MATCH_TIMEOUT_SECONDS &&
            !isCreatingBotMatch
        ) {
            setIsCreatingBotMatch(true);

            const apiBase =
                import.meta.env.VITE_API_BASE_URL || "";

            const createBotMatch = async () => {
                try {
                    const botAddress = "GBOT" + publicKey!.slice(4);
                    const response = await fetch(
                        `${apiBase}/api/matchmaking/create-bot-match`,
                        {
                            method: "POST",
                            headers: {
                                "Content-Type": "application/json",
                            },
                            body: JSON.stringify({
                                player1Address: publicKey,
                                player2Address: botAddress,
                                player2Name: "Arena Bot",
                            }),
                        }
                    );

                    if (response.ok) {
                        const { matchId } = await response.json();
                        await leaveQueue();
                        navigateTo(`/match/${matchId}`);
                    } else {
                        console.error("Failed to create bot match");
                        setIsCreatingBotMatch(false);
                    }
                } catch (err) {
                    console.error("Error creating bot match:", err);
                    setIsCreatingBotMatch(false);
                }
            };

            createBotMatch();
        }
    }, [
        isInQueue,
        waitTimeSeconds,
        isCreatingBotMatch,
        publicKey,
        leaveQueue,
    ]);

    // Wallet not connected
    if (!isConnected) {
        return (
            <div className="fixed inset-0 bg-black flex items-center justify-center z-50">
                <div className="text-center bg-black/40 border border-cyber-orange/30 rounded-[20px] p-10 max-w-md">
                    <h2 className="text-2xl font-bold text-white font-orbitron mb-4">
                        WALLET REQUIRED
                    </h2>
                    <p className="text-cyber-gray text-sm mb-6">
                        Connect your Stellar wallet to search for opponents.
                    </p>
                    <button
                        onClick={() => navigateTo("/play")}
                        className="w-full bg-transparent border border-cyber-orange text-cyber-orange font-orbitron hover:bg-cyber-orange/10 py-3 rounded-xl text-sm"
                    >
                        BACK TO ARENA
                    </button>
                </div>
            </div>
        );
    }

    // Error state
    if (error) {
        return (
            <div className="fixed inset-0 bg-black flex items-center justify-center z-50">
                <div className="text-center bg-black/40 border border-red-500/30 rounded-[20px] p-10 max-w-md">
                    <h2 className="text-2xl font-bold text-red-500 font-orbitron mb-4">
                        ERROR
                    </h2>
                    <p className="text-cyber-gray text-sm mb-6">{error}</p>
                    <div className="flex gap-4">
                        <button
                            onClick={() => {
                                setHasStarted(false);
                                joinQueue();
                            }}
                            className="flex-1 bg-gradient-cyber text-white border-0 font-orbitron hover:opacity-90 py-3 rounded-xl text-sm"
                        >
                            TRY AGAIN
                        </button>
                        <button
                            onClick={() => navigateTo("/play")}
                            className="flex-1 bg-transparent border border-white/10 text-cyber-gray font-orbitron hover:bg-white/5 py-3 rounded-xl text-sm"
                        >
                            BACK
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    // Matching state — opponent found animation
    if (isMatching) {
        return (
            <div className="fixed inset-0 bg-black flex flex-col items-center justify-center z-50">
                <div className="relative w-64 h-64 mb-12 flex items-center justify-center">
                    <div className="absolute w-full h-full rounded-full border-4 border-emerald-500 animate-ping" />
                    <div className="absolute w-32 h-32 rounded-full bg-emerald-500/20 flex items-center justify-center">
                        <svg
                            className="w-16 h-16 text-emerald-500"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M5 13l4 4L19 7"
                            />
                        </svg>
                    </div>
                </div>
                <h2 className="text-2xl font-bold font-orbitron text-emerald-500 mb-2">
                    OPPONENT FOUND!
                </h2>
                <p className="text-cyber-gray font-montserrat">
                    Preparing match...
                </p>
            </div>
        );
    }

    // Default: immersive search HUD
    return (
        <div className="fixed inset-0 z-50">
            <MatchmakingHUD
                waitTimeSeconds={waitTimeSeconds}
                playerCount={playerCount}
                onCancel={async () => {
                    await leaveQueue();
                    navigateTo("/play");
                }}
            />
        </div>
    );
}
