/**
 * ResultsScene — Post-match results screen
 * Shows VICTORY/DEFEAT with glow, round scores, animated ELO,
 * on-chain verification status, and navigation buttons.
 * Adapted from KaspaClash ResultsScene for Veilstar Brawl.
 */

import { Scene } from "phaser";
import { GAME_DIMENSIONS } from "../config";
import { EventBus } from "../EventBus";

const API_BASE = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");

export interface ResultsSceneData {
    isWinner: boolean;
    playerRole: "player1" | "player2";
    matchId: string;
    player1RoundsWon: number;
    player2RoundsWon: number;
    reason?: "knockout" | "timeout" | "forfeit" | "decision";
    ratingChanges?: {
        winner: { before: number; after: number; change: number };
        loser: { before: number; after: number; change: number };
    };
    isPrivateRoom?: boolean;
    onChainSessionId?: number;
    onChainTxHash?: string;
    contractId?: string;
}

export class ResultsScene extends Scene {
    private resultsData!: ResultsSceneData;
    private onChainStatusContainer?: Phaser.GameObjects.Container;
    private onChainStatusBg?: Phaser.GameObjects.Rectangle;
    private onChainStatusLabelText?: Phaser.GameObjects.Text;
    private onChainStatusTxText?: Phaser.GameObjects.Text;
    private onChainPollTimer?: Phaser.Time.TimerEvent;

    constructor() {
        super("ResultsScene");
    }

    private shouldShowRatingChanges(): boolean {
        return !!this.resultsData.ratingChanges && !this.resultsData.isPrivateRoom;
    }

    create(data: ResultsSceneData) {
        this.resultsData = data;
        this.cameras.main.fadeIn(800, 0, 0, 0);
        this.events.once("shutdown", () => this.stopOnChainPolling());
        this.events.once("destroy", () => this.stopOnChainPolling());

        // Background
        this.add.rectangle(
            GAME_DIMENSIONS.CENTER_X,
            GAME_DIMENSIONS.CENTER_Y,
            GAME_DIMENSIONS.WIDTH,
            GAME_DIMENSIONS.HEIGHT,
            0x050505,
        );

        // Subtle grid overlay
        this.add.grid(
            GAME_DIMENSIONS.CENTER_X,
            GAME_DIMENSIONS.CENTER_Y,
            GAME_DIMENSIONS.WIDTH,
            GAME_DIMENSIONS.HEIGHT,
            40, 40,
            0x0a0a0a, 0,
            0x1a1a1a, 0.15,
        );

        const isWinner = this.resultsData.isWinner;

        // ── Title ──
        const titleText = isWinner ? "VICTORY" : "DEFEAT";
        const titleColor = isWinner ? "#F0B71F" : "#ef4444"; // cyber-gold vs red
        const glowHex = isWinner ? 0xf0b71f : 0xef4444;

        const title = this.add.text(
            GAME_DIMENSIONS.CENTER_X, 150, titleText,
            {
                fontFamily: "Orbitron, monospace",
                fontSize: "100px",
                color: titleColor,
                stroke: "#000000",
                strokeThickness: 8,
            },
        ).setOrigin(0.5).setAlpha(0);

        const glow = this.add.text(
            GAME_DIMENSIONS.CENTER_X, 150, titleText,
            {
                fontFamily: "Orbitron, monospace",
                fontSize: "100px",
                color: titleColor,
            },
        ).setOrigin(0.5).setAlpha(0).setBlendMode(Phaser.BlendModes.ADD);

        this.tweens.add({
            targets: [title, glow],
            alpha: 1,
            y: 160,
            duration: 1000,
            ease: "Back.out",
        });

        this.tweens.add({
            targets: glow,
            alpha: 0.4,
            yoyo: true,
            repeat: -1,
            duration: 1500,
            ease: "Sine.easeInOut",
        });

        // ── Reason subtitle ──
        const reason = this.resultsData.reason ?? "knockout";
        const reasonLabel =
            reason === "knockout" ? "KNOCKOUT!" :
            reason === "timeout" ? "TIME OUT" :
            reason === "forfeit" ? (isWinner ? "OPPONENT FORFEITED" : "YOU FORFEITED") :
            "DECISION";

        this.add.text(
            GAME_DIMENSIONS.CENTER_X, 250, reasonLabel,
            {
                fontFamily: "Orbitron, monospace",
                fontSize: "28px",
                color: "#ffffff",
                letterSpacing: 4,
            },
        ).setOrigin(0.5).setAlpha(0.8);

        // ── Stats panel ──
        this.createStatsPanel(isWinner);

        // ── On-chain status ──
        this.createOnChainStatus();
        this.startOnChainPolling();

        // ── Buttons ──
        this.createButtons();
    }

