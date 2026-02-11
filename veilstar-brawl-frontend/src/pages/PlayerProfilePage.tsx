/**
 * PlayerProfilePage — Player profile with stats and match history
 * Fetches from /api/players/:address and /api/players/:address/matches
 * Adapted from KaspaClash player profile page.
 */

import { useState, useEffect } from "react";
import GameLayout from "@/components/layout/GameLayout";
import { useWalletStandalone } from "@/hooks/useWalletStandalone";

interface PlayerProfile {
    address: string;
    displayName: string | null;
    rating: number;
    wins: number;
    losses: number;
    rank: number | null;
    createdAt: string;
}

interface MatchRecord {
    matchId: string;
    opponentAddress: string;
    opponentName: string | null;
    playerCharacterId: string | null;
    opponentCharacterId: string | null;
    result: "win" | "loss";
    score: string;
    completedAt: string;
}

interface MatchHistoryResponse {
    matches: MatchRecord[];
    total: number;
}

function formatAddress(address: string): string {
    if (address.length > 16) {
        return `${address.slice(0, 6)}...${address.slice(-4)}`;
    }
    return address;
}

function formatTimeAgo(dateString: string): string {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    return `${diffDays}d ago`;
}

function calculateWinRate(wins: number, losses: number): string {
    const total = wins + losses;
    if (total === 0) return "0%";
    return `${Math.round((wins / total) * 100)}%`;
}

