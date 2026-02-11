/**
 * FightGameClient - React wrapper for Online FightScene
 * Handles match lifecycle, EventBus bridging, and game channel integration
 */

import React, { useEffect, useRef, useState, useCallback } from "react";
import { PhaserGame } from "@/game/PhaserGame";
import { EventBus } from "@/game/EventBus";
import type { FightSceneConfig } from "@/game/scenes/FightScene";

/**
 * Props for the FightGameClient component.
 */
interface FightGameClientProps {
    matchId: string;
    player1Address: string;
    player2Address: string;
    player1Character: string;
    player2Character: string;
    playerRole: "player1" | "player2";
    matchFormat?: "best_of_3" | "best_of_5";
    onMatchEnd: (result: { isWinner: boolean; ratingChanges?: any; onChainSessionId?: number; onChainTxHash?: string; contractId?: string }) => void;
    onExit: () => void;
}

/**
 * FightGameClient component — wraps FightScene Phaser game for online matches.
 * Mirrors PracticeGameClient pattern but bridges useGameChannel events.
 */
export function FightGameClient({
    matchId,
    player1Address,
    player2Address,
    player1Character,
    player2Character,
    playerRole,
    matchFormat = "best_of_3",
    onMatchEnd,
    onExit,
}: FightGameClientProps) {
    const [isReady, setIsReady] = useState(false);

    // Refs to avoid stale closures
    const onMatchEndRef = useRef(onMatchEnd);
    const onExitRef = useRef(onExit);

    useEffect(() => {
        onMatchEndRef.current = onMatchEnd;
        onExitRef.current = onExit;
    }, [onMatchEnd, onExit]);

    // Scene config for FightScene.init()
    const sceneConfig: FightSceneConfig = {
        matchId,
        player1Address,
        player2Address,
        player1Character,
        player2Character,
        playerRole,
        matchFormat,
    };

    // Listen for FightScene events
    useEffect(() => {
        const handleSceneReady = () => {
            setIsReady(true);
        };

        const handleMatchResult = (data: unknown) => {
            const payload = data as { isWinner: boolean; ratingChanges?: any; onChainSessionId?: number; onChainTxHash?: string; contractId?: string };
            onMatchEndRef.current(payload);
        };

        const handleForfeit = (data: unknown) => {
            console.log("[FightGameClient] Forfeit requested:", data);
            // Emit to useGameChannel which will handle server communication
            // The forfeit event is already emitted by FightScene
        };

        EventBus.on("fight_scene_ready", handleSceneReady);
        EventBus.on("fight:matchResult", handleMatchResult);
        EventBus.on("fight:forfeit", handleForfeit);

        return () => {
            EventBus.off("fight_scene_ready", handleSceneReady);
            EventBus.off("fight:matchResult", handleMatchResult);
            EventBus.off("fight:forfeit", handleForfeit);
        };
    }, []);

    return (
        <div className="relative w-full h-full">
            {/* Online match header */}
            <div className="absolute top-0 left-0 right-0 z-10 hidden xl:flex justify-between items-center p-4 bg-gradient-to-b from-black/80 to-transparent">
                <div className="flex items-center gap-4">
                    <span className="text-2xl font-bold font-orbitron text-white tracking-wider drop-shadow-[0_0_10px_rgba(240,183,31,0.5)]">
                        VEILSTAR<span className="text-cyber-gold"> BRAWL</span>
                    </span>
                    <span className="text-cyber-gold text-sm font-orbitron tracking-wide px-3 py-1 bg-black/60 rounded-full border border-cyber-gold/30">
                        RANKED MATCH
                    </span>
                </div>
                <div className="flex items-center gap-4">
                    <span className="text-cyber-gray text-xs font-orbitron tracking-widest">
                        Match: <span className="text-cyber-gold">{matchId.slice(0, 8)}...</span>
                    </span>
                    <button
                        onClick={() => onExitRef.current()}
                        className="text-red-400 text-xs font-orbitron tracking-wide px-3 py-1 bg-red-500/10 rounded-full border border-red-500/30 hover:bg-red-500/20 transition-all"
                    >
                        FORFEIT
                    </button>
                </div>
            </div>

            {/* Phaser game container */}
            <PhaserGame
                currentScene="FightScene"
                sceneConfig={sceneConfig as any}
            />
        </div>
    );
}

export default FightGameClient;