    // =========================================================================
    // Stats panel — rounds won + animated ELO
    // =========================================================================
    private createStatsPanel(isWinner: boolean) {
        const container = this.add.container(GAME_DIMENSIONS.CENTER_X, 410);
        const showRatingChanges = this.shouldShowRatingChanges();

        // Panel background
        const panelH = showRatingChanges ? 230 : this.resultsData.isPrivateRoom ? 180 : 140;
        const panel = this.add.rectangle(0, 0, 580, panelH, 0x111111, 0.9)
            .setStrokeStyle(2, 0x333333);
        container.add(panel);

        const leftX = -140;
        const rightX = 140;
        const headerY = -panelH / 2 + 30;
        const scoreY = headerY + 45;

        // Column headers
        const leftColor = isWinner ? "#F0B71F" : "#ef4444";
        const rightColor = isWinner ? "#ef4444" : "#F0B71F";
        container.add(this.add.text(leftX, headerY, "YOU", {
            fontFamily: "Orbitron, monospace", fontSize: "22px", color: leftColor,
        }).setOrigin(0.5));
        container.add(this.add.text(rightX, headerY, "OPPONENT", {
            fontFamily: "Orbitron, monospace", fontSize: "22px", color: rightColor,
        }).setOrigin(0.5));

        // Round scores
        const myRounds = this.resultsData.playerRole === "player1"
            ? this.resultsData.player1RoundsWon : this.resultsData.player2RoundsWon;
        const opRounds = this.resultsData.playerRole === "player1"
            ? this.resultsData.player2RoundsWon : this.resultsData.player1RoundsWon;

        container.add(this.add.text(leftX, scoreY, `${myRounds} WINS`, {
            fontFamily: "Orbitron, monospace", fontSize: "36px", color: "#ffffff",
        }).setOrigin(0.5));
        container.add(this.add.text(0, scoreY, "-", {
            fontFamily: "Orbitron, monospace", fontSize: "36px", color: "#666666",
        }).setOrigin(0.5));
        container.add(this.add.text(rightX, scoreY, `${opRounds} WINS`, {
            fontFamily: "Orbitron, monospace", fontSize: "36px", color: "#ffffff",
        }).setOrigin(0.5));

        // Animated ELO
        const rc = showRatingChanges ? this.resultsData.ratingChanges : undefined;
        if (rc) {
            const ratingY = scoreY + 70;
            container.add(this.add.text(0, ratingY - 25, "RATING", {
                fontFamily: "Orbitron, monospace", fontSize: "14px", color: "#666666",
            }).setOrigin(0.5));

            const myRating = isWinner ? rc.winner : rc.loser;
            const opRating = isWinner ? rc.loser : rc.winner;

            // My rating — animated counter
            const myRatingText = this.add.text(leftX, ratingY + 10, `${myRating.before}`, {
                fontFamily: "Orbitron, monospace", fontSize: "48px", color: "#ffffff",
                stroke: "#000000", strokeThickness: 4,
            }).setOrigin(0.5);
            container.add(myRatingText);

            const myChangeStr = myRating.change >= 0 ? `+${myRating.change}` : `${myRating.change}`;
            const myChangeColor = myRating.change >= 0 ? "#F0B71F" : "#ef4444";
            const myChangeText = this.add.text(leftX, ratingY + 50, myChangeStr, {
                fontFamily: "Orbitron, monospace", fontSize: "22px", color: myChangeColor, fontStyle: "bold",
            }).setOrigin(0.5).setAlpha(0).setScale(0.5);
            container.add(myChangeText);

            // Opponent rating
            const opRatingText = this.add.text(rightX, ratingY + 10, `${opRating.before}`, {
                fontFamily: "Orbitron, monospace", fontSize: "48px", color: "#ffffff",
                stroke: "#000000", strokeThickness: 4,
            }).setOrigin(0.5);
            container.add(opRatingText);

            const opChangeStr = opRating.change >= 0 ? `+${opRating.change}` : `${opRating.change}`;
            const opChangeColor = opRating.change >= 0 ? "#F0B71F" : "#ef4444";
            const opChangeText = this.add.text(rightX, ratingY + 50, opChangeStr, {
                fontFamily: "Orbitron, monospace", fontSize: "22px", color: opChangeColor, fontStyle: "bold",
            }).setOrigin(0.5).setAlpha(0).setScale(0.5);
            container.add(opChangeText);

            // Animate my rating
            this.tweens.addCounter({
                from: myRating.before,
                to: myRating.after,
                duration: 2000,
                ease: "Power2",
                delay: 800,
                onUpdate: (tween) => {
                    myRatingText.setText(`${Math.round(tween.getValue() ?? myRating.before)}`);
                },
                onComplete: () => {
                    myRatingText.setText(`${myRating.after}`);
                    myRatingText.setTint(myRating.change >= 0 ? 0xf0b71f : 0xef4444);
                    this.tweens.add({
                        targets: myChangeText,
                        alpha: 1, scale: 1, y: ratingY + 45,
                        duration: 500, ease: "Back.out",
                    });
                },
            });

            // Animate opponent rating
            this.tweens.addCounter({
                from: opRating.before,
                to: opRating.after,
                duration: 2000,
                ease: "Power2",
                delay: 800,
                onUpdate: (tween) => {
                    opRatingText.setText(`${Math.round(tween.getValue() ?? opRating.before)}`);
                },
                onComplete: () => {
                    opRatingText.setText(`${opRating.after}`);
                    this.tweens.add({
                        targets: opChangeText,
                        alpha: 1, scale: 1, y: ratingY + 45,
                        duration: 500, ease: "Back.out",
                    });
                },
            });
        }

        if (this.resultsData.isPrivateRoom) {
            container.add(this.add.text(0, scoreY + 58, "NO ELO CHANGED!", {
                fontFamily: "Orbitron, monospace",
                fontSize: "24px",
                color: "#fbbf24",
                fontStyle: "bold",
            }).setOrigin(0.5));
        }

        // Animate container in
        container.setScale(0);
        this.tweens.add({
            targets: container,
            scaleX: 1, scaleY: 1,
            duration: 500, delay: 500,
            ease: "Back.out",
        });
    }

