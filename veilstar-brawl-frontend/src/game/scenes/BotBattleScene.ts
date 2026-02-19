/**
 * BotBattleScene - Plays back pre-computed bot matches
 * 
 * The match is fully simulated server-side using CombatEngine.
 * This scene just animates the pre-computed turn sequence.
 * Spectators joining mid-match start from the correct turn based on elapsed time.
 * 
 * TAB SWITCHING / VISIBILITY SYNC:
 * When users minimize or switch tabs, Phaser pauses but the server-side match continues.
 * Upon returning, the scene detects visibility change, calculates missed turns,
 * fast-forwards game state without animation, and resumes playback from current turn.
 */

import Phaser from "phaser";
import { EventBus } from "../EventBus";
import { GAME_DIMENSIONS, CHARACTER_POSITIONS, UI_POSITIONS } from "../config";
import { getCharacterScale, getCharacterYOffset, getAnimationScale, getSFXKey, getSoundDelay } from "../config/sprite-config";
import { CHARACTER_ROSTER } from "../../data/characters";
import type { Character } from "@/types/game";
import type { PowerSurgeCardId } from "@/types/power-surge";
import type { BotTurnData } from "../../lib/chat/fake-chat-service";
import { SpectatorPowerSurgeCards } from "../ui/SpectatorPowerSurgeCards";
import { TextFactory } from "../ui/TextFactory";
import { preloadFightSceneAssets, createCharacterAnimations } from "../utils/asset-loader";

/**
 * Bot battle scene configuration - receives pre-computed match data
 */
export interface BotBattleSceneConfig {
    matchId: string;
    bot1CharacterId: string;
    bot2CharacterId: string;
    bot1Name: string;
    bot2Name: string;
    turns: BotTurnData[];
    totalTurns: number;
    startTurnIndex: number;       // Which turn to start from (for late joiners)
    turnDurationMs: number;
    bot1MaxHp: number;
    bot2MaxHp: number;
    bot1MaxEnergy: number;
    bot2MaxEnergy: number;
    matchWinner: "player1" | "player2" | null;
    bot1RoundsWon: number;
    bot2RoundsWon: number;
    matchCreatedAt: number;       // Server timestamp when match was created
    serverTime?: number;          // Server's current timestamp
    elapsedMs?: number;           // Server-calculated elapsed time since match creation
    bettingStatus?: {             // Server-calculated betting status
        isOpen: boolean;
        secondsRemaining: number;
        reason?: string;
    };
}

/**
 * BotBattleScene - Animates pre-computed bot battles
 */
export class BotBattleScene extends Phaser.Scene {
    // Config
    private config!: BotBattleSceneConfig;
    private bot1Character!: Character;
    private bot2Character!: Character;

    // UI Elements
    private player1HealthBar!: Phaser.GameObjects.Graphics;
    private player2HealthBar!: Phaser.GameObjects.Graphics;
    private player1EnergyBar!: Phaser.GameObjects.Graphics;
    private player2EnergyBar!: Phaser.GameObjects.Graphics;
    private player1GuardMeter!: Phaser.GameObjects.Graphics;
    private player2GuardMeter!: Phaser.GameObjects.Graphics;
    private roundScoreText!: Phaser.GameObjects.Text;
    private narrativeText!: Phaser.GameObjects.Text;

    // Character sprites
    private player1Sprite!: Phaser.GameObjects.Sprite;
    private player2Sprite!: Phaser.GameObjects.Sprite;

    // Playback state
    private currentTurnIndex: number = 0;
    private isPlaying: boolean = false;
    private bot1RoundsWon: number = 0;
    private bot2RoundsWon: number = 0;
    private currentRound: number = 1;

    // Audio
    private bgmVolume: number = 0.3;
    private sfxVolume: number = 0.5;

    // Visibility sync
    private visibilityChangeHandler: (() => void) | null = null;
    private matchStartTime: number = 0; // When the match actually started (server time)
    private readonly BETTING_WINDOW_MS = 30000; // 30 seconds betting period before match starts
    private serverTimeOffset: number = 0; // Difference between server time and client time

    // Power Surge UI
    private powerSurgeUI: SpectatorPowerSurgeCards | null = null;

    constructor() {
        super({ key: "BotBattleScene" });
    }

    init(data: BotBattleSceneConfig): void {
        this.config = data;
        this.currentTurnIndex = data.startTurnIndex || 0;
        this.isPlaying = false;
        this.bot1RoundsWon = 0;
        this.bot2RoundsWon = 0;
        this.currentRound = 1;

        // Calculate when this match's gameplay started (after betting window)
        // Server created the match at matchCreatedAt, gameplay starts 30s later
        this.matchStartTime = data.matchCreatedAt + this.BETTING_WINDOW_MS;

        // Calculate server time offset for accurate sync
        if (data.serverTime) {
            this.serverTimeOffset = data.serverTime - Date.now();
            console.log('[BotBattleScene] Server time offset:', this.serverTimeOffset, 'ms');
        }

        // Find characters
        this.bot1Character = CHARACTER_ROSTER.find(c => c.id === data.bot1CharacterId) || CHARACTER_ROSTER[0];
        this.bot2Character = CHARACTER_ROSTER.find(c => c.id === data.bot2CharacterId) || CHARACTER_ROSTER[1];

        // Log server sync info
        if (data.serverTime && data.elapsedMs !== undefined) {
            console.log('[BotBattleScene] Server sync:', {
                serverTime: new Date(data.serverTime).toISOString(),
                clientTime: new Date().toISOString(),
                elapsedMs: data.elapsedMs,
                bettingSecondsRemaining: data.bettingStatus?.secondsRemaining,
            });
        }
    }

    preload(): void {
        preloadFightSceneAssets(this, this.bot1Character.id, this.bot2Character.id);
    }

    create(): void {
        this.loadAudioSettings();

        // Create animations
        createCharacterAnimations(this, [this.bot1Character.id, this.bot2Character.id]);

        // Play BGM
        this.sound.pauseOnBlur = false;
        if (this.cache.audio.exists("bgm_fight")) {
            this.sound.play("bgm_fight", { loop: true, volume: this.bgmVolume });
        }

        // Create scene elements
        this.createBackground();
        this.createUI();
        this.createCharacters();
        this.createBotBadge();

        // If starting mid-match, fast-forward state
        if (this.currentTurnIndex > 0) {
            this.fastForwardToTurn(this.currentTurnIndex);
        }

        // Handle shutdown
        this.events.once("shutdown", this.handleShutdown, this);
        this.events.once("destroy", this.handleShutdown, this);

        // Setup visibility handler for tab switching
        this.setupVisibilityHandler();

        // Listen for visibility resync events from React client (server-authoritative)
        this.setupVisibilityResyncListener();

        // If joining mid-match (not at turn 0), skip betting countdown
        if (this.currentTurnIndex > 0) {
            // Start playback immediately for late joiners
            this.time.delayedCall(500, () => {
                this.startPlayback();
            });
        } else if (this.config.bettingStatus && !this.config.bettingStatus.isOpen) {
            // Betting window already closed, start immediately
            this.time.delayedCall(500, () => {
                this.startPlayback();
            });
        } else {
            // Schedule match start without Phaser UI (handled by React)
            this.scheduleMatchStart();
        }

        EventBus.emit("bot_battle_scene_ready", {
            matchId: this.config.matchId,
            bot1: this.bot1Character,
            bot2: this.bot2Character,
        });
    }

