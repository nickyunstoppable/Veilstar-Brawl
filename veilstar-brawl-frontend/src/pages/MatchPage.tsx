/**
 * MatchPage - Online ranked match flow
 * States: character_select → queuing → matched → fighting → results
 */

import React, { useState, useCallback, useEffect, lazy, Suspense } from "react";
import GameLayout from "@/components/layout/GameLayout";
import { useWallet } from "@/hooks/useWallet";
import { EventBus } from "@/game/EventBus";
import { getCharacter } from "@/data/characters";

// Lazy load the game client for code splitting
const FightGameClient = lazy(() =>
    import("@/components/fight/FightGameClient").then((mod) => ({
        default: mod.FightGameClient,
    }))
);

// Characters available for ranked play
const RANKED_CHARACTERS = [
    "dag-warrior",
    "hash-striker",
    "block-phantom",
    "tx-monk",
    "mempool-specter",
    "utxo-samurai",
] as const;

type MatchState = "character_select" | "queuing" | "matched" | "fighting" | "results";

interface MatchConfig {
    characterId: string;
    matchId: string;
    player1Address: string;
    player2Address: string;
    player1Character: string;
    player2Character: string;
    playerRole: "player1" | "player2";
}

interface MatchResult {
    isWinner: boolean;
    ratingChanges?: {
        winner: { before: number; after: number; change: number };
        loser: { before: number; after: number; change: number };
    };
    onChainSessionId?: number;
    onChainTxHash?: string;
    contractId?: string;
}

