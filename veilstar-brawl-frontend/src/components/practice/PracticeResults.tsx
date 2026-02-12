import React from "react";
import { Button } from "@/components/ui/button";

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
                        <a href="/play" className="w-full relative">
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
                        </a>
                    </div>
                </div>
            </div>
        </div>
    );
}
