/**
 * Practice Mode Page
 * Offline AI training mode - no wallet required
 */

import React, { useState, useCallback, lazy, Suspense } from "react";
import GameLayout from "@/components/layout/GameLayout";
import PracticeMenu from "@/components/practice/PracticeMenu";
import PracticeResults from "@/components/practice/PracticeResults";
import type { AIDifficulty } from "@/lib/game/ai-opponent";

// Lazy load PracticeGameClient for code splitting
const PracticeGameClient = lazy(() =>
    import("@/components/practice/PracticeGameClient").then((mod) => ({
        default: mod.PracticeGameClient,
    }))
);

interface PracticeConfig {
    characterId: string;
    difficulty: AIDifficulty;
}

interface MatchResult {
    playerWon: boolean;
    playerRoundsWon: number;
    aiRoundsWon: number;
}

export default function PracticePage() {
    const [gameState, setGameState] = useState<"menu" | "playing" | "results">("menu");
    const [practiceConfig, setPracticeConfig] = useState<PracticeConfig | null>(null);
    const [matchResult, setMatchResult] = useState<MatchResult | null>(null);

    const handleStart = useCallback((characterId: string, difficulty: string) => {
        setPracticeConfig({
            characterId,
            difficulty: difficulty as AIDifficulty,
        });
        setGameState("playing");
    }, []);

    const handleMatchEnd = useCallback((result: MatchResult) => {
        setMatchResult(result);
        setGameState("results");
    }, []);

    const handleRetry = useCallback(() => {
        // Keep same config, start new match
        setMatchResult(null);
        setGameState("playing");
    }, []);

    const handleExit = useCallback(() => {
        setPracticeConfig(null);
        setMatchResult(null);
        setGameState("menu");
    }, []);

    // Fullscreen game view
    if (gameState === "playing" && practiceConfig) {
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
                    <PracticeGameClient
                        characterId={practiceConfig.characterId}
                        aiDifficulty={practiceConfig.difficulty}
                        matchFormat="best_of_3"
                        onMatchEnd={handleMatchEnd}
                        onExit={handleExit}
                    />
                </Suspense>
            </div>
        );
    }

    return (
        <GameLayout>
            <div className="min-h-screen pt-6 sm:pt-10 pb-20 relative">
                {/* Background Elements */}
                <div className="absolute inset-0 overflow-hidden pointer-events-none">
                    <div className="absolute top-[20%] left-[-10%] w-[500px] h-[500px] bg-cyber-orange/10 rounded-full blur-[100px] translate-z-0"></div>
                    <div className="absolute bottom-[10%] right-[-10%] w-[600px] h-[600px] bg-cyber-gold/5 rounded-full blur-[120px] translate-z-0"></div>
                </div>

                <div className="container mx-auto px-4 sm:px-6 lg:px-12 xl:px-24 relative z-10">
                    {gameState === "menu" && (
                        <PracticeMenu onStart={handleStart} />
                    )}

                    {gameState === "results" && matchResult && (
                        <PracticeResults
                            winner={matchResult.playerWon ? "player" : "ai"}
                            onRetry={handleRetry}
                        />
                    )}
                </div>
            </div>
        </GameLayout>
    );
}