    // ==========================================================================
    // FAST-FORWARD FOR LATE JOINERS
    // ==========================================================================

    /**
     * Fast-forward game state to a specific turn without animating
     */
    private fastForwardToTurn(targetTurnIndex: number): void {
        for (let i = 0; i < targetTurnIndex && i < this.config.turns.length; i++) {
            const turn = this.config.turns[i] as BotTurnData & Record<string, unknown>;

            // Track round wins
            if (turn.isRoundEnd && turn.roundWinner) {
                if (turn.roundWinner === "player1") this.bot1RoundsWon++;
                else this.bot2RoundsWon++;

                if (!turn.isMatchEnd) {
                    this.currentRound++;
                }
            }
        }

        // Set state from the turn we're starting at
        if (targetTurnIndex > 0 && targetTurnIndex <= this.config.turns.length) {
            const currentTurn = this.config.turns[targetTurnIndex - 1];
            this.updateUIFromTurn(currentTurn);
            this.roundScoreText.setText(
                `Round ${this.currentRound}  •  ${this.bot1RoundsWon} - ${this.bot2RoundsWon}  (First to 2)`
            );
        }
    }

    // ==========================================================================
    // VISIBILITY SYNC (TAB SWITCHING)
    // ==========================================================================

    /**
     * Setup visibility change handler to sync when user returns to tab.
     * When users minimize or switch tabs, Phaser pauses but the server-side
     * match continues. This ensures we fast-forward to the current turn.
     */
    private setupVisibilityHandler(): void {
        if (typeof document === "undefined") return;

        this.visibilityChangeHandler = () => {
            if (document.visibilityState === "visible") {
                console.log("[BotBattleScene] Tab became visible, checking for resync");
                this.handleVisibilityResync();
            }
        };

        document.addEventListener("visibilitychange", this.visibilityChangeHandler);
        this.events.once("shutdown", this.cleanupVisibilityHandler, this);
        this.events.once("destroy", this.cleanupVisibilityHandler, this);
    }

    /**
     * Clean up visibility change handler.
     */
    private cleanupVisibilityHandler(): void {
        if (this.visibilityChangeHandler && typeof document !== "undefined") {
            document.removeEventListener("visibilitychange", this.visibilityChangeHandler);
            this.visibilityChangeHandler = null;
        }
    }

    /**
     * Setup listener for visibility resync events from React client.
     * This provides server-authoritative sync data.
     */
    private setupVisibilityResyncListener(): void {
        const handleServerSync = (rawData: unknown) => {
            const data = rawData as {
                matchId: string;
                serverTime: number;
                currentTurnIndex: number;
                elapsedMs: number;
                bettingStatus: {
                    isOpen: boolean;
                    secondsRemaining: number;
                };
            };

            // Only handle events for our match
            if (data.matchId !== this.config.matchId) return;

            console.log('[BotBattleScene] Received server sync event:', {
                serverTime: new Date(data.serverTime).toISOString(),
                currentTurnIndex: data.currentTurnIndex,
                bettingOpen: data.bettingStatus.isOpen,
                bettingSecondsRemaining: data.bettingStatus.secondsRemaining,
            });

            // Update server time offset
            this.serverTimeOffset = data.serverTime - Date.now();

            // If betting is still open, reschedule match start with correct remaining time
            if (data.bettingStatus.isOpen) {
                console.log('[BotBattleScene] Still in betting phase, rescheduling match start with', data.bettingStatus.secondsRemaining, 'seconds remaining');
                this.rescheduleMatchStart(data.bettingStatus.secondsRemaining);
                return;
            }

            // Betting is closed - perform resync
            // This handles both starting playback and fast-forwarding
            this.performServerResync(data.currentTurnIndex);
        };

        EventBus.on("bot_battle_visibility_resync", handleServerSync);

        // Cleanup on shutdown
        this.events.once("shutdown", () => {
            EventBus.off("bot_battle_visibility_resync", handleServerSync);
        });
        this.events.once("destroy", () => {
            EventBus.off("bot_battle_visibility_resync", handleServerSync);
        });
    }

    /**
     * Perform resync using server-provided turn index.
     * This is more accurate than client-side calculation.
     * Handles both starting playback (if not started) and fast-forwarding.
     */
    private performServerResync(serverTurnIndex: number): void {
        const turnsBehind = Math.max(0, serverTurnIndex - this.currentTurnIndex);

        // Check if playback hasn't started yet (betting phase just ended)
        if (!this.isPlaying && this.currentTurnIndex === 0) {
            console.log('[BotBattleScene] Playback not started yet, starting now from turn', serverTurnIndex);

            // Cancel any pending scheduled match start (from scheduleMatchStart)
            this.time.removeAllEvents();

            // Fast-forward to current turn if needed
            if (serverTurnIndex > 0) {
                this.fastForwardToTurn(serverTurnIndex);
                this.currentTurnIndex = serverTurnIndex;
            }

            // Start playback
            this.startPlayback();
            return;
        }

        if (turnsBehind <= 0) {
            console.log('[BotBattleScene] Already synced, no resync needed');
            return;
        }

        console.log(`[BotBattleScene] Server resync: behind by ${turnsBehind} turns, fast-forwarding from ${this.currentTurnIndex} to ${serverTurnIndex}`);

        // Stop current playback
        const wasPlaying = this.isPlaying;
        this.isPlaying = false;

        // Cancel all scheduled turn animations
        this.time.removeAllEvents();

        // Fast-forward through missed turns
        this.fastForwardVisibilityGap(serverTurnIndex);

        // Resume playback if we were playing
        if (wasPlaying && this.currentTurnIndex < this.config.turns.length) {
            this.isPlaying = true;
            // Small delay before resuming to show updated state
            this.time.delayedCall(500, () => this.playNextTurn());
        } else if (this.currentTurnIndex >= this.config.turns.length) {
            // Match ended while we were away
            this.showMatchEnd();
        }
    }

