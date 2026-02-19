/**
 * SpectatorClient — PvP Match Spectator
 * Embeds Phaser FightScene in spectator mode with betting panel and chat
 */

import React, { useState, useEffect, useCallback, useRef, lazy, Suspense } from "react";
import { useSpectatorChannel } from "../../hooks/useSpectatorChannel";
import { SpectatorChat } from "./SpectatorChat";
import { BettingPanel } from "../betting/BettingPanel";
import { WinningNotification } from "../betting/WinningNotification";
import { getCharacter } from "../../data/characters";

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:3001";

// =============================================================================
// TYPES
// =============================================================================

interface SpectatorClientProps {
    matchId: string;
}

interface MatchData {
    id: string;
    player1Address: string;
    player2Address: string;
    player1CharacterId: string | null;
    player2CharacterId: string | null;
    format: string;
    status: string;
    player1RoundsWon: number;
    player2RoundsWon: number;
    currentRound: number;
    player1: { address: string; displayName: string | null; rating: number } | null;
    player2: { address: string; displayName: string | null; rating: number } | null;
}

function truncateAddress(address: string): string {
    if (!address) return "???";
    if (address.length <= 16) return address;
    return `${address.slice(0, 10)}...${address.slice(-6)}`;
}

function navigate(path: string) {
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
}

// =============================================================================
// COMPONENT
// =============================================================================

