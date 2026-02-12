/**
 * QueuePage — Fullscreen matchmaking queue
 * Auto-joins queue on mount, shows immersive HUD while searching,
 * triggers on-chain registration when opponent is found,
 * navigates to /match/:matchId after registration completes.
 */

import React, { useEffect, useState, useRef } from "react";
import MatchmakingHUD from "@/components/matchmaking/MatchmakingHUD";
import { useMatchmakingQueue } from "@/hooks/useMatchmakingQueue";
import { useWallet } from "@/hooks/useWallet";
import { useOnChainRegistration } from "@/hooks/useOnChainRegistration";
import { getSupabaseClient } from "@/lib/supabase/client";

function navigateTo(path: string) {
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
}

export default function QueuePage() {
    const { publicKey, isConnected } = useWallet();
    const {
        isInQueue,
        isJoining,
        isMatching,
        waitTimeSeconds,
        playerCount,
        error,
        matchResult,
        joinQueue,
        leaveQueue,
    } = useMatchmakingQueue();

    const {
        status: regStatus,
        error: regError,
        registerOnChain,
        markComplete,
    } = useOnChainRegistration();

    const [hasStarted, setHasStarted] = useState(false);
    const navigationDoneRef = useRef(false);
    const matchFoundAtRef = useRef<number | null>(null);
    const registrationTriggeredRef = useRef(false);

    // Track when the Opponent Found screen first appears
    useEffect(() => {
        if ((isMatching || matchResult) && !matchFoundAtRef.current) {
            matchFoundAtRef.current = Date.now();
        }
    }, [isMatching, matchResult]);

    // Auto-join queue on mount if wallet connected
    useEffect(() => {
        if (isConnected && publicKey && !isInQueue && !hasStarted && !isJoining) {
            setHasStarted(true);
            joinQueue();
        }
    }, [isConnected, publicKey, isInQueue, hasStarted, isJoining, joinQueue]);

    // When match is found, trigger on-chain registration immediately.
    useEffect(() => {
        if (!matchResult) return;
        if (registrationTriggeredRef.current) return;

        registrationTriggeredRef.current = true;
        registerOnChain(matchResult.matchId).catch((err) => {
            console.error("[QueuePage] Registration signing failed:", err);
        });
    }, [matchResult, registerOnChain]);

    // Listen for registration_complete broadcast (when other player finishes signing)
    // IMPORTANT: server broadcasts on `game:<matchId>`.
    useEffect(() => {
        if (!matchResult) return;

        const supabase = getSupabaseClient();
        const channel = supabase
            .channel(`game:${matchResult.matchId}`)
            .on("broadcast", { event: "registration_complete" }, (payload) => {
                const data = payload.payload as { txHash?: string };
                console.log("[QueuePage] registration_complete received");
                markComplete(data?.txHash);
            })
            .subscribe();

        return () => {
            supabase.removeChannel(channel);
        };
    }, [matchResult, markComplete]);

    // Navigate to match only once BOTH players have signed (status === "complete").
    // Enforce a minimum 2-second Opponent Found display so both players see it.
    useEffect(() => {
        if (!matchResult || navigationDoneRef.current) return;

        if (regStatus !== "complete") return;

        const MIN_DISPLAY_MS = 2000;
        const elapsed = matchFoundAtRef.current
            ? Date.now() - matchFoundAtRef.current
            : 0;
        const remaining = Math.max(0, MIN_DISPLAY_MS - elapsed);

        const timer = setTimeout(() => {
            if (!navigationDoneRef.current) {
                navigationDoneRef.current = true;
                navigateTo(`/match/${matchResult.matchId}`);
            }
        }, remaining);

        return () => clearTimeout(timer);
    }, [matchResult, regStatus]);

    // Wallet not connected
    if (!isConnected) {
        return (
            <div className="fixed inset-0 bg-black flex items-center justify-center z-50">
                <div className="text-center bg-black/40 border border-cyber-orange/30 rounded-[20px] p-10 max-w-md">
                    <h2 className="text-2xl font-bold text-white font-orbitron mb-4">
                        WALLET REQUIRED
                    </h2>
                    <p className="text-cyber-gray text-sm mb-6">
                        Connect your Stellar wallet to search for opponents.
                    </p>
                    <button
                        onClick={() => navigateTo("/play")}
                        className="w-full bg-transparent border border-cyber-orange text-cyber-orange font-orbitron hover:bg-cyber-orange/10 py-3 rounded-xl text-sm"
                    >
                        BACK TO ARENA
                    </button>
                </div>
            </div>
        );
    }

    // Error state
    if (error) {
        return (
            <div className="fixed inset-0 bg-black flex items-center justify-center z-50">
                <div className="text-center bg-black/40 border border-red-500/30 rounded-[20px] p-10 max-w-md">
                    <h2 className="text-2xl font-bold text-red-500 font-orbitron mb-4">
                        ERROR
                    </h2>
                    <p className="text-cyber-gray text-sm mb-6">{error}</p>
                    <div className="flex gap-4">
                        <button
                            onClick={() => {
                                setHasStarted(false);
                                joinQueue();
                            }}
                            className="flex-1 bg-gradient-cyber text-white border-0 font-orbitron hover:opacity-90 py-3 rounded-xl text-sm"
                        >
                            TRY AGAIN
                        </button>
                        <button
                            onClick={() => navigateTo("/play")}
                            className="flex-1 bg-transparent border border-white/10 text-cyber-gray font-orbitron hover:bg-white/5 py-3 rounded-xl text-sm"
                        >
                            BACK
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    // Matching state — opponent found animation + on-chain registration
    // Use both isMatching (queue status) and matchResult (definitive match found)
    // because the initiating player may skip the "matching" state entirely,
    // jumping straight from "queued" to "matched"
    if (isMatching || matchResult) {
        return (
            <div className="fixed inset-0 bg-black flex flex-col items-center justify-center z-50">
                <div className="relative w-64 h-64 mb-12 flex items-center justify-center">
                    <div className="absolute w-full h-full rounded-full border-4 border-emerald-500 animate-ping" />
                    <div className="absolute w-32 h-32 rounded-full bg-emerald-500/20 flex items-center justify-center">
                        <svg
                            className="w-16 h-16 text-emerald-500"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M5 13l4 4L19 7"
                            />
                        </svg>
                    </div>
                </div>
                <h2 className="text-2xl font-bold font-orbitron text-emerald-500 mb-2">
                    OPPONENT FOUND!
                </h2>

                {/* On-chain registration status */}
                {regStatus !== "idle" && regStatus !== "complete" && regStatus !== "skipped" && (
                    <div className="mt-4">
                        <div className="bg-black/80 border border-cyber-gold/40 rounded-xl px-6 py-3 flex items-center gap-3 backdrop-blur-sm">
                            {regStatus === "error" ? (
                                <>
                                    <span className="w-3 h-3 rounded-full bg-red-500" />
                                    <span className="text-red-400 text-xs font-orbitron tracking-wider">
                                        ON-CHAIN: {regError || "FAILED"}
                                    </span>
                                </>
                            ) : (
                                <>
                                    <div className="w-4 h-4 border-2 border-cyber-gold border-t-transparent rounded-full animate-spin" />
                                    <span className="text-cyber-gold text-xs font-orbitron tracking-wider">
                                        {regStatus === "preparing" && "PREPARING TX..."}
                                        {regStatus === "signing" && "SIGN IN WALLET..."}
                                        {regStatus === "waiting_for_opponent" && "WAITING FOR OPPONENT SIGNATURE..."}
                                        {regStatus === "submitting" && "SUBMITTING ON-CHAIN..."}
                                    </span>
                                </>
                            )}
                        </div>
                    </div>
                )}

                {regStatus === "idle" && (
                    <p className="text-cyber-gray font-montserrat">
                        Preparing match...
                    </p>
                )}

                {regStatus === "complete" && (
                    <p className="text-cyber-gray font-montserrat">
                        Entering character select...
                    </p>
                )}
            </div>
        );
    }

    // Default: immersive search HUD
    return (
        <div className="fixed inset-0 z-50">
            <MatchmakingHUD
                waitTimeSeconds={waitTimeSeconds}
                playerCount={playerCount}
                onCancel={async () => {
                    await leaveQueue();
                    navigateTo("/play");
                }}
            />
        </div>
    );
}