    /**
     * Handle resync when tab becomes visible.
     * Calculate the current server turn and fast-forward if needed.
     * Uses server time offset for accuracy if available.
     */
    private handleVisibilityResync(): void {
        // Calculate what turn we SHOULD be at based on elapsed time
        // Apply server time offset for accuracy
        const now = Date.now() + this.serverTimeOffset;

        // Check if we're still in betting window
        if (now < this.matchStartTime) {
            // Calculate remaining time and reschedule match start
            const remainingMs = this.matchStartTime - now;
            const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
            console.log("[BotBattleScene] Still in betting window, rescheduling match start with", remainingSeconds, "seconds remaining");
            this.rescheduleMatchStart(remainingSeconds);
            return;
        }

        // Betting window is over - calculate expected turn
        const gameElapsed = now - this.matchStartTime;
        const expectedTurnIndex = Math.floor(gameElapsed / this.config.turnDurationMs);

        // Clamp to valid range
        const clampedExpectedTurn = Math.min(Math.max(0, expectedTurnIndex), this.config.totalTurns - 1);

        // Check if playback hasn't started yet (betting phase just ended while tab was hidden)
        if (!this.isPlaying && this.currentTurnIndex === 0) {
            console.log("[BotBattleScene] Betting ended while tab was hidden, starting playback from turn", clampedExpectedTurn);

            // Cancel any pending scheduled match start
            this.time.removeAllEvents();

            // Fast-forward to current turn if needed
            if (clampedExpectedTurn > 0) {
                this.fastForwardToTurn(clampedExpectedTurn);
                this.currentTurnIndex = clampedExpectedTurn;
            }

            // Start playback
            this.startPlayback();
            return;
        }

        // How many turns did we miss while tab was hidden?
        const turnsBehind = Math.max(0, clampedExpectedTurn - this.currentTurnIndex);

        if (turnsBehind > 0) {
            console.log(`[BotBattleScene] Behind by ${turnsBehind} turns, fast-forwarding from ${this.currentTurnIndex} to ${clampedExpectedTurn}`);

            // Stop current playback
            const wasPlaying = this.isPlaying;
            this.isPlaying = false;

            // Cancel all scheduled turn animations
            this.time.removeAllEvents();

            // Fast-forward through missed turns
            this.fastForwardVisibilityGap(clampedExpectedTurn);

            // Resume playback if we were playing
            if (wasPlaying && this.currentTurnIndex < this.config.turns.length) {
                this.isPlaying = true;
                // Small delay before resuming to show updated state
                this.time.delayedCall(500, () => this.playNextTurn());
            } else if (this.currentTurnIndex >= this.config.turns.length) {
                // Match ended while we were away
                this.showMatchEnd();
            }
        } else {
            console.log(`[BotBattleScene] No resync needed (current: ${this.currentTurnIndex}, expected: ${clampedExpectedTurn})`);
        }
    }

    /**
     * Fast-forward through turns that happened while tab was hidden.
     * Updates game state and UI without animations.
     */
    private fastForwardVisibilityGap(targetTurnIndex: number): void {
        const startTurn = this.currentTurnIndex;
        const endTurn = Math.min(targetTurnIndex, this.config.turns.length);

        console.log(`[BotBattleScene] Fast-forwarding from turn ${startTurn} to ${endTurn}`);

        // Process each missed turn
        for (let i = startTurn; i < endTurn; i++) {
            const turn = this.config.turns[i] as BotTurnData & Record<string, unknown>;

            // Track round wins
            if (turn.isRoundEnd && turn.roundWinner) {
                if (turn.roundWinner === "player1") this.bot1RoundsWon++;
                else this.bot2RoundsWon++;

                if (!turn.isMatchEnd) {
                    this.currentRound++;
                }
            }

            this.currentTurnIndex++;
        }

        // Update UI to reflect current state
        if (this.currentTurnIndex > 0 && this.currentTurnIndex <= this.config.turns.length) {
            const currentTurn = this.config.turns[this.currentTurnIndex - 1];
            this.updateUIFromTurn(currentTurn);
            this.roundScoreText.setText(
                `Round ${this.currentRound}  •  ${this.bot1RoundsWon} - ${this.bot2RoundsWon}  (First to 2)`
            );

            // Show notification that we caught up
            this.narrativeText.setText(`⚡ CATCHING UP TO TURN ${this.currentTurnIndex} ⚡`);
            this.narrativeText.setAlpha(1);
            this.tweens.add({
                targets: this.narrativeText,
                alpha: 0,
                delay: 1000,
                duration: 500,
            });
        }

        // Ensure characters are in idle state
        const p1Char = this.bot1Character.id;
        const p2Char = this.bot2Character.id;

        if (this.anims.exists(`${p1Char}_idle`)) {
            const p1IdleScale = getAnimationScale(p1Char, "idle");
            this.player1Sprite.setScale(p1IdleScale);
            this.player1Sprite.play(`${p1Char}_idle`);
        }
        if (this.anims.exists(`${p2Char}_idle`)) {
            const p2IdleScale = getAnimationScale(p2Char, "idle");
            this.player2Sprite.setScale(p2IdleScale);
            this.player2Sprite.play(`${p2Char}_idle`);
        }

        // Reset sprite positions to original
        this.player1Sprite.x = CHARACTER_POSITIONS.PLAYER1.X;
        this.player2Sprite.x = CHARACTER_POSITIONS.PLAYER2.X;
    }

    // ==========================================================================
    // AUDIO
    // ==========================================================================

    private loadAudioSettings(): void {
        try {
            const savedBgm = localStorage.getItem("veilstar_bgm_volume");
            const savedSfx = localStorage.getItem("veilstar_sfx_volume");
            if (savedBgm !== null) this.bgmVolume = parseFloat(savedBgm);
            if (savedSfx !== null) this.sfxVolume = parseFloat(savedSfx);
        } catch (e) {
            console.warn("Failed to load audio settings", e);
        }
    }

    private playSFX(key: string): void {
        if (this.game.sound.locked) return;
        try {
            this.sound.play(key, { volume: this.sfxVolume });
            this.time.delayedCall(5000, () => {
                const sound = this.sound.get(key);
                if (sound && sound.isPlaying) sound.stop();
            });
        } catch (e) {
            console.warn(`Failed to play SFX: ${key}`, e);
        }
    }

    private handleShutdown(): void {
        const bgm = this.sound.get("bgm_fight");
        if (bgm && bgm.isPlaying) bgm.stop();
        this.cleanupVisibilityHandler();

        // Clean up power surge UI
        if (this.powerSurgeUI) {
            this.powerSurgeUI.destroy();
            this.powerSurgeUI = null;
        }
    }

    // ==========================================================================
    // BACKGROUND
    // ==========================================================================

