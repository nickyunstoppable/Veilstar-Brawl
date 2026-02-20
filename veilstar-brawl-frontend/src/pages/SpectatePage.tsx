import React, { useState, useEffect, useCallback } from "react";
import { motion } from "framer-motion";
import { HugeiconsIcon } from "@hugeicons/react";
import { RoboticIcon, DiceFaces03Icon } from "@hugeicons/core-free-icons";
import { getCharacter } from "../data/characters";
import GameLayout from "../components/layout/GameLayout";

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:3001";

// =============================================================================
// TYPES
// =============================================================================

interface BotMatch {
    id: string;
    bot1CharacterId: string;
    bot2CharacterId: string;
    bot1Name: string;
    bot2Name: string;
    createdAt: number;
    status: string;
}

// =============================================================================
// HELPERS
// =============================================================================

function navigate(path: string) {
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
}

// =============================================================================
// BOT MATCH CARD
// =============================================================================

function BotMatchCard({ match }: { match: BotMatch }) {
    const bot1Character = getCharacter(match.bot1CharacterId);
    const bot2Character = getCharacter(match.bot2CharacterId);

    return (
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="group relative rounded-[20px] bg-black/40 border border-orange-500/40 p-6 pt-14 hover:border-orange-500 transition-all hover:bg-black/60 overflow-hidden"
        >
            {/* Bot Match Indicator */}
            <div className="absolute top-4 right-4 flex items-center gap-2 z-10 bg-orange-500/20 px-3 py-1 rounded-full border border-orange-500/40 backdrop-blur-sm">
                <HugeiconsIcon icon={RoboticIcon} className="w-5 h-5 text-orange-400" />
                <span className="text-xs text-orange-400 font-orbitron uppercase tracking-wider font-bold">Bot Match</span>
            </div>

            {/* Match Info */}
            <div className="flex items-center justify-between gap-4">
                {/* Bot 1 */}
                <div className="flex-1 text-center min-w-0">
                    <div className="relative w-20 h-20 mx-auto mb-3">
                        {bot1Character ? (
                            <img
                                src={bot1Character.portraitUrl}
                                alt={bot1Character.name}
                                className="w-full h-full object-cover rounded-lg border border-orange-500/30"
                            />
                        ) : (
                            <div className="w-full h-full rounded-lg bg-orange-500/10 border border-orange-500/30 flex items-center justify-center">
                                <HugeiconsIcon icon={RoboticIcon} className="text-orange-400 w-8 h-8" />
                            </div>
                        )}
                    </div>
                    <p className="text-white font-orbitron text-sm truncate w-full px-2">{match.bot1Name}</p>
                    <p className="text-orange-400 text-xs mt-1">BOT</p>
                </div>

                {/* VS */}
                <div className="text-center px-2 shrink-0">
                    <div className="text-3xl font-bold font-orbitron text-orange-400">
                        VS
                    </div>
                    <p className="text-cyber-gray text-[10px] mt-2 uppercase tracking-wider bg-orange-500/10 px-2 py-1 rounded">
                        Best of 3
                    </p>
                </div>

                {/* Bot 2 */}
                <div className="flex-1 text-center min-w-0">
                    <div className="relative w-20 h-20 mx-auto mb-3">
                        {bot2Character ? (
                            <img
                                src={bot2Character.portraitUrl}
                                alt={bot2Character.name}
                                className="w-full h-full object-cover rounded-lg border border-orange-500/30"
                            />
                        ) : (
                            <div className="w-full h-full rounded-lg bg-orange-500/10 border border-orange-500/30 flex items-center justify-center">
                                <HugeiconsIcon icon={RoboticIcon} className="text-orange-400 w-8 h-8" />
                            </div>
                        )}
                    </div>
                    <p className="text-white font-orbitron text-sm truncate w-full px-2">{match.bot2Name}</p>
                    <p className="text-orange-400 text-xs mt-1">BOT</p>
                </div>
            </div>

            {/* Watch Button */}
            <div className="mt-8">
                <button
                    onClick={() => navigate(`/spectate/bot/${match.id}`)}
                    className="w-full bg-gradient-to-r from-orange-500 to-amber-500 text-white border-0 font-orbitron hover:opacity-90 py-4 text-lg tracking-widest rounded-xl cursor-pointer font-bold transition-opacity"
                >
                    WATCH BOT BATTLE
                </button>
            </div>
        </motion.div>
    );
}

// =============================================================================
// MAIN PAGE
// =============================================================================

