import React, { useEffect, useState, useCallback } from "react";
import { motion } from "framer-motion";
import { HugeiconsIcon } from "@hugeicons/react";
import { RoboticIcon, DiceFaces03Icon } from "@hugeicons/core-free-icons";
import GameLayout from "../components/layout/GameLayout";
import { getCharacter } from "../data/characters";
import { useWalletStandalone } from "../hooks/useWalletStandalone";

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:3001";

interface BetHistoryItem {
    id: string;
    matchId: string;
    matchType: "bot";
    player1Name: string;
    player2Name: string;
    player1CharacterId: string;
    player2CharacterId: string;
    betOn: "player1" | "player2";
    amount: string;
    feeAmount: string;
    netAmount: string;
    payoutAmount: string | null;
    status: string;
    winner: "player1" | "player2" | null;
    createdAt: string;
    paidAt: string | null;
    txId: string;
    payoutTxId: string | null;
}

interface BetStats {
    totalBets: number;
    wonBets: number;
    lostBets: number;
    pendingBets: number;
    totalWagered: string;
    totalWon: string;
}

function sompiToXlm(sompi: string): number {
    return Number(BigInt(sompi || "0")) / 10_000_000;
}

function formatDate(dateString: string): string {
    const date = new Date(dateString);
    return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function truncateTxId(txId: string): string {
    if (!txId) return "";
    if (txId.length <= 16) return txId;
    return `${txId.slice(0, 8)}...${txId.slice(-8)}`;
}

function getStellarExpertTestnetTxUrl(txId: string): string {
    return `https://stellar.expert/explorer/testnet/tx/${encodeURIComponent(txId)}`;
}

function navigate(path: string) {
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
}

function getStatusColor(status: string): string {
    switch (status) {
        case "won":
            return "text-green-400";
        case "lost":
            return "text-red-400";
        case "confirmed":
            return "text-yellow-400";
        case "pending":
            return "text-gray-400";
        default:
            return "text-gray-400";
    }
}

export default function BetHistoryPage() {
    const [history, setHistory] = useState<BetHistoryItem[]>([]);
    const [stats, setStats] = useState<BetStats | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [page, setPage] = useState(0);
    const [hasMore, setHasMore] = useState(false);

    const { publicKey, isConnected, isConnecting, connect } = useWalletStandalone();
    const ITEMS_PER_PAGE = 10;

    const walletAddress = publicKey || localStorage.getItem("stellar_address") || null;

    const fetchHistory = useCallback(async () => {
        if (!walletAddress) {
            setLoading(false);
            return;
        }

        setLoading(true);
        setError(null);

        try {
            const offset = page * ITEMS_PER_PAGE;
            const response = await fetch(
                `${API_BASE}/api/bot-betting/history?address=${encodeURIComponent(walletAddress)}&limit=${ITEMS_PER_PAGE}&offset=${offset}`
            );

            if (!response.ok) {
                throw new Error("Failed to fetch bet history");
            }

            const data = await response.json();
            if (!data.success) {
                throw new Error(data.error || "Failed to load history");
            }

            setHistory(data.history || []);
            setStats(data.stats || null);
            setHasMore(Boolean(data.pagination?.hasMore));
        } catch (err) {
            console.error("[BetHistoryPage] Error fetching history:", err);
            setError(err instanceof Error ? err.message : "Failed to load history");
        } finally {
            setLoading(false);
        }
    }, [walletAddress, page]);

    useEffect(() => {
        fetchHistory();
    }, [fetchHistory]);

    if (!walletAddress) {
        return (
            <GameLayout>
                <div className="container mx-auto px-6 lg:px-12 xl:px-24 py-10">
                    <div className="text-center py-20 max-w-xl mx-auto bg-black/40 border border-cyber-gold/30 rounded-2xl">
                        <h2 className="text-3xl font-orbitron text-cyber-gold mb-4">Wallet Not Connected</h2>
                        <p className="text-cyber-gray mb-8">Connect your wallet to view your bot bet history.</p>
                        <div className="flex items-center justify-center gap-3">
                            <button
                                onClick={() => navigate("/spectate")}
                                className="bg-white/10 text-white border border-white/20 font-orbitron px-5 py-2.5 rounded-lg cursor-pointer"
                            >
                                Back to Spectate
                            </button>
                            <button
                                onClick={() => connect()}
                                disabled={isConnecting || isConnected}
                                className="bg-gradient-cyber text-white border-0 font-orbitron px-5 py-2.5 rounded-lg cursor-pointer disabled:opacity-60"
                            >
                                {isConnecting ? "CONNECTING..." : "CONNECT WALLET"}
                            </button>
                        </div>
                    </div>
                </div>
            </GameLayout>
        );
    }

    return (
        <GameLayout>
            <div className="container mx-auto px-6 lg:px-12 xl:px-24 py-6">
                <div className="mb-8 text-center">
                    <h1 className="text-4xl lg:text-[52px] font-bold leading-tight mb-4 font-orbitron text-white">
                        MY BOT <span className="text-cyber-orange">BET HISTORY</span>
                    </h1>
                    <div className="mt-4">
                        <button
                            onClick={() => navigate("/spectate")}
                            className="bg-gradient-cyber text-white border-0 font-orbitron px-5 py-2.5 rounded-lg cursor-pointer font-semibold text-sm tracking-widest hover:opacity-90 transition-opacity inline-flex items-center gap-2"
                        >
                            <HugeiconsIcon icon={DiceFaces03Icon} className="w-5 h-5" /> Back to Spectate
                        </button>
                    </div>
                </div>

                {stats && (
                    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-8">
                        <div className="bg-black/40 border border-cyber-gold/30 rounded-lg p-4">
                            <p className="text-cyber-gray text-xs uppercase tracking-wider mb-1">Total Bets</p>
                            <p className="text-white font-orbitron text-2xl font-bold">{stats.totalBets}</p>
                        </div>
                        <div className="bg-black/40 border border-green-500/40 rounded-lg p-4">
                            <p className="text-cyber-gray text-xs uppercase tracking-wider mb-1">Won</p>
                            <p className="text-green-400 font-orbitron text-2xl font-bold">{stats.wonBets}</p>
                        </div>
                        <div className="bg-black/40 border border-red-500/40 rounded-lg p-4">
                            <p className="text-cyber-gray text-xs uppercase tracking-wider mb-1">Lost</p>
                            <p className="text-red-400 font-orbitron text-2xl font-bold">{stats.lostBets}</p>
                        </div>
                        <div className="bg-black/40 border border-yellow-500/40 rounded-lg p-4">
                            <p className="text-cyber-gray text-xs uppercase tracking-wider mb-1">Pending</p>
                            <p className="text-yellow-400 font-orbitron text-2xl font-bold">{stats.pendingBets}</p>
                        </div>
                        <div className="bg-black/40 border border-cyber-orange/40 rounded-lg p-4">
                            <p className="text-cyber-gray text-xs uppercase tracking-wider mb-1">Wagered</p>
                            <p className="text-cyber-orange font-orbitron text-xl font-bold">{sompiToXlm(stats.totalWagered).toFixed(2)} XLM</p>
                        </div>
                        <div className="bg-black/40 border border-cyber-gold/40 rounded-lg p-4">
                            <p className="text-cyber-gray text-xs uppercase tracking-wider mb-1">Won</p>
                            <p className="text-cyber-gold font-orbitron text-xl font-bold">{sompiToXlm(stats.totalWon).toFixed(2)} XLM</p>
                        </div>
                    </div>
                )}

                {loading ? (
                    <div className="flex items-center justify-center py-20">
                        <div className="text-center">
                            <div className="w-16 h-16 border-4 border-cyber-gold border-t-transparent rounded-full animate-spin mx-auto mb-4" />
                            <p className="text-cyber-gold text-lg font-medium font-orbitron tracking-widest uppercase">
                                Loading history...
                            </p>
                        </div>
                    </div>
                ) : error ? (
                    <div className="bg-red-500/10 border border-red-500/40 rounded-lg p-6 text-center">
                        <p className="text-red-400 font-orbitron">⚠️ {error}</p>
                        <button
                            onClick={fetchHistory}
                            className="mt-4 bg-red-500 text-white border-0 font-orbitron px-5 py-2.5 rounded-lg cursor-pointer"
                        >
                            Retry
                        </button>
                    </div>
                ) : history.length === 0 ? (
                    <div className="bg-black/40 border border-cyber-gold/30 rounded-lg p-12 text-center">
                        <p className="text-cyber-gray font-orbitron">No bot bets yet.</p>
                        <button
                            onClick={() => navigate("/spectate")}
                            className="mt-4 bg-gradient-cyber text-white border-0 font-orbitron px-5 py-2.5 rounded-lg cursor-pointer"
                        >
                            Watch Bot Matches
                        </button>
                    </div>
                ) : (
                    <>
                        <div className="space-y-4">
                            {history.map((bet, index) => {
                                const player1Character = getCharacter(bet.player1CharacterId);
                                const player2Character = getCharacter(bet.player2CharacterId);
                                const betOnPlayer1 = bet.betOn === "player1";

                                return (
                                    <motion.div
                                        key={bet.id}
                                        initial={{ opacity: 0, y: 20 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        transition={{ delay: index * 0.05 }}
                                        className={`bg-black/40 border rounded-lg p-6 ${
                                            bet.status === "won"
                                                ? "border-green-500/40 hover:border-green-500"
                                                : bet.status === "lost"
                                                    ? "border-red-500/40 hover:border-red-500"
                                                    : "border-cyber-orange/40 hover:border-cyber-orange"
                                        } transition-all`}
                                    >
                                        <div className="mb-4">
                                            <span className="inline-block px-3 py-1 rounded-full text-xs font-orbitron bg-cyber-orange/20 text-cyber-orange border border-cyber-orange/40">
                                                BOT MATCH
                                            </span>
                                        </div>

                                        <div className="flex flex-col md:flex-row gap-6">
                                            <div className="flex items-center gap-4 flex-1">
                                                <div className={`flex-1 text-center ${betOnPlayer1 ? "opacity-100" : "opacity-50"}`}>
                                                    <div className="relative w-16 h-16 mx-auto mb-2">
                                                        {player1Character ? (
                                                            <img
                                                                src={player1Character.portraitUrl}
                                                                alt={bet.player1Name}
                                                                className={`w-full h-full object-cover rounded-lg border ${betOnPlayer1 ? "border-cyber-orange" : "border-gray-500"}`}
                                                            />
                                                        ) : (
                                                            <div className="w-full h-full rounded-lg bg-cyber-orange/10 border border-cyber-orange/30 flex items-center justify-center">
                                                                <HugeiconsIcon icon={RoboticIcon} className="text-cyber-orange w-6 h-6" />
                                                            </div>
                                                        )}
                                                    </div>
                                                    <p className="text-white font-orbitron text-sm">{bet.player1Name}</p>
                                                    {bet.winner === "player1" && <p className="text-green-400 text-xs mt-1">Winner</p>}
                                                </div>

                                                <div className="text-center px-2">
                                                    <div className="text-xl font-bold font-orbitron text-cyber-orange">VS</div>
                                                </div>

                                                <div className={`flex-1 text-center ${!betOnPlayer1 ? "opacity-100" : "opacity-50"}`}>
                                                    <div className="relative w-16 h-16 mx-auto mb-2">
                                                        {player2Character ? (
                                                            <img
                                                                src={player2Character.portraitUrl}
                                                                alt={bet.player2Name}
                                                                className={`w-full h-full object-cover rounded-lg border ${!betOnPlayer1 ? "border-cyber-orange" : "border-gray-500"}`}
                                                            />
                                                        ) : (
                                                            <div className="w-full h-full rounded-lg bg-cyber-orange/10 border border-cyber-orange/30 flex items-center justify-center">
                                                                <HugeiconsIcon icon={RoboticIcon} className="text-cyber-orange w-6 h-6" />
                                                            </div>
                                                        )}
                                                    </div>
                                                    <p className="text-white font-orbitron text-sm">{bet.player2Name}</p>
                                                    {bet.winner === "player2" && <p className="text-green-400 text-xs mt-1">Winner</p>}
                                                </div>
                                            </div>

                                            <div className="flex-1 space-y-2">
                                                <div className="flex items-center justify-between">
                                                    <span className="text-cyber-gray text-sm">Status:</span>
                                                    <span className={`font-orbitron font-bold ${getStatusColor(bet.status)}`}>
                                                        {bet.status.toUpperCase()}
                                                    </span>
                                                </div>
                                                <div className="flex items-center justify-between">
                                                    <span className="text-cyber-gray text-sm">Bet Amount:</span>
                                                    <span className="text-white font-orbitron">{sompiToXlm(bet.amount).toFixed(2)} XLM</span>
                                                </div>
                                                {bet.status === "won" && bet.payoutAmount && (
                                                    <div className="flex items-center justify-between">
                                                        <span className="text-cyber-gray text-sm">Payout:</span>
                                                        <span className="text-green-400 font-orbitron font-bold">
                                                            +{sompiToXlm(bet.payoutAmount).toFixed(2)} XLM
                                                        </span>
                                                    </div>
                                                )}
                                                <div className="flex items-center justify-between">
                                                    <span className="text-cyber-gray text-sm">Date:</span>
                                                    <span className="text-gray-400 text-xs">{formatDate(bet.createdAt)}</span>
                                                </div>
                                                {bet.txId && (
                                                    <div className="flex items-center justify-between">
                                                        <span className="text-cyber-gray text-sm">TX:</span>
                                                        <a
                                                            href={getStellarExpertTestnetTxUrl(bet.txId)}
                                                            target="_blank"
                                                            rel="noopener noreferrer"
                                                            className="text-cyber-gold text-xs font-mono hover:underline"
                                                        >
                                                            {truncateTxId(bet.txId)}
                                                        </a>
                                                    </div>
                                                )}
                                                {bet.payoutTxId && (
                                                    <div className="flex items-center justify-between">
                                                        <span className="text-cyber-gray text-sm">Claim TX:</span>
                                                        <a
                                                            href={getStellarExpertTestnetTxUrl(bet.payoutTxId)}
                                                            target="_blank"
                                                            rel="noopener noreferrer"
                                                            className="text-green-400 text-xs font-mono hover:underline"
                                                        >
                                                            {truncateTxId(bet.payoutTxId)}
                                                        </a>
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    </motion.div>
                                );
                            })}
                        </div>

                        <div className="flex items-center justify-center gap-4 mt-8">
                            <button
                                onClick={() => setPage((p) => Math.max(0, p - 1))}
                                disabled={page === 0}
                                className="bg-cyber-orange text-black border-0 font-orbitron px-5 py-2.5 rounded-lg cursor-pointer disabled:opacity-50"
                            >
                                ← Previous
                            </button>
                            <span className="text-cyber-gray font-orbitron">Page {page + 1}</span>
                            <button
                                onClick={() => setPage((p) => p + 1)}
                                disabled={!hasMore}
                                className="bg-cyber-orange text-black border-0 font-orbitron px-5 py-2.5 rounded-lg cursor-pointer disabled:opacity-50"
                            >
                                Next →
                            </button>
                        </div>
                    </>
                )}
            </div>
        </GameLayout>
    );
}
