import { useEffect, useState } from "react";
import GameLayout from "@/components/layout/GameLayout";
import { PhaserGame } from "@/game/PhaserGame";
import type { ReplayData } from "@/lib/video-recorder";

export default function ReplayPage({ matchId }: { matchId: string }) {
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [replay, setReplay] = useState<ReplayData | null>(null);

    useEffect(() => {
        const abortController = new AbortController();
        const apiBase = import.meta.env.VITE_API_BASE_URL || window.location.origin;

        (async () => {
            try {
                setLoading(true);
                setError(null);
                const res = await fetch(`${apiBase}/api/replay-data?matchId=${encodeURIComponent(matchId)}`, {
                    signal: abortController.signal,
                });
                if (!res.ok) {
                    throw new Error(await res.text());
                }
                const data = (await res.json()) as ReplayData;
                setReplay(data);
            } catch (e) {
                if (e instanceof Error && e.name === "AbortError") return;
                setError(e instanceof Error ? e.message : "Failed to load replay");
            } finally {
                if (!abortController.signal.aborted) setLoading(false);
            }
        })();

        return () => abortController.abort();
    }, [matchId]);

    if (loading) {
        return (
            <GameLayout>
                <div className="flex items-center justify-center min-h-[60vh]">
                    <div className="text-center">
                        <div className="w-10 h-10 border-4 border-cyber-gold/30 border-t-cyber-gold rounded-full animate-spin mx-auto mb-4" />
                        <p className="text-cyber-gray font-orbitron text-sm">Loading replay...</p>
                    </div>
                </div>
            </GameLayout>
        );
    }

    if (error || !replay) {
        return (
            <GameLayout>
                <div className="flex items-center justify-center min-h-[60vh]">
                    <div className="text-center max-w-md">
                        <h1 className="text-3xl font-bold font-orbitron text-white mb-4">REPLAY UNAVAILABLE</h1>
                        <p className="text-cyber-gray font-montserrat mb-6">{error || "Replay data could not be loaded."}</p>
                        <a href={`/m/${matchId}`}>
                            <button className="bg-transparent border border-cyber-gold/30 text-cyber-gold font-orbitron text-sm px-6 py-2 rounded-xl hover:bg-cyber-gold/10 transition-all">
                                BACK TO MATCH
                            </button>
                        </a>
                    </div>
                </div>
            </GameLayout>
        );
    }

    return (
        <div className="fixed inset-0 z-50 bg-black overflow-hidden">
            <div className="absolute top-4 left-4 z-50">
                <a
                    href={`/m/${matchId}`}
                    className="inline-flex items-center gap-2 bg-black/60 border border-white/10 text-white/80 hover:text-white px-4 py-2 rounded-xl font-orbitron text-xs"
                >
                    ← MATCH
                </a>
            </div>

            <PhaserGame currentScene="ReplayScene" sceneConfig={replay as any} />
        </div>
    );
}