    private createBackground(): void {
        if (this.textures.exists("arena-bg")) {
            const bg = this.add.image(GAME_DIMENSIONS.CENTER_X, GAME_DIMENSIONS.CENTER_Y, "arena-bg");
            bg.setDisplaySize(GAME_DIMENSIONS.WIDTH, GAME_DIMENSIONS.HEIGHT);
        } else {
            const graphics = this.add.graphics();
            graphics.fillGradientStyle(0x0a0a0a, 0x0a0a0a, 0x1a1a2e, 0x1a1a2e, 1);
            graphics.fillRect(0, 0, GAME_DIMENSIONS.WIDTH, GAME_DIMENSIONS.HEIGHT);
        }

        // Dark overlay
        this.add.rectangle(
            GAME_DIMENSIONS.CENTER_X,
            GAME_DIMENSIONS.CENTER_Y,
            GAME_DIMENSIONS.WIDTH,
            GAME_DIMENSIONS.HEIGHT,
            0x000000,
            0.3
        );
    }

    private createBotBadge(): void {
        const badge = this.add.container(GAME_DIMENSIONS.CENTER_X, 120);
        const bg = this.add.rectangle(0, 0, 240, 40, 0x000000, 0.8).setStrokeStyle(2, 0xff6b35);
        const text = TextFactory.createLabel(this, 0, 0, "BOT BATTLE (LIVE)", {
            fontSize: "18px",
            color: "#ff6b35",
        }).setOrigin(0.5);
        badge.add([bg, text]);

        // Pulse
        this.tweens.add({
            targets: badge,
            alpha: 0.7,
            yoyo: true,
            repeat: -1,
            duration: 1000,
            ease: "Sine.easeInOut",
        });
    }

    // ==========================================================================
    // UI
    // ==========================================================================

    private createUI(): void {
        const barWidth = UI_POSITIONS.HEALTH_BAR.PLAYER1.WIDTH;
        const barHeight = 25;

        // Health bars
        this.createHealthBar(UI_POSITIONS.HEALTH_BAR.PLAYER1.X, UI_POSITIONS.HEALTH_BAR.PLAYER1.Y, barWidth, barHeight, "player1");
        this.createHealthBar(UI_POSITIONS.HEALTH_BAR.PLAYER2.X, UI_POSITIONS.HEALTH_BAR.PLAYER2.Y, barWidth, barHeight, "player2");

        // Energy bars
        this.createEnergyBar(UI_POSITIONS.HEALTH_BAR.PLAYER1.X, UI_POSITIONS.HEALTH_BAR.PLAYER1.Y + 30, barWidth, 12, "player1");
        this.createEnergyBar(UI_POSITIONS.HEALTH_BAR.PLAYER2.X, UI_POSITIONS.HEALTH_BAR.PLAYER2.Y + 30, barWidth, 12, "player2");

        // Guard meters
        this.createGuardMeter(UI_POSITIONS.HEALTH_BAR.PLAYER1.X, UI_POSITIONS.HEALTH_BAR.PLAYER1.Y + 45, barWidth, 6, "player1");
        this.createGuardMeter(UI_POSITIONS.HEALTH_BAR.PLAYER2.X, UI_POSITIONS.HEALTH_BAR.PLAYER2.Y + 45, barWidth, 6, "player2");

        // Labels
        TextFactory.createLabel(this, UI_POSITIONS.HEALTH_BAR.PLAYER1.X + barWidth + 5, UI_POSITIONS.HEALTH_BAR.PLAYER1.Y + 30, "EN", { fontSize: "10px", color: "#3b82f6" });
        TextFactory.createLabel(this, UI_POSITIONS.HEALTH_BAR.PLAYER2.X - 20, UI_POSITIONS.HEALTH_BAR.PLAYER2.Y + 30, "EN", { fontSize: "10px", color: "#3b82f6" });

        TextFactory.createLabel(
            this,
            UI_POSITIONS.HEALTH_BAR.PLAYER1.X,
            UI_POSITIONS.HEALTH_BAR.PLAYER1.Y - 18,
            `BOT 1: ${this.config.bot1Name.toUpperCase()} (${this.config.bot1MaxHp} HP)`,
            { fontSize: "12px", color: "#ff6b35", fontStyle: "bold" }
        );

        TextFactory.createLabel(
            this,
            UI_POSITIONS.HEALTH_BAR.PLAYER2.X + barWidth,
            UI_POSITIONS.HEALTH_BAR.PLAYER2.Y - 18,
            `BOT 2: ${this.config.bot2Name.toUpperCase()} (${this.config.bot2MaxHp} HP)`,
            { fontSize: "12px", color: "#ff6b35", fontStyle: "bold", align: "right" }
        ).setOrigin(1, 0);

        this.roundScoreText = TextFactory.createScore(
            this,
            GAME_DIMENSIONS.CENTER_X,
            60,
            `Round ${this.currentRound}  •  ${this.bot1RoundsWon} - ${this.bot2RoundsWon}  (First to 2)`
        ).setOrigin(0.5);

        this.narrativeText = TextFactory.createNarrative(
            this,
            GAME_DIMENSIONS.CENTER_X,
            GAME_DIMENSIONS.HEIGHT - 100,
            ""
        ).setOrigin(0.5).setAlpha(0).setDepth(100);

        // Draw initial bars
        this.updateHealthBarDisplay("player1", this.config.bot1MaxHp, this.config.bot1MaxHp);
        this.updateHealthBarDisplay("player2", this.config.bot2MaxHp, this.config.bot2MaxHp);
        this.updateEnergyBarDisplay("player1", this.config.bot1MaxEnergy, this.config.bot1MaxEnergy);
        this.updateEnergyBarDisplay("player2", this.config.bot2MaxEnergy, this.config.bot2MaxEnergy);
        this.updateGuardMeterDisplay("player1", 0);
        this.updateGuardMeterDisplay("player2", 0);
    }

    private createHealthBar(x: number, y: number, w: number, h: number, player: "player1" | "player2"): void {
        const g = this.add.graphics();
        g.fillStyle(0x333333, 1);
        g.fillRoundedRect(x, y, w, h, 4);
        g.lineStyle(2, 0x40e0d0, 1);
        g.strokeRoundedRect(x, y, w, h, 4);

        const hG = this.add.graphics();
        if (player === "player1") this.player1HealthBar = hG;
        else this.player2HealthBar = hG;
    }

    private createEnergyBar(x: number, y: number, w: number, h: number, player: "player1" | "player2"): void {
        const bg = this.add.graphics();
        bg.fillStyle(0x222222, 1);
        bg.fillRoundedRect(x, y, w, h, 2);
        bg.lineStyle(1, 0x3b82f6, 0.5);
        bg.strokeRoundedRect(x, y, w, h, 2);

        const eG = this.add.graphics();
        if (player === "player1") this.player1EnergyBar = eG;
        else this.player2EnergyBar = eG;
    }

