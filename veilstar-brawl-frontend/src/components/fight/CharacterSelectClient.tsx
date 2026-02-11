/**
 * CharacterSelectClient — React wrapper that embeds the Phaser CharacterSelectScene
 * Handles match data fetching and EventBus bridging for character selection.
 * After both players confirm, the Phaser scene auto-transitions to FightScene.
 */

import React, { useEffect, useRef, useState, useCallback } from "react";
import { PhaserGame } from "@/game/PhaserGame";
import { EventBus } from "@/game/EventBus";
import { useWallet } from "@/hooks/useWallet";
import { useOnChainRegistration, type RegistrationStatus } from "@/hooks/useOnChainRegistration";
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

    // On-chain registration (client-signed via Freighter)
    const {
        status: regStatus,
        error: regError,
        registerOnChain,
        markComplete,
        markSkipped,
    } = useOnChainRegistration();

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
                        requiresOnChainRegistration?: boolean;
                    };

                    // Trigger on-chain registration signing if required
                    if (data.requiresOnChainRegistration) {
                        registerOnChain(matchId).catch((err) =>
                            console.error("[CharacterSelectClient] Registration signing failed:", err),
                        );
                    } else {
                        markSkipped();
                    }

                    EventBus.emit("match_starting", {
                        countdown: data.countdownSeconds,
                        player1CharacterId: data.player1CharacterId,
                        player2CharacterId: data.player2CharacterId,
                    });
                })
                .on("broadcast", { event: "registration_complete" }, (payload) => {
                    const data = payload.payload as { sessionId?: number; txHash?: string };
                    markComplete(data.txHash);
                })
                .on("broadcast", { event: "match_cancelled" }, () => {
                    console.log("[CharacterSelectClient] Match cancelled");
                    navigateTo("/play");
                })
                .on("broadcast", { event: "player_disconnected" }, (payload) => {
                    EventBus.emit("opponent_disconnected", payload.payload);
                    EventBus.emit("game:playerDisconnected", payload.payload);
                })
                .on("broadcast", { event: "player_reconnected" }, (payload) => {
                    EventBus.emit("opponent_reconnected", payload.payload);
                    EventBus.emit("game:playerReconnected", payload.payload);
                })
                // FightScene events (forwarded via EventBus so FightScene can receive them)
                .on("broadcast", { event: "round_starting" }, (payload) => {
                    EventBus.emit("game:roundStarting", payload.payload);
                })
                .on("broadcast", { event: "move_submitted" }, (payload) => {
                    EventBus.emit("game:moveSubmitted", payload.payload);
                })
                .on("broadcast", { event: "move_confirmed" }, (payload) => {
                    EventBus.emit("game:moveConfirmed", payload.payload);
                })
                .on("broadcast", { event: "round_resolved" }, (payload) => {
                    EventBus.emit("game:roundResolved", payload.payload);
                })
                .on("broadcast", { event: "match_ended" }, (payload) => {
                    EventBus.emit("game:matchEnded", payload.payload);
                })
                .on("broadcast", { event: "move_rejected" }, (payload) => {
                    EventBus.emit("game:moveRejected", payload.payload);
                })
                .on("broadcast", { event: "fight_state_update" }, (payload) => {
                    EventBus.emit("game:fightStateUpdate", payload.payload);
                })
                .on("broadcast", { event: "chat_message" }, (payload) => {
                    EventBus.emit("game:chatMessage", payload.payload);
                })
                .on("broadcast", { event: "sticker_displayed" }, (payload) => {
                    EventBus.emit("game:stickerMessage", payload.payload);
                })
                .subscribe((status) => {
                    if (status === "SUBSCRIBED") {
                        EventBus.emit("channel_ready", { matchId });
                    }
                });
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

        const handleSubmitMove = async (data: unknown) => {
            const payload = data as {
                matchId: string;
                roundNumber: number;
                turnNumber: number;
                move: string;
                message: string;
                playerRole: string;
                playerAddress: string;
            };
            try {
                const res = await fetch(`${API_BASE}/api/matches/${payload.matchId}/move`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        address: payload.playerAddress,
                        move: payload.move,
                        roundNumber: payload.roundNumber,
                        turnNumber: payload.turnNumber,
                    }),
                });
                if (!res.ok) {
                    console.error("[CharacterSelectClient] Move submission failed:", await res.text());
                }
            } catch (err) {
                console.error("[CharacterSelectClient] Failed to submit move:", err);
            }
        };

        const handleForfeit = async (data: unknown) => {
            const payload = data as { matchId: string; playerRole: string };
            try {
                await fetch(`${API_BASE}/api/matches/${payload.matchId}/forfeit`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        address: publicKey,
                        playerRole: payload.playerRole,
                    }),
                });
            } catch (err) {
                console.error("[CharacterSelectClient] Failed to forfeit:", err);
            }
        };

        EventBus.on("selection_confirmed", handleSelectionConfirmed);
        EventBus.on("game:sendBanConfirmed", handleBanConfirmed);
        EventBus.on("fight:matchResult", handleMatchResult);
        EventBus.on("fight:submitMove", handleSubmitMove);
        EventBus.on("fight:forfeit", handleForfeit);

        return () => {
            EventBus.off("selection_confirmed", handleSelectionConfirmed);
            EventBus.off("game:sendBanConfirmed", handleBanConfirmed);
            EventBus.off("fight:matchResult", handleMatchResult);
            EventBus.off("fight:submitMove", handleSubmitMove);
            EventBus.off("fight:forfeit", handleForfeit);
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

            {/* On-chain registration status overlay */}
            {regStatus !== "idle" && regStatus !== "complete" && regStatus !== "skipped" && (
                <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-20 pointer-events-none">
                    <div className="bg-black/80 border border-cyber-gold/40 rounded-xl px-6 py-3 flex items-center gap-3 backdrop-blur-sm">
                        {regStatus === "error" ? (
                            <>
                                <span className="w-3 h-3 rounded-full bg-red-500" />
                                <span className="text-red-400 text-xs font-orbitron tracking-wider">
                                    ON-CHAIN: {regError || "FAILED"}
                                </span>
                            </>
                        ) : (
                            <>
                                <div className="w-4 h-4 border-2 border-cyber-gold border-t-transparent rounded-full animate-spin" />
                                <span className="text-cyber-gold text-xs font-orbitron tracking-wider">
                                    {regStatus === "preparing" && "PREPARING TX..."}
                                    {regStatus === "signing" && "SIGN IN WALLET..."}
                                    {regStatus === "waiting_for_opponent" && "WAITING FOR OPPONENT SIGNATURE..."}
                                    {regStatus === "submitting" && "SUBMITTING ON-CHAIN..."}
                                </span>
                            </>
                        )}
                    </div>
                </div>
            )}

            <PhaserGame
                currentScene="CharacterSelectScene"
                sceneConfig={sceneConfig as unknown as Record<string, unknown>}
            />
        </div>
    );
}

export default CharacterSelectClient;
