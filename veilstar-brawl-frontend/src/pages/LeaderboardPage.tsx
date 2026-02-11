/**
 * LeaderboardPage — ELO-ranked leaderboard
 * Fetches from /api/leaderboard, shows rank/player/wins/losses/rating table
 * with pagination. Adapted from KaspaClash LeaderboardTable.
 */

import { useState, useEffect } from "react";
import GameLayout from "@/components/layout/GameLayout";

const PAGE_SIZE = 50;

interface LeaderboardEntry {
    rank: number;
    address: string;
    displayName: string | null;
    wins: number;
    losses: number;
    rating: number;
}

interface LeaderboardResponse {
    entries: LeaderboardEntry[];
    total: number;
}

function formatAddress(address: string): string {
    if (address.length > 16) {
        return `${address.slice(0, 6)}...${address.slice(-4)}`;
    }
    return address;
}

export default function LeaderboardPage() {
    const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [currentPage, setCurrentPage] = useState(1);
    const [totalEntries, setTotalEntries] = useState(0);

    useEffect(() => {
        const abortController = new AbortController();

        async function fetchLeaderboard() {
            try {
                setLoading(true);
                setError(null);

                const offset = (currentPage - 1) * PAGE_SIZE;
                const apiBase = import.meta.env.VITE_API_BASE_URL || window.location.origin;
                const params = new URLSearchParams({
                    limit: PAGE_SIZE.toString(),
                    offset: offset.toString(),
                    sortBy: "rating",
                });

                const response = await fetch(`${apiBase}/api/leaderboard?${params}`, {
                    signal: abortController.signal,
                });

                if (!response.ok) throw new Error("Failed to fetch leaderboard");

                const data: LeaderboardResponse = await response.json();
                setEntries(data.entries);
                setTotalEntries(data.total);
            } catch (err) {
                if (err instanceof Error && err.name === "AbortError") return;
                setError(err instanceof Error ? err.message : "An error occurred");
            } finally {
                if (!abortController.signal.aborted) setLoading(false);
            }
        }

        fetchLeaderboard();
        return () => abortController.abort();
    }, [currentPage]);

    const totalPages = Math.ceil(totalEntries / PAGE_SIZE);

    return (
        <GameLayout>
            <div className="relative w-full min-h-full pb-20">
                {/* Background glow */}
                <div className="absolute top-[-10%] left-1/2 -translate-x-1/2 w-[800px] h-[500px] rounded-full blur-[150px] pointer-events-none bg-cyber-gold/5" />

                <div className="relative z-10 max-w-5xl mx-auto">
                    {/* Header */}
                    <div className="text-center mb-10">
                        <h1 className="text-3xl sm:text-4xl lg:text-[52px] font-bold leading-tight mb-3 font-orbitron text-white">
                            HALL OF <span className="text-cyber-gold">FAME</span>
                        </h1>
                        <p className="text-cyber-gray text-sm sm:text-base font-montserrat">
                            The top fighters ranked by ELO rating.
                        </p>
                    </div>

                    {/* Decorative line */}
                    <div className="flex items-center gap-4 mb-8">
                        <div className="flex-1 h-px bg-gradient-to-r from-transparent via-cyber-gold/40 to-transparent" />
                        <span className="text-cyber-gray text-xs uppercase font-orbitron tracking-wider">Season 1</span>
                        <div className="flex-1 h-px bg-gradient-to-r from-transparent via-cyber-gold/40 to-transparent" />
                    </div>

                    {/* Table */}
                    {loading && entries.length === 0 ? (
                        <div className="w-full bg-black/40 border border-cyber-gold/20 rounded-2xl p-12 backdrop-blur-md">
                            <div className="flex flex-col items-center gap-4">
                                <div className="w-10 h-10 border-4 border-cyber-gold/30 border-t-cyber-gold rounded-full animate-spin" />
                                <p className="text-cyber-gray font-orbitron text-sm">Loading leaderboard...</p>
                            </div>
                        </div>
                    ) : error ? (
                        <div className="w-full bg-black/40 border border-red-500/20 rounded-2xl p-12 backdrop-blur-md text-center">
                            <p className="text-red-400 font-orbitron">Error loading leaderboard</p>
                            <p className="text-cyber-gray text-sm mt-2">{error}</p>
                        </div>
                    ) : entries.length === 0 ? (
                        <div className="w-full bg-black/40 border border-cyber-gold/20 rounded-2xl p-12 backdrop-blur-md text-center">
                            <p className="text-cyber-gray font-orbitron">No fighters yet</p>
                            <p className="text-cyber-gray/60 text-sm mt-2">Be the first to claim glory!</p>
                        </div>
                    ) : (
                        <div className={`w-full bg-black/40 border border-cyber-gold/20 rounded-2xl overflow-hidden backdrop-blur-md relative ${loading ? "opacity-70 pointer-events-none" : ""}`}>
                            {loading && (
                                <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
                                    <div className="w-10 h-10 border-4 border-cyber-gold/30 border-t-cyber-gold rounded-full animate-spin" />
                                </div>
                            )}

                            <div className="overflow-x-auto">
                                <table className="w-full">
                                    <thead className="bg-cyber-gold/10 border-b border-cyber-gold/20">
                                        <tr>
                                            <th className="w-[80px] px-4 py-3 text-left text-cyber-gold font-orbitron font-bold text-xs sm:text-sm">RANK</th>
                                            <th className="px-4 py-3 text-left text-white font-orbitron text-xs sm:text-sm min-w-[150px]">PLAYER</th>
                                            <th className="px-4 py-3 text-right text-white font-orbitron text-xs sm:text-sm">WINS</th>
                                            <th className="px-4 py-3 text-right text-white font-orbitron text-xs sm:text-sm">LOSSES</th>
                                            <th className="px-4 py-3 text-right text-cyber-orange font-orbitron font-bold text-xs sm:text-sm">RATING</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {entries.map((player) => (
                                            <tr
                                                key={player.address}
                                                className="border-b border-white/5 hover:bg-cyber-gold/5 transition-colors cursor-pointer"
                                                onClick={() => {
                                                    window.history.pushState({}, "", `/player/${player.address}`);
                                                    window.dispatchEvent(new PopStateEvent("popstate"));
                                                }}
                                            >
                                                <td className="px-4 py-3 font-bold font-orbitron text-base sm:text-lg">
                                                    {player.rank === 1 && <span className="text-[#FFD700] drop-shadow-[0_0_10px_rgba(255,215,0,0.5)]">#1</span>}
                                                    {player.rank === 2 && <span className="text-[#C0C0C0] drop-shadow-[0_0_10px_rgba(192,192,192,0.5)]">#2</span>}
                                                    {player.rank === 3 && <span className="text-[#CD7F32] drop-shadow-[0_0_10px_rgba(205,127,50,0.5)]">#3</span>}
                                                    {player.rank > 3 && <span className="text-cyber-gray">#{player.rank}</span>}
                                                </td>
                                                <td className="px-4 py-3">
                                                    <div className="min-w-0 flex-1">
                                                        <p className="text-white font-orbitron font-medium text-sm sm:text-base truncate">
                                                            {player.displayName || formatAddress(player.address)}
                                                        </p>
                                                        {player.displayName && (
                                                            <p className="text-cyber-gray text-xs font-mono truncate">
                                                                {formatAddress(player.address)}
                                                            </p>
                                                        )}
                                                    </div>
                                                </td>
                                                <td className="px-4 py-3 text-right font-orbitron text-emerald-400 font-medium text-sm sm:text-base">
                                                    {player.wins}
                                                </td>
                                                <td className="px-4 py-3 text-right font-orbitron text-red-400 font-medium text-sm sm:text-base">
                                                    {player.losses}
                                                </td>
                                                <td className="px-4 py-3 text-right font-orbitron font-bold text-cyber-orange text-base sm:text-lg">
                                                    {Math.round(player.rating)}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    )}

                    {/* Pagination */}
                    {totalPages > 1 && (
                        <div className="flex items-center justify-center gap-2 mt-8">
                            <button
                                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                                disabled={currentPage === 1 || loading}
                                className="px-3 py-2 rounded-lg border border-cyber-gold/30 text-white font-orbitron text-sm hover:bg-cyber-gold/10 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                            >
                                ←
                            </button>

                            {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
                                let page: number;
                                if (totalPages <= 5) {
                                    page = i + 1;
                                } else if (currentPage <= 3) {
                                    page = i + 1;
                                } else if (currentPage >= totalPages - 2) {
                                    page = totalPages - 4 + i;
                                } else {
                                    page = currentPage - 2 + i;
                                }
                                return (
                                    <button
                                        key={page}
                                        onClick={() => setCurrentPage(page)}
                                        disabled={loading}
                                        className={`min-w-[40px] h-10 rounded-lg font-orbitron font-bold text-sm flex items-center justify-center transition-all ${
                                            currentPage === page
                                                ? "bg-cyber-gold text-black shadow-[0_0_15px_rgba(240,183,31,0.5)]"
                                                : "bg-black/30 text-cyber-gray border border-white/10 hover:border-cyber-gold/50 hover:text-white"
                                        }`}
                                    >
                                        {page}
                                    </button>
                                );
                            })}

                            <button
                                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                                disabled={currentPage === totalPages || loading}
                                className="px-3 py-2 rounded-lg border border-cyber-gold/30 text-white font-orbitron text-sm hover:bg-cyber-gold/10 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                            >
                                →
                            </button>
                        </div>
                    )}

                    <div className="mt-8 text-center">
                        <p className="text-cyber-gray text-xs">Rankings update in real-time.</p>
                    </div>
                </div>
            </div>
        </GameLayout>
    );
}