    private createGuardMeter(x: number, y: number, w: number, h: number, player: "player1" | "player2"): void {
        const bg = this.add.graphics();
        bg.fillStyle(0x111111, 1);
        bg.fillRect(x, y, w, h);

        const gG = this.add.graphics();
        if (player === "player1") this.player1GuardMeter = gG;
        else this.player2GuardMeter = gG;
    }

    // ==========================================================================
    // CHARACTERS
    // ==========================================================================

    private createCharacters(): void {
        const p1Char = this.bot1Character.id;
        const p2Char = this.bot2Character.id;

        const p1Scale = getCharacterScale(p1Char);
        const p2Scale = getCharacterScale(p2Char);
        const p1YOffset = getCharacterYOffset(p1Char, "idle");
        const p2YOffset = getCharacterYOffset(p2Char, "idle");

        this.player1Sprite = this.add.sprite(
            CHARACTER_POSITIONS.PLAYER1.X,
            CHARACTER_POSITIONS.PLAYER1.Y - 50 + p1YOffset,
            `char_${p1Char}_idle`
        );
        this.player1Sprite.setScale(p1Scale).setOrigin(0.5, 0.5);
        if (this.anims.exists(`${p1Char}_idle`)) {
            this.player1Sprite.play(`${p1Char}_idle`);
        }

        this.player2Sprite = this.add.sprite(
            CHARACTER_POSITIONS.PLAYER2.X,
            CHARACTER_POSITIONS.PLAYER2.Y - 50 + p2YOffset,
            `char_${p2Char}_idle`
        );
        this.player2Sprite.setScale(p2Scale).setOrigin(0.5, 0.5).setFlipX(true);
        if (this.anims.exists(`${p2Char}_idle`)) {
            this.player2Sprite.play(`${p2Char}_idle`);
        }
    }

    // ==========================================================================
    // BAR UPDATES
    // ==========================================================================

    private updateHealthBarDisplay(player: "player1" | "player2", hp: number, maxHp: number): void {
        const barWidth = UI_POSITIONS.HEALTH_BAR.PLAYER1.WIDTH;
        const barHeight = 25;
        const pct = Math.min(1, Math.max(0, hp) / (maxHp || 1));
        const innerW = (barWidth - 4) * pct;

        const g = player === "player1" ? this.player1HealthBar : this.player2HealthBar;
        const x = player === "player1" ? UI_POSITIONS.HEALTH_BAR.PLAYER1.X : UI_POSITIONS.HEALTH_BAR.PLAYER2.X;
        const y = player === "player1" ? UI_POSITIONS.HEALTH_BAR.PLAYER1.Y : UI_POSITIONS.HEALTH_BAR.PLAYER2.Y;

        g.clear();
        let color = 0x00ff88;
        if (pct <= 0.25) color = 0xff4444;
        else if (pct <= 0.5) color = 0xffaa00;

        g.fillStyle(color, 1);
        if (player === "player2") {
            g.fillRoundedRect(x + 2 + (barWidth - 4 - innerW), y + 2, innerW, barHeight - 4, 3);
        } else {
            g.fillRoundedRect(x + 2, y + 2, innerW, barHeight - 4, 3);
        }
    }

    private updateEnergyBarDisplay(player: "player1" | "player2", energy: number, maxEnergy: number): void {
        const barWidth = UI_POSITIONS.HEALTH_BAR.PLAYER1.WIDTH;
        const barHeight = 12;
        const yOffset = 30;
        const pct = Math.min(1, Math.max(0, energy) / (maxEnergy || 1));
        const innerW = (barWidth - 2) * pct;

        const g = player === "player1" ? this.player1EnergyBar : this.player2EnergyBar;
        const x = player === "player1" ? UI_POSITIONS.HEALTH_BAR.PLAYER1.X : UI_POSITIONS.HEALTH_BAR.PLAYER2.X;
        const y = (player === "player1" ? UI_POSITIONS.HEALTH_BAR.PLAYER1.Y : UI_POSITIONS.HEALTH_BAR.PLAYER2.Y) + yOffset;

        g.clear();
        g.fillStyle(0x3b82f6, 1);
        if (player === "player2") {
            g.fillRoundedRect(x + 1 + (barWidth - 2 - innerW), y + 1, innerW, barHeight - 2, 2);
        } else {
            g.fillRoundedRect(x + 1, y + 1, innerW, barHeight - 2, 2);
        }
    }

    private updateGuardMeterDisplay(player: "player1" | "player2", guardMeter: number): void {
        const barWidth = UI_POSITIONS.HEALTH_BAR.PLAYER1.WIDTH;
        const barHeight = 6;
        const yOffset = 45;
        const pct = Math.min(1, Math.max(0, guardMeter) / 100);
        const innerW = barWidth * pct;

        const g = player === "player1" ? this.player1GuardMeter : this.player2GuardMeter;
        const x = player === "player1" ? UI_POSITIONS.HEALTH_BAR.PLAYER1.X : UI_POSITIONS.HEALTH_BAR.PLAYER2.X;
        const y = (player === "player1" ? UI_POSITIONS.HEALTH_BAR.PLAYER1.Y : UI_POSITIONS.HEALTH_BAR.PLAYER2.Y) + yOffset;

        g.clear();
        let color = 0xf97316;
        if (pct >= 0.75) color = 0xef4444;

        g.fillStyle(color, 1);
        if (player === "player2") {
            g.fillRect(x + (barWidth - innerW), y, innerW, barHeight);
        } else {
            g.fillRect(x, y, innerW, barHeight);
        }
    }

    private updateUIFromTurn(turn: BotTurnData): void {
        const t = turn as BotTurnData & Record<string, unknown>;
        this.updateHealthBarDisplay("player1", turn.bot1Hp, this.config.bot1MaxHp);
        this.updateHealthBarDisplay("player2", turn.bot2Hp, this.config.bot2MaxHp);
        this.updateEnergyBarDisplay("player1", (t.bot1Energy as number) ?? 0, this.config.bot1MaxEnergy);
        this.updateEnergyBarDisplay("player2", (t.bot2Energy as number) ?? 0, this.config.bot2MaxEnergy);
        this.updateGuardMeterDisplay("player1", (t.bot1GuardMeter as number) ?? 0);
        this.updateGuardMeterDisplay("player2", (t.bot2GuardMeter as number) ?? 0);
    }

    // ==========================================================================
    // MATCH SCHEDULING
    // ==========================================================================

    private scheduleMatchStart(): void {
        const serverSecondsRemaining = this.config.bettingStatus?.secondsRemaining ?? 30;

        console.log('[BotBattleScene] Scheduling match start in', serverSecondsRemaining, 'seconds');

        // After server-provided duration, start the match
        this.time.delayedCall(serverSecondsRemaining * 1000, () => {
            this.startPlayback();
        });
    }

