import { useMemo, useState } from "react";
import { NETWORK } from "@/utils/constants";
import { HugeiconsIcon } from "@hugeicons/react";
import {
    Blockchain03Icon,
    Alert02Icon,
    ViewIcon,
    FlashIcon,
    ArrowUp01Icon,
    ArrowDown01Icon,
} from "@hugeicons/core-free-icons";

export interface TransactionData {
    txId: string;
    moveType: string;
    playerAddress: string;
    roundNumber: number;
    confirmedAt: string | null;
    createdAt: string;
}

interface TransactionTimelineProps {
    transactions: TransactionData[];
    matchCreatedAt: string;
    matchCompletedAt: string | null;
}

function formatTxId(txId: string): string {
    if (txId.length > 20) return `${txId.substring(0, 10)}...${txId.substring(txId.length - 8)}`;
    return txId;
}

function formatAddress(address: string): string {
    if (address.length > 16) return `${address.substring(0, 8)}...${address.substring(address.length - 4)}`;
    return address;
}

function getExplorerUrl(txId: string): string {
    const base = NETWORK === "testnet" ? "https://stellar.expert/explorer/testnet" : "https://stellar.expert/explorer/public";
    return `${base}/tx/${txId}`;
}

function getTimeDiff(startTime: string, endTime: string): string {
    const start = new Date(startTime).getTime();
    const end = new Date(endTime).getTime();
    const diffMs = end - start;
    if (!Number.isFinite(diffMs) || diffMs < 0) return "—";
    if (diffMs < 1000) return `${diffMs}ms`;
    if (diffMs < 60000) return `${(diffMs / 1000).toFixed(1)}s`;
    const minutes = Math.floor(diffMs / 60000);
    const seconds = Math.floor((diffMs % 60000) / 1000);
    return `${minutes}m ${seconds}s`;
}

export default function TransactionTimeline({ transactions, matchCreatedAt, matchCompletedAt }: TransactionTimelineProps) {
    const [expanded, setExpanded] = useState(false);

    const sortedTxs = useMemo(
        () => [...transactions].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
        [transactions],
    );

    const matchDuration = matchCompletedAt ? getTimeDiff(matchCreatedAt, matchCompletedAt) : null;
    const displayed = expanded ? sortedTxs : sortedTxs.slice(0, 3);

    if (transactions.length === 0) {
        return (
            <div className="bg-black/40 border border-cyber-gold/20 rounded-xl p-6 backdrop-blur-md max-w-4xl mx-auto">
                <div className="text-center">
                    <div className="inline-flex items-center gap-2 text-cyber-gray">
                        <HugeiconsIcon icon={Alert02Icon} className="w-5 h-5" />
                        <span className="font-mono text-sm">No blockchain transactions recorded for this match</span>
                    </div>
                    <p className="text-cyber-gray/60 text-xs mt-2">
                        This match may have used off-chain signing for some actions.
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="bg-black/40 border border-cyber-gold/20 rounded-xl p-6 backdrop-blur-md max-w-4xl mx-auto">
            <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-cyber-gold/10 flex items-center justify-center border border-cyber-gold/20">
                        <HugeiconsIcon icon={Blockchain03Icon} className="w-5 h-5 text-cyber-gold" />
                    </div>
                    <div>
                        <h3 className="text-lg font-bold font-orbitron text-white">BLOCKCHAIN TRANSACTIONS</h3>
                        <p className="text-cyber-gray text-xs font-mono">{transactions.length} moves recorded on-chain</p>
                    </div>
                </div>

                {matchDuration && (
                    <div className="hidden md:block text-right">
                        <div className="text-xs text-cyber-gray uppercase">Match Duration</div>
                        <div className="text-white font-mono font-bold">{matchDuration}</div>
                    </div>
                )}
            </div>

            <div className="bg-gradient-to-r from-cyber-gold/10 to-transparent border-l-2 border-cyber-gold px-4 py-3 rounded-r mb-6">
                <div className="flex items-center gap-2">
                    <HugeiconsIcon icon={FlashIcon} className="w-4 h-4 text-cyber-gold" />
                    <span className="text-cyber-gold text-sm font-bold">Powered by Stellar</span>
                    <span className="text-cyber-gray text-xs">— fast settlement + ZK proof artifacts</span>
                </div>
            </div>

            <div className="space-y-3">
                {displayed.map((tx, index) => (
                    <div key={`${tx.txId}-${index}`} className="group bg-black/30 border border-white/5 hover:border-cyber-gold/30 rounded-lg p-4 transition-all">
                        <div className="flex items-center justify-between gap-4">
                            <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                    <span className="text-cyber-gold font-bold uppercase text-sm truncate">{tx.moveType}</span>
                                    <span className="text-cyber-gray text-xs shrink-0">{tx.roundNumber > 0 ? `Round ${tx.roundNumber}` : ""}</span>
                                </div>
                                <div className="text-cyber-gray/70 text-xs font-mono mt-1 truncate">by {formatAddress(tx.playerAddress)}</div>
                            </div>

                            <a
                                href={getExplorerUrl(tx.txId)}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="shrink-0 flex items-center gap-2 px-3 py-1.5 rounded bg-cyber-gold/10 hover:bg-cyber-gold/20 border border-cyber-gold/20 text-cyber-gold text-xs font-mono transition-all"
                            >
                                <span className="hidden sm:inline">{formatTxId(tx.txId)}</span>
                                <span className="sm:hidden">View</span>
                                <HugeiconsIcon icon={ViewIcon} className="w-3 h-3" />
                            </a>
                        </div>
                    </div>
                ))}
            </div>

            {sortedTxs.length > 4 && (
                <div className="mt-4 text-center">
                    <button
                        onClick={() => setExpanded((v) => !v)}
                        className="bg-transparent text-cyber-gray hover:text-cyber-gold font-mono text-xs inline-flex items-center justify-center gap-2"
                    >
                        <span>{expanded ? "Show Less" : `Show All ${sortedTxs.length} Transactions`}</span>
                        <HugeiconsIcon icon={expanded ? ArrowUp01Icon : ArrowDown01Icon} className="w-3 h-3" />
                    </button>
                </div>
            )}

            {matchDuration && (
                <div className="md:hidden flex justify-center gap-6 mt-4 pt-4 border-t border-white/5">
                    <div className="text-center">
                        <div className="text-xs text-cyber-gray uppercase">Duration</div>
                        <div className="text-white font-mono font-bold text-sm">{matchDuration}</div>
                    </div>
                </div>
            )}
        </div>
    );
}
