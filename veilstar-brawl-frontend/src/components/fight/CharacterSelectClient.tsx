/**
 * CharacterSelectClient — React wrapper that embeds the Phaser CharacterSelectScene
 * Handles match data fetching and EventBus bridging for character selection.
 * After both players confirm, the Phaser scene auto-transitions to FightScene.
 */

import React, { useEffect, useRef, useState, useCallback } from "react";
import { PhaserGame } from "@/game/PhaserGame";
import { EventBus } from "@/game/EventBus";
import { useWallet } from "@/hooks/useWallet";
import { getSupabaseClient } from "@/lib/supabase/client";
import type { RealtimeChannel } from "@supabase/supabase-js";
import type { CharacterSelectSceneConfig } from "@/game/scenes/CharacterSelectScene";

interface CharacterSelectClientProps {
    matchId: string;
    onMatchEnd?: (result: {
        isWinner: boolean;
        ratingChanges?: unknown;
        onChainSessionId?: number;
        onChainTxHash?: string;
        contractId?: string;
    }) => void;
    onExit?: () => void;
}

const API_BASE = import.meta.env.VITE_API_BASE_URL || "";

/** Broadcast a game event via Supabase Realtime */
async function broadcastGameEvent(matchId: string, event: string, payload: Record<string, unknown>) {
    try {
        const supabase = getSupabaseClient();
        const channel = supabase.channel(`game:${matchId}`);
        await channel.send({ type: "broadcast", event, payload });
        await supabase.removeChannel(channel);
    } catch (err) {
        console.warn("[CharacterSelectClient] Failed to broadcast:", err);
    }
}

function navigateTo(path: string) {
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
}