    // =========================================================================
    // On-chain verification status
    // =========================================================================
    private createOnChainStatus() {
        if (!this.resultsData.onChainSessionId) return;

        const y = this.shouldShowRatingChanges() ? 570 : 520;
        const container = this.add.container(GAME_DIMENSIONS.CENTER_X, y);

        const hasHash = !!this.resultsData.onChainTxHash;
        const statusColor = hasHash ? "#22c55e" : "#fbbf24";
        const statusIcon = hasHash ? "✓" : "⏳";
        const statusLabel = hasHash
            ? `⛓ ON-CHAIN VERIFIED ${statusIcon}  Session #${this.resultsData.onChainSessionId}`
            : `⛓ ON-CHAIN PENDING ${statusIcon}  Session #${this.resultsData.onChainSessionId}`;

        const bg = this.add.rectangle(0, 0, 500, hasHash ? 70 : 40, 0x0a1a0a, 0.8)
            .setStrokeStyle(1, hasHash ? 0x22c55e : 0xfbbf24);
        container.add(bg);

        const statusText = this.add.text(0, hasHash ? -14 : 0, statusLabel, {
            fontFamily: "Orbitron, monospace", fontSize: "13px", color: statusColor,
        }).setOrigin(0.5);
        container.add(statusText);

        let txText: Phaser.GameObjects.Text | undefined;
        if (this.resultsData.onChainTxHash) {
            const short = `TX: ${this.resultsData.onChainTxHash.slice(0, 10)}...${this.resultsData.onChainTxHash.slice(-10)}`;
            txText = this.add.text(0, 10, short, {
                fontFamily: "monospace", fontSize: "11px", color: "#888888",
            }).setOrigin(0.5);
            container.add(txText);
        }

        this.onChainStatusContainer = container;
        this.onChainStatusBg = bg;
        this.onChainStatusLabelText = statusText;
        this.onChainStatusTxText = txText;

        container.setAlpha(0);
        this.tweens.add({
            targets: container,
            alpha: 1,
            duration: 600,
            delay: 1200,
        });
    }

    private startOnChainPolling() {
        if (!this.resultsData.onChainSessionId) return;
        if (this.resultsData.onChainTxHash) return;

        this.onChainPollTimer = this.time.addEvent({
            delay: 2500,
            loop: true,
            callback: () => {
                void this.pollOnChainStatus();
            },
        });

        void this.pollOnChainStatus();
    }

    private stopOnChainPolling() {
        if (this.onChainPollTimer) {
            this.onChainPollTimer.remove(false);
            this.onChainPollTimer = undefined;
        }
    }

