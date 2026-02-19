/**
 * BettingPanel Component
 * UI for placing bets on PvP matches during spectating
 */

import React, { useState, useCallback, useEffect } from "react";
import {
    formatXlm,
    formatOdds,
    calculatePotentialWinnings,
    xlmToStroops,
    type BettingPool,
    type OddsInfo,
    calculateOdds,
} from "../../lib/betting/betting-service";

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:3001";

const QUICK_BETS = [1, 5, 10, 25, 50, 100];

interface BettingPanelProps {
    matchId: string;
    player1Name: string;
    player2Name: string;
}

export function BettingPanel({ matchId, player1Name, player2Name }: BettingPanelProps) {
    const [selectedPlayer, setSelectedPlayer] = useState<"player1" | "player2" | null>(null);
    const [betAmount, setBetAmount] = useState("");
    const [pool, setPool] = useState<BettingPool | null>(null);
    const [odds, setOdds] = useState<OddsInfo | null>(null);
    const [placing, setPlacing] = useState(false);
    const [betPlaced, setBetPlaced] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Fetch pool data
    useEffect(() => {
        const fetchPool = async () => {
            try {
                const response = await fetch(`${API_BASE}/api/betting/pool/${matchId}`);
                if (response.ok) {
                    const data = await response.json();
                    if (data.pool) {
                        const p: BettingPool = {
                            id: data.pool.id,
                            matchId: data.pool.match_id,
                            player1Total: BigInt(data.pool.player1_total || 0),
                            player2Total: BigInt(data.pool.player2_total || 0),
                            totalPool: BigInt(data.pool.total_pool || 0),
                            totalFees: BigInt(data.pool.total_fees || 0),
                            status: data.pool.status,
                            winner: data.pool.winner,
                        };
                        setPool(p);
                        setOdds(calculateOdds(p));
                    }
                    if (data.userBet) {
                        setBetPlaced(true);
                    }
                }
            } catch (err) {
                console.error("Error fetching betting pool:", err);
            }
        };

        fetchPool();
        const interval = setInterval(fetchPool, 3000);
        return () => clearInterval(interval);
    }, [matchId]);

    const handlePlaceBet = useCallback(async () => {
        if (!selectedPlayer || !betAmount || placing) return;

        const amount = parseFloat(betAmount);
        if (isNaN(amount) || amount <= 0) {
            setError("Invalid bet amount");
            return;
        }

        setPlacing(true);
        setError(null);

        try {
            const response = await fetch(`${API_BASE}/api/betting/place`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    matchId,
                    betOn: selectedPlayer,
                    amount: Number(xlmToStroops(amount)),
                    bettorAddress: localStorage.getItem("stellar_address") || "anonymous",
                }),
            });

            if (!response.ok) {
                const data = await response.json();
                throw new Error(data.error || "Failed to place bet");
            }

            setBetPlaced(true);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to place bet");
        } finally {
            setPlacing(false);
        }
    }, [selectedPlayer, betAmount, matchId, placing]);

    const potentialWinnings = selectedPlayer && betAmount && pool
        ? calculatePotentialWinnings(pool, selectedPlayer, xlmToStroops(parseFloat(betAmount) || 0))
        : null;

    const isLocked = pool?.status === "locked" || pool?.status === "resolved" || pool?.status === "refunded";

    return (
        <div
            style={{
                borderRadius: "12px",
                background: "rgba(0, 0, 0, 0.6)",
                border: "1px solid rgba(139, 92, 246, 0.25)",
                backdropFilter: "blur(12px)",
                overflow: "hidden",
            }}
        >
            {/* Header */}
            <div
                style={{
                    padding: "14px 16px",
                    background: "linear-gradient(to right, rgba(139, 92, 246, 0.2), rgba(99, 102, 241, 0.1), transparent)",
                    borderBottom: "1px solid rgba(139, 92, 246, 0.2)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                }}
            >
                <span
                    style={{
                        color: "#a78bfa",
                        fontFamily: "'Orbitron', sans-serif",
                        fontSize: "13px",
                        fontWeight: 700,
                        letterSpacing: "0.08em",
                    }}
                >
                    ⚡ PLACE YOUR BET
                </span>
                {odds && (
                    <span style={{ color: "#6b7280", fontSize: "11px" }}>
                        Pool: {formatXlm(odds.totalPool)}
                    </span>
                )}
            </div>

            <div style={{ padding: "16px" }}>
                {betPlaced ? (
                    <div style={{ textAlign: "center", padding: "24px 0" }}>
                        <div style={{ fontSize: "40px", marginBottom: "12px" }}>✅</div>
                        <p style={{ color: "#22c55e", fontFamily: "'Orbitron', sans-serif", fontSize: "14px", fontWeight: 700 }}>
                            BET PLACED!
                        </p>
                        <p style={{ color: "#9ca3af", fontSize: "12px", marginTop: "8px" }}>
                            Good luck! Results will show when the match ends.
                        </p>
                    </div>
                ) : isLocked ? (
                    <div style={{ textAlign: "center", padding: "24px 0" }}>
                        <div style={{ fontSize: "40px", marginBottom: "12px" }}>🔒</div>
                        <p style={{ color: "#9ca3af", fontFamily: "'Orbitron', sans-serif", fontSize: "14px" }}>
                            BETTING CLOSED
                        </p>
                    </div>
                ) : (
                    <>
                        {/* Player Selection */}
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", marginBottom: "16px" }}>
                            {(["player1", "player2"] as const).map((player) => {
                                const isSelected = selectedPlayer === player;
                                const playerOdds = odds ? (player === "player1" ? odds.player1Odds : odds.player2Odds) : 2.0;
                                const percentage = odds ? (player === "player1" ? odds.player1Percentage : odds.player2Percentage) : 50;
                                const color = player === "player1" ? "#a78bfa" : "#6366f1";

                                return (
                                    <button
                                        key={player}
                                        onClick={() => setSelectedPlayer(player)}
                                        style={{
                                            padding: "12px",
                                            borderRadius: "8px",
                                            border: `2px solid ${isSelected ? color : "rgba(75, 85, 99, 0.3)"}`,
                                            background: isSelected ? `${color}22` : "rgba(17, 24, 39, 0.6)",
                                            cursor: "pointer",
                                            transition: "all 0.2s",
                                            textAlign: "center",
                                        }}
                                    >
                                        <p
                                            style={{
                                                color: isSelected ? color : "#d1d5db",
                                                fontFamily: "'Orbitron', sans-serif",
                                                fontSize: "12px",
                                                fontWeight: 700,
                                                overflow: "hidden",
                                                textOverflow: "ellipsis",
                                                whiteSpace: "nowrap",
                                            }}
                                        >
                                            {player === "player1" ? player1Name : player2Name}
                                        </p>
                                        <p style={{ color: "#6b7280", fontSize: "11px", marginTop: "4px" }}>
                                            {formatOdds(playerOdds)} • {percentage.toFixed(0)}%
                                        </p>
                                    </button>
                                );
                            })}
                        </div>

                        {/* Amount Input */}
                        <div style={{ marginBottom: "12px" }}>
                            <label style={{ fontSize: "11px", color: "#9ca3af", marginBottom: "4px", display: "block" }}>
                                Amount (XLM)
                            </label>
                            <input
                                type="number"
                                value={betAmount}
                                onChange={(e) => setBetAmount(e.target.value)}
                                placeholder="0.00"
                                min="0.01"
                                step="0.01"
                                style={{
                                    width: "100%",
                                    padding: "10px 12px",
                                    borderRadius: "8px",
                                    background: "rgba(17, 24, 39, 0.8)",
                                    border: "1px solid #374151",
                                    color: "#fff",
                                    fontSize: "16px",
                                    fontFamily: "'Orbitron', sans-serif",
                                    outline: "none",
                                    boxSizing: "border-box",
                                }}
                            />
                        </div>

                        {/* Quick Bets */}
                        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginBottom: "16px" }}>
                            {QUICK_BETS.map((amount) => (
                                <button
                                    key={amount}
                                    onClick={() => setBetAmount(String(amount))}
                                    style={{
                                        padding: "4px 10px",
                                        borderRadius: "6px",
                                        background: "rgba(17, 24, 39, 0.8)",
                                        border: "1px solid #374151",
                                        color: "#d1d5db",
                                        fontSize: "12px",
                                        cursor: "pointer",
                                        transition: "all 0.2s",
                                    }}
                                >
                                    {amount} XLM
                                </button>
                            ))}
                        </div>

                        {/* Potential Winnings */}
                        {potentialWinnings && parseFloat(betAmount) > 0 && (
                            <div
                                style={{
                                    padding: "10px 12px",
                                    borderRadius: "8px",
                                    background: "rgba(34, 197, 94, 0.1)",
                                    border: "1px solid rgba(34, 197, 94, 0.3)",
                                    marginBottom: "16px",
                                }}
                            >
                                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px" }}>
                                    <span style={{ color: "#9ca3af" }}>Potential Payout</span>
                                    <span style={{ color: "#22c55e", fontWeight: 700 }}>{formatXlm(potentialWinnings.payout)}</span>
                                </div>
                                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", marginTop: "4px" }}>
                                    <span style={{ color: "#9ca3af" }}>Profit</span>
                                    <span style={{ color: "#22c55e" }}>+{formatXlm(potentialWinnings.profit)}</span>
                                </div>
                            </div>
                        )}

                        {/* Error */}
                        {error && (
                            <p style={{ color: "#ef4444", fontSize: "12px", marginBottom: "8px", textAlign: "center" }}>
                                {error}
                            </p>
                        )}

                        {/* Place Bet Button */}
                        <button
                            onClick={handlePlaceBet}
                            disabled={!selectedPlayer || !betAmount || placing}
                            style={{
                                width: "100%",
                                padding: "12px",
                                borderRadius: "8px",
                                background: selectedPlayer
                                    ? "linear-gradient(to right, #8b5cf6, #6366f1)"
                                    : "rgba(75, 85, 99, 0.5)",
                                color: "#fff",
                                fontFamily: "'Orbitron', sans-serif",
                                fontSize: "14px",
                                fontWeight: 700,
                                letterSpacing: "0.08em",
                                border: "none",
                                cursor: selectedPlayer && betAmount && !placing ? "pointer" : "not-allowed",
                                opacity: selectedPlayer && betAmount && !placing ? 1 : 0.5,
                                transition: "all 0.2s",
                            }}
                        >
                            {placing ? "PLACING..." : "PLACE BET"}
                        </button>
                    </>
                )}
            </div>
        </div>
    );
}