    /**
     * Reschedule match start when returning from tab switch during betting phase.
     * Phaser timers pause when tab is hidden, so we need to cancel and reschedule
     * with the correct remaining time from the server.
     */
    private rescheduleMatchStart(secondsRemaining: number): void {
        // Don't reschedule if playback already started
        if (this.isPlaying) {
            console.log('[BotBattleScene] Playback already started, skipping reschedule');
            return;
        }

        // Cancel any existing scheduled events (including the original scheduleMatchStart timer)
        this.time.removeAllEvents();

        if (secondsRemaining <= 0) {
            // Betting just ended, start immediately
            console.log('[BotBattleScene] Betting ended, starting playback immediately');
            this.startPlayback();
        } else {
            // Reschedule with correct remaining time
            console.log('[BotBattleScene] Rescheduling match start in', secondsRemaining, 'seconds');
            this.time.delayedCall(secondsRemaining * 1000, () => {
                this.startPlayback();
            });
        }
    }

    // ==========================================================================
    // PLAYBACK
    // ==========================================================================

    private startPlayback(): void {
        // Check if match already finished
        if (this.currentTurnIndex >= this.config.turns.length) {
            this.showMatchEnd();
            return;
        }

        this.isPlaying = true;
        this.playNextTurn();
    }

    private playNextTurn(): void {
        if (!this.isPlaying || this.currentTurnIndex >= this.config.turns.length) {
            this.showMatchEnd();
            return;
        }

        const turn = this.config.turns[this.currentTurnIndex] as BotTurnData & Record<string, unknown>;

        // Check if this turn has power surge data (first turn of round)
        if (turn.isRoundStart && turn.surgeCardIds && turn.bot1SurgeSelection && turn.bot2SurgeSelection) {
            this.showPowerSurgeUI(turn as BotTurnData, () => {
                this.animateTurn(turn as BotTurnData);
                this.currentTurnIndex++;
            });
        } else {
            this.animateTurn(turn as BotTurnData);
            this.currentTurnIndex++;
        }
    }

    /**
     * Show power surge card reveal for spectators
     */
    private showPowerSurgeUI(turn: BotTurnData, onComplete: () => void): void {
        const t = turn as BotTurnData & Record<string, unknown>;

        // Clean up any existing power surge UI
        if (this.powerSurgeUI) {
            this.powerSurgeUI.destroy();
            this.powerSurgeUI = null;
        }

        // Clear any leftover narrative text from previous round (e.g., "X WINS THE ROUND!")
        this.narrativeText.setAlpha(0);
        this.narrativeText.setText("");

        // Reset HP/Energy/Guard bars for the new round BEFORE showing power surge UI
        this.updateHealthBarDisplay("player1", this.config.bot1MaxHp, this.config.bot1MaxHp);
        this.updateHealthBarDisplay("player2", this.config.bot2MaxHp, this.config.bot2MaxHp);
        this.updateEnergyBarDisplay("player1", this.config.bot1MaxEnergy, this.config.bot1MaxEnergy);
        this.updateEnergyBarDisplay("player2", this.config.bot2MaxEnergy, this.config.bot2MaxEnergy);
        this.updateGuardMeterDisplay("player1", 0);
        this.updateGuardMeterDisplay("player2", 0);

        // Create spectator power surge UI
        this.powerSurgeUI = new SpectatorPowerSurgeCards({
            scene: this,
            roundNumber: turn.roundNumber,
            cardIds: t.surgeCardIds as PowerSurgeCardId[],
            player1Selection: t.bot1SurgeSelection as PowerSurgeCardId,
            player2Selection: t.bot2SurgeSelection as PowerSurgeCardId,
            player1SpriteY: this.player1Sprite.y,
            player2SpriteY: this.player2Sprite.y,
            player1Sprite: this.player1Sprite,
            player2Sprite: this.player2Sprite,
            onComplete: () => {
                this.powerSurgeUI = null;
                onComplete();
            },
        });
    }