    private async pollOnChainStatus() {
        const matchId = this.resultsData.matchId;
        if (!matchId) return;
        if (this.resultsData.onChainTxHash) {
            this.stopOnChainPolling();
            return;
        }

        const url = `${API_BASE}/api/matches/${matchId}?lite=1`;
        try {
            const res = await fetch(url);
            if (!res.ok) {
                if (res.status === 404) {
                    console.warn("[ResultsScene] Stopping on-chain poll: match not found", {
                        matchId,
                        status: res.status,
                        url,
                    });
                    this.stopOnChainPolling();
                    return;
                }

                console.warn("[ResultsScene] On-chain poll non-OK response", {
                    matchId,
                    status: res.status,
                    url,
                });
                return;
            }

            const json = await res.json() as {
                match?: {
                    onchain_result_tx_hash?: string | null;
                    onChainTxHash?: string | null;
                };
            };

            const txHash =
                json?.match?.onchain_result_tx_hash
                || json?.match?.onChainTxHash
                || null;

            if (!txHash) return;

            this.resultsData.onChainTxHash = txHash;
            this.updateOnChainStatusToVerified(txHash);
            this.stopOnChainPolling();
        } catch (error) {
            console.warn("[ResultsScene] On-chain poll failed", {
                matchId,
                url,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    private updateOnChainStatusToVerified(txHash: string) {
        if (!this.onChainStatusContainer || !this.onChainStatusBg || !this.onChainStatusLabelText) return;
        const sessionId = this.resultsData.onChainSessionId;
        if (!sessionId) return;

        this.onChainStatusBg.setSize(500, 70);
        this.onChainStatusBg.setStrokeStyle(1, 0x22c55e);
        this.onChainStatusLabelText.setText(`⛓ ON-CHAIN VERIFIED ✓  Session #${sessionId}`);
        this.onChainStatusLabelText.setColor("#22c55e");
        this.onChainStatusLabelText.setY(-14);

        const short = `TX: ${txHash.slice(0, 10)}...${txHash.slice(-10)}`;
        if (!this.onChainStatusTxText) {
            this.onChainStatusTxText = this.add.text(0, 10, short, {
                fontFamily: "monospace",
                fontSize: "11px",
                color: "#888888",
            }).setOrigin(0.5);
            this.onChainStatusContainer.add(this.onChainStatusTxText);
        } else {
            this.onChainStatusTxText.setText(short);
            this.onChainStatusTxText.setY(10);
        }

        this.tweens.add({
            targets: this.onChainStatusContainer,
            scaleX: 1.03,
            scaleY: 1.03,
            duration: 140,
            yoyo: true,
            ease: "Sine.easeInOut",
        });
    }

    // =========================================================================
    // Navigation buttons
    // =========================================================================
    private createButtons() {
        const y = this.shouldShowRatingChanges()
            ? (this.resultsData.onChainSessionId ? 640 : 590)
            : (this.resultsData.onChainSessionId ? 590 : 540);

        // Play Again
        this.createButton(
            GAME_DIMENSIONS.CENTER_X - 150, y,
            "PLAY AGAIN",
            () => EventBus.emit("navigate", { path: "/match" }),
            0xf0b71f,
        );

        // Return to Menu
        this.createButton(
            GAME_DIMENSIONS.CENTER_X + 150, y,
            "RETURN TO MENU",
            () => EventBus.emit("navigate", { path: "/play" }),
            0x6b7280,
        );
    }

    private createButton(
        x: number, y: number, label: string,
        callback: () => void, color: number,
    ) {
        const container = this.add.container(x, y);

        const bg = this.add.rectangle(0, 0, 240, 52, color)
            .setInteractive({ useHandCursor: true });

        const text = this.add.text(0, 0, label, {
            fontFamily: "Orbitron, monospace",
            fontSize: "15px",
            color: "#000000",
            fontStyle: "bold",
        }).setOrigin(0.5);

        container.add([bg, text]);

        const hoverColor = this.lightenColor(color, 0.2);

        bg.on("pointerover", () => {
            bg.setFillStyle(hoverColor);
            this.tweens.add({
                targets: container,
                scaleX: 1.05, scaleY: 1.05,
                duration: 200, ease: "Back.out",
            });
        });

        bg.on("pointerout", () => {
            bg.setFillStyle(color);
            this.tweens.add({
                targets: container,
                scaleX: 1, scaleY: 1,
                duration: 200, ease: "Back.out",
            });
        });

        bg.on("pointerdown", () => {
            this.tweens.add({
                targets: container,
                scaleX: 0.95, scaleY: 0.95,
                duration: 100, yoyo: true,
                onComplete: callback,
            });
        });

        return container;
    }

    private lightenColor(color: number, amount: number): number {
        const r = Math.min(255, ((color >> 16) & 0xff) + Math.floor(255 * amount));
        const g = Math.min(255, ((color >> 8) & 0xff) + Math.floor(255 * amount));
        const b = Math.min(255, (color & 0xff) + Math.floor(255 * amount));
        return (r << 16) | (g << 8) | b;
    }
}