export function SpectatorClient({ matchId }: SpectatorClientProps) {
    const [match, setMatch] = useState<MatchData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [matchEnded, setMatchEnded] = useState(false);
    const [winner, setWinner] = useState<string | null>(null);
    const [showWinNotification, setShowWinNotification] = useState(false);
    const [winAmount, setWinAmount] = useState<bigint>(0n);
    const matchEndedRef = useRef(false);

    // Fetch match data
    useEffect(() => {
        const fetchMatch = async () => {
            try {
                const response = await fetch(`${API_BASE}/api/matches/${matchId}/public`);
                if (!response.ok) throw new Error("Match not found");
                const data = await response.json();
                setMatch(data.match || data);
                setLoading(false);
            } catch (err) {
                setError(err instanceof Error ? err.message : "Failed to load match");
                setLoading(false);
            }
        };

        fetchMatch();
    }, [matchId]);

    // Poll match state updates
    useEffect(() => {
        if (!match || matchEnded) return;

        const pollMatch = async () => {
            try {
                const response = await fetch(`${API_BASE}/api/matches/${matchId}/public`);
                if (response.ok) {
                    const data = await response.json();
                    setMatch(data.match || data);
                }
            } catch {
                // Ignore polling errors
            }
        };

        const interval = setInterval(pollMatch, 3000);
        return () => clearInterval(interval);
    }, [matchId, match, matchEnded]);

    // Handle match ended
    const handleMatchEnded = useCallback((payload: any) => {
        if (matchEndedRef.current) return;
        matchEndedRef.current = true;
        setMatchEnded(true);
        setWinner(payload.winner || null);

        // Check if user had a bet
        const userAddress = localStorage.getItem("stellar_address");
        if (userAddress) {
            fetch(`${API_BASE}/api/betting/pool/${matchId}`)
                .then(res => res.json())
                .then(data => {
                    if (data.userBet && data.userBet.status === "won" && data.userBet.payout_amount) {
                        setWinAmount(BigInt(data.userBet.payout_amount));
                        setShowWinNotification(true);
                    }
                })
                .catch(() => { });
        }
    }, [matchId]);

    // Handle match cancelled
    const handleMatchCancelled = useCallback(() => {
        setMatchEnded(true);
        setError("Match was cancelled");
    }, []);

    // Spectator channel for real-time updates
    const { state: channelState } = useSpectatorChannel({
        matchId,
        onMatchEnded: handleMatchEnded,
        onMatchCancelled: handleMatchCancelled,
        onRoundResolved: (payload) => {
            // Update local match state with round results
            const p = payload as any;
            setMatch(prev => prev ? {
                ...prev,
                player1RoundsWon: p.player1RoundsWon ?? prev.player1RoundsWon,
                player2RoundsWon: p.player2RoundsWon ?? prev.player2RoundsWon,
            } : prev);
        },
    });

    if (loading) {
        return (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", background: "#0a0a0f" }}>
                <div style={{ textAlign: "center" }}>
                    <div
                        style={{
                            width: "64px",
                            height: "64px",
                            border: "4px solid #8b5cf6",
                            borderTopColor: "transparent",
                            borderRadius: "50%",
                            animation: "spin 1s linear infinite",
                            margin: "0 auto 16px",
                        }}
                    />
                    <p style={{ color: "#a78bfa", fontFamily: "'Orbitron', sans-serif", letterSpacing: "0.1em" }}>
                        LOADING MATCH...
                    </p>
                </div>
                <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            </div>
        );
    }

    if (error || !match) {
        return (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", background: "#0a0a0f" }}>
                <div style={{ textAlign: "center" }}>
                    <div style={{ fontSize: "64px", marginBottom: "16px" }}>❌</div>
                    <p style={{ color: "#ef4444", fontSize: "18px", marginBottom: "16px" }}>{error || "Match not found"}</p>
                    <button
                        onClick={() => navigate("/spectate")}
                        style={{
                            background: "linear-gradient(to right, #8b5cf6, #6366f1)",
                            color: "#fff",
                            border: "none",
                            padding: "12px 24px",
                            borderRadius: "8px",
                            fontFamily: "'Orbitron', sans-serif",
                            cursor: "pointer",
                        }}
                    >
                        ← BACK TO SPECTATE
                    </button>
                </div>
            </div>
        );
    }

    const player1Name = match.player1?.displayName || truncateAddress(match.player1Address);
    const player2Name = match.player2?.displayName || (match.player2Address ? truncateAddress(match.player2Address) : "???");
    const player1Character = match.player1CharacterId ? getCharacter(match.player1CharacterId) : null;
    const player2Character = match.player2CharacterId ? getCharacter(match.player2CharacterId) : null;

    return (
        <div
            style={{
                display: "flex",
                minHeight: "100vh",
                background: "linear-gradient(135deg, #0a0a0f 0%, #0d0d1a 50%, #0a0a0f 100%)",
            }}
        >
            {/* Main Content — Game / Match View */}
            <div style={{ flex: 1, display: "flex", flexDirection: "column", position: "relative" }}>
                {/* Top Bar */}
                <div
                    style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "12px 24px",
                        background: "rgba(0, 0, 0, 0.6)",
                        borderBottom: "1px solid rgba(139, 92, 246, 0.2)",
                        backdropFilter: "blur(8px)",
                        zIndex: 10,
                    }}
                >
                    <button
                        onClick={() => navigate("/spectate")}
                        style={{
                            background: "rgba(255,255,255,0.08)",
                            color: "#a78bfa",
                            border: "none",
                            padding: "6px 14px",
                            borderRadius: "6px",
                            fontFamily: "'Orbitron', sans-serif",
                            fontSize: "11px",
                            cursor: "pointer",
                            display: "flex",
                            alignItems: "center",
                            gap: "6px",
                        }}
                    >
                        ← BACK
                    </button>

                    {/* Match Status */}
                    <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                            <span style={{ color: "#d1d5db", fontFamily: "'Orbitron', sans-serif", fontSize: "13px" }}>
                                {player1Name}
                            </span>
                            <span style={{ color: "#a78bfa", fontFamily: "'Orbitron', sans-serif", fontSize: "20px", fontWeight: 700 }}>
                                {match.player1RoundsWon}
                            </span>
                            <span style={{ color: "#4b5563" }}>—</span>
                            <span style={{ color: "#6366f1", fontFamily: "'Orbitron', sans-serif", fontSize: "20px", fontWeight: 700 }}>
                                {match.player2RoundsWon}
                            </span>
                            <span style={{ color: "#d1d5db", fontFamily: "'Orbitron', sans-serif", fontSize: "13px" }}>
                                {player2Name}
                            </span>
                        </div>

                        {/* Live badge */}
                        <div
                            style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "6px",
                                background: "rgba(239, 68, 68, 0.15)",
                                padding: "4px 10px",
                                borderRadius: "6px",
                                border: "1px solid rgba(239, 68, 68, 0.3)",
                            }}
                        >
                            <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#ef4444", animation: "pulse 1s infinite" }} />
                            <span style={{ color: "#ef4444", fontSize: "11px", fontFamily: "'Orbitron', sans-serif", fontWeight: 700 }}>
                                {matchEnded ? "ENDED" : "LIVE"}
                            </span>
                        </div>
                    </div>

                    {/* Connection status */}
                    <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                        <span
                            style={{
                                width: "8px",
                                height: "8px",
                                borderRadius: "50%",
                                background: channelState.isSubscribed ? "#22c55e" : "#f59e0b",
                            }}
                        />
                        <span style={{ color: "#6b7280", fontSize: "10px" }}>
                            {channelState.isSubscribed ? "Connected" : "Connecting..."}
                        </span>
                    </div>
                </div>

                {/* Game Area */}
                <div
                    style={{
                        flex: 1,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        position: "relative",
                    }}
                >
                    {/* Match Status Overlay if ended */}
                    {matchEnded && (
                        <div
                            style={{
                                position: "absolute",
                                inset: 0,
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                background: "rgba(0, 0, 0, 0.7)",
                                zIndex: 20,
                            }}
                        >
                            <div style={{ textAlign: "center" }}>
                                <div style={{ fontSize: "64px", marginBottom: "16px" }}>🏆</div>
                                <h2 style={{ color: "#fbbf24", fontFamily: "'Orbitron', sans-serif", fontSize: "28px", marginBottom: "8px" }}>
                                    MATCH COMPLETE
                                </h2>
                                <p style={{ color: "#d1d5db", fontSize: "16px", marginBottom: "24px" }}>
                                    {winner === match.player1Address ? player1Name : player2Name} wins!
                                </p>
                                <button
                                    onClick={() => navigate("/spectate")}
                                    style={{
                                        background: "linear-gradient(to right, #8b5cf6, #6366f1)",
                                        color: "#fff",
                                        border: "none",
                                        padding: "12px 24px",
                                        borderRadius: "8px",
                                        fontFamily: "'Orbitron', sans-serif",
                                        cursor: "pointer",
                                    }}
                                >
                                    FIND ANOTHER MATCH
                                </button>
                            </div>
                        </div>
                    )}

                    {/* Player panels */}
                    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: "48px", padding: "48px" }}>
                        {/* P1 */}
                        <div style={{ textAlign: "center" }}>
                            <div style={{
                                width: "200px",
                                height: "200px",
                                borderRadius: "16px",
                                border: "2px solid rgba(139, 92, 246, 0.4)",
                                overflow: "hidden",
                                background: "rgba(139, 92, 246, 0.05)",
                                margin: "0 auto 16px",
                            }}>
                                {player1Character && (
                                    <img src={player1Character.portraitUrl} alt={player1Character.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                                )}
                            </div>
                            <p style={{ color: "#a78bfa", fontFamily: "'Orbitron', sans-serif", fontSize: "16px", fontWeight: 700 }}>{player1Name}</p>
                            <p style={{ color: "#6b7280", fontSize: "12px", marginTop: "4px" }}>{player1Character?.name || "Selecting..."}</p>
                        </div>

                        {/* VS */}
                        <div style={{ textAlign: "center" }}>
                            <div style={{ fontSize: "48px", fontWeight: 700, fontFamily: "'Orbitron', sans-serif", color: "#4b5563" }}>VS</div>
                            <div style={{ marginTop: "8px", color: "#9ca3af", fontSize: "12px" }}>
                                Round {match.currentRound || 1} • {match.format === "best_of_3" ? "Best of 3" : "Best of 5"}
                            </div>
                        </div>

                        {/* P2 */}
                        <div style={{ textAlign: "center" }}>
                            <div style={{
                                width: "200px",
                                height: "200px",
                                borderRadius: "16px",
                                border: "2px solid rgba(99, 102, 241, 0.4)",
                                overflow: "hidden",
                                background: "rgba(99, 102, 241, 0.05)",
                                margin: "0 auto 16px",
                            }}>
                                {player2Character && (
                                    <img src={player2Character.portraitUrl} alt={player2Character.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                                )}
                            </div>
                            <p style={{ color: "#6366f1", fontFamily: "'Orbitron', sans-serif", fontSize: "16px", fontWeight: 700 }}>{player2Name}</p>
                            <p style={{ color: "#6b7280", fontSize: "12px", marginTop: "4px" }}>{player2Character?.name || "Selecting..."}</p>
                        </div>
                    </div>
                </div>
            </div>

            {/* Sidebar — Betting + Chat */}
            <div
                style={{
                    width: "360px",
                    flexShrink: 0,
                    display: "flex",
                    flexDirection: "column",
                    gap: "16px",
                    padding: "16px",
                    background: "rgba(0, 0, 0, 0.3)",
                    borderLeft: "1px solid rgba(139, 92, 246, 0.15)",
                    overflowY: "auto",
                }}
            >
                <BettingPanel matchId={matchId} player1Name={player1Name} player2Name={player2Name} />
                <SpectatorChat matchId={matchId} isBotMatch={false} player1Name={player1Name} player2Name={player2Name} />
            </div>

            {/* Win Notification */}
            <WinningNotification isOpen={showWinNotification} winAmount={winAmount} onClose={() => setShowWinNotification(false)} />

            <style>{`
                @keyframes spin { to { transform: rotate(360deg); } }
                @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
            `}</style>
        </div>
    );
}
