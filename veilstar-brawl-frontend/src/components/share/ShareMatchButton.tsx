import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { NewTwitterIcon } from "@hugeicons/core-free-icons";

interface ShareMatchButtonProps {
    matchId: string;
    winnerLabel: string;
}

export default function ShareMatchButton({ matchId, winnerLabel }: ShareMatchButtonProps) {
    const [copied, setCopied] = useState(false);

    const replayUrl = `${window.location.origin}/replay/${matchId}`;

    const handleCopy = () => {
        navigator.clipboard.writeText(replayUrl).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        });
    };

    const handleShare = () => {
        const text = `I just finished a Veilstar Brawl match (${winnerLabel}) — ZK mechanics on Stellar. Watch the full replay!`;
        const shareUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(replayUrl)}`;
        window.open(shareUrl, "_blank");
    };

    return (
        <div className="flex gap-4">
            <button
                onClick={handleCopy}
                className="flex-1 bg-transparent border-cyber-gold text-cyber-gold hover:bg-cyber-gold/10 font-orbitron px-4 py-3 rounded-lg transition-colors border"
            >
                {copied ? "COPIED!" : "COPY REPLAY LINK"}
            </button>
            <button
                onClick={handleShare}
                className="flex-1 bg-[#1DA1F2] hover:bg-[#1a94df] text-white border-0 font-orbitron px-4 py-3 rounded-lg transition-all flex items-center gap-2 justify-center"
            >
                <HugeiconsIcon icon={NewTwitterIcon} className="w-4 h-4" />
                SHARE REPLAY
            </button>
        </div>
    );
}
