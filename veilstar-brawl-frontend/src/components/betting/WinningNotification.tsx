/**
 * WinningNotification Component
 * Shows animated celebration when user wins a bet
 * Casino psychology: Only show wins, never show losses
 */

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import confetti from "canvas-confetti";
import { ClashShardsIcon } from "../currency/ClashShardsIcon";

interface WinningNotificationProps {
    show: boolean;
    amount: number; // Amount won in XLM
    prediction: "player1" | "player2" | "bot1" | "bot2";
    winnerName: string;
    onClose: () => void;
}

export function WinningNotification({
    show,
    amount,
    prediction,
    winnerName,
    onClose
}: WinningNotificationProps) {
    const [hasPlayedConfetti, setHasPlayedConfetti] = useState(false);

    useEffect(() => {
        if (show && !hasPlayedConfetti) {
            // Fire confetti
            const duration = 3000;
            const animationEnd = Date.now() + duration;
            const defaults = { startVelocity: 30, spread: 360, ticks: 60, zIndex: 9999 };

            function randomInRange(min: number, max: number) {
                return Math.random() * (max - min) + min;
            }

            const interval: any = setInterval(function() {
                const timeLeft = animationEnd - Date.now();

                if (timeLeft <= 0) {
                    return clearInterval(interval);
                }

                const particleCount = 50 * (timeLeft / duration);
                confetti({
                    ...defaults,
                    particleCount,
                    origin: { x: randomInRange(0.1, 0.3), y: Math.random() - 0.2 },
                    colors: ['#FFD700', '#FFA500', '#FF6B35', '#F7931A']
                });
                confetti({
                    ...defaults,
                    particleCount,
                    origin: { x: randomInRange(0.7, 0.9), y: Math.random() - 0.2 },
                    colors: ['#FFD700', '#FFA500', '#FF6B35', '#F7931A']
                });
            }, 250);

            setHasPlayedConfetti(true);

            // Auto close after 5 seconds
            const timeout = setTimeout(() => {
                onClose();
            }, 5000);

            return () => {
                clearInterval(interval);
                clearTimeout(timeout);
            };
        }

        if (!show) {
            setHasPlayedConfetti(false);
        }
    }, [show, hasPlayedConfetti, onClose]);

    return (
        <AnimatePresence>
            {show && (
                <>
                    {/* Backdrop */}
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[9998]"
                        onClick={onClose}
                    />

                    {/* Winning Card */}
                    <motion.div
                        initial={{ scale: 0, rotate: -10, y: 100 }}
                        animate={{ 
                            scale: 1, 
                            rotate: 0, 
                            y: 0,
                            transition: {
                                type: "spring",
                                stiffness: 200,
                                damping: 15
                            }
                        }}
                        exit={{ scale: 0, opacity: 0 }}
                        className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[9999] w-[90vw] max-w-md"
                    >
                        <div className="relative bg-gradient-to-br from-yellow-500/20 via-orange-500/20 to-red-500/20 rounded-2xl border-4 border-yellow-400 shadow-2xl shadow-yellow-500/50 overflow-hidden">
                            {/* Animated background */}
                            <div className="absolute inset-0 bg-gradient-to-br from-yellow-500/10 to-orange-500/10 animate-pulse" />
                            
                            {/* Glowing particles effect */}
                            <div className="absolute inset-0 overflow-hidden">
                                {[...Array(20)].map((_, i) => (
                                    <motion.div
                                        key={i}
                                        className="absolute w-2 h-2 bg-yellow-400 rounded-full"
                                        initial={{ 
                                            x: Math.random() * 400 - 200,
                                            y: Math.random() * 400 - 200,
                                            opacity: 0
                                        }}
                                        animate={{
                                            y: [null, -500],
                                            opacity: [0, 1, 0],
                                            scale: [0, 1.5, 0]
                                        }}
                                        transition={{
                                            duration: 2,
                                            delay: i * 0.1,
                                            repeat: Infinity,
                                            repeatDelay: 1
                                        }}
                                        style={{
                                            left: '50%',
                                            top: '50%'
                                        }}
                                    />
                                ))}
                            </div>

                            {/* Content */}
                            <div className="relative p-8 text-center">
                                {/* Trophy/Star Icon */}
                                <motion.div
                                    initial={{ scale: 0, rotate: 180 }}
                                    animate={{ 
                                        scale: 1, 
                                        rotate: 0,
                                        transition: { delay: 0.2, type: "spring" }
                                    }}
                                    className="mb-4 flex justify-center"
                                >
                                    <div className="w-20 h-20 bg-gradient-to-br from-yellow-400 to-orange-500 rounded-full flex items-center justify-center shadow-lg shadow-yellow-500/50">
                                        <ClashShardsIcon className="w-12 h-12 text-white" />
                                    </div>
                                </motion.div>

                                {/* Winner Text */}
                                <motion.div
                                    initial={{ opacity: 0, y: 20 }}
                                    animate={{ opacity: 1, y: 0, transition: { delay: 0.3 } }}
                                >
                                    <h2 className="text-4xl font-bold text-yellow-400 font-orbitron mb-2 tracking-wider drop-shadow-lg">
                                        YOU WIN!
                                    </h2>
                                    <p className="text-gray-300 text-lg mb-4">
                                        Your prediction was correct!
                                    </p>
                                </motion.div>

                                {/* Winner Name */}
                                <motion.div
                                    initial={{ opacity: 0, scale: 0.8 }}
                                    animate={{ opacity: 1, scale: 1, transition: { delay: 0.4 } }}
                                    className="mb-6 p-3 bg-black/40 rounded-lg border border-yellow-400/30"
                                >
                                    <p className="text-sm text-gray-400 mb-1">Winner</p>
                                    <p className="text-xl font-bold text-yellow-400 font-orbitron">
                                        {winnerName}
                                    </p>
                                </motion.div>

                                {/* Amount Won */}
                                <motion.div
                                    initial={{ opacity: 0, scale: 0.5 }}
                                    animate={{ 
                                        opacity: 1, 
                                        scale: 1,
                                        transition: { delay: 0.5, type: "spring", stiffness: 300 }
                                    }}
                                    className="mb-6"
                                >
                                    <p className="text-sm text-gray-400 mb-2">You Won</p>
                                    <div className="flex items-center justify-center gap-3">
                                        <motion.div
                                            animate={{ 
                                                scale: [1, 1.1, 1],
                                                rotate: [0, 5, -5, 0]
                                            }}
                                            transition={{ 
                                                duration: 0.5,
                                                repeat: Infinity,
                                                repeatDelay: 1
                                            }}
                                        >
                                            <ClashShardsIcon className="w-10 h-10" />
                                        </motion.div>
                                        <p className="text-6xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-yellow-400 via-orange-400 to-yellow-400 font-orbitron">
                                            {amount.toFixed(2)}
                                        </p>
                                    </div>
                                    <p className="text-gray-400 mt-2">XLM</p>
                                </motion.div>

                                {/* Payout Message */}
                                <motion.div
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1, transition: { delay: 0.6 } }}
                                    className="text-sm text-green-400 p-3 bg-green-500/10 rounded-lg border border-green-500/30 mb-4"
                                >
                                     Winnings have been sent to your wallet
                                </motion.div>

                                {/* Close Button */}
                                <motion.button
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1, transition: { delay: 0.7 } }}
                                    onClick={onClose}
                                    className="w-full py-3 bg-gradient-to-r from-yellow-500 to-orange-500 text-white font-bold rounded-lg font-orbitron hover:opacity-90 transition-opacity"
                                >
                                    AWESOME!
                                </motion.button>
                            </div>
                        </div>
                    </motion.div>
                </>
            )}
        </AnimatePresence>
    );
}
