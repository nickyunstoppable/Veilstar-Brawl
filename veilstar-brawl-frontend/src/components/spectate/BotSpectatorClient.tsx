/**
 * BotSpectatorClient — Bot Match Spectator
 * Pre-computed bot match playback with Phaser canvas, betting panel and chat.
 * Handles tab visibility sync and auto-match transitions via EventBus.
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { HugeiconsIcon } from "@hugeicons/react";
import { RoboticIcon } from "@hugeicons/core-free-icons";
import { SpectatorChat } from "./SpectatorChat";
import { BotBettingPanel } from "../betting/BotBettingPanel";
import { WinningNotification } from "../betting/WinningNotification";
import { EventBus } from "../../game/EventBus";
import type { BotTurnData } from "../../lib/chat/fake-chat-service";
import type { BotBattleSceneConfig } from "../../game/scenes/BotBattleScene";

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:3001";
const BOT_MATCH_SIDE_CACHE_KEY = "bot_betting_match_side_cache_v1";
const BETTING_DURATION_MS = 30000;
const BOT_MAX_HP = 100;
const BOT_MAX_ENERGY = 100;

// =============================================================================
// TYPES
// =============================================================================

interface BotMatch {
    id: string;
    bot1CharacterId: string;
    bot2CharacterId: string;
    bot1Name: string;
    bot2Name: string;
    turns: BotTurnData[];
    totalTurns: number;
    turnDurationMs: number;
    matchWinner: string | null;
    status: string;
    createdAt: number;
    seed: string;
}

interface BotSpectatorClientProps {
    matchId: string;
}

function navigate(path: string) {
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
}

function readCachedMatchBet(matchId: string): { side: "player1" | "player2"; amount?: number | string | null } | null {
    try {
        const raw = localStorage.getItem(BOT_MATCH_SIDE_CACHE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        const cached = parsed?.[matchId];
        if (!cached) return null;
        const side = cached.side;
        if (side !== "player1" && side !== "player2") return null;
        return { side, amount: cached.amount };
    } catch {
        return null;
    }
}

// =============================================================================
// COMPONENT
// =============================================================================

export function BotSpectatorClient({ matchId }: BotSpectatorClientProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const gameRef = useRef<Phaser.Game | null>(null);
    const isLoadingNewMatch = useRef(false);
    const isSyncingRef = useRef(false);
    const tabHiddenAtRef = useRef<number | null>(null);
    const nextMatchRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const nextMatchRetryAttemptsRef = useRef(0);
    const winNotificationShownForMatchRef = useRef<string | null>(null);

    const [currentMatch, setCurrentMatch] = useState<BotMatch | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [gameReady, setGameReady] = useState(false);

    // Betting/progress state for header UI and betting panel props
    const [bettingSecondsRemaining, setBettingSecondsRemaining] = useState(30);
    const [isBettingOpen, setIsBettingOpen] = useState(true);
    const [startTurnIndex, setStartTurnIndex] = useState(0);

    // Winning notification
    const [showWinNotification, setShowWinNotification] = useState(false);
    const [winAmount, setWinAmount] = useState<number>(0);
    const [winPrediction, setWinPrediction] = useState<"player1" | "player2" | "bot1" | "bot2">("player1");
    const [winWinnerName, setWinWinnerName] = useState<string>("");

    const normalizeSide = useCallback((value: unknown): "player1" | "player2" | null => {
        const normalized = String(value || "").toLowerCase();
        if (normalized === "player1" || normalized === "bot1") return "player1";
        if (normalized === "player2" || normalized === "bot2") return "player2";
        return null;
    }, []);

    const showWinningNotificationFromBet = useCallback((
        match: BotMatch,
        userBet: any,
        options?: {
            requireWonStatus?: boolean;
            forcedPrediction?: "player1" | "player2";
        }
    ) => {
        if (!userBet) return false;

        const normalizedStatus = String(userBet.status || "").toLowerCase();
        const requireWonStatus = options?.requireWonStatus ?? true;
        if (requireWonStatus && normalizedStatus !== "won") return false;

        const betPrediction = normalizeSide(userBet.bet_on ?? userBet.betOn);
        const prediction = options?.forcedPrediction ?? betPrediction;
        if (!prediction) return false;

        const payoutCandidate =
            userBet.payout_amount
            ?? userBet.payoutAmount
            ?? userBet.onchain_payout_amount
            ?? userBet.onchainPayoutAmount
            ?? userBet.amount
            ?? null;

        let payoutXlm = 0;
        if (payoutCandidate !== null && payoutCandidate !== undefined && payoutCandidate !== "") {
            try {
                const payoutStroops = BigInt(String(payoutCandidate));
                const optimisticPayoutStroops =
                    userBet.payout_amount || userBet.payoutAmount || userBet.onchain_payout_amount || userBet.onchainPayoutAmount
                        ? payoutStroops
                        : payoutStroops * 2n;
                payoutXlm = Number(optimisticPayoutStroops) / 10000000;
            } catch {
                const numeric = Number(payoutCandidate);
                payoutXlm = Number.isFinite(numeric) ? (numeric * 2) / 10000000 : 0;
            }
        }

        const winnerName = prediction === "player1" ? match.bot1Name : match.bot2Name;

        setWinAmount(Number.isFinite(payoutXlm) && payoutXlm > 0 ? payoutXlm : 0);
        setWinPrediction(prediction);
        setWinWinnerName(winnerName);
        setShowWinNotification(true);

        winNotificationShownForMatchRef.current = match.id;
        return true;
    }, []);

    const checkForWinningBet = useCallback(async (
        match: BotMatch,
        options?: {
            requireWonStatus?: boolean;
            forcedPrediction?: "player1" | "player2";
        }
    ) => {
        const userAddress = localStorage.getItem("stellar_address");
        if (!userAddress) return false;

        try {
            const res = await fetch(`${API_BASE}/api/bot-betting/pool/${match.id}?address=${encodeURIComponent(userAddress)}`);
            if (!res.ok) return false;
            const data = await res.json();
            return showWinningNotificationFromBet(match, data.userBet, options);
        } catch {
            return false;
        }
    }, [showWinningNotificationFromBet]);

    // Fetch match data
    const fetchMatch = useCallback(async (id: string) => {
        try {
            setLoading(true);
            const response = await fetch(`${API_BASE}/api/bot-games?matchId=${id}`);
            if (!response.ok) throw new Error("Failed to fetch bot match");
            const data = await response.json();
            const match = data.match;
            if (!match) throw new Error("No bot match available");

            setCurrentMatch(match);

            // Calculate start turn based on elapsed time
            const elapsed = Date.now() - match.createdAt;
            if (elapsed < BETTING_DURATION_MS) {
                setIsBettingOpen(true);
                setBettingSecondsRemaining(Math.ceil((BETTING_DURATION_MS - elapsed) / 1000));
                setStartTurnIndex(0);
            } else {
                setIsBettingOpen(false);
                setBettingSecondsRemaining(0);
                const matchElapsed = elapsed - BETTING_DURATION_MS;
                const turnIndex = Math.min(
                    Math.floor(matchElapsed / (match.turnDurationMs || 2500)),
                    match.totalTurns - 1
                );
                setStartTurnIndex(turnIndex);
            }

            setLoading(false);
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to load bot match");
            setLoading(false);
        }
    }, []);

    // Initial fetch
    useEffect(() => {
        fetchMatch(matchId);
    }, [matchId, fetchMatch]);

    useEffect(() => {
        winNotificationShownForMatchRef.current = null;
        setShowWinNotification(false);
    }, [matchId]);

    // Betting countdown timer (for the betting panel props)
    useEffect(() => {
        if (!isBettingOpen || bettingSecondsRemaining <= 0) return;

        const timer = setInterval(() => {
            setBettingSecondsRemaining(prev => {
                if (prev <= 1) {
                    setIsBettingOpen(false);
                    return 0;
                }
                return prev - 1;
            });
        }, 1000);

        return () => clearInterval(timer);
    }, [isBettingOpen, bettingSecondsRemaining]);

    // Fallback auto-switch polling after a match has fully elapsed.
    useEffect(() => {
        if (!currentMatch) return;

        const matchDurationMs = BETTING_DURATION_MS + (currentMatch.totalTurns * (currentMatch.turnDurationMs || 2500));
        const hasFullyElapsed = Date.now() - currentMatch.createdAt >= matchDurationMs + 5000;
        if (!hasFullyElapsed) return;

        const interval = setInterval(async () => {
            try {
                const response = await fetch(`${API_BASE}/api/bot-games`);
                if (!response.ok) return;
                const data = await response.json();
                if (data.match && data.match.id !== currentMatch.id) {
                    navigate(`/spectate/bot/${data.match.id}`);
                }
            } catch {
                // Ignore transient errors
            }
        }, 2500);

        return () => clearInterval(interval);
    }, [currentMatch]);

    // Initialize Phaser once match data is loaded
    useEffect(() => {
        if (!currentMatch || !containerRef.current) return;

        let isMounted = true;

        async function initGame() {
            if (!currentMatch || !containerRef.current) return;

            try {
                const Phaser = (await import("phaser")).default;
                const { BotBattleScene } = await import("../../game/scenes/BotBattleScene");

                if (!isMounted || !containerRef.current) return;

                if (gameRef.current) {
                    gameRef.current.destroy(true);
                    gameRef.current = null;
                }

                const phaserConfig: Phaser.Types.Core.GameConfig = {
                    type: Phaser.AUTO,
                    width: 1280,
                    height: 720,
                    parent: containerRef.current,
                    backgroundColor: "#0a0a0a",
                    scale: {
                        mode: Phaser.Scale.FIT,
                        autoCenter: Phaser.Scale.CENTER_BOTH,
                    },
                    scene: [BotBattleScene],
                };

                gameRef.current = new Phaser.Game(phaserConfig);

                // Map matchWinner: "bot1"/"bot2" → "player1"/"player2"
                const mappedWinner: "player1" | "player2" | null =
                    currentMatch.matchWinner === "bot1" ? "player1" :
                    currentMatch.matchWinner === "bot2" ? "player2" : null;

                const sceneConfig: BotBattleSceneConfig = {
                    matchId: currentMatch.id,
                    bot1CharacterId: currentMatch.bot1CharacterId,
                    bot2CharacterId: currentMatch.bot2CharacterId,
                    bot1Name: currentMatch.bot1Name,
                    bot2Name: currentMatch.bot2Name,
                    turns: currentMatch.turns,
                    totalTurns: currentMatch.totalTurns,
                    startTurnIndex,
                    turnDurationMs: currentMatch.turnDurationMs || 2500,
                    bot1MaxHp: BOT_MAX_HP,
                    bot2MaxHp: BOT_MAX_HP,
                    bot1MaxEnergy: BOT_MAX_ENERGY,
                    bot2MaxEnergy: BOT_MAX_ENERGY,
                    matchWinner: mappedWinner,
                    bot1RoundsWon: 0,
                    bot2RoundsWon: 0,
                    matchCreatedAt: currentMatch.createdAt,
                    bettingStatus: {
                        isOpen: isBettingOpen,
                        secondsRemaining: bettingSecondsRemaining,
                    },
                };

                gameRef.current.scene.start("BotBattleScene", sceneConfig);
                setGameReady(true);
            } catch (err) {
                console.error("[BotSpectatorClient] Failed to init Phaser:", err);
                setError("Failed to load game");
            }
        }

        initGame();

        // Match end: check if user won a bet
        const handleMatchEnd = async (rawData: unknown) => {
            const eventData = rawData as { matchId: string; winner: "player1" | "player2" | null };
            if (eventData.matchId !== currentMatch.id) return;

            if (winNotificationShownForMatchRef.current === currentMatch.id) return;

            const winnerSide = normalizeSide(eventData.winner);
            if (winnerSide) {
                const cachedBet = readCachedMatchBet(currentMatch.id);
                if (cachedBet && cachedBet.side === winnerSide) {
                    showWinningNotificationFromBet(currentMatch, {
                        bet_on: cachedBet.side,
                        amount: cachedBet.amount,
                    }, {
                        requireWonStatus: false,
                        forcedPrediction: winnerSide,
                    });
                    return;
                }

                const optimisticShown = await checkForWinningBet(currentMatch, {
                    requireWonStatus: false,
                    forcedPrediction: winnerSide,
                });
                if (optimisticShown) return;
            }

            const maxAttempts = 12;
            for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
                const shown = await checkForWinningBet(currentMatch);
                if (shown) break;
                await new Promise((resolve) => setTimeout(resolve, 1500));
            }
        };
        EventBus.on("bot_battle_match_end", handleMatchEnd);

        // New match request
        const handleNewMatchRequest = async () => {
            if (isLoadingNewMatch.current) return;
            isLoadingNewMatch.current = true;

            try {
                const response = await fetch(`${API_BASE}/api/bot-games`);
                if (response.ok) {
                    const data = await response.json();
                    if (data.match && data.match.id !== currentMatch.id) {
                        if (nextMatchRetryTimerRef.current) {
                            clearTimeout(nextMatchRetryTimerRef.current);
                            nextMatchRetryTimerRef.current = null;
                        }
                        nextMatchRetryAttemptsRef.current = 0;
                        navigate(`/spectate/bot/${data.match.id}`);
                        return;
                    }
                }

                if (nextMatchRetryAttemptsRef.current < 15) {
                    nextMatchRetryAttemptsRef.current += 1;
                    nextMatchRetryTimerRef.current = setTimeout(() => {
                        void handleNewMatchRequest();
                    }, 1500);
                }
            } catch {
                // Ignore
            } finally {
                isLoadingNewMatch.current = false;
            }
        };
        EventBus.on("bot_battle_request_new_match", handleNewMatchRequest);

        return () => {
            isMounted = false;
            EventBus.off("bot_battle_match_end", handleMatchEnd);
            EventBus.off("bot_battle_request_new_match", handleNewMatchRequest);
            if (nextMatchRetryTimerRef.current) {
                clearTimeout(nextMatchRetryTimerRef.current);
                nextMatchRetryTimerRef.current = null;
            }
            if (gameRef.current) {
                gameRef.current.destroy(true);
                gameRef.current = null;
            }
        };
    }, [currentMatch, checkForWinningBet, normalizeSide]); // eslint-disable-line react-hooks/exhaustive-deps

    // Tab visibility sync — emit to Phaser scene via EventBus
    const handleVisibilityChange = useCallback(() => {
        if (document.visibilityState === "hidden") {
            tabHiddenAtRef.current = Date.now();
            return;
        }
        const hiddenDuration = tabHiddenAtRef.current ? Date.now() - tabHiddenAtRef.current : 0;
        if (hiddenDuration < 1000 || isSyncingRef.current || !currentMatch) return;

        isSyncingRef.current = true;
        fetch(`${API_BASE}/api/bot-games/sync?matchId=${currentMatch.id}`)
            .then(res => res.json())
            .then(data => {
                if (data.bettingStatus) {
                    setIsBettingOpen(data.bettingStatus.isOpen);
                    setBettingSecondsRemaining(data.bettingStatus.secondsRemaining || 0);
                }
                EventBus.emit("bot_battle_visibility_resync", {
                    matchId: currentMatch.id,
                    serverTime: Date.now(),
                    currentTurnIndex: data.currentTurnIndex ?? 0,
                    elapsedMs: data.elapsedMs ?? 0,
                    bettingStatus: data.bettingStatus ?? { isOpen: false, secondsRemaining: 0 },
                });
            })
            .catch(() => { })
            .finally(() => {
                isSyncingRef.current = false;
                tabHiddenAtRef.current = null;
            });
    }, [currentMatch]);

    useEffect(() => {
        document.addEventListener("visibilitychange", handleVisibilityChange);
        return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
    }, [handleVisibilityChange]);

    // =========================================================================
    // RENDER
    // =========================================================================

    if (loading) {
        return (
            <div className="relative w-full h-screen flex items-center justify-center bg-[#0a0a0a]">
                <div className="text-center">
                    <div className="w-16 h-16 border-4 border-orange-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
                    <p className="text-orange-400 text-lg font-orbitron tracking-widest uppercase">
                        Loading Bot Match...
                    </p>
                </div>
            </div>
        );
    }

    if (error || !currentMatch) {
        return (
            <div className="relative w-full h-screen flex items-center justify-center bg-[#0a0a0a]">
                <div className="text-center">
                    <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-orange-500/10 border border-orange-500/30 flex items-center justify-center">
                        <HugeiconsIcon icon={RoboticIcon} className="w-10 h-10 text-orange-400" />
                    </div>
                    <p className="text-red-500 text-lg mb-6">{error || "No bot match available"}</p>
                    <button
                        onClick={() => navigate("/spectate")}
                        className="bg-gradient-to-r from-orange-500 to-amber-500 text-white border-0 font-orbitron px-6 py-3 rounded-lg cursor-pointer font-bold hover:opacity-90 transition-opacity"
                    >
                        ← BACK TO SPECTATE
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="relative w-full h-screen flex flex-col bg-[#0a0a0a] overflow-hidden">
            {/* Header */}
            <motion.div
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
                className="p-4 flex items-center justify-between bg-black/40 backdrop-blur-sm border-b border-cyber-gold/20 shrink-0"
            >
                <button
                    onClick={() => navigate("/spectate")}
                    className="text-cyber-gold hover:text-white font-orbitron text-sm bg-white/5 px-3 py-1.5 rounded-lg transition-colors border-0 cursor-pointer"
                >
                    ← Back
                </button>

                <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-orange-500/20 border border-orange-500/40">
                        <HugeiconsIcon icon={RoboticIcon} className="w-4 h-4 text-orange-400" />
                        <span className="text-orange-400 font-orbitron text-sm font-bold">LIVE BOT MATCH</span>
                    </div>
                    <div className="hidden sm:flex items-center gap-2">
                        <span className="text-gray-400 text-xs font-mono">
                            Turn {startTurnIndex}/{currentMatch.totalTurns}
                        </span>
                        <div className="w-24 h-2 bg-gray-700 rounded-full overflow-hidden">
                            <div
                                className="h-full bg-orange-500 transition-all duration-500"
                                style={{ width: `${currentMatch.totalTurns > 0 ? (startTurnIndex / currentMatch.totalTurns) * 100 : 0}%` }}
                            />
                        </div>
                    </div>
                </div>

                <div className="text-white font-orbitron text-sm">
                    <span className="text-orange-400">{currentMatch.bot1Name}</span>
                    <span className="mx-2 text-gray-500">vs</span>
                    <span className="text-orange-400">{currentMatch.bot2Name}</span>
                </div>

            </motion.div>

            {/* Main Content — Phaser canvas + Betting/Chat panel */}
            <div className="flex-1 flex flex-col xl:flex-row items-stretch gap-4 p-4 min-h-0 overflow-y-auto xl:overflow-hidden">
                {/* Phaser canvas container */}
                <div className="flex-1 flex items-center justify-center w-full min-h-0">
                    <motion.div
                        initial={{ opacity: 0, scale: 0.95 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ delay: 0.1 }}
                        ref={containerRef}
                        className="w-full max-w-[1280px] aspect-video bg-black rounded-lg overflow-hidden border-2 border-orange-500/30 shadow-lg shadow-orange-500/10 relative xl:h-full xl:max-h-full xl:aspect-auto"
                    >
                        {!gameReady && (
                            <div className="flex items-center justify-center h-full">
                                <div className="text-center">
                                    <div className="w-12 h-12 border-4 border-orange-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
                                    <p className="text-orange-400 font-orbitron">
                                        {startTurnIndex > 0
                                            ? `Catching up to turn ${startTurnIndex}...`
                                            : "Loading bot battle..."}
                                    </p>
                                </div>
                            </div>
                        )}

                        {/* Waiting for bets overlay */}
                        <AnimatePresence>
                            {gameReady && isBettingOpen && bettingSecondsRemaining > 0 && (
                                <motion.div
                                    initial={{ opacity: 0, scale: 0.9 }}
                                    animate={{ opacity: 1, scale: 1 }}
                                    exit={{ opacity: 0, scale: 1.1 }}
                                    className="absolute inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
                                >
                                    <div className="relative p-8 rounded-2xl border-2 border-orange-500/50 bg-black/90 shadow-[0_0_50px_rgba(255,107,53,0.3)] text-center max-w-[90%] sm:max-w-md">
                                        <h2 className="text-2xl sm:text-4xl font-orbitron font-bold text-yellow-400 mb-4 tracking-wider animate-pulse">
                                            WAITING FOR BETS...
                                        </h2>
                                        <div className="flex justify-center my-6">
                                            <div className={`text-6xl sm:text-8xl font-orbitron font-bold ${
                                                bettingSecondsRemaining <= 5 ? "text-red-500" :
                                                bettingSecondsRemaining <= 10 ? "text-orange-500" : "text-orange-400"
                                            }`}>
                                                {bettingSecondsRemaining}
                                            </div>
                                        </div>
                                        <p className="text-gray-400 text-sm">Match starts when timer reaches 0</p>
                                    </div>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </motion.div>
                </div>

                {/* Right panel — Betting + Chat */}
                <motion.div
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.3 }}
                    className="w-full xl:w-[380px] shrink-0 flex flex-col gap-4 min-h-0 xl:h-full xl:overflow-y-auto pr-1"
                >
                    <BotBettingPanel
                        matchId={currentMatch.id}
                        bot1Name={currentMatch.bot1Name}
                        bot2Name={currentMatch.bot2Name}
                        bettingSecondsRemaining={bettingSecondsRemaining}
                        isBettingOpen={isBettingOpen}
                    />
                    <SpectatorChat
                        matchId={currentMatch.id}
                        matchStartTime={currentMatch.createdAt}
                        turns={currentMatch.turns}
                        isBotMatch={true}
                        player1Name={currentMatch.bot1Name}
                        player2Name={currentMatch.bot2Name}
                        bettingPhaseEndTime={currentMatch.createdAt + BETTING_DURATION_MS}
                    />
                </motion.div>
            </div>

            {/* Footer */}
            <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.4 }}
                className="px-4 py-3 bg-black/40 border-t border-cyber-gold/20 shrink-0"
            >
                <div className="flex items-center justify-between text-xs text-gray-500">
                    <p>
                        <span className="text-orange-400">⚡</span> 24/7 Bot Battle Room • New match starts automatically •
                        You joined at turn {startTurnIndex}
                    </p>
                    <p className="font-mono hidden sm:block">{currentMatch.id.slice(0, 20)}...</p>
                </div>
            </motion.div>

            {/* Win Notification */}
            <WinningNotification
                show={showWinNotification}
                amount={winAmount}
                prediction={winPrediction}
                winnerName={winWinnerName}
                onClose={() => setShowWinNotification(false)}
            />
        </div>
    );
}
