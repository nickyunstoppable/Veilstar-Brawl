/**
 * MatchmakingHUD — Immersive fullscreen search overlay
 * Veilstar Brawl cyber-gold theme with scanner reticle, system logs, and timer
 */

import React, { useEffect, useState } from "react";

interface MatchmakingHUDProps {
    waitTimeSeconds: number;
    playerCount: number;
    onCancel: () => void;
}

export default function MatchmakingHUD({
    waitTimeSeconds,
    playerCount,
    onCancel,
}: MatchmakingHUDProps) {
    const [logs, setLogs] = useState<string[]>([]);

    // Simulated system logs — Stellar / Veilstar themed
    useEffect(() => {
        const potentialLogs = [
            "Syncing with Stellar Horizon nodes...",
            "Validating Soroban contract state...",
            "Network status: HEALTHY",
            "Broadcasting matchmaking intent...",
            "Searching for opponent [VBR-7B-...]...",
            "Verifying on-chain game hub...",
            "Arena queue optimized.",
            "Latency check: 38ms",
            "Connecting to relay node 0xCB4V...",
            "XLM escrow pre-check: OK",
            "Querying matchmaking_queue table...",
            "Rating range expanding...",
            "Checking player availability...",
        ];

        const interval = setInterval(() => {
            if (Math.random() > 0.55) {
                const newLog =
                    potentialLogs[
                        Math.floor(Math.random() * potentialLogs.length)
                    ];
                const timestamp =
                    new Date().toLocaleTimeString("en-US", {
                        hour12: false,
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                    }) +
                    "." +
                    String(Math.floor(Math.random() * 999)).padStart(3, "0");
                setLogs((prev) =>
                    [`[${timestamp}] ${newLog}`, ...prev].slice(0, 8)
                );
            }
        }, 800);

        return () => clearInterval(interval);
    }, []);

    const formattedTime = new Date(waitTimeSeconds * 1000)
        .toISOString()
        .substring(14, 19);

    return (
        <div className="relative w-full h-full flex flex-col items-center justify-center overflow-hidden bg-black animate-[fadeInFromBlack_1s_ease-out_forwards]">
            {/* Arrival Flash */}
            <div className="absolute inset-0 bg-white z-[60] pointer-events-none animate-[flashOut_1.5s_ease-out_forwards]" />

            {/* Animated grid background */}
            <div className="absolute inset-0 z-0">
                <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(240,183,31,0.08)_0%,transparent_70%)]" />
                {/* Horizontal scan line */}
                <div className="absolute w-full h-px bg-cyber-gold/30 animate-[scanVertical_4s_ease-in-out_infinite]" />
                {/* Grid dots */}
                <div
                    className="absolute inset-0 opacity-10"
                    style={{
                        backgroundImage:
                            "radial-gradient(circle, #F0B71F 1px, transparent 1px)",
                        backgroundSize: "40px 40px",
                    }}
                />
            </div>

            {/* CRT Scanlines */}
            <div
                className="absolute inset-0 z-10 pointer-events-none"
                style={{
                    background:
                        "linear-gradient(rgba(18,16,16,0) 50%, rgba(0,0,0,0.25) 50%), linear-gradient(90deg, rgba(240,183,31,0.03), rgba(224,54,9,0.02), rgba(240,183,31,0.03))",
                    backgroundSize: "100% 2px, 3px 100%",
                }}
            />

            {/* Central HUD */}
            <div className="relative z-20 w-full h-full max-w-[1920px] flex flex-col lg:flex-row items-center lg:items-stretch justify-between p-6 lg:p-8 gap-6 lg:gap-8">
                {/* Left Panel: System Logs */}
                <div className="w-full lg:w-1/4 order-2 lg:order-1 flex items-end pb-8 lg:pb-12">
                    <div className="bg-black/60 border-l-2 border-cyber-gold/50 p-4 w-full font-mono text-xs text-cyber-gold/80 shadow-[0_0_15px_rgba(240,183,31,0.1)] backdrop-blur-md">
                        <div className="flex items-center gap-2 mb-2 border-b border-cyber-gold/20 pb-2">
                            <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
                            <span className="font-bold tracking-widest text-white text-[10px]">
                                SYSTEM_LOG
                            </span>
                        </div>
                        <div className="flex flex-col gap-1 overflow-hidden">
                            {logs.map((log, i) => (
                                <div
                                    key={i}
                                    className="opacity-80"
                                    style={{
                                        animation:
                                            "fadeSlideIn 0.3s ease-out forwards",
                                    }}
                                >
                                    <span className="text-cyber-gray/80 block truncate text-[11px]">
                                        {log}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>

                {/* Center Panel: Scanner Reticle */}
                <div className="w-full lg:w-1/2 order-1 lg:order-2 flex flex-col items-center justify-center relative">
                    {/* Scanner Circle */}
                    <div className="relative w-52 h-52 sm:w-64 sm:h-64 flex items-center justify-center">
                        <div className="absolute inset-0 border-2 border-cyber-gold/20 rounded-full animate-[spin_10s_linear_infinite]" />
                        <div className="absolute inset-4 border border-cyber-orange/40 rounded-full animate-[spin_3s_linear_infinite_reverse] border-t-transparent border-l-transparent" />

                        {/* Inner ring */}
                        <div className="absolute inset-8 border border-cyber-gold/15 rounded-full" />

                        {/* Crosshairs */}
                        <div className="absolute inset-0 flex items-center justify-center">
                            <div className="w-full h-px bg-cyber-gold/30" />
                            <div className="h-full w-px bg-cyber-gold/30 absolute" />
                        </div>

                        {/* Corner brackets */}
                        <div className="absolute top-2 left-2 w-4 h-4 border-t-2 border-l-2 border-cyber-gold/60" />
                        <div className="absolute top-2 right-2 w-4 h-4 border-t-2 border-r-2 border-cyber-gold/60" />
                        <div className="absolute bottom-2 left-2 w-4 h-4 border-b-2 border-l-2 border-cyber-gold/60" />
                        <div className="absolute bottom-2 right-2 w-4 h-4 border-b-2 border-r-2 border-cyber-gold/60" />

                        {/* Scanner Bar */}
                        <div
                            className="absolute w-full h-0.5 bg-cyber-gold/80 shadow-[0_0_10px_#F0B71F] opacity-70 top-0"
                            style={{
                                animation: "scanBar 2s ease-in-out infinite",
                            }}
                        />

                        {/* Center Label */}
                        <div className="bg-black/80 px-4 py-1.5 border border-cyber-gold text-cyber-gold font-orbitron font-bold tracking-widest text-xs sm:text-sm z-10 animate-pulse">
                            SEARCHING
                        </div>
                    </div>

                    <div className="mt-6 sm:mt-8 text-center">
                        <h2 className="text-2xl sm:text-3xl font-bold font-orbitron text-white mb-1">
                            ARENA LINK ACTIVE
                        </h2>
                        <p className="text-cyber-gray font-mono text-sm">
                            <span className="text-cyber-gold">
                                {playerCount}
                            </span>{" "}
                            SIGNALS DETECTED
                        </p>
                    </div>
                </div>

                {/* Right Panel: Timer & Cancel */}
                <div className="w-full lg:w-1/4 order-3 flex flex-col gap-4 pt-8 lg:pt-12">
                    <div className="bg-black/60 border-r-2 border-cyber-orange/50 p-4 font-orbitron text-right backdrop-blur-md">
                        <div className="text-xs text-cyber-gray uppercase tracking-widest mb-1">
                            Elapsed Time
                        </div>
                        <div className="text-3xl sm:text-4xl font-bold text-white tabular-nums">
                            {formattedTime}
                        </div>
                    </div>

                    <div className="bg-black/60 border-r-2 border-cyber-gold/50 p-4 font-orbitron text-right flex-grow flex flex-col justify-end backdrop-blur-md">
                        <div className="text-xs text-cyber-gray uppercase tracking-widest mb-2">
                            Priority Queue
                        </div>
                        <div className="w-full bg-cyber-gray/20 h-1 mb-1 overflow-hidden">
                            <div
                                className="h-full bg-gradient-to-r from-cyber-gold to-cyber-orange w-full origin-left"
                                style={{
                                    animation:
                                        "loadingBar 2s ease-in-out infinite",
                                }}
                            />
                        </div>
                        <div className="text-cyber-gold text-xs">
                            Stellar Network Mode
                        </div>
                    </div>

                    <button
                        onClick={onCancel}
                        className="w-full border border-red-500/50 text-red-400 hover:bg-red-500/10 hover:border-red-500 font-orbitron py-3 rounded-xl text-sm transition-all mt-auto bg-transparent"
                    >
                        ABORT LINK
                    </button>
                </div>
            </div>

            <style>{`
                @keyframes flashOut {
                    0% { opacity: 1; }
                    100% { opacity: 0; visibility: hidden; }
                }
                @keyframes fadeInFromBlack {
                    0% { filter: brightness(0); }
                    100% { filter: brightness(1); }
                }
                @keyframes scanBar {
                    0%, 100% { top: 0%; opacity: 0; }
                    10%, 90% { opacity: 1; }
                    50% { top: 100%; }
                }
                @keyframes loadingBar {
                    0% { transform: scaleX(0); }
                    50% { transform: scaleX(1); }
                    100% { transform: scaleX(0); transform-origin: right; }
                }
                @keyframes scanVertical {
                    0% { top: 0%; }
                    50% { top: 100%; }
                    100% { top: 0%; }
                }
                @keyframes fadeSlideIn {
                    0% { opacity: 0; transform: translateX(-8px); }
                    100% { opacity: 0.8; transform: translateX(0); }
                }
            `}</style>
        </div>
    );
}