export default function PlayerProfilePage({ address }: { address: string }) {
    const { publicKey } = useWalletStandalone();
    const [profile, setProfile] = useState<PlayerProfile | null>(null);
    const [matches, setMatches] = useState<MatchRecord[]>([]);
    const [loading, setLoading] = useState(true);
    const [matchesLoading, setMatchesLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const isOwnProfile = publicKey === address;

    // Fetch player profile
    useEffect(() => {
        const abortController = new AbortController();

        async function fetchProfile() {
            try {
                setLoading(true);
                setError(null);

                const apiBase = import.meta.env.VITE_API_BASE_URL || window.location.origin;
                const response = await fetch(`${apiBase}/api/players/${encodeURIComponent(address)}`, {
                    signal: abortController.signal,
                });

                if (response.status === 404) {
                    setError("Player not found");
                    return;
                }
                if (!response.ok) throw new Error("Failed to fetch player profile");

                const data = await response.json();
                setProfile(data);
            } catch (err) {
                if (err instanceof Error && err.name === "AbortError") return;
                setError(err instanceof Error ? err.message : "An error occurred");
            } finally {
                if (!abortController.signal.aborted) setLoading(false);
            }
        }

        fetchProfile();
        return () => abortController.abort();
    }, [address]);

    // Fetch match history
    useEffect(() => {
        const abortController = new AbortController();

        async function fetchMatches() {
            try {
                setMatchesLoading(true);
                const apiBase = import.meta.env.VITE_API_BASE_URL || window.location.origin;
                const response = await fetch(
                    `${apiBase}/api/players/${encodeURIComponent(address)}/matches?limit=10`,
                    { signal: abortController.signal },
                );

                if (!response.ok) return;

                const data: MatchHistoryResponse = await response.json();
                setMatches(data.matches);
            } catch (err) {
                if (err instanceof Error && err.name === "AbortError") return;
            } finally {
                if (!abortController.signal.aborted) setMatchesLoading(false);
            }
        }

        fetchMatches();
        return () => abortController.abort();
    }, [address]);

    if (loading) {
        return (
            <GameLayout>
                <div className="flex items-center justify-center min-h-[60vh]">
                    <div className="text-center">
                        <div className="w-10 h-10 border-4 border-cyber-gold/30 border-t-cyber-gold rounded-full animate-spin mx-auto mb-4" />
                        <p className="text-cyber-gray font-orbitron text-sm">Loading profile...</p>
                    </div>
                </div>
            </GameLayout>
        );
    }

    if (error || !profile) {
        return (
            <GameLayout>
                <div className="flex items-center justify-center min-h-[60vh]">
                    <div className="text-center max-w-md">
                        <h1 className="text-3xl font-bold font-orbitron text-white mb-4">PLAYER NOT FOUND</h1>
                        <p className="text-cyber-gray font-montserrat mb-6">
                            The player with address {formatAddress(address)} does not exist.
                        </p>
                        <a href="/leaderboard">
                            <button className="bg-transparent border border-cyber-gold/30 text-cyber-gold font-orbitron text-sm px-6 py-2 rounded-xl hover:bg-cyber-gold/10 transition-all">
                                VIEW LEADERBOARD
                            </button>
                        </a>
                    </div>
                </div>
            </GameLayout>
        );
    }

    const winRate = calculateWinRate(profile.wins, profile.losses);
    const displayRank = profile.rank ? `#${profile.rank}` : "Unranked";

    return (
        <GameLayout>
            <div className="relative w-full min-h-full pb-20">
                <div className="relative z-10 max-w-5xl mx-auto">
                    {/* Profile Header Card */}
                    <div className="bg-black/40 border border-cyber-gold/30 rounded-2xl p-6 sm:p-8 backdrop-blur-md mb-8">
                        <div className="flex flex-col md:flex-row gap-6 sm:gap-8 items-center">
                            {/* Avatar / Rank */}
                            <div className="relative">
                                <div className="w-28 h-28 sm:w-32 sm:h-32 rounded-full border-4 border-cyber-gold bg-black flex items-center justify-center">
                                    <span className="text-4xl sm:text-5xl">⚔️</span>
                                </div>
                                <div className="absolute -bottom-3 left-1/2 -translate-x-1/2 bg-cyber-gold text-black font-bold font-orbitron px-3 py-1 rounded-full text-xs sm:text-sm whitespace-nowrap shadow-lg">
                                    RANK {displayRank}
                                </div>
                            </div>

                            {/* Info */}
                            <div className="flex-1 text-center md:text-left space-y-2">
                                <div className="flex items-center justify-center md:justify-start gap-3">
                                    <h1 className="text-xl sm:text-2xl md:text-3xl font-bold text-white font-orbitron break-all">
                                        {profile.displayName || formatAddress(profile.address)}
                                    </h1>
                                    {isOwnProfile && (
                                        <span className="text-xs font-orbitron text-cyber-gold bg-cyber-gold/10 border border-cyber-gold/30 px-2 py-1 rounded-full">
                                            YOU
                                        </span>
                                    )}
                                </div>
                                <p className="text-cyber-gray font-mono text-xs sm:text-sm break-all">
                                    {profile.address}
                                </p>
                                <div className="flex flex-wrap gap-3 justify-center md:justify-start mt-4">
                                    <span className="bg-cyber-gray/10 px-3 py-1.5 rounded text-cyber-gray font-mono text-xs border border-cyber-gray/20">
                                        Joined: {new Date(profile.createdAt).toLocaleDateString("en-US", { month: "short", year: "numeric" })}
                                    </span>
                                </div>
                            </div>

                            {/* Stats Grid */}
                            <div className="grid grid-cols-3 gap-4 md:gap-8 border-t md:border-t-0 md:border-l border-white/10 pt-4 md:pt-0 md:pl-8 w-full md:w-auto">
                                <div className="text-center">
                                    <div className="text-2xl sm:text-3xl font-bold font-orbitron text-cyber-orange">{profile.rating}</div>
                                    <div className="text-[10px] sm:text-xs text-cyber-gray uppercase tracking-wider">Rating</div>
                                </div>
                                <div className="text-center">
                                    <div className="text-2xl sm:text-3xl font-bold font-orbitron text-white">{profile.wins}</div>
                                    <div className="text-[10px] sm:text-xs text-cyber-gray uppercase tracking-wider">Wins</div>
                                </div>
                                <div className="text-center">
                                    <div className="text-2xl sm:text-3xl font-bold font-orbitron text-green-500">{winRate}</div>
                                    <div className="text-[10px] sm:text-xs text-cyber-gray uppercase tracking-wider">Win Rate</div>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Decorative line */}
                    <div className="flex items-center gap-4 mb-8">
                        <div className="flex-1 h-px bg-gradient-to-r from-transparent via-cyber-gold/40 to-transparent" />
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                        {/* Left Column: Season Stats */}
                        <div className="space-y-6">
                            <div className="p-6 bg-black/40 border border-cyber-gray/20 rounded-xl backdrop-blur-md">
                                <h3 className="text-lg font-orbitron text-white mb-4">SEASON STATS</h3>
                                <div className="space-y-4">
                                    <div className="flex justify-between text-sm">
                                        <span className="text-cyber-gray">Total Matches</span>
                                        <span className="text-white font-mono">{profile.wins + profile.losses}</span>
                                    </div>
                                    <div className="flex justify-between text-sm">
                                        <span className="text-cyber-gray">Wins</span>
                                        <span className="text-green-500 font-mono">{profile.wins}</span>
                                    </div>
                                    <div className="flex justify-between text-sm">
                                        <span className="text-cyber-gray">Losses</span>
                                        <span className="text-red-500 font-mono">{profile.losses}</span>
                                    </div>
                                    <div className="flex justify-between text-sm">
                                        <span className="text-cyber-gray">Win Rate</span>
                                        <span className="text-cyber-gold font-mono">{winRate}</span>
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Right Column: Match History */}
                        <div className="lg:col-span-2">
                            <h3 className="text-lg font-orbitron text-white mb-4 border-l-4 border-cyber-gold pl-4">RECENT BATTLES</h3>

                            {matchesLoading ? (
                                <div className="text-center py-8">
                                    <div className="w-8 h-8 border-4 border-cyber-gold/30 border-t-cyber-gold rounded-full animate-spin mx-auto" />
                                </div>
                            ) : matches.length === 0 ? (
                                <div className="text-center py-8 text-cyber-gray text-sm">
                                    No matches found yet. Start playing to build your history!
                                </div>
                            ) : (
                                <div className="space-y-2">
                                    {matches.map((match) => (
                                        <div
                                            key={match.matchId}
                                            className="group bg-black/40 border-l-4 border-l-transparent hover:border-l-cyber-gold border-y border-r border-white/10 p-3 sm:p-4 flex items-center justify-between transition-all hover:bg-cyber-gold/5"
                                        >
                                            {/* Result Badge */}
                                            <div className="w-14 sm:w-16 shrink-0">
                                                <span className={`font-bold font-orbitron px-2 sm:px-3 py-1 rounded text-xs sm:text-sm ${
                                                    match.result === "win"
                                                        ? "bg-green-500/20 text-green-500"
                                                        : "bg-red-500/20 text-red-500"
                                                }`}>
                                                    {match.result === "win" ? "WIN" : "LOSS"}
                                                </span>
                                            </div>

                                            {/* Match Details */}
                                            <div className="flex-1 px-3 sm:px-4 min-w-0">
                                                <div className="flex items-center gap-2 mb-1">
                                                    <span className="text-white font-medium text-sm truncate">
                                                        {match.score}
                                                    </span>
                                                </div>
                                                <div className="text-xs text-cyber-gray font-mono">
                                                    {formatTimeAgo(match.completedAt)}
                                                </div>
                                            </div>

                                            {/* Opponent */}
                                            <div className="hidden sm:block text-right shrink-0">
                                                <span className="text-xs text-cyber-gray block">OPPONENT</span>
                                                <button
                                                    onClick={() => {
                                                        window.history.pushState({}, "", `/player/${match.opponentAddress}`);
                                                        window.dispatchEvent(new PopStateEvent("popstate"));
                                                    }}
                                                    className="text-xs sm:text-sm text-white font-mono hover:text-cyber-gold transition-colors bg-transparent border-none p-0 cursor-pointer"
                                                >
                                                    {match.opponentName || formatAddress(match.opponentAddress)}
                                                </button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </GameLayout>
    );
}
