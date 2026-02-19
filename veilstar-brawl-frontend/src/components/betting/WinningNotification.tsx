/**
 * WinningNotification Component
 * Fullscreen celebration overlay when user wins a bet
 */

import React, { useEffect, useState, useCallback } from "react";
import { formatXlm } from "../../lib/betting/betting-service";

interface WinningNotificationProps {
    isOpen: boolean;
    winAmount: bigint;
    onClose: () => void;
}

export function WinningNotification({ isOpen, winAmount, onClose }: WinningNotificationProps) {
    const [show, setShow] = useState(false);

    useEffect(() => {
        if (isOpen) {
            // Delay slightly for animation
            const timer = setTimeout(() => setShow(true), 100);
            // Auto-close after 5 seconds
            const autoClose = setTimeout(() => {
                setShow(false);
                setTimeout(onClose, 300);
            }, 5000);
            return () => {
                clearTimeout(timer);
                clearTimeout(autoClose);
            };
        } else {
            setShow(false);
        }
    }, [isOpen, onClose]);

    const handleDismiss = useCallback(() => {
        setShow(false);
        setTimeout(onClose, 300);
    }, [onClose]);

    if (!isOpen) return null;

    return (
        <div
            onClick={handleDismiss}
            style={{
                position: "fixed",
                inset: 0,
                zIndex: 100,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: show ? "rgba(0, 0, 0, 0.85)" : "rgba(0, 0, 0, 0)",
                transition: "background 0.4s",
                cursor: "pointer",
            }}
        >
            <div
                style={{
                    transform: show ? "scale(1)" : "scale(0.3)",
                    opacity: show ? 1 : 0,
                    transition: "all 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)",
                    textAlign: "center",
                    position: "relative",
                }}
            >
                {/* Glow ring */}
                <div
                    style={{
                        position: "absolute",
                        inset: "-80px",
                        borderRadius: "50%",
                        background: "radial-gradient(circle, rgba(34, 197, 94, 0.15) 0%, transparent 70%)",
                        animation: "pulse 2s infinite",
                        pointerEvents: "none",
                    }}
                />

                {/* Trophy */}
                <div style={{ fontSize: "96px", lineHeight: 1, marginBottom: "20px", animation: "bounce 1s ease" }}>
                    🏆
                </div>

                {/* Title */}
                <h2
                    style={{
                        fontFamily: "'Orbitron', sans-serif",
                        fontSize: "36px",
                        fontWeight: 700,
                        background: "linear-gradient(to right, #fbbf24, #f59e0b, #fbbf24)",
                        WebkitBackgroundClip: "text",
                        WebkitTextFillColor: "transparent",
                        marginBottom: "8px",
                        letterSpacing: "0.1em",
                    }}
                >
                    YOU WON!
                </h2>

                {/* Amount */}
                <div
                    style={{
                        fontSize: "42px",
                        fontWeight: 700,
                        fontFamily: "'Orbitron', sans-serif",
                        color: "#22c55e",
                        marginBottom: "16px",
                    }}
                >
                    +{formatXlm(winAmount)}
                </div>

                {/* Subtitle */}
                <p style={{ color: "#9ca3af", fontSize: "14px" }}>
                    Your winnings have been credited to your account
                </p>

                {/* Dismiss hint */}
                <p style={{ color: "#4b5563", fontSize: "12px", marginTop: "24px" }}>
                    Click anywhere to dismiss
                </p>
            </div>

            <style>{`
                @keyframes bounce {
                    0%, 100% { transform: translateY(0); }
                    50% { transform: translateY(-20px); }
                }
                @keyframes pulse {
                    0%, 100% { opacity: 1; }
                    50% { opacity: 0.5; }
                }
            `}</style>
        </div>
    );
}