export default function MatchPage() {
    const { publicKey, isConnected } = useWallet();
    const [matchState, setMatchState] = useState<MatchState>("character_select");
    const [selectedCharacter, setSelectedCharacter] = useState<string | null>(null);
    const [matchConfig, setMatchConfig] = useState<MatchConfig | null>(null);
    const [matchResult, setMatchResult] = useState<MatchResult | null>(null);
    const [queueTime, setQueueTime] = useState(0);
    const [queueError, setQueueError] = useState<string | null>(null);

    // Queue timer
    useEffect(() => {
        let timer: ReturnType<typeof setInterval>;
        if (matchState === "queuing") {
            timer = setInterval(() => {
                setQueueTime((prev) => prev + 1);
            }, 1000);
        }
        return () => clearInterval(timer);
    }, [matchState]);

    // Wallet requirement check
    if (!isConnected || !publicKey) {
        return (
            <GameLayout>
                <div className="min-h-screen flex items-center justify-center">
                    <div className="text-center bg-black/40 border border-cyber-orange/30 rounded-[20px] p-10 max-w-md">
                        <h2 className="text-2xl font-bold text-white font-orbitron mb-4">
                            WALLET REQUIRED
                        </h2>
                        <p className="text-cyber-gray text-sm mb-6">
                            Connect your Stellar wallet to enter ranked matches.
                            Your wallet is used to sign moves for verification.
                        </p>
                        <a href="/play">
                            <button className="w-full bg-transparent border border-cyber-orange text-cyber-orange font-orbitron hover:bg-cyber-orange/10 py-3 rounded-xl text-sm">
                                BACK TO ARENA
                            </button>
                        </a>
                    </div>
                </div>
            </GameLayout>
        );
    }

    // Character selection handler
    const handleSelectCharacter = useCallback((charId: string) => {
        setSelectedCharacter(charId);
    }, []);

    // Queue start handler
    const handleJoinQueue = useCallback(async () => {
        if (!selectedCharacter || !publicKey) return;

        setMatchState("queuing");
        setQueueTime(0);
        setQueueError(null);

        try {
            const apiBase = import.meta.env.VITE_API_BASE_URL || window.location.origin;
            const response = await fetch(`${apiBase}/api/matchmaking/queue`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    playerAddress: publicKey,
                    characterId: selectedCharacter,
                    mode: "ranked",
                }),
            });

            if (!response.ok) {
                throw new Error(`Queue failed: ${response.status}`);
            }

            const data = await response.json();
            console.log("[MatchPage] Queued:", data);

            // Poll for match or listen via EventBus
            // For now, simulate a match being found after a delay (TODO: replace with real matchmaking)
            if (data.matchId) {
                // Immediate match found
                handleMatchFound(data);
            }
            // Otherwise, wait for EventBus event from useMatchmakingQueue
        } catch (err) {
            console.error("[MatchPage] Queue error:", err);
            setQueueError(err instanceof Error ? err.message : "Failed to join queue");
            setMatchState("character_select");
        }
    }, [selectedCharacter, publicKey]);

    // Match found handler
    const handleMatchFound = useCallback((data: any) => {
        setMatchConfig({
            characterId: selectedCharacter!,
            matchId: data.matchId,
            player1Address: data.player1Address || publicKey!,
            player2Address: data.player2Address || "opponent",
            player1Character: data.player1Character || selectedCharacter!,
            player2Character: data.player2Character || "dag-warrior",
            playerRole: data.playerRole || "player1",
        });
        setMatchState("fighting");
    }, [selectedCharacter, publicKey]);

    // Listen for matchmaking events
    useEffect(() => {
        const onMatchFound = (data: unknown) => {
            handleMatchFound(data);
        };

        EventBus.on("matchmaking:matchFound", onMatchFound);
        return () => {
            EventBus.off("matchmaking:matchFound", onMatchFound);
        };
    }, [handleMatchFound]);

    // Cancel queue
    const handleCancelQueue = useCallback(() => {
        setMatchState("character_select");
        setQueueTime(0);
        // TODO: Send cancel request to server
    }, []);

    // Match end handler
    const handleMatchEnd = useCallback((result: MatchResult) => {
        setMatchResult(result);
        setMatchState("results");
    }, []);

    // Exit handler
    const handleExit = useCallback(() => {
        window.history.pushState({}, "", "/play");
        window.dispatchEvent(new PopStateEvent("popstate"));
    }, []);

    // =========================================================================
    // RENDER: FIGHTING
    // =========================================================================
    if (matchState === "fighting" && matchConfig) {
        return (
            <div className="fixed inset-0 z-50 bg-black overflow-hidden">
                <Suspense
                    fallback={
                        <div className="w-full h-full bg-black/50 flex items-center justify-center">
                            <div className="text-center">
                                <div className="w-12 h-12 border-4 border-cyber-gold border-t-transparent rounded-full animate-spin mx-auto mb-4" />
                                <p className="text-cyber-gold font-orbitron tracking-widest uppercase text-sm">Loading Game Engine...</p>
                            </div>
                        </div>
                    }
                >
                    <FightGameClient
                        matchId={matchConfig.matchId}
                        player1Address={matchConfig.player1Address}
                        player2Address={matchConfig.player2Address}
                        player1Character={matchConfig.player1Character}
                        player2Character={matchConfig.player2Character}
                        playerRole={matchConfig.playerRole}
                        matchFormat="best_of_3"
                        onMatchEnd={handleMatchEnd}
                        onExit={handleExit}
                    />
                </Suspense>
            </div>
        );
    }

    // =========================================================================
    // RENDER: RESULTS
    // =========================================================================
    if (matchState === "results" && matchResult) {
        return (
            <GameLayout>
                <div className="min-h-screen flex items-center justify-center">
                    <div className="text-center max-w-md">
                        <h1 className={`text-6xl font-bold font-orbitron mb-6 ${matchResult.isWinner ? "text-emerald-400" : "text-red-400"}`}>
                            {matchResult.isWinner ? "VICTORY" : "DEFEAT"}
                        </h1>

                        {matchResult.ratingChanges && (
                            <div className="bg-black/40 border border-white/10 rounded-[20px] p-6 mb-8">
                                <p className="text-cyber-gray text-sm font-orbitron mb-2">RATING CHANGE</p>
                                <p className={`text-3xl font-bold font-orbitron ${matchResult.isWinner ? "text-emerald-400" : "text-red-400"}`}>
                                    {matchResult.isWinner
                                        ? `+${matchResult.ratingChanges.winner.change}`
                                        : `${matchResult.ratingChanges.loser.change}`
                                    }
                                </p>
                            </div>
                        )}

                        {matchResult.onChainSessionId && (
                            <div className="bg-black/40 border border-emerald-500/20 rounded-[20px] p-4 mb-6">
                                <p className="text-emerald-400 text-xs font-orbitron mb-1">
                                    ⛓ ON-CHAIN VERIFIED
                                </p>
                                <p className="text-cyber-gray text-xs font-mono">
                                    Session #{matchResult.onChainSessionId}
                                </p>
                                {matchResult.onChainTxHash && (
                                    <p className="text-cyber-gray/60 text-xs font-mono mt-1 truncate">
                                        TX: {matchResult.onChainTxHash}
                                    </p>
                                )}
                                {matchResult.contractId && (
                                    <p className="text-cyber-gray/40 text-xs font-mono mt-1 truncate">
                                        Contract: {matchResult.contractId}
                                    </p>
                                )}
                            </div>
                        )}

                        <div className="flex gap-4">
                            <button
                                onClick={() => {
                                    setMatchState("character_select");
                                    setMatchResult(null);
                                    setMatchConfig(null);
                                }}
                                className="flex-1 bg-gradient-cyber text-white border-0 font-orbitron hover:opacity-90 py-3 rounded-xl text-sm"
                            >
                                PLAY AGAIN
                            </button>
                            <button
                                onClick={handleExit}
                                className="flex-1 bg-transparent border border-white/10 text-cyber-gray font-orbitron hover:bg-white/5 py-3 rounded-xl text-sm"
                            >
                                EXIT
                            </button>
                        </div>
                    </div>
                </div>
            </GameLayout>
        );
    }

    // =========================================================================
    // RENDER: QUEUING
    // =========================================================================
    if (matchState === "queuing") {
        const minutes = Math.floor(queueTime / 60);
        const seconds = queueTime % 60;

        return (
            <GameLayout>
                <div className="min-h-screen flex items-center justify-center">
                    <div className="text-center max-w-md">
                        {/* Pulsing search animation */}
                        <div className="relative w-32 h-32 mx-auto mb-8">
                            <div className="absolute inset-0 rounded-full border-2 border-cyber-gold/30 animate-ping" />
                            <div className="absolute inset-2 rounded-full border-2 border-cyber-gold/50 animate-pulse" />
                            <div className="absolute inset-4 rounded-full bg-cyber-gold/10 flex items-center justify-center">
                                <svg className="w-12 h-12 text-cyber-gold animate-spin" style={{ animationDuration: "3s" }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                                </svg>
                            </div>
                        </div>

                        <h2 className="text-3xl font-bold text-white font-orbitron mb-2">
                            SEARCHING
                        </h2>
                        <p className="text-cyber-gray text-sm font-montserrat mb-6">
                            Finding a worthy opponent...
                        </p>

                        {/* Timer */}
                        <div className="bg-black/40 border border-cyber-gold/20 rounded-xl px-6 py-3 inline-block mb-8">
                            <span className="text-cyber-gold font-mono text-2xl tracking-widest">
                                {String(minutes).padStart(2, "0")}:{String(seconds).padStart(2, "0")}
                            </span>
                        </div>

                        {/* Selected character preview */}
                        {selectedCharacter && (
                            <div className="mb-8">
                                <p className="text-cyber-gray text-xs font-orbitron mb-2">FIGHTER</p>
                                <p className="text-white font-orbitron text-lg">
                                    {getCharacter(selectedCharacter)?.name || selectedCharacter}
                                </p>
                            </div>
                        )}

                        {queueError && (
                            <div className="bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 mb-4">
                                <p className="text-red-400 text-sm">{queueError}</p>
                            </div>
                        )}

                        <button
                            onClick={handleCancelQueue}
                            className="bg-transparent border border-red-500/50 text-red-400 font-orbitron hover:bg-red-500/10 px-8 py-3 rounded-xl text-sm transition-all"
                        >
                            CANCEL
                        </button>
                    </div>
                </div>
            </GameLayout>
        );
    }

    // =========================================================================
    // RENDER: CHARACTER SELECT
    // =========================================================================
    return (
        <GameLayout>
            <div className="min-h-screen pt-6 sm:pt-10 pb-20 relative">
                {/* Background */}
                <div className="absolute inset-0 overflow-hidden pointer-events-none">
                    <div className="absolute top-[20%] left-[-10%] w-[500px] h-[500px] bg-cyber-gold/10 rounded-full blur-[100px]" />
                    <div className="absolute bottom-[10%] right-[-10%] w-[600px] h-[600px] bg-cyber-orange/5 rounded-full blur-[120px]" />
                </div>

                <div className="container mx-auto px-4 sm:px-6 lg:px-12 xl:px-24 relative z-10">
                    {/* Header */}
                    <div className="text-center max-w-4xl mx-auto mb-12">
                        <h1 className="text-3xl sm:text-4xl lg:text-[48px] font-bold leading-tight mb-4 font-orbitron text-white">
                            CHOOSE YOUR <span className="text-cyber-gold">FIGHTER</span>
                        </h1>
                        <p className="text-cyber-gray text-base font-montserrat">
                            Select a character for ranked matchmaking.
                        </p>
                    </div>

                    {/* Character Grid */}
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 sm:gap-6 mb-12">
                        {RANKED_CHARACTERS.map((charId) => {
                            const char = getCharacter(charId);
                            if (!char) return null;
                            const isSelected = selectedCharacter === charId;

                            return (
                                <button
                                    key={charId}
                                    onClick={() => handleSelectCharacter(charId)}
                                    className={`
                                        group relative rounded-[16px] p-4 transition-all overflow-hidden text-left
                                        ${isSelected
                                            ? "bg-cyber-gold/20 border-2 border-cyber-gold shadow-[0_0_20px_rgba(240,183,31,0.3)] scale-105"
                                            : "bg-black/40 border border-white/10 hover:border-cyber-gold/40 hover:bg-black/60"
                                        }
                                    `}
                                >
                                    {/* Character image */}
                                    <div className="relative w-full aspect-square mb-3 overflow-hidden rounded-xl bg-black/40">
                                        <img
                                            src={`/assets/characters/${charId}/idle.png`}
                                            alt={char.name}
                                            className="w-full h-full object-contain"
                                            onError={(e) => {
                                                (e.target as HTMLImageElement).style.display = "none";
                                            }}
                                        />
                                        {isSelected && (
                                            <div className="absolute inset-0 bg-cyber-gold/10 flex items-center justify-center">
                                                <span className="text-cyber-gold text-3xl">✓</span>
                                            </div>
                                        )}
                                    </div>

                                    {/* Character name */}
                                    <p className={`text-sm font-orbitron font-bold truncate ${isSelected ? "text-cyber-gold" : "text-white"}`}>
                                        {char.name}
                                    </p>
                                    <p className="text-xs text-cyber-gray mt-1 capitalize">
                                        {char.archetype || "fighter"}
                                    </p>
                                </button>
                            );
                        })}
                    </div>

                    {/* Action Buttons */}
                    <div className="flex justify-center gap-4">
                        <a href="/play">
                            <button className="bg-transparent border border-white/10 text-cyber-gray font-orbitron hover:bg-white/5 px-8 py-3 rounded-xl text-sm transition-all">
                                BACK
                            </button>
                        </a>
                        <button
                            onClick={handleJoinQueue}
                            disabled={!selectedCharacter}
                            className={`font-orbitron px-10 py-3 rounded-xl text-sm transition-all ${selectedCharacter
                                    ? "bg-gradient-cyber text-white border-0 hover:opacity-90 hover:shadow-[0_0_20px_rgba(240,183,31,0.3)]"
                                    : "bg-white/5 text-white/30 border border-white/10 cursor-not-allowed"
                                }`}
                        >
                            FIND MATCH
                        </button>
                    </div>
                </div>
            </div>
        </GameLayout>
    );
}
