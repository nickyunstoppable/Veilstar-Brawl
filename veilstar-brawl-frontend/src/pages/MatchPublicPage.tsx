import { useEffect, useMemo, useState } from "react";
import GameLayout from "@/components/layout/GameLayout";
import MatchSummary from "@/components/share/MatchSummary";
import ShareMatchButton from "@/components/share/ShareMatchButton";
import TransactionTimeline, { type TransactionData } from "@/components/share/TransactionTimeline";
import { ExportMP4Wrapper } from "@/components/share/ExportMP4Wrapper";

type MatchRow = any;

function formatAddress(address: string): string {
    if (address.length > 16) return `${address.substring(0, 10)}...${address.substring(address.length - 6)}`;
    return address;
}

function formatDuration(start: string, end: string | null): string {
    if (!end) return "—";
    const ms = new Date(end).getTime() - new Date(start).getTime();
    if (!Number.isFinite(ms) || ms < 0) return "—";
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const r = s % 60;
    if (m <= 0) return `${r}s`;
    return `${m}m ${r}s`;
}

export default function MatchPublicPage({ matchId }: { matchId: string }) {
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [match, setMatch] = useState<MatchRow | null>(null);
    const [rounds, setRounds] = useState<any[]>([]);
    const [transactions, setTransactions] = useState<TransactionData[]>([]);
    const [zk, setZk] = useState<any>(null);

    useEffect(() => {
        const abortController = new AbortController();
        const apiBase = import.meta.env.VITE_API_BASE_URL || window.location.origin;

        (async () => {
            try {
                setLoading(true);
                setError(null);
                const res = await fetch(`${apiBase}/api/matches/${encodeURIComponent(matchId)}/public`, {
                    signal: abortController.signal,
                });
                if (!res.ok) {
                    if (res.status === 404) throw new Error("Match not found");
                    throw new Error(await res.text());
                }
                const data = await res.json();
                setMatch(data.match);
                setRounds(data.rounds || []);
                setTransactions((data.transactions || []) as TransactionData[]);
                setZk(data.zk || null);
            } catch (e) {
                if (e instanceof Error && e.name === "AbortError") return;
                setError(e instanceof Error ? e.message : "Failed to load match");
            } finally {
                if (!abortController.signal.aborted) setLoading(false);
            }
        })();

        return () => abortController.abort();
    }, [matchId]);

    const summary = useMemo(() => {
        if (!match) return null;
        const isP1Winner = match.winner_address === match.player1_address;
        const winner = {
            characterId: isP1Winner ? match.player1_character_id : match.player2_character_id,
            address: match.winner_address || match.player1_address,
        };
        const loser = {
            characterId: isP1Winner ? match.player2_character_id : match.player1_character_id,
            address: isP1Winner ? (match.player2_address || "") : match.player1_address,
        };

        const hits = (() => {
            // Approximate: count turns where damage > 0
            let total = 0;
            for (const r of rounds) {
                if ((r.player1_damage_dealt ?? 0) > 0) total++;
                if ((r.player2_damage_dealt ?? 0) > 0) total++;
            }
            return total;
        })();

        const zkCommitsLabel = zk?.counts ? `${zk.counts.verified}/${zk.counts.total}` : "0";

        return {
            id: match.id,
            winner,
            loser,
            score: `${match.player1_rounds_won ?? 0}-${match.player2_rounds_won ?? 0}`,
            status: match.status,
            zkVerifiedLabel: zk?.counts?.verified > 0 ? "ZK commits verified" : "ZK-ready match",
            durationLabel: formatDuration(match.created_at, match.completed_at),
            totalHits: hits,
            zkCommitsLabel,
        };
    }, [match, rounds, zk]);

    if (loading) {
        return (
            <GameLayout>
                <div className="flex items-center justify-center min-h-[60vh]">
                    <div className="text-center">
                        <div className="w-10 h-10 border-4 border-cyber-gold/30 border-t-cyber-gold rounded-full animate-spin mx-auto mb-4" />
                        <p className="text-cyber-gray font-orbitron text-sm">Loading match...</p>
                    </div>
                </div>
            </GameLayout>
        );
    }

    if (error || !match || !summary) {
        return (
            <GameLayout>
                <div className="flex items-center justify-center min-h-[60vh]">
                    <div className="text-center max-w-md">
                        <h1 className="text-3xl font-bold font-orbitron text-white mb-4">MATCH NOT FOUND</h1>
                        <p className="text-cyber-gray font-montserrat mb-6">{error || "The match you’re looking for doesn’t exist."}</p>
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

    const isCompleted = match.status === "completed";

    return (
        <GameLayout>
            <div className="min-h-screen pt-10 pb-20 relative">
                <div className="container mx-auto px-6 lg:px-12 xl:px-24 relative z-10">
                    <MatchSummary matchData={summary} />

                    {isCompleted && (
                        <div className="max-w-md mx-auto mt-6 flex flex-col gap-3">
                            <a
                                href={`/replay/${match.id}`}
                                className="w-full flex items-center justify-center gap-3 px-6 py-4 bg-gradient-to-r from-purple-600 to-indigo-600 text-white font-orbitron rounded-lg hover:from-purple-500 hover:to-indigo-500 transition-all shadow-lg shadow-purple-500/20"
                            >
                                <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                                    <path d="M8 5v14l11-7z" />
                                </svg>
                                WATCH FULL REPLAY
                            </a>
                            <ExportMP4Wrapper matchId={match.id} />
                        </div>
                    )}

                    <div className="max-w-md mx-auto mt-4">
                        <ShareMatchButton matchId={match.id} winnerLabel={formatAddress(summary.winner.address)} />
                    </div>

                    <div className="mt-8">
                        <TransactionTimeline
                            transactions={transactions}
                            matchCreatedAt={match.created_at}
                            matchCompletedAt={match.completed_at}
                        />
                    </div>

                    {/* ZK panel (judge-friendly) */}
                    <div className="mt-8 bg-black/40 border border-cyber-gold/20 rounded-xl p-6 backdrop-blur-md max-w-4xl mx-auto">
                        <h3 className="text-lg font-bold font-orbitron text-white mb-2">ZK PROOF ARTIFACTS</h3>
                        <p className="text-cyber-gray text-xs font-mono mb-4">
                            Private round commits + proof metadata stored for this match.
                        </p>

                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            <div className="bg-black/30 border border-white/5 rounded-lg p-4">
                                <div className="text-cyber-gray text-xs uppercase mb-1">Private Commits</div>
                                <div className="text-white font-mono text-sm">
                                    {zk?.counts ? `${zk.counts.total} total` : "—"}
                                </div>
                            </div>
                            <div className="bg-black/30 border border-white/5 rounded-lg p-4">
                                <div className="text-cyber-gray text-xs uppercase mb-1">Verified</div>
                                <div className="text-cyber-gold font-mono text-sm">
                                    {zk?.counts ? `${zk.counts.verified} verified` : "—"}
                                </div>
                            </div>
                            <div className="bg-black/30 border border-white/5 rounded-lg p-4">
                                <div className="text-cyber-gray text-xs uppercase mb-1">On-chain Session</div>
                                <div className="text-white font-mono text-sm">
                                    {match.onchain_session_id ? `#${match.onchain_session_id}` : "—"}
                                </div>
                            </div>
                        </div>

                        {zk?.privateCommits?.length > 0 && (
                            <div className="mt-4">
                                <div className="text-cyber-gray text-xs uppercase mb-2">Latest Commit</div>
                                {(() => {
                                    const last = zk.privateCommits[zk.privateCommits.length - 1];
                                    return (
                                        <div className="bg-black/30 border border-white/5 rounded-lg p-4">
                                            <div className="text-xs text-cyber-gray font-mono break-all">
                                                player: <span className="text-white">{last.player_address}</span>
                                            </div>
                                            <div className="text-xs text-cyber-gray font-mono break-all mt-2">
                                                commitment: <span className="text-white">{last.commitment}</span>
                                            </div>
                                            {last.transcript_hash && (
                                                <div className="text-xs text-cyber-gray font-mono break-all mt-2">
                                                    transcript: <span className="text-white">{last.transcript_hash}</span>
                                                </div>
                                            )}
                                            {last.onchain_commit_tx_hash && (
                                                <div className="text-xs text-cyber-gray font-mono break-all mt-2">
                                                    on-chain tx: <span className="text-cyber-gold">{last.onchain_commit_tx_hash}</span>
                                                </div>
                                            )}
                                        </div>
                                    );
                                })()}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </GameLayout>
    );
}