    private animateTurn(turn: BotTurnData): void {
        const t = turn as BotTurnData & Record<string, unknown>;
        const p1Char = this.bot1Character.id;
        const p2Char = this.bot2Character.id;
        const p1OriginalX = CHARACTER_POSITIONS.PLAYER1.X;
        const p2OriginalX = CHARACTER_POSITIONS.PLAYER2.X;
        const meetingPointX = GAME_DIMENSIONS.CENTER_X;

        // Calculate HP differences for damage display
        const prevP1Health = this.currentTurnIndex > 0 ?
            this.config.turns[this.currentTurnIndex - 1].bot1Hp : this.config.bot1MaxHp;
        const prevP2Health = this.currentTurnIndex > 0 ?
            this.config.turns[this.currentTurnIndex - 1].bot2Hp : this.config.bot2MaxHp;
        const p1Damage = Math.max(0, prevP1Health - turn.bot1Hp);
        const p2Damage = Math.max(0, prevP2Health - turn.bot2Hp);

        // Check if either player is stunned (from move being "stunned")
        const p1IsStunned = turn.bot1Move === "stunned";
        const p2IsStunned = turn.bot2Move === "stunned";

        // Determine target positions based on stun state (match FightScene exactly)
        let p1TargetX = meetingPointX - 50;
        let p2TargetX = meetingPointX + 50;

        if (p1IsStunned) {
            p1TargetX = p1OriginalX; // P1 stays in place
            p2TargetX = p1OriginalX + 150; // P2 runs to P1
        } else if (p2IsStunned) {
            p2TargetX = p2OriginalX; // P2 stays in place
            p1TargetX = p2OriginalX - 150; // P1 runs to P2
        }

        // Phase 1: Both characters run toward target with run scale (only if not stunned)
        if (!p1IsStunned && this.anims.exists(`${p1Char}_run`)) {
            const p1RunScale = getAnimationScale(p1Char, "run");
            this.player1Sprite.setScale(p1RunScale);
            this.player1Sprite.play(`${p1Char}_run`);
        } else if (p1IsStunned) {
            if (this.anims.exists(`${p1Char}_idle`)) {
                const p1IdleScale = getAnimationScale(p1Char, "idle");
                this.player1Sprite.setScale(p1IdleScale);
                this.player1Sprite.play(`${p1Char}_idle`);
            }
            this.tweens.add({
                targets: this.player1Sprite,
                tint: 0xff6666,
                yoyo: true,
                repeat: 3,
                duration: 200,
                onComplete: () => this.player1Sprite.clearTint()
            });
        }
        if (!p2IsStunned && this.anims.exists(`${p2Char}_run`)) {
            const p2RunScale = getAnimationScale(p2Char, "run");
            this.player2Sprite.setScale(p2RunScale);
            this.player2Sprite.play(`${p2Char}_run`);
        } else if (p2IsStunned) {
            if (this.anims.exists(`${p2Char}_idle`)) {
                const p2IdleScale = getAnimationScale(p2Char, "idle");
                this.player2Sprite.setScale(p2IdleScale);
                this.player2Sprite.play(`${p2Char}_idle`);
            }
            this.tweens.add({
                targets: this.player2Sprite,
                tint: 0xff6666,
                yoyo: true,
                repeat: 3,
                duration: 200,
                onComplete: () => this.player2Sprite.clearTint()
            });
        }

        // Tween both characters toward targets (match FightScene timing: 600ms)
        this.tweens.add({
            targets: this.player1Sprite,
            x: p1TargetX,
            duration: p1IsStunned ? 0 : 600,
            ease: "Power2"
        });

        this.tweens.add({
            targets: this.player2Sprite,
            x: p2TargetX,
            duration: p2IsStunned ? 0 : 600,
            ease: "Power2",
            onComplete: () => {
                const p1Move = turn.bot1Move;
                const p2Move = turn.bot2Move;

                // Helper: P1 Attack animation with damage display
                const runP1Attack = (): Promise<void> => {
                    return new Promise((resolve) => {
                        if (p1IsStunned) { resolve(); return; }

                        const animKey = `${p1Char}_${p1Move}`;
                        if (this.anims.exists(animKey) || p1Move === "block") {
                            const scale = getAnimationScale(p1Char, p1Move);
                            this.player1Sprite.setScale(scale);
                            if (this.anims.exists(animKey)) {
                                this.player1Sprite.play(animKey);
                            }
                            const sfxKey = getSFXKey(p1Char, p1Move);
                            const delay = getSoundDelay(p1Char, p1Move);
                            if (delay > 0) {
                                this.time.delayedCall(delay, () => this.playSFX(sfxKey));
                            } else {
                                this.playSFX(sfxKey);
                            }
                        }

                        if (p2Damage > 0) {
                            this.time.delayedCall(300, () => {
                                this.showFloatingText(`-${p2Damage}`, p2TargetX, CHARACTER_POSITIONS.PLAYER2.Y - 130, "#ff4444");
                                this.tweens.add({ targets: this.player2Sprite, alpha: 0.5, yoyo: true, duration: 50, repeat: 3 });
                            });
                        } else if ((t.bot2Outcome as string) === "missed") {
                            this.time.delayedCall(300, () => {
                                this.showFloatingText("DODGE!", p2TargetX, CHARACTER_POSITIONS.PLAYER2.Y - 130, "#8800ff");
                            });
                        }

                        if (t.bot2EnergyDrained && (t.bot2EnergyDrained as number) > 0) {
                            this.time.delayedCall(500, () => {
                                this.showFloatingText(`-${Math.round(t.bot2EnergyDrained as number)} EN`, p2TargetX, CHARACTER_POSITIONS.PLAYER2.Y - 100, "#3b82f6");
                            });
                        }

                        const bot1TotalHeal = ((t.bot1HpRegen as number) || 0) + ((t.bot1Lifesteal as number) || 0);
                        if (bot1TotalHeal > 0) {
                            this.time.delayedCall(700, () => {
                                this.showFloatingText(`+${Math.round(bot1TotalHeal)} HP`, p1TargetX, CHARACTER_POSITIONS.PLAYER1.Y - 100, "#00ff88");
                            });
                        }

                        this.time.delayedCall(1200, () => resolve());
                    });
                };

                // Helper: P2 Attack animation with damage display
                const runP2Attack = (): Promise<void> => {
                    return new Promise((resolve) => {
                        if (p2IsStunned) { resolve(); return; }

                        const animKey = `${p2Char}_${p2Move}`;
                        if (this.anims.exists(animKey) || p2Move === "block") {
                            const scale = getAnimationScale(p2Char, p2Move);
                            this.player2Sprite.setScale(scale);
                            if (this.anims.exists(animKey)) {
                                this.player2Sprite.play(animKey);
                            }
                            const sfxKey = getSFXKey(p2Char, p2Move);
                            const delay = getSoundDelay(p2Char, p2Move);
                            if (delay > 0) {
                                this.time.delayedCall(delay, () => this.playSFX(sfxKey));
                            } else {
                                this.playSFX(sfxKey);
                            }
                        }

                        if (p1Damage > 0) {
                            this.time.delayedCall(300, () => {
                                this.showFloatingText(`-${p1Damage}`, p1TargetX, CHARACTER_POSITIONS.PLAYER1.Y - 130, "#ff4444");
                                this.tweens.add({ targets: this.player1Sprite, alpha: 0.5, yoyo: true, duration: 50, repeat: 3 });
                            });
                        } else if ((t.bot1Outcome as string) === "missed") {
                            this.time.delayedCall(300, () => {
                                this.showFloatingText("DODGE!", p1TargetX, CHARACTER_POSITIONS.PLAYER1.Y - 130, "#8800ff");
                            });
                        }

                        if (t.bot1EnergyDrained && (t.bot1EnergyDrained as number) > 0) {
                            this.time.delayedCall(500, () => {
                                this.showFloatingText(`-${Math.round(t.bot1EnergyDrained as number)} EN`, p1TargetX, CHARACTER_POSITIONS.PLAYER1.Y - 100, "#3b82f6");
                            });
                        }

                        const bot2TotalHeal = ((t.bot2HpRegen as number) || 0) + ((t.bot2Lifesteal as number) || 0);
                        if (bot2TotalHeal > 0) {
                            this.time.delayedCall(700, () => {
                                this.showFloatingText(`+${Math.round(bot2TotalHeal)} HP`, p2TargetX, CHARACTER_POSITIONS.PLAYER2.Y - 100, "#00ff88");
                            });
                        }

                        this.time.delayedCall(1200, () => resolve());
                    });
                };

                // Execute Sequence - Match FightScene logic exactly
                // Concurrent if either player is blocking
                const isConcurrent = p1Move === "block" || p2Move === "block";

                const executeSequence = async () => {
                    if (isConcurrent) {
                        await Promise.all([runP1Attack(), runP2Attack()]);
                    } else {
                        await runP1Attack();
                        await runP2Attack();
                    }

                    const narrative = (t.narrative as string) || "Both attacks clash!";
                    this.narrativeText.setText(narrative);
                    this.narrativeText.setAlpha(1);

                    this.updateUIFromTurn(turn);
                    this.roundScoreText.setText(
                        `Round ${this.currentRound}  •  ${this.bot1RoundsWon} - ${this.bot2RoundsWon}  (First to 2)`
                    );

                    // Return to start positions
                    const returnToStartPositions = (): Promise<void> => {
                        return new Promise((resolve) => {
                            if (!p1IsStunned && this.anims.exists(`${p1Char}_run`)) {
                                const p1RunScale = getAnimationScale(p1Char, "run");
                                this.player1Sprite.setScale(p1RunScale);
                                this.player1Sprite.play(`${p1Char}_run`);
                            }
                            if (!p2IsStunned && this.anims.exists(`${p2Char}_run`)) {
                                const p2RunScale = getAnimationScale(p2Char, "run");
                                this.player2Sprite.setScale(p2RunScale);
                                this.player2Sprite.play(`${p2Char}_run`);
                                this.player2Sprite.setFlipX(true);
                            }

                            this.tweens.add({ targets: this.player1Sprite, x: p1OriginalX, duration: p1IsStunned ? 0 : 600, ease: "Power2" });
                            this.tweens.add({
                                targets: this.player2Sprite, x: p2OriginalX, duration: p2IsStunned ? 0 : 600, ease: "Power2",
                                onComplete: () => resolve()
                            });
                        });
                    };

                    await returnToStartPositions();

                    this.tweens.add({ targets: this.narrativeText, alpha: 0, duration: 300 });

                    if (t.isRoundEnd) {
                        if (t.roundWinner) {
                            const loserChar = t.roundWinner === "player1" ? p2Char : p1Char;
                            const loserSprite = t.roundWinner === "player1" ? this.player2Sprite : this.player1Sprite;

                            if (this.anims.exists(`${loserChar}_dead`)) {
                                loserSprite.setScale(getAnimationScale(loserChar, "dead"));
                                loserSprite.play(`${loserChar}_dead`);
                            }

                            if (t.roundWinner === "player1") this.bot1RoundsWon++;
                            else this.bot2RoundsWon++;

                            this.roundScoreText.setText(
                                `Round ${this.currentRound}  •  ${this.bot1RoundsWon} - ${this.bot2RoundsWon}  (First to 2)`
                            );

                            await new Promise<void>((resolve) => this.time.delayedCall(1500, resolve));

                            const winnerName = t.roundWinner === "player1" ? this.config.bot1Name : this.config.bot2Name;
                            this.narrativeText.setText(`${(winnerName as string).toUpperCase()} WINS THE ROUND!`);
                            this.narrativeText.setAlpha(1);

                            if (!t.isMatchEnd) {
                                await new Promise<void>((resolve) => this.time.delayedCall(3000, resolve));
                                this.currentRound++;
                                this.roundScoreText.setText(
                                    `Round ${this.currentRound}  •  ${this.bot1RoundsWon} - ${this.bot2RoundsWon}  (First to 2)`
                                );
                                if (this.anims.exists(`${loserChar}_idle`)) {
                                    loserSprite.setScale(getAnimationScale(loserChar, "idle"));
                                    loserSprite.play(`${loserChar}_idle`);
                                }
                            }
                        } else {
                            // DRAW Logic (Double KO)
                            if (this.anims.exists(`${p1Char}_dead`)) {
                                this.player1Sprite.setScale(getAnimationScale(p1Char, "dead"));
                                this.player1Sprite.play(`${p1Char}_dead`);
                            }
                            if (this.anims.exists(`${p2Char}_dead`)) {
                                this.player2Sprite.setScale(getAnimationScale(p2Char, "dead"));
                                this.player2Sprite.play(`${p2Char}_dead`);
                            }

                            await new Promise<void>((resolve) => this.time.delayedCall(1500, resolve));

                            this.narrativeText.setText("⚡ DOUBLE KO - DRAW! ⚡");
                            this.narrativeText.setAlpha(1);

                            if (!t.isMatchEnd) {
                                await new Promise<void>((resolve) => this.time.delayedCall(3000, resolve));
                                this.currentRound++;
                                this.roundScoreText.setText(
                                    `Round ${this.currentRound}  •  ${this.bot1RoundsWon} - ${this.bot2RoundsWon}  (First to 2)`
                                );
                                if (this.anims.exists(`${p1Char}_idle`)) {
                                    this.player1Sprite.setScale(getAnimationScale(p1Char, "idle"));
                                    this.player1Sprite.play(`${p1Char}_idle`);
                                }
                                if (this.anims.exists(`${p2Char}_idle`)) {
                                    this.player2Sprite.setScale(getAnimationScale(p2Char, "idle"));
                                    this.player2Sprite.play(`${p2Char}_idle`);
                                }
                            }
                        }
                    } else {
                        // NOT Round End - reset to idle
                        if (this.anims.exists(`${p1Char}_idle`)) {
                            const p1IdleScale = getAnimationScale(p1Char, "idle");
                            this.player1Sprite.setScale(p1IdleScale);
                            this.player1Sprite.play(`${p1Char}_idle`);
                        }
                        if (this.anims.exists(`${p2Char}_idle`)) {
                            const p2IdleScale = getAnimationScale(p2Char, "idle");
                            this.player2Sprite.setScale(p2IdleScale);
                            this.player2Sprite.play(`${p2Char}_idle`);
                        }
                    }

                    const delay = Math.max(100, this.config.turnDurationMs - 3500);
                    this.time.delayedCall(delay, () => this.playNextTurn());
                };

                executeSequence();
            }
        });
    }

