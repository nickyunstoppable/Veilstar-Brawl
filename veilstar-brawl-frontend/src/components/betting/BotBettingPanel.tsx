/**
 * BotBettingPanel Component
 * Betting panel for bot matches with countdown timer
 */

import React, { useState, useCallback, useEffect } from "react";
import {
    formatXlm,
    formatOdds,
    xlmToStroops,
    calculateHouseFee,
    calculateHousePayout,
    calculateHouseTotalCost,
} from "../../lib/betting/betting-service";
import { useWalletStandalone } from "../../hooks/useWalletStandalone";
import { claimPayoutOnChain, commitBetOnChain, revealBetOnChain } from "../../lib/betting/zk-betting-service";

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:3001";

const QUICK_BETS = [1, 5, 10, 25, 50, 100];

interface BotBettingPanelProps {
    matchId: string;
    bot1Name: string;
    bot2Name: string;
    bettingSecondsRemaining: number;
    isBettingOpen: boolean;
}

export function BotBettingPanel({ matchId, bot1Name, bot2Name, bettingSecondsRemaining, isBettingOpen }: BotBettingPanelProps) {
    const { publicKey, isConnected, isConnecting, connect, getContractSigner } = useWalletStandalone();
    const [selectedBot, setSelectedBot] = useState<"player1" | "player2" | null>(null);
    const [betAmount, setBetAmount] = useState("");
    const [placing, setPlacing] = useState(false);
    const [betPlaced, setBetPlaced] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [revealing, setRevealing] = useState(false);
    const [claiming, setClaiming] = useState(false);
    const [onchainPoolId, setOnchainPoolId] = useState<number | null>(null);
    const [userBet, setUserBet] = useState<any | null>(null);

    const bettorAddress = publicKey || localStorage.getItem("stellar_address") || null;

    useEffect(() => {
        if (publicKey) {
            localStorage.setItem("stellar_address", publicKey);
        }
    }, [publicKey]);

    // Fetch pool data
    useEffect(() => {
        const fetchPool = async () => {
            try {
                const poolUrl = bettorAddress
                    ? `${API_BASE}/api/bot-betting/pool/${matchId}?address=${encodeURIComponent(bettorAddress)}`
                    : `${API_BASE}/api/bot-betting/pool/${matchId}`;
                const response = await fetch(poolUrl);
                if (response.ok) {
                    const data = await response.json();
                    if (data.pool) {
                        setOnchainPoolId(Number(data.pool.onchain_pool_id || 0) || null);
                    }
                    setUserBet(data.userBet || null);
                    setBetPlaced(Boolean(data.userBet));
                    setError(null);
                } else {
                    setError("Betting service unavailable");
                }
            } catch (err) {
                setError("Betting service unavailable");
            }
        };

        fetchPool();
        const interval = setInterval(fetchPool, 3000);
        return () => clearInterval(interval);
    }, [matchId, bettorAddress]);

    // Reset when match changes
    useEffect(() => {
        setSelectedBot(null);
        setBetAmount("");
        setBetPlaced(false);
        setError(null);
        setUserBet(null);
        setOnchainPoolId(null);
    }, [matchId]);

    const handlePlaceBet = useCallback(async () => {
        if (!selectedBot || !betAmount || placing) return;

        const amount = parseFloat(betAmount);
        if (isNaN(amount) || amount <= 0) {
            setError("Invalid bet amount");
            return;
        }

        setPlacing(true);
        setError(null);

        try {
            let address = bettorAddress;
            if (!address) {
                await connect();
                address = localStorage.getItem("stellar_address") || publicKey || null;
            }

            if (!address) {
                throw new Error("Connect your wallet to place a bet");
            }

            if (!onchainPoolId) {
                throw new Error("On-chain pool not ready yet. Please try again in a moment.");
            }

            let contractSigner;
            try {
                contractSigner = getContractSigner();
            } catch {
                contractSigner = undefined;
            }
            if (!contractSigner) {
                throw new Error("Wallet signer unavailable. Reconnect wallet and try again.");
            }

            const onchainCommit = await commitBetOnChain({
                poolId: onchainPoolId,
                bettor: address,
                side: selectedBot,
                amount: xlmToStroops(amount),
                signer: contractSigner,
            });

            const response = await fetch(`${API_BASE}/api/bot-betting/place`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    matchId,
                    betOn: selectedBot,
                    amount: Number(xlmToStroops(amount)),
                    bettorAddress: address,
                    onchainPoolId,
                    txId: onchainCommit.txHash,
                    commitmentHash: onchainCommit.commitmentHex,
                    revealSalt: onchainCommit.saltHex,
                }),
            });

            if (!response.ok) {
                const data = await response.json();
                throw new Error(data.error || "Failed to place bet");
            }

            const payload = await response.json();
            setBetPlaced(true);
            if (payload?.bet) {
                setUserBet(payload.bet);
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to place bet");
        } finally {
            setPlacing(false);
        }
    }, [selectedBot, betAmount, matchId, placing, bettorAddress, connect, publicKey, onchainPoolId, getContractSigner]);

    const handleRevealBet = useCallback(async () => {
        if (!userBet || revealing) return;
        setRevealing(true);
        setError(null);
        try {
            const address = bettorAddress;
            if (!address) throw new Error("Connect wallet first");
            if (!onchainPoolId) throw new Error("On-chain pool missing");
            if (!userBet.reveal_salt) throw new Error("Missing reveal salt for this bet");

            let contractSigner;
            try {
                contractSigner = getContractSigner();
            } catch {
                contractSigner = undefined;
            }
            if (!contractSigner) throw new Error("Wallet signer unavailable");

            const revealed = await revealBetOnChain({
                poolId: onchainPoolId,
                bettor: address,
                side: userBet.bet_on,
                saltHex: userBet.reveal_salt,
                signer: contractSigner,
            });

            await fetch(`${API_BASE}/api/bot-betting/reveal`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    matchId,
                    bettorAddress: address,
                    revealTxId: revealed.txHash,
                }),
            });

            setUserBet((prev: any) => prev ? { ...prev, revealed: true, reveal_tx_id: revealed.txHash } : prev);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to reveal bet");
        } finally {
            setRevealing(false);
        }
    }, [userBet, revealing, bettorAddress, onchainPoolId, matchId, getContractSigner]);

    const handleClaimPayout = useCallback(async () => {
        if (!userBet || claiming) return;
        setClaiming(true);
        setError(null);
        try {
            const address = bettorAddress;
            if (!address) throw new Error("Connect wallet first");
            if (!onchainPoolId) throw new Error("On-chain pool missing");

            let contractSigner;
            try {
                contractSigner = getContractSigner();
            } catch {
                contractSigner = undefined;
            }
            if (!contractSigner) throw new Error("Wallet signer unavailable");

            const claimed = await claimPayoutOnChain({
                poolId: onchainPoolId,
                bettor: address,
                signer: contractSigner,
            });

            await fetch(`${API_BASE}/api/bot-betting/claim`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    matchId,
                    bettorAddress: address,
                    claimTxId: claimed.txHash,
                    payoutAmount: claimed.payoutAmount ? claimed.payoutAmount.toString() : null,
                }),
            });

            setUserBet((prev: any) => prev ? {
                ...prev,
                claim_tx_id: claimed.txHash,
                payout_amount: claimed.payoutAmount ? claimed.payoutAmount.toString() : prev.payout_amount,
            } : prev);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to claim payout");
        } finally {
            setClaiming(false);
        }
    }, [userBet, claiming, bettorAddress, onchainPoolId, matchId, getContractSigner]);

    const stakeAmount = betAmount ? xlmToStroops(parseFloat(betAmount) || 0) : 0n;
    const houseFee = stakeAmount > 0n ? calculateHouseFee(stakeAmount) : 0n;
    const totalCost = stakeAmount > 0n ? calculateHouseTotalCost(stakeAmount) : 0n;
    const housePayout = stakeAmount > 0n ? calculateHousePayout(stakeAmount) : 0n;

    const canBet = isBettingOpen && !betPlaced;
    const canReveal = !isBettingOpen && !!betPlaced && !!userBet && !userBet.revealed;
    const canClaim = !!userBet && userBet.revealed && userBet.status === "won" && !userBet.claim_tx_id;

    // Countdown timer display
    const minutes = Math.floor(bettingSecondsRemaining / 60);
    const seconds = bettingSecondsRemaining % 60;
    const timerDisplay = `${minutes}:${String(seconds).padStart(2, "0")}`;
    const isTimeLow = bettingSecondsRemaining <= 10;

    return (
        <div
            style={{
                borderRadius: "12px",
                background: "rgba(0, 0, 0, 0.6)",
                border: `1px solid ${isTimeLow && canBet ? "rgba(239, 68, 68, 0.4)" : "rgba(249, 115, 22, 0.25)"}`,
                backdropFilter: "blur(12px)",
                overflow: "hidden",
                transition: "border-color 0.3s",
            }}
        >
            {/* Header */}
            <div
                style={{
                    padding: "14px 16px",
                    background: "linear-gradient(to right, rgba(249, 115, 22, 0.2), rgba(234, 179, 8, 0.1), transparent)",
                    borderBottom: "1px solid rgba(249, 115, 22, 0.2)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                }}
            >
                <span
                    style={{
                        color: "#fb923c",
                        fontFamily: "'Orbitron', sans-serif",
                        fontSize: "13px",
                        fontWeight: 700,
                        letterSpacing: "0.08em",
                    }}
                >
                    🤖 BOT BETTING
                </span>
                {/* Countdown */}
                {canBet && (
                    <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                        <div
                            style={{
                                width: "8px",
                                height: "8px",
                                borderRadius: "50%",
                                background: isTimeLow ? "#ef4444" : "#22c55e",
                                animation: isTimeLow ? "pulse 0.5s infinite" : "pulse 2s infinite",
                            }}
                        />
                        <span
                            style={{
                                fontFamily: "'Orbitron', sans-serif",
                                fontSize: "14px",
                                fontWeight: 700,
                                color: isTimeLow ? "#ef4444" : "#22c55e",
                            }}
                        >
                            {timerDisplay}
                        </span>
                    </div>
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
                            Watch the battle to see the result!
                        </p>

                        {canReveal && (
                            <button
                                onClick={handleRevealBet}
                                disabled={revealing || isConnecting}
                                style={{
                                    width: "100%",
                                    padding: "10px",
                                    borderRadius: "8px",
                                    marginTop: "12px",
                                    background: "rgba(59, 130, 246, 0.2)",
                                    color: "#93c5fd",
                                    fontFamily: "'Orbitron', sans-serif",
                                    fontSize: "13px",
                                    fontWeight: 700,
                                    border: "1px solid rgba(59, 130, 246, 0.45)",
                                    cursor: revealing || isConnecting ? "not-allowed" : "pointer",
                                    opacity: revealing || isConnecting ? 0.6 : 1,
                                }}
                            >
                                {revealing ? "REVEALING..." : "REVEAL BET"}
                            </button>
                        )}

                        {canClaim && (
                            <button
                                onClick={handleClaimPayout}
                                disabled={claiming || isConnecting}
                                style={{
                                    width: "100%",
                                    padding: "10px",
                                    borderRadius: "8px",
                                    marginTop: "8px",
                                    background: "rgba(34, 197, 94, 0.2)",
                                    color: "#22c55e",
                                    fontFamily: "'Orbitron', sans-serif",
                                    fontSize: "13px",
                                    fontWeight: 700,
                                    border: "1px solid rgba(34, 197, 94, 0.45)",
                                    cursor: claiming || isConnecting ? "not-allowed" : "pointer",
                                    opacity: claiming || isConnecting ? 0.6 : 1,
                                }}
                            >
                                {claiming ? "CLAIMING..." : "CLAIM PAYOUT"}
                            </button>
                        )}
                    </div>
                ) : !isBettingOpen ? (
                    <div style={{ textAlign: "center", padding: "24px 0" }}>
                        <div style={{ fontSize: "40px", marginBottom: "12px" }}>🔒</div>
                        <p style={{ color: "#9ca3af", fontFamily: "'Orbitron', sans-serif", fontSize: "14px" }}>
                            BETTING CLOSED
                        </p>
                        <p style={{ color: "#6b7280", fontSize: "12px", marginTop: "8px" }}>
                            Wait for the next match to bet
                        </p>
                    </div>
                ) : (
                    <>
                        {/* Bot Selection */}
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", marginBottom: "16px" }}>
                            {(["player1", "player2"] as const).map((bot) => {
                                const isSelected = selectedBot === bot;
                                const botOdds = 2.0;
                                const percentage = 50;
                                const name = bot === "player1" ? bot1Name : bot2Name;
                                const color = bot === "player1" ? "#fb923c" : "#fbbf24";

                                return (
                                    <button
                                        key={bot}
                                        onClick={() => setSelectedBot(bot)}
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
                                        <p style={{ fontSize: "16px", marginBottom: "4px" }}>🤖</p>
                                        <p
                                            style={{
                                                color: isSelected ? color : "#d1d5db",
                                                fontFamily: "'Orbitron', sans-serif",
                                                fontSize: "11px",
                                                fontWeight: 700,
                                                overflow: "hidden",
                                                textOverflow: "ellipsis",
                                                whiteSpace: "nowrap",
                                            }}
                                        >
                                            {name}
                                        </p>
                                        <p style={{ color: "#6b7280", fontSize: "11px", marginTop: "4px" }}>
                                            {formatOdds(botOdds)} • {percentage.toFixed(0)}%
                                        </p>
                                    </button>
                                );
                            })}
                        </div>

                        <div
                            style={{
                                padding: "8px 10px",
                                borderRadius: "8px",
                                background: "rgba(249, 115, 22, 0.08)",
                                border: "1px solid rgba(249, 115, 22, 0.3)",
                                color: "#fdba74",
                                fontSize: "11px",
                                marginBottom: "12px",
                                textAlign: "center",
                            }}
                        >
                            House odds: 2.00x • Fee: 1% (you pay stake + fee)
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
                                    }}
                                >
                                    {amount} XLM
                                </button>
                            ))}
                        </div>

                        {/* Potential Winnings */}
                        {stakeAmount > 0n && parseFloat(betAmount) > 0 && (
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
                                    <span style={{ color: "#9ca3af" }}>Potential Payout (2x)</span>
                                    <span style={{ color: "#22c55e", fontWeight: 700 }}>{formatXlm(housePayout)}</span>
                                </div>
                                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", marginTop: "4px" }}>
                                    <span style={{ color: "#9ca3af" }}>Fee (1%)</span>
                                    <span style={{ color: "#f59e0b", fontWeight: 700 }}>{formatXlm(houseFee)}</span>
                                </div>
                                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", marginTop: "4px" }}>
                                    <span style={{ color: "#9ca3af" }}>Total Charged</span>
                                    <span style={{ color: "#e5e7eb", fontWeight: 700 }}>{formatXlm(totalCost)}</span>
                                </div>
                            </div>
                        )}

                        {/* Error */}
                        {error && (
                            <p style={{ color: "#ef4444", fontSize: "12px", marginBottom: "8px", textAlign: "center" }}>{error}</p>
                        )}

                        {/* Place Bet */}
                        <button
                            onClick={handlePlaceBet}
                            disabled={!selectedBot || !betAmount || placing || isConnecting}
                            style={{
                                width: "100%",
                                padding: "12px",
                                borderRadius: "8px",
                                background: selectedBot
                                    ? "linear-gradient(to right, #f97316, #f59e0b)"
                                    : "rgba(75, 85, 99, 0.5)",
                                color: "#fff",
                                fontFamily: "'Orbitron', sans-serif",
                                fontSize: "14px",
                                fontWeight: 700,
                                letterSpacing: "0.08em",
                                border: "none",
                                cursor: selectedBot && betAmount && !placing && !isConnecting ? "pointer" : "not-allowed",
                                opacity: selectedBot && betAmount && !placing && !isConnecting ? 1 : 0.5,
                            }}
                        >
                            {isConnecting
                                ? "CONNECTING WALLET..."
                                : placing
                                    ? "PLACING..."
                                    : isConnected
                                        ? "PLACE BET"
                                        : "CONNECT WALLET & BET"}
                        </button>

                        {canReveal && (
                            <button
                                onClick={handleRevealBet}
                                disabled={revealing || isConnecting}
                                style={{
                                    width: "100%",
                                    padding: "10px",
                                    borderRadius: "8px",
                                    marginTop: "8px",
                                    background: "rgba(59, 130, 246, 0.2)",
                                    color: "#93c5fd",
                                    fontFamily: "'Orbitron', sans-serif",
                                    fontSize: "13px",
                                    fontWeight: 700,
                                    border: "1px solid rgba(59, 130, 246, 0.45)",
                                    cursor: revealing || isConnecting ? "not-allowed" : "pointer",
                                    opacity: revealing || isConnecting ? 0.6 : 1,
                                }}
                            >
                                {revealing ? "REVEALING..." : "REVEAL BET"}
                            </button>
                        )}

                        {canClaim && (
                            <button
                                onClick={handleClaimPayout}
                                disabled={claiming || isConnecting}
                                style={{
                                    width: "100%",
                                    padding: "10px",
                                    borderRadius: "8px",
                                    marginTop: "8px",
                                    background: "rgba(34, 197, 94, 0.2)",
                                    color: "#22c55e",
                                    fontFamily: "'Orbitron', sans-serif",
                                    fontSize: "13px",
                                    fontWeight: 700,
                                    border: "1px solid rgba(34, 197, 94, 0.45)",
                                    cursor: claiming || isConnecting ? "not-allowed" : "pointer",
                                    opacity: claiming || isConnecting ? 0.6 : 1,
                                }}
                            >
                                {claiming ? "CLAIMING..." : "CLAIM PAYOUT"}
                            </button>
                        )}
                    </>
                )}
            </div>

            <style>{`
                @keyframes pulse {
                    0%, 100% { opacity: 1; }
                    50% { opacity: 0.3; }
                }
            `}</style>
        </div>
    );
}
