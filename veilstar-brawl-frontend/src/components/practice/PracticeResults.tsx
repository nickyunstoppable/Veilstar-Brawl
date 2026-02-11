import React from "react";
import { Button } from "@/components/ui/button";
import { motion } from "framer-motion";

interface PracticeResultsProps {
    winner: "player" | "ai";
    onRetry: () => void;
}

export default function PracticeResults({ winner, onRetry }: PracticeResultsProps) {
    return (
        <div className="fixed inset-0 lg:left-72 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm animate-in fade-in duration-500">
            <div className="relative w-full max-w-2xl text-center">
                {/* Result Title */}
                <h1 className="text-[80px] sm:text-[120px] font-black font-orbitron leading-none mb-8 tracking-tighter drop-shadow-[0_0_30px_rgba(0,0,0,0.8)]">
                    {winner === "player" ? (
                        <span className="bg-gradient-cyber bg-clip-text text-transparent">VICTORY</span>
                    ) : (
                        <span className="text-gray-500">DEFEAT</span>
                    )}
                </h1>

                <div className="bg-black/60 border border-cyber-gold/30 rounded-2xl p-8 backdrop-blur-md max-w-md mx-auto">
                    <p className="text-cyber-gray text-lg mb-8 font-montserrat">
                        {winner === "player"
                            ? "Excellent work. Your skills are sharpening."
                            : "Don't give up. Analyse your mistakes and try again."}
                    </p>

                    <div className="flex flex-col gap-4">
                        <Button
                            onClick={onRetry}
                            className="w-full h-12 bg-cyber-gold text-black font-bold font-orbitron hover:bg-cyber-gold/90"
                        >
                            PLAY AGAIN
                        </Button>
                        {/* Spotlight Overlay: Dims everything EXCEPT this button when active */}
                        {winner === "player" && (
                            <div className="fixed inset-0 bg-black/80 z-10 pointer-events-none animate-in fade-in duration-500" />
                        )}

                        <a href="/play" className={`w-full relative ${winner === "player" ? "z-20" : ""}`}>
                            <Button
                                variant="outline"
                                className={`
                                        w-full h-12 font-orbitron transition-all duration-300
                                        ${winner === "player"
                                        ? "border-orange-500 bg-orange-500/10 text-orange-400 hover:text-white hover:bg-orange-500/20 shadow-[0_0_15px_rgba(249,115,22,0.3)] animate-pulse"
                                        : "border-cyber-gray text-cyber-gray hover:text-white hover:border-white"
                                    }
                                    `}
                            >
                                BACK TO MENU
                            </Button>

                            {/* Tutorial-style Tooltip */}
                            {winner === "player" && (
                                <motion.div
                                    initial={{ opacity: 0, y: 10 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ delay: 0.5, duration: 0.5 }}
                                    className="absolute top-full mt-4 left-1/2 -translate-x-1/2 w-[280px] bg-zinc-900 border border-zinc-700 rounded-xl p-4 shadow-2xl z-20 pointer-events-none"
                                >
                                    {/* Arrow pointing up */}
                                    <div className="absolute -top-3 left-1/2 -translate-x-1/2 text-zinc-900 drop-shadow-sm">
                                        <svg width="24" height="12" viewBox="0 0 24 12" fill="currentColor">
                                            <path d="M0 12L12 0L24 12H0Z" />
                                        </svg>
                                    </div>

                                    <div className="flex flex-col gap-2 text-center">
                                        <h3 className="text-sm font-bold text-orange-500 uppercase tracking-wider">
                                            Return to Menu
                                        </h3>
                                        <p className="text-white text-xs leading-relaxed">
                                            Head back to the menu to find a real match!
                                        </p>
                                    </div>
                                </motion.div>
                            )}
                        </a>
                    </div>
                </div>
            </div>
        </div>
    );
}
