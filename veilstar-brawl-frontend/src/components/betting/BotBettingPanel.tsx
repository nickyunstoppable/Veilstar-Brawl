/**
 * BotBettingPanel Component
 * Betting panel for bot matches with countdown timer
 */

import React, { useState, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { HugeiconsIcon } from "@hugeicons/react";
import { LockKeyIcon, Tick02Icon, Time03Icon, RoboticIcon } from "@hugeicons/core-free-icons";
import {
    formatXlm,
    xlmToStroops,
    calculateHouseFee,
    calculateHousePayout,
    calculateHouseTotalCost,
} from "../../lib/betting/betting-service";
import { useWalletStandalone } from "../../hooks/useWalletStandalone";
import { commitBetOnChain } from "../../lib/betting/zk-betting-service";
import { ClashShardsIcon } from "../currency/ClashShardsIcon";

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:3001";
const BOT_MATCH_SIDE_CACHE_KEY = "bot_betting_match_side_cache_v1";
const BOT_MATCH_SIDE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const QUICK_BETS = [1, 5, 10, 25, 50, 100];

interface BotBettingPanelProps {
    matchId: string;
    bot1Name: string;
    bot2Name: string;
    bettingSecondsRemaining: number;
    isBettingOpen: boolean;
}

function writeMatchSideCache(matchId: string, side: "player1" | "player2", amountStroops?: number | string | null) {
    try {
        const now = Date.now();
        const raw = localStorage.getItem(BOT_MATCH_SIDE_CACHE_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        const source = parsed && typeof parsed === "object" ? parsed : {};
        const prunedEntries = Object.entries(source).filter(([, value]) => {
            const entry = value as { ts?: unknown };
            const ts = Number(entry?.ts);
            return Number.isFinite(ts) && now - ts <= BOT_MATCH_SIDE_CACHE_TTL_MS;
        });
        const pruned = Object.fromEntries(prunedEntries);
        const next = {
            ...pruned,
            [matchId]: {
                side,
                amount: amountStroops ?? null,
                ts: now,
            },
        };
        localStorage.setItem(BOT_MATCH_SIDE_CACHE_KEY, JSON.stringify(next));
    } catch {
        // Ignore cache write issues
    }
}

export function BotBettingPanel({ matchId, bot1Name, bot2Name, bettingSecondsRemaining, isBettingOpen }: BotBettingPanelProps) {
    const { publicKey, isConnected, isConnecting, connect, getContractSigner } = useWalletStandalone();
    const [selectedBot, setSelectedBot] = useState<"player1" | "player2" | null>(null);
    const [betAmount, setBetAmount] = useState("");
    const [placing, setPlacing] = useState(false);
    const [betPlaced, setBetPlaced] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);
    const [forceClosed, setForceClosed] = useState(false);
    const [forceClosedReason, setForceClosedReason] = useState<string | null>(null);
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
                    if (data.userBet?.bet_on === "player1" || data.userBet?.bet_on === "player2") {
                        writeMatchSideCache(matchId, data.userBet.bet_on, data.userBet?.amount ?? null);
                    }
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
        setSuccess(null);
        setForceClosed(false);
        setForceClosedReason(null);
        setUserBet(null);
        setOnchainPoolId(null);
    }, [matchId]);

    const handlePlaceBet = useCallback(async () => {
        if (!selectedBot || !betAmount || placing) return;

        if (!isBettingOpen || bettingSecondsRemaining <= 0) {
            setError("Betting already closed for this match");
            return;
        }

        const amount = parseFloat(betAmount);
        if (isNaN(amount) || amount <= 0) {
            setError("Invalid bet amount");
            return;
        }

        setPlacing(true);
        setError(null);
        setSuccess(null);

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

            const activeMatchRes = await fetch(`${API_BASE}/api/bot-games?matchId=${encodeURIComponent(matchId)}`);
            if (!activeMatchRes.ok) {
                throw new Error("Unable to verify active match. Please try again.");
            }
            const activeMatchPayload = await activeMatchRes.json();
            const activeMatch = activeMatchPayload?.match;
            if (!activeMatch || activeMatch.id !== matchId) {
                throw new Error("This match has expired. Wait for the next bot match.");
            }
            const elapsedMs = Date.now() - Number(activeMatch.createdAt || 0);
            if (!Number.isFinite(elapsedMs) || elapsedMs >= 30000) {
                throw new Error("Betting window closed. Wait for the next match.");
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
            setSuccess("Bet placed successfully");
            if (payload?.bet) {
                setUserBet(payload.bet);
                if (payload.bet?.bet_on === "player1" || payload.bet?.bet_on === "player2") {
                    writeMatchSideCache(matchId, payload.bet.bet_on, payload.bet?.amount ?? null);
                }
            } else {
                writeMatchSideCache(matchId, selectedBot, Number(xlmToStroops(amount)));
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to place bet";
            setError(message);
            if (message.toLowerCase().includes("deadline passed") || message.toLowerCase().includes("betting window closed")) {
                setForceClosed(true);
                setForceClosedReason("Betting closed for this round");
            }
        } finally {
            setPlacing(false);
        }
    }, [selectedBot, betAmount, placing, isBettingOpen, bettingSecondsRemaining, bettorAddress, connect, publicKey, onchainPoolId, matchId, getContractSigner]);

    const stakeAmount = betAmount ? xlmToStroops(parseFloat(betAmount) || 0) : 0n;
    const houseFee = stakeAmount > 0n ? calculateHouseFee(stakeAmount) : 0n;
    const totalCost = stakeAmount > 0n ? calculateHouseTotalCost(stakeAmount) : 0n;
    const housePayout = stakeAmount > 0n ? calculateHousePayout(stakeAmount) : 0n;

    const canBet = isBettingOpen && !forceClosed && !betPlaced;
    const hasClaimRecorded = Boolean(userBet?.claim_tx_id);
    const autoSettling = !!userBet && !isBettingOpen && !userBet.revealed;
    const autoClaiming = !!userBet && userBet.revealed && userBet.status === "won" && !hasClaimRecorded;

    // Countdown timer display
    const minutes = Math.floor(bettingSecondsRemaining / 60);
    const seconds = bettingSecondsRemaining % 60;
    const timerDisplay = `${minutes}:${String(seconds).padStart(2, "0")}`;
    const isTimeLow = bettingSecondsRemaining <= 10;

    if (!canBet && !betPlaced) {
        return (
            <div className="bg-black/60 backdrop-blur-sm rounded-xl border border-gray-600/30 p-4">
                <div className="text-center">
                    <div className="text-red-400 font-orbitron text-sm mb-2 flex items-center justify-center gap-2">
                        <HugeiconsIcon icon={LockKeyIcon} className="w-4 h-4" /> BETTING CLOSED
                    </div>
                    <div className="mt-3 text-xs text-gray-500">
                        {forceClosedReason || "Wait for the next match to place bets"}
                    </div>
                </div>
            </div>
        );
    }

    return (
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-black/60 backdrop-blur-sm rounded-xl border border-orange-500/30 p-3 sm:p-4"
        >
            {/* Header */}
            <div className="flex items-center justify-between mb-4">
                <h3 className="text-orange-400 font-orbitron text-xs sm:text-sm font-bold tracking-wider flex items-center gap-2">
                    <ClashShardsIcon className="w-4 h-4 sm:w-5 sm:h-5" /> BOT BETTING
                </h3>
                <div className="flex items-center gap-2">
                    <HugeiconsIcon icon={Time03Icon} className="w-4 h-4 text-orange-400" />
                    <span className={`text-xs font-mono font-bold ${isTimeLow ? "text-red-400" : bettingSecondsRemaining <= 10 ? "text-yellow-400" : "text-green-400"}`}>
                        {timerDisplay}
                    </span>
                </div>
            </div>

            {/* House Model Badge */}
            <div className="mb-4 p-2 bg-gradient-to-r from-yellow-500/10 to-orange-500/10 rounded-lg border border-yellow-500/30">
                <div className="text-center">
                    <div className="text-yellow-400 font-orbitron text-lg font-bold">2x PAYOUT</div>
                    <div className="text-xs text-gray-400">Fixed odds • 1% fee • Win double your bet!</div>
                </div>
            </div>

            {betPlaced ? (
                <div className="text-center py-5">
                    <div className="text-4xl mb-2">✅</div>
                    <p className="text-green-400 font-orbitron text-sm font-bold">
                        BET PLACED!
                    </p>
                    <p className="text-gray-400 text-xs mt-2">
                        Watch the battle to see the result!
                    </p>

                    {autoSettling && (
                        <p className="text-blue-300 text-xs mt-3">
                            Settling bet automatically...
                        </p>
                    )}
                    {autoClaiming && (
                        <p className="text-green-400 text-xs mt-3">
                            Processing payout automatically...
                        </p>
                    )}
                    {hasClaimRecorded && (
                        <p className="text-green-400 text-xs mt-3">
                            Payout completed ✅
                        </p>
                    )}
                </div>
            ) : (
                <>
                    {/* Bot Selection */}
                    <div className="grid grid-cols-2 gap-2 sm:gap-3 mb-4">
                        <button
                            onClick={() => setSelectedBot("player1")}
                            className={`relative p-2 sm:p-3 rounded-lg border-2 transition-all ${selectedBot === "player1"
                                ? "border-orange-400 bg-orange-500/20"
                                : "border-gray-700 bg-gray-800/50 hover:border-orange-400/50"
                                }`}
                        >
                            <div className="text-xs text-gray-400 mb-1 truncate flex items-center justify-center gap-1">
                                <HugeiconsIcon icon={RoboticIcon} className="w-3 h-3" /> {bot1Name}
                            </div>
                            <div className="text-lg sm:text-xl font-bold text-orange-400 font-orbitron">
                                2.00x
                            </div>
                            <div className="text-xs text-gray-500">Win double!</div>
                        </button>

                        <button
                            onClick={() => setSelectedBot("player2")}
                            className={`relative p-2 sm:p-3 rounded-lg border-2 transition-all ${selectedBot === "player2"
                                ? "border-cyan-400 bg-cyan-500/20"
                                : "border-gray-700 bg-gray-800/50 hover:border-cyan-400/50"
                                }`}
                        >
                            <div className="text-xs text-gray-400 mb-1 truncate flex items-center justify-center gap-1">
                                <HugeiconsIcon icon={RoboticIcon} className="w-3 h-3" /> {bot2Name}
                            </div>
                            <div className="text-lg sm:text-xl font-bold text-cyan-400 font-orbitron">
                                2.00x
                            </div>
                            <div className="text-xs text-gray-500">Win double!</div>
                        </button>
                    </div>

                    <div className="mb-4">
                        <label className="text-xs text-gray-400 mb-2 block">Bet Amount (XLM)</label>
                        <input
                            type="number"
                            min="0.01"
                            step="0.01"
                            value={betAmount}
                            onChange={(e) => setBetAmount(e.target.value)}
                            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white font-orbitron focus:border-orange-500 focus:outline-none"
                        />

                        <div className="flex gap-1 flex-wrap mt-2">
                            {QUICK_BETS.map((amount) => (
                                <button
                                    key={amount}
                                    onClick={() => setBetAmount(String(amount))}
                                    className="px-2 py-1 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-300"
                                >
                                    {amount} XLM
                                </button>
                            ))}
                        </div>
                    </div>

                    {stakeAmount > 0n && parseFloat(betAmount) > 0 && (
                        <div className="bg-gradient-to-r from-green-500/10 to-emerald-500/10 rounded-lg p-3 mb-4 border border-green-500/30">
                            <div className="flex justify-between items-center">
                                <div>
                                    <div className="text-xs text-gray-400 mb-1">If you win</div>
                                    <div className="text-xl font-bold text-green-400 font-orbitron">
                                        {formatXlm(housePayout)}
                                    </div>
                                </div>
                                <div className="text-right">
                                    <div className="text-xs text-gray-500">You send</div>
                                    <div className="text-xs text-orange-400 font-mono">
                                        {formatXlm(totalCost)}
                                    </div>
                                    <div className="text-xs text-gray-500 mt-1">
                                        (stake + {formatXlm(houseFee)} fee)
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    <AnimatePresence>
                        {error && (
                            <motion.div
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                className="text-red-400 text-sm mb-3 p-2 bg-red-500/10 rounded"
                            >
                                {error}
                            </motion.div>
                        )}
                        {success && (
                            <motion.div
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                className="text-green-400 text-sm mb-3 p-2 bg-green-500/10 rounded flex items-center gap-2"
                            >
                                <HugeiconsIcon icon={Tick02Icon} className="w-4 h-4" /> {success}
                            </motion.div>
                        )}
                    </AnimatePresence>

                    <button
                        onClick={handlePlaceBet}
                        disabled={!selectedBot || !betAmount || placing || isConnecting}
                        className="w-full bg-gradient-to-r from-orange-500 to-orange-600 text-white font-orbitron hover:opacity-90 disabled:opacity-50 rounded-lg py-3 font-bold"
                    >
                        {isConnecting
                            ? "CONNECTING WALLET..."
                            : placing
                                ? "PLACING BET..."
                                : isConnected
                                    ? `Bet ${betAmount || "0"} XLM on ${selectedBot === "player1" ? bot1Name : bot2Name}`
                                    : "CONNECT WALLET"}
                    </button>

                    <div className="text-center text-xs text-gray-500 mt-2">
                        House betting • Fixed 2x payout • 1% fee
                    </div>

                    {autoSettling && (
                        <p className="text-blue-300 text-xs mt-2 text-center">
                            Settling bet automatically...
                        </p>
                    )}
                    {autoClaiming && (
                        <p className="text-green-400 text-xs mt-2 text-center">
                            Processing payout automatically...
                        </p>
                    )}
                </>
            )}
        </motion.div>
    );
}