export default function SpectatePage() {
    const [botMatch, setBotMatch] = useState<BotMatch | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const fetchMatches = useCallback(async () => {
        try {
            const botResponse = await fetch(`${API_BASE}/api/bot-games`);
            if (!botResponse.ok) {
                throw new Error("Failed to fetch bot match");
            }
            const botData = await botResponse.json();
            setBotMatch(botData.match || null);

            setError(null);
        } catch (err) {
            console.error("Error fetching bot match:", err);
            setError("Failed to load bot match");
        } finally {
            setLoading(false);
        }
    }, []);

    // Polling
    useEffect(() => {
        fetchMatches();
        const interval = setInterval(fetchMatches, 5000);
        return () => clearInterval(interval);
    }, [fetchMatches]);

    const fadeInUp = {
        hidden: { opacity: 0, y: 20 },
        visible: { opacity: 1, y: 0, transition: { duration: 0.6 } },
    };

    const staggerContainer = {
        hidden: { opacity: 0 },
        visible: {
            opacity: 1,
            transition: { staggerChildren: 0.1 },
        },
    };

    return (
        <GameLayout>
            <div className="relative w-full min-h-full pt-6 sm:pt-10 pb-20">
                {/* Background Grid Lines */}
                <div className="absolute top-0 bottom-0 left-[70.5px] w-px bg-cyber-orange/10 hidden md:block pointer-events-none" />
                <div className="absolute top-0 bottom-0 right-[70.5px] w-px bg-cyber-gold/10 hidden md:block pointer-events-none" />

                <div className="container mx-auto px-6 lg:px-12 xl:px-24 relative z-10">
                    {/* Header */}
                    <motion.div
                        variants={staggerContainer}
                        initial="hidden"
                        animate="visible"
                        className="text-center max-w-4xl mx-auto mb-16"
                    >
                        <motion.h1
                            variants={fadeInUp}
                            className="text-4xl lg:text-[60px] font-bold leading-tight mb-4 font-orbitron text-white"
                        >
                            LIVE <span className="text-cyber-orange">BATTLES</span>
                        </motion.h1>
                        <motion.p variants={fadeInUp} className="text-cyber-gray text-lg font-montserrat">
                            Watch real-time matches powered by Stellar's blockchain infrastructure.
                        </motion.p>
                        <motion.div variants={fadeInUp} className="mt-6">
                            <button
                                onClick={() => navigate("/bet-history")}
                                className="bg-gradient-cyber text-white border-0 font-orbitron px-5 py-2.5 rounded-lg cursor-pointer font-semibold text-sm tracking-widest hover:opacity-90 transition-opacity inline-flex items-center gap-2"
                            >
                                <HugeiconsIcon icon={DiceFaces03Icon} className="w-5 h-5" /> My Bet History
                            </button>
                        </motion.div>
                    </motion.div>

                    {/* Content */}
                    {loading ? (
                        <div className="flex items-center justify-center py-20">
                            <div className="text-center">
                                <div className="w-16 h-16 border-4 border-cyber-gold border-t-transparent rounded-full animate-spin mx-auto mb-4" />
                                <p className="text-cyber-gold text-lg font-medium font-orbitron tracking-widest uppercase">
                                    Loading matches...
                                </p>
                            </div>
                        </div>
                    ) : error ? (
                        <div className="text-center py-20">
                            <p className="text-red-500 text-lg mb-4">{error}</p>
                            <button
                                onClick={fetchMatches}
                                className="bg-gradient-cyber text-white border-0 font-orbitron px-5 py-2.5 rounded-lg cursor-pointer"
                            >
                                Try Again
                            </button>
                        </div>
                    ) : !botMatch ? (
                        <motion.div
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            className="text-center py-20"
                        >
                            <h2 className="text-2xl font-bold text-white font-orbitron mb-4">NO BOT MATCH ACTIVE</h2>
                            <p className="text-cyber-gray text-lg mb-8 max-w-md mx-auto">
                                Bot battle room is warming up. Check back in a moment.
                            </p>
                        </motion.div>
                    ) : (
                        <>
                            {/* Single Bot Match Room */}
                            {botMatch && (
                                <>
                                    <div className="mb-8 text-center">
                                        <h2 className="text-2xl font-bold text-orange-400 font-orbitron mb-2 flex items-center justify-center gap-2">
                                            24/7 BOT BATTLE ROOM
                                        </h2>
                                        <p className="text-cyber-gray">Watch continuous bot battles and place bets on the outcomes!</p>
                                    </div>
                                    <motion.div
                                        variants={staggerContainer}
                                        initial="hidden"
                                        animate="visible"
                                        className="max-w-2xl mx-auto"
                                    >
                                        <BotMatchCard match={botMatch} />
                                    </motion.div>
                                </>
                            )}
                        </>
                    )}

                    {/* Decorative bottom line */}
                    <div className="mt-20 flex items-center gap-4">
                        <div className="flex-1 h-px bg-gradient-to-r from-transparent via-cyber-gold/30 to-transparent" />
                    </div>
                </div>
            </div>
        </GameLayout>
    );
}
