/**
 * PracticeGameClient - React wrapper for Practice Mode Phaser game
 * Handles practice-specific events and game lifecycle
 */

import React, { useEffect, useRef, useState } from "react";
import { PhaserGame } from "@/game/PhaserGame";
import { EventBus } from "@/game/EventBus";
import { usePracticeStore } from "@/stores/practice-store";
import type { AIDifficulty } from "@/lib/game/ai-opponent";

/**
 * Practice game client props.
 */
interface PracticeGameClientProps {
    characterId: string;
    aiDifficulty: AIDifficulty;
    matchFormat?: "best_of_3" | "best_of_5";
    onMatchEnd: (result: { playerWon: boolean; playerRoundsWon: number; aiRoundsWon: number }) => void;
    onExit: () => void;
}

/**
 * PracticeGameClient component.
 */
export function PracticeGameClient({
    characterId,
    aiDifficulty,
    matchFormat = "best_of_3",
    onMatchEnd,
    onExit,
}: PracticeGameClientProps) {
    const [isReady, setIsReady] = useState(false);
    const practiceStore = usePracticeStore();

    // Keep refs to avoid stale closures in event handlers
    const onMatchEndRef = useRef(onMatchEnd);
    const onExitRef = useRef(onExit);

    useEffect(() => {
        onMatchEndRef.current = onMatchEnd;
        onExitRef.current = onExit;
    }, [onMatchEnd, onExit]);

    // Start match in store
    useEffect(() => {
        practiceStore.startMatch(characterId, aiDifficulty, matchFormat);
    }, [characterId, aiDifficulty, matchFormat]);

    // Listen for practice events
    useEffect(() => {
        const handleSceneReady = () => {
            setIsReady(true);
        };

        const handleMatchEnded = (data: unknown) => {
            const payload = data as {
                playerWon: boolean;
                playerRoundsWon: number;
                aiRoundsWon: number;
                difficulty: AIDifficulty;
            };

            // Update store
            practiceStore.endMatch(payload.playerWon);

            // Notify parent
            onMatchEndRef.current({
                playerWon: payload.playerWon,
                playerRoundsWon: payload.playerRoundsWon,
                aiRoundsWon: payload.aiRoundsWon,
            });
        };

        const handleExit = () => {
            onExitRef.current();
        };

        // Register listeners
        EventBus.on("practice_scene_ready", handleSceneReady);
        EventBus.on("practice_match_ended", handleMatchEnded);
        EventBus.on("practice_exit", handleExit);

        return () => {
            EventBus.off("practice_scene_ready", handleSceneReady);
            EventBus.off("practice_match_ended", handleMatchEnded);
            EventBus.off("practice_exit", handleExit);
        };
    }, []);

    return (
        <div className="relative w-full h-full">
            {/* Practice mode header */}
            <div className="absolute top-0 left-0 right-0 z-10 hidden xl:flex justify-between items-center p-4 bg-gradient-to-b from-black/80 to-transparent">
                <div className="flex items-center gap-4">
                    <span className="text-2xl font-bold font-orbitron text-white tracking-wider drop-shadow-[0_0_10px_rgba(240,183,31,0.5)]">
                        VEILSTAR<span className="text-cyber-gold"> BRAWL</span>
                    </span>
                    <span className="text-cyber-gray text-sm font-orbitron tracking-wide px-3 py-1 bg-black/60 rounded-full border border-cyber-gray/30">
                        PRACTICE MODE
                    </span>
                </div>
                <div className="text-cyber-gray text-xs font-orbitron tracking-widest">
                    AI: <span className="text-cyber-gold uppercase">{aiDifficulty}</span>
                </div>
            </div>

            {/* Phaser game container */}
            <PhaserGame
                currentScene="PracticeScene"
                sceneConfig={{
                    playerCharacterId: characterId,
                    aiDifficulty: aiDifficulty,
                    matchFormat: matchFormat,
                } as any}
            />
        </div>
    );
}

export default PracticeGameClient;
