import { getCharacter } from "@/data/characters";
import { HugeiconsIcon } from "@hugeicons/react";
import { ChampionIcon, Robot01Icon, Tick02Icon } from "@hugeicons/core-free-icons";

interface MatchSummaryProps {
    matchData: {
        id: string;
        winner: { characterId: string | null; address: string };
        loser: { characterId: string | null; address: string };
        score?: string;
        status?: string;
        zkVerifiedLabel?: string;
        durationLabel?: string;
        totalHits?: number;
        zkCommitsLabel?: string;
    };
}

function formatAddress(address: string): string {
    if (address.length > 16) return `${address.slice(0, 10)}...${address.slice(-6)}`;
    return address;
}

export default function MatchSummary({ matchData }: MatchSummaryProps) {
    const winnerName = matchData.winner.characterId ? (getCharacter(matchData.winner.characterId)?.name ?? matchData.winner.characterId) : "Unknown";
    const loserName = matchData.loser.characterId ? (getCharacter(matchData.loser.characterId)?.name ?? matchData.loser.characterId) : "Unknown";

    return (
        <div className="bg-black/40 border border-cyber-gold/30 rounded-2xl p-8 backdrop-blur-md max-w-4xl mx-auto">
            <div className="text-center mb-12">
                <span className="text-cyber-gray text-sm uppercase tracking-widest font-bold">MATCH RESULT</span>
                <h2 className="text-4xl md:text-6xl font-bold font-orbitron text-white mt-2">
                    {winnerName} WINS!
                </h2>
                {matchData.score && (
                    <div className="text-2xl font-mono text-cyber-gold mt-2">{matchData.score}</div>
                )}
                <div className="flex justify-center mt-4">
                    <span className="bg-cyber-gold/20 text-cyber-gold border border-cyber-gold px-4 py-1 rounded text-sm font-mono flex items-center gap-2">
                        <HugeiconsIcon icon={Tick02Icon} className="w-4 h-4 text-green-500 animate-pulse" />
                        {matchData.zkVerifiedLabel || "ZK-verified on Stellar"}
                    </span>
                </div>
            </div>

            <div className="flex flex-col md:flex-row items-center justify-between gap-12 mb-12">
                <div className="text-center flex-1">
                    <div className="w-32 h-32 rounded-full border-4 border-cyber-gold mx-auto mb-4 bg-black flex items-center justify-center relative shadow-[0_0_30px_rgba(240,183,31,0.3)]">
                        <HugeiconsIcon icon={ChampionIcon} className="w-16 h-16 text-white" />
                        <div className="absolute -bottom-3 bg-cyber-gold text-black px-3 py-0.5 text-xs font-bold rounded">WINNER</div>
                    </div>
                    <h3 className="text-xl font-bold text-white font-orbitron">{winnerName}</h3>
                    <p className="text-cyber-gray font-mono text-sm">{formatAddress(matchData.winner.address)}</p>
                </div>

                <div className="text-2xl font-black font-orbitron text-cyber-gray italic">VS</div>

                <div className="text-center flex-1">
                    <div className="w-24 h-24 rounded-full border-2 border-cyber-gray/50 mx-auto mb-4 bg-black flex items-center justify-center grayscale opacity-80">
                        <HugeiconsIcon icon={Robot01Icon} className="w-12 h-12 text-cyber-gray" />
                    </div>
                    <h3 className="text-lg font-bold text-cyber-gray font-orbitron">{loserName}</h3>
                    <p className="text-cyber-gray/50 font-mono text-xs">{formatAddress(matchData.loser.address)}</p>
                </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-2">
                <div className="bg-black/30 p-4 rounded text-center border border-white/5">
                    <div className="text-cyber-gray text-xs uppercase mb-1">Duration</div>
                    <div className="text-white font-mono">{matchData.durationLabel || "—"}</div>
                </div>
                <div className="bg-black/30 p-4 rounded text-center border border-white/5">
                    <div className="text-cyber-gray text-xs uppercase mb-1">Total Hits</div>
                    <div className="text-white font-mono">{typeof matchData.totalHits === "number" ? matchData.totalHits : "—"}</div>
                </div>
                <div className="bg-black/30 p-4 rounded text-center border border-white/5">
                    <div className="text-cyber-gray text-xs uppercase mb-1">Match</div>
                    <div className="text-white font-mono">{matchData.status || "—"}</div>
                </div>
                <div className="bg-black/30 p-4 rounded text-center border border-white/5">
                    <div className="text-cyber-gray text-xs uppercase mb-1">ZK Commits</div>
                    <div className="text-cyber-gold font-mono font-bold">{matchData.zkCommitsLabel || "—"}</div>
                </div>
            </div>
        </div>
    );
}