    /**
     * Show floating damage/healing text above a character.
     */
    private showFloatingText(text: string, x: number, y: number, color: string): void {
        const floatingText = this.add.text(x, y, text, {
            fontFamily: "Orbitron",
            fontSize: "24px",
            color: color,
            fontStyle: "bold",
            stroke: "#000000",
            strokeThickness: 4,
        }).setOrigin(0.5);

        this.tweens.add({
            targets: floatingText,
            y: y - 50,
            alpha: 0,
            duration: 1000,
            ease: "Power2",
            onComplete: () => floatingText.destroy(),
        });
    }

    private showMatchEnd(): void {
        this.isPlaying = false;

        const winner = this.config.matchWinner;
        const winnerName = winner === "player1" ? this.config.bot1Name : this.config.bot2Name;

        this.narrativeText.setText(`🏆 ${winnerName} WINS! 🏆`);
        this.narrativeText.setFontSize(48);
        this.narrativeText.setAlpha(1);

        const winnerSprite = winner === "player1" ? this.player1Sprite : this.player2Sprite;
        this.tweens.add({
            targets: winnerSprite,
            y: winnerSprite.y - 30,
            duration: 500,
            yoyo: true,
            repeat: 2,
            ease: "Sine.easeOut",
        });

        EventBus.emit("bot_battle_match_end", {
            matchId: this.config.matchId,
            winner,
        });

        this.time.delayedCall(5000, () => {
            EventBus.emit("bot_battle_request_new_match");
        });
    }
}

export default BotBattleScene;