export function CharacterSelectClient({ matchId, onMatchEnd, onExit }: CharacterSelectClientProps) {
    const { publicKey } = useWallet();
    const [sceneConfig, setSceneConfig] = useState<CharacterSelectSceneConfig | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const onMatchEndRef = useRef(onMatchEnd);
    const onExitRef = useRef(onExit);
    useEffect(() => {
        onMatchEndRef.current = onMatchEnd;
        onExitRef.current = onExit;
    }, [onMatchEnd, onExit]);

    // Fetch match data and build scene config
    useEffect(() => {
        if (!matchId || !publicKey) return;

        const fetchMatch = async () => {
            try {
                const res = await fetch(`${API_BASE}/api/matches/${matchId}`);
                if (!res.ok) {
                    setError("Match not found");
                    setLoading(false);
                    return;
                }
                const data = await res.json();
                const match = data.match;

                const isHost = match.player1_address === publicKey;
                const isBot = !match.player2_address || match.player2_address.startsWith("GBOT");

                const config: CharacterSelectSceneConfig = {
                    matchId,
                    playerAddress: publicKey,
                    opponentAddress: isHost ? match.player2_address : match.player1_address,
                    isHost,
                    selectionTimeLimit: 25,
                    selectionDeadlineAt: match.selection_deadline_at || undefined,
                    existingPlayerCharacter: isHost ? match.player1_character_id : match.player2_character_id,
                    existingOpponentCharacter: isHost ? match.player2_character_id : match.player1_character_id,
                    existingPlayerBan: null,
                    existingOpponentBan: null,
                    isBot,
                    botBanId: null,
                };

                setSceneConfig(config);
                setLoading(false);
            } catch (err) {
                console.error("[CharacterSelectClient] Error fetching match:", err);
                setError("Failed to load match");
                setLoading(false);
            }
        };

        fetchMatch();
    }, [matchId, publicKey]);

    // Subscribe to Supabase Realtime for opponent events on game:${matchId}
    useEffect(() => {
        if (!sceneConfig || !publicKey) return;

        let channel: RealtimeChannel | null = null;

        try {
            const supabase = getSupabaseClient();
            channel = supabase
                .channel(`game:${matchId}`)
                .on("broadcast", { event: "character_selected" }, (payload) => {
                    const data = payload.payload as { player: string; characterId: string };
                    // Only forward opponent's selection, not our own
                    const myRole = sceneConfig.isHost ? "player1" : "player2";
                    if (data.player !== myRole) {
                        EventBus.emit("opponent_character_confirmed", {
                            characterId: data.characterId,
                        });
                    }
                })
                .on("broadcast", { event: "ban_confirmed" }, (payload) => {
                    const data = payload.payload as { player: string; characterId: string };
                    EventBus.emit("game:banConfirmed", {
                        characterId: data.characterId,
                        player: data.player,
                    });
                })
                .on("broadcast", { event: "match_starting" }, (payload) => {
                    const data = payload.payload as {
                        countdownSeconds: number;
                        player1CharacterId?: string;
                        player2CharacterId?: string;
                    };
                    EventBus.emit("match_starting", {
                        countdown: data.countdownSeconds,
                        player1CharacterId: data.player1CharacterId,
                        player2CharacterId: data.player2CharacterId,
                    });
                })
                .subscribe();
        } catch (err) {
            console.warn("[CharacterSelectClient] Failed to set up Realtime:", err);
        }

        return () => {
            if (channel) {
                channel.unsubscribe();
            }
        };
    }, [sceneConfig, matchId, publicKey]);

    // Listen for EventBus events to send selections to server
    useEffect(() => {
        if (!sceneConfig) return;

        const handleSelectionConfirmed = async (data: unknown) => {
            const { characterId } = data as { characterId: string };
            try {
                await fetch(`${API_BASE}/api/matches/${matchId}/select`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ address: publicKey, characterId }),
                });
            } catch (err) {
                console.error("[CharacterSelectClient] Failed to submit selection:", err);
            }
        };

        const handleBanConfirmed = async (data: unknown) => {
            const { characterId } = data as { characterId: string };
            try {
                await broadcastGameEvent(matchId, "ban_confirmed", {
                    player: sceneConfig.isHost ? "player1" : "player2",
                    characterId,
                });
            } catch (err) {
                console.error("[CharacterSelectClient] Failed to broadcast ban:", err);
            }
        };

        const handleMatchResult = (data: unknown) => {
            const payload = data as {
                isWinner: boolean;
                ratingChanges?: unknown;
                onChainSessionId?: number;
                onChainTxHash?: string;
                contractId?: string;
            };
            onMatchEndRef.current?.(payload);
        };

        EventBus.on("selection_confirmed", handleSelectionConfirmed);
        EventBus.on("game:sendBanConfirmed", handleBanConfirmed);
        EventBus.on("fight:matchResult", handleMatchResult);

        return () => {
            EventBus.off("selection_confirmed", handleSelectionConfirmed);
            EventBus.off("game:sendBanConfirmed", handleBanConfirmed);
            EventBus.off("fight:matchResult", handleMatchResult);
        };
    }, [sceneConfig, matchId, publicKey]);

    if (loading) {
        return (
            <div className="fixed inset-0 bg-black flex items-center justify-center z-50">
                <div className="text-center">
                    <div className="w-12 h-12 border-4 border-cyber-gold border-t-transparent rounded-full animate-spin mx-auto mb-4" />
                    <p className="text-cyber-gold font-orbitron tracking-widest text-sm">
                        LOADING MATCH...
                    </p>
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="fixed inset-0 bg-black flex items-center justify-center z-50">
                <div className="text-center bg-black/40 border border-red-500/30 rounded-[20px] p-10 max-w-md">
                    <h2 className="text-2xl font-bold text-red-500 font-orbitron mb-4">ERROR</h2>
                    <p className="text-cyber-gray text-sm mb-6">{error}</p>
                    <button
                        onClick={() => navigateTo("/play")}
                        className="w-full bg-transparent border border-white/10 text-cyber-gray font-orbitron hover:bg-white/5 py-3 rounded-xl text-sm"
                    >
                        BACK TO ARENA
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="fixed inset-0 z-50 bg-black overflow-hidden">
            {/* Header bar */}
            <div className="absolute top-0 left-0 right-0 z-10 hidden xl:flex justify-between items-center p-4 bg-gradient-to-b from-black/80 to-transparent pointer-events-none">
                <span className="text-2xl font-bold font-orbitron text-white tracking-wider drop-shadow-[0_0_10px_rgba(240,183,31,0.5)]">
                    VEILSTAR<span className="text-cyber-gold"> BRAWL</span>
                </span>
                <span className="text-cyber-gray text-xs font-orbitron tracking-widest">
                    Match: <span className="text-cyber-gold">{matchId.slice(0, 8)}...</span>
                </span>
            </div>

            <PhaserGame
                currentScene="CharacterSelectScene"
                sceneConfig={sceneConfig as unknown as Record<string, unknown>}
            />
        </div>
    );
}

export default CharacterSelectClient;
