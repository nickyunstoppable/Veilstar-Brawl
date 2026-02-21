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
import { getDeterministicPowerSurgeCards } from "@/types/power-surge";
import type { BotTurnData } from "../../lib/chat/fake-chat-service";
import { SpectatorPowerSurgeCards } from "../ui/SpectatorPowerSurgeCards";
import { TextFactory } from "../ui/TextFactory";
import { preloadFightSceneAssets, createCharacterAnimations } from "../utils/asset-loader";
import { getCharacterCombatStats } from "../combat/CharacterStats";
import { calculateSurgeEffects } from "../combat/SurgeEffects";

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
    private player1MaxHp: number = 100;
    private player2MaxHp: number = 100;
    private player1MaxEnergy: number = 100;
    private player2MaxEnergy: number = 100;
    private activeRoundP1Surge: PowerSurgeCardId | null = null;
    private activeRoundP2Surge: PowerSurgeCardId | null = null;
    private warnedAboutTurnFallbackData: boolean = false;

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

        // Use real character combat stats (authoritative for UI max values)
        const p1Stats = getCharacterCombatStats(this.bot1Character.id);
        const p2Stats = getCharacterCombatStats(this.bot2Character.id);
        this.player1MaxHp = p1Stats.maxHp;
        this.player2MaxHp = p2Stats.maxHp;
        this.player1MaxEnergy = p1Stats.maxEnergy;
        this.player2MaxEnergy = p2Stats.maxEnergy;

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
            const turn = this.normalizeTurn(this.config.turns[i], i);

            if (turn.isRoundStart) {
                const withSurge = this.ensureSurgeData(turn);
                this.activeRoundP1Surge = withSurge.bot1SurgeSelection;
                this.activeRoundP2Surge = withSurge.bot2SurgeSelection;
            }

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
            const currentTurn = this.normalizeTurn(this.config.turns[targetTurnIndex - 1], targetTurnIndex - 1);
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
            const turn = this.normalizeTurn(this.config.turns[i], i);

            if (turn.isRoundStart) {
                const withSurge = this.ensureSurgeData(turn);
                this.activeRoundP1Surge = withSurge.bot1SurgeSelection;
                this.activeRoundP2Surge = withSurge.bot2SurgeSelection;
            }

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
            const currentTurn = this.normalizeTurn(this.config.turns[this.currentTurnIndex - 1], this.currentTurnIndex - 1);
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
            `BOT 1: ${this.config.bot1Name.toUpperCase()} (${this.player1MaxHp} HP)`,
            { fontSize: "12px", color: "#ff6b35", fontStyle: "bold" }
        );

        TextFactory.createLabel(
            this,
            UI_POSITIONS.HEALTH_BAR.PLAYER2.X + barWidth,
            UI_POSITIONS.HEALTH_BAR.PLAYER2.Y - 18,
            `BOT 2: ${this.config.bot2Name.toUpperCase()} (${this.player2MaxHp} HP)`,
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
        this.updateHealthBarDisplay("player1", this.player1MaxHp, this.player1MaxHp);
        this.updateHealthBarDisplay("player2", this.player2MaxHp, this.player2MaxHp);
        this.updateEnergyBarDisplay("player1", this.player1MaxEnergy, this.player1MaxEnergy);
        this.updateEnergyBarDisplay("player2", this.player2MaxEnergy, this.player2MaxEnergy);
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

    private updateUIFromTurn(turn: NormalizedBotTurn): void {
        this.updateHealthBarDisplay("player1", turn.bot1Hp, this.player1MaxHp);
        this.updateHealthBarDisplay("player2", turn.bot2Hp, this.player2MaxHp);
        this.updateEnergyBarDisplay("player1", turn.bot1Energy, this.player1MaxEnergy);
        this.updateEnergyBarDisplay("player2", turn.bot2Energy, this.player2MaxEnergy);
        this.updateGuardMeterDisplay("player1", turn.bot1GuardMeter);
        this.updateGuardMeterDisplay("player2", turn.bot2GuardMeter);
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

        const turn = this.normalizeTurn(this.config.turns[this.currentTurnIndex], this.currentTurnIndex);

        // Ensure active surges are available even when joining mid-round
        if (!turn.isRoundStart) {
            const roundStartTurn = this.findRoundStartTurn(turn.roundNumber, this.currentTurnIndex);
            if (roundStartTurn) {
                const withSurge = this.ensureSurgeData(roundStartTurn);
                this.activeRoundP1Surge = withSurge.bot1SurgeSelection;
                this.activeRoundP2Surge = withSurge.bot2SurgeSelection;
            }
        }

        // Check if this turn should show power surge (first turn of round)
        if (turn.isRoundStart) {
            const withSurge = this.ensureSurgeData(turn);
            this.activeRoundP1Surge = withSurge.bot1SurgeSelection;
            this.activeRoundP2Surge = withSurge.bot2SurgeSelection;

            this.showPowerSurgeUI(withSurge, () => {
                this.animateTurn(withSurge);
                this.currentTurnIndex++;
            });
        } else {
            this.animateTurn(turn);
            this.currentTurnIndex++;
        }
    }

    /**
     * Show power surge card reveal for spectators
     */
    private showPowerSurgeUI(turn: NormalizedBotTurn, onComplete: () => void): void {
        // Clean up any existing power surge UI
        if (this.powerSurgeUI) {
            this.powerSurgeUI.destroy();
            this.powerSurgeUI = null;
        }

        // Clear any leftover narrative text from previous round (e.g., "X WINS THE ROUND!")
        this.narrativeText.setAlpha(0);
        this.narrativeText.setText("");

        // Reset HP/Energy/Guard bars for the new round BEFORE showing power surge UI
        this.updateHealthBarDisplay("player1", this.player1MaxHp, this.player1MaxHp);
        this.updateHealthBarDisplay("player2", this.player2MaxHp, this.player2MaxHp);
        this.updateEnergyBarDisplay("player1", this.player1MaxEnergy, this.player1MaxEnergy);
        this.updateEnergyBarDisplay("player2", this.player2MaxEnergy, this.player2MaxEnergy);
        this.updateGuardMeterDisplay("player1", 0);
        this.updateGuardMeterDisplay("player2", 0);

        // Create spectator power surge UI
        const fallbackCard = turn.surgeCardIds[0] ?? "dag-overclock";
        this.powerSurgeUI = new SpectatorPowerSurgeCards({
            scene: this,
            roundNumber: turn.roundNumber,
            cardIds: turn.surgeCardIds,
            player1Selection: turn.bot1SurgeSelection ?? fallbackCard,
            player2Selection: turn.bot2SurgeSelection ?? fallbackCard,
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

    private animateTurn(turn: NormalizedBotTurn): void {
        const p1Char = this.bot1Character.id;
        const p2Char = this.bot2Character.id;
        const p1OriginalX = CHARACTER_POSITIONS.PLAYER1.X;
        const p2OriginalX = CHARACTER_POSITIONS.PLAYER2.X;
        const meetingPointX = GAME_DIMENSIONS.CENTER_X;

        // FightScene-compatible damage source and turn-start stun override
        const prevTurn = this.currentTurnIndex > 0
            ? this.normalizeTurn(this.config.turns[this.currentTurnIndex - 1], this.currentTurnIndex - 1)
            : null;
        const p1StunnedAtTurnStart = !turn.isRoundStart && Boolean(prevTurn?.bot1IsStunned);
        const p2StunnedAtTurnStart = !turn.isRoundStart && Boolean(prevTurn?.bot2IsStunned);

        const p1Move = p1StunnedAtTurnStart && turn.bot1Move !== "stunned" ? "stunned" : turn.bot1Move;
        const p2Move = p2StunnedAtTurnStart && turn.bot2Move !== "stunned" ? "stunned" : turn.bot2Move;

        const fallbackP1Damage = Math.max(
            0,
            (prevTurn?.bot1Hp ?? this.player1MaxHp) - turn.bot1Hp + Math.max(0, turn.bot1HpRegen) + Math.max(0, turn.bot1Lifesteal)
        );
        const fallbackP2Damage = Math.max(
            0,
            (prevTurn?.bot2Hp ?? this.player2MaxHp) - turn.bot2Hp + Math.max(0, turn.bot2HpRegen) + Math.max(0, turn.bot2Lifesteal)
        );
        const p1Damage = Math.max(0, Math.floor(turn.bot1DamageTakenProvided ? turn.bot1DamageTaken : fallbackP1Damage));
        const p2Damage = Math.max(0, Math.floor(turn.bot2DamageTakenProvided ? turn.bot2DamageTaken : fallbackP2Damage));

        // Check stun state for this turn's animation flow
        const p1IsStunned = p1Move === "stunned" || turn.bot1Outcome === "stunned";
        const p2IsStunned = p2Move === "stunned" || turn.bot2Outcome === "stunned";

        const getAnimDurationMs = (animKey: string, fallbackMs: number): number => {
            try {
                if (!this.anims.exists(animKey)) return fallbackMs;
                const anim = this.anims.get(animKey) as unknown as { duration?: number; frames?: unknown[]; frameRate?: number };
                const duration = Number(anim?.duration);
                if (Number.isFinite(duration) && duration > 0) return Math.ceil(duration);

                const frames = Array.isArray(anim?.frames) ? anim.frames.length : Number((anim as Record<string, unknown>)?.frames ?? 0);
                const frameRate = Number(anim?.frameRate ?? 24);
                if (Number.isFinite(frames) && frames > 0 && Number.isFinite(frameRate) && frameRate > 0) {
                    return Math.ceil((frames / frameRate) * 1000);
                }
            } catch {
                // fall back
            }
            return fallbackMs;
        };

        const splitDamageIntoHits = (total: number, hits: number): number[] => {
            const safeHits = Math.max(1, Math.floor(hits));
            const safeTotal = Math.max(0, Math.floor(total));
            const base = Math.floor(safeTotal / safeHits);
            const remainder = safeTotal % safeHits;
            return Array.from({ length: safeHits }, (_, i) => base + (i < remainder ? 1 : 0));
        };

        const surgeForPlayback = calculateSurgeEffects(this.activeRoundP1Surge, this.activeRoundP2Surge);
        const p1HitCount = (!p1IsStunned
            && surgeForPlayback.player1Modifiers.doubleHit
            && surgeForPlayback.player1Modifiers.doubleHitMoves.includes(p1Move))
            ? 2
            : 1;
        const p2HitCount = (!p2IsStunned
            && surgeForPlayback.player2Modifiers.doubleHit
            && surgeForPlayback.player2Modifiers.doubleHitMoves.includes(p2Move))
            ? 2
            : 1;

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
                // Helper: P1 Attack animation with damage display
                const runP1Attack = (): Promise<void> => {
                    return new Promise((resolve) => {
                        if (p1IsStunned) { resolve(); return; }

                        const animKey = `${p1Char}_${p1Move}`;
                        const animDurationMs = getAnimDurationMs(animKey, 1200);
                        const baseSpacingMs = (p1Move === "punch" || p1Move === "kick") ? 1200 : animDurationMs;
                        const hitSpacingMs = Math.max(baseSpacingMs, animDurationMs);
                        const impactMs = Math.min(300, Math.max(120, Math.floor(animDurationMs * 0.25)));
                        const shouldRepeat = (p1Move === "punch" || p1Move === "kick") && p1HitCount > 1;
                        const hitCount = shouldRepeat ? p1HitCount : 1;
                        const damageParts = splitDamageIntoHits(p2Damage, hitCount);

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

                        for (let i = 0; i < hitCount; i++) {
                            const startOffset = i * hitSpacingMs;
                            this.time.delayedCall(startOffset + impactMs, () => {
                                const part = damageParts[i] ?? 0;
                                if (part > 0) {
                                    this.showFloatingText(`-${part}`, p2TargetX, CHARACTER_POSITIONS.PLAYER2.Y - 130, "#ff4444");
                                    this.tweens.add({ targets: this.player2Sprite, alpha: 0.5, yoyo: true, duration: 50, repeat: 3 });
                                } else if (i === 0 && turn.bot2Outcome === "missed") {
                                    this.showFloatingText("DODGE!", p2TargetX, CHARACTER_POSITIONS.PLAYER2.Y - 130, "#8800ff");
                                }
                            });
                        }

                        const afterLastHitOffset = (hitCount - 1) * hitSpacingMs;

                        if (turn.bot2EnergyDrained && turn.bot2EnergyDrained > 0) {
                            this.time.delayedCall(afterLastHitOffset + 500, () => {
                                this.showFloatingText(`-${Math.round(turn.bot2EnergyDrained)} EN`, p2TargetX, CHARACTER_POSITIONS.PLAYER2.Y - 100, "#3b82f6");
                            });
                        }

                        const bot1TotalHeal = (turn.bot1HpRegen || 0) + (turn.bot1Lifesteal || 0);
                        if (bot1TotalHeal > 0) {
                            this.time.delayedCall(afterLastHitOffset + 700, () => {
                                this.showFloatingText(`+${Math.round(bot1TotalHeal)} HP`, p1TargetX, CHARACTER_POSITIONS.PLAYER1.Y - 100, "#00ff88");
                            });
                        }

                        this.time.delayedCall(afterLastHitOffset + animDurationMs, () => resolve());
                    });
                };

                // Helper: P2 Attack animation with damage display
                const runP2Attack = (): Promise<void> => {
                    return new Promise((resolve) => {
                        if (p2IsStunned) { resolve(); return; }

                        const animKey = `${p2Char}_${p2Move}`;
                        const animDurationMs = getAnimDurationMs(animKey, 1200);
                        const baseSpacingMs = (p2Move === "punch" || p2Move === "kick") ? 1200 : animDurationMs;
                        const hitSpacingMs = Math.max(baseSpacingMs, animDurationMs);
                        const impactMs = Math.min(300, Math.max(120, Math.floor(animDurationMs * 0.25)));
                        const shouldRepeat = (p2Move === "punch" || p2Move === "kick") && p2HitCount > 1;
                        const hitCount = shouldRepeat ? p2HitCount : 1;
                        const damageParts = splitDamageIntoHits(p1Damage, hitCount);

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

                        for (let i = 0; i < hitCount; i++) {
                            const startOffset = i * hitSpacingMs;
                            this.time.delayedCall(startOffset + impactMs, () => {
                                const part = damageParts[i] ?? 0;
                                if (part > 0) {
                                    this.showFloatingText(`-${part}`, p1TargetX, CHARACTER_POSITIONS.PLAYER1.Y - 130, "#ff4444");
                                    this.tweens.add({ targets: this.player1Sprite, alpha: 0.5, yoyo: true, duration: 50, repeat: 3 });
                                } else if (i === 0 && turn.bot1Outcome === "missed") {
                                    this.showFloatingText("DODGE!", p1TargetX, CHARACTER_POSITIONS.PLAYER1.Y - 130, "#8800ff");
                                }
                            });
                        }

                        const afterLastHitOffset = (hitCount - 1) * hitSpacingMs;

                        if (turn.bot1EnergyDrained && turn.bot1EnergyDrained > 0) {
                            this.time.delayedCall(afterLastHitOffset + 500, () => {
                                this.showFloatingText(`-${Math.round(turn.bot1EnergyDrained)} EN`, p1TargetX, CHARACTER_POSITIONS.PLAYER1.Y - 100, "#3b82f6");
                            });
                        }

                        const bot2TotalHeal = (turn.bot2HpRegen || 0) + (turn.bot2Lifesteal || 0);
                        if (bot2TotalHeal > 0) {
                            this.time.delayedCall(afterLastHitOffset + 700, () => {
                                this.showFloatingText(`+${Math.round(bot2TotalHeal)} HP`, p2TargetX, CHARACTER_POSITIONS.PLAYER2.Y - 100, "#00ff88");
                            });
                        }

                        this.time.delayedCall(afterLastHitOffset + animDurationMs, () => resolve());
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

                    const narrative = this.buildDisplayNarrative(turn, p1Move, p2Move);
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

                    if (turn.isRoundEnd) {
                        if (turn.roundWinner) {
                            const loserChar = turn.roundWinner === "player1" ? p2Char : p1Char;
                            const loserSprite = turn.roundWinner === "player1" ? this.player2Sprite : this.player1Sprite;

                            if (this.anims.exists(`${loserChar}_dead`)) {
                                loserSprite.setScale(getAnimationScale(loserChar, "dead"));
                                loserSprite.play(`${loserChar}_dead`);
                            }

                            if (turn.roundWinner === "player1") this.bot1RoundsWon++;
                            else this.bot2RoundsWon++;

                            this.roundScoreText.setText(
                                `Round ${this.currentRound}  •  ${this.bot1RoundsWon} - ${this.bot2RoundsWon}  (First to 2)`
                            );

                            await new Promise<void>((resolve) => this.time.delayedCall(1500, resolve));

                            const winnerName = turn.roundWinner === "player1" ? this.config.bot1Name : this.config.bot2Name;
                            const wonOnTime = turn.bot1Hp > 0 && turn.bot2Hp > 0;
                            this.narrativeText.setText(
                                wonOnTime
                                    ? `${(winnerName as string).toUpperCase()} WINS ON TIME (HP%)!`
                                    : `${(winnerName as string).toUpperCase()} WINS THE ROUND!`
                            );
                            this.narrativeText.setAlpha(1);

                            if (!turn.isMatchEnd) {
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

                            if (!turn.isMatchEnd) {
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

        const finalWinner = this.resolveFinalWinner();

        if (finalWinner === null) {
            this.narrativeText.setText("⚖️ MATCH DRAW! ⚖️");
        } else {
            const winnerName = finalWinner === "player1" ? this.config.bot1Name : this.config.bot2Name;
            this.narrativeText.setText(`🏆 ${winnerName} WINS! 🏆`);
        }
        this.narrativeText.setFontSize(48);
        this.narrativeText.setAlpha(1);

        if (finalWinner !== null) {
            const winnerSprite = finalWinner === "player1" ? this.player1Sprite : this.player2Sprite;
            this.tweens.add({
                targets: winnerSprite,
                y: winnerSprite.y - 30,
                duration: 500,
                yoyo: true,
                repeat: 2,
                ease: "Sine.easeOut",
            });
        }

        EventBus.emit("bot_battle_match_end", {
            matchId: this.config.matchId,
            winner: finalWinner,
        });

        this.time.delayedCall(5000, () => {
            EventBus.emit("bot_battle_request_new_match");
        });
    }

    private toNumber(value: unknown, fallback: number): number {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    private toMove(value: unknown): "punch" | "kick" | "block" | "special" | "stunned" {
        if (value === "punch" || value === "kick" || value === "block" || value === "special" || value === "stunned") {
            return value;
        }
        return "block";
    }

    private hashSeed(seed: string): number {
        let hash = 2166136261;
        for (let i = 0; i < seed.length; i++) {
            hash ^= seed.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return Math.abs(hash);
    }

    private ensureSurgeData(turn: NormalizedBotTurn): NormalizedBotTurn {
        if (turn.surgeCardIds.length > 0 && turn.bot1SurgeSelection && turn.bot2SurgeSelection) {
            return turn;
        }

        const deck = getDeterministicPowerSurgeCards(this.config.matchId, turn.roundNumber, 3).map(card => card.id);
        const safeDeck = deck.length > 0 ? deck : ["dag-overclock", "block-fortress", "sompi-shield"] as PowerSurgeCardId[];

        const p1Seed = this.hashSeed(`${this.config.matchId}:${turn.roundNumber}:p1`);
        const p2Seed = this.hashSeed(`${this.config.matchId}:${turn.roundNumber}:p2`);
        const p1Selection = safeDeck[p1Seed % safeDeck.length];
        const p2Selection = safeDeck[p2Seed % safeDeck.length];

        return {
            ...turn,
            surgeCardIds: safeDeck,
            bot1SurgeSelection: turn.bot1SurgeSelection ?? p1Selection,
            bot2SurgeSelection: turn.bot2SurgeSelection ?? p2Selection,
        };
    }

    private findRoundStartTurn(roundNumber: number, upToIndex: number): NormalizedBotTurn | null {
        for (let i = 0; i <= upToIndex && i < this.config.turns.length; i++) {
            const turn = this.normalizeTurn(this.config.turns[i], i);
            if (turn.roundNumber === roundNumber && turn.isRoundStart) {
                return turn;
            }
        }
        return null;
    }

    private resolveFinalWinner(): "player1" | "player2" | null {
        if (this.config.matchWinner === "player1" || this.config.matchWinner === "player2") {
            return this.config.matchWinner;
        }

        if (this.bot1RoundsWon > this.bot2RoundsWon) return "player1";
        if (this.bot2RoundsWon > this.bot1RoundsWon) return "player2";

        const lastTurn = this.config.turns.length > 0
            ? this.normalizeTurn(this.config.turns[this.config.turns.length - 1], this.config.turns.length - 1)
            : null;
        if (!lastTurn) return null;
        if (lastTurn.bot1Hp > lastTurn.bot2Hp) return "player1";
        if (lastTurn.bot2Hp > lastTurn.bot1Hp) return "player2";
        return null;
    }

    private buildDisplayNarrative(
        turn: NormalizedBotTurn,
        p1Move: "punch" | "kick" | "block" | "special" | "stunned",
        p2Move: "punch" | "kick" | "block" | "special" | "stunned"
    ): string {
        const moveNames: Record<typeof p1Move, string> = {
            punch: "throws a punch",
            kick: "fires a kick",
            block: "raises guard",
            special: "unleashes a special",
            stunned: "is stunned",
        };

        const p1Action = moveNames[p1Move];
        const p2Action = moveNames[p2Move];
        const p1Missed = turn.bot1Outcome === "missed";
        const p2Missed = turn.bot2Outcome === "missed";

        if (turn.isRoundEnd && !turn.roundWinner) {
            return "⚡ DOUBLE KO — BOTH BOTS DROP! ⚡";
        }

        if (p1Move === "stunned" && p2Move === "stunned") {
            return "Both bots are stunned and lose the moment.";
        }

        if (p1Move === "stunned") {
            return `Bot 1 is stunned while Bot 2 ${p2Action}.`;
        }

        if (p2Move === "stunned") {
            return `Bot 1 ${p1Action} while Bot 2 is stunned.`;
        }

        if (p1Missed && p2Missed) {
            return `Bot 1 ${p1Action}, Bot 2 ${p2Action}—both attacks miss.`;
        }

        if (p1Missed) {
            return `Bot 1 ${p1Action}, but Bot 2 slips away.`;
        }

        if (p2Missed) {
            return `Bot 2 ${p2Action}, but Bot 1 slips away.`;
        }

        return `Bot 1 ${p1Action}, Bot 2 ${p2Action}.`;
    }

    private normalizeTurn(rawTurn: BotTurnData, index: number): NormalizedBotTurn {
        const raw = rawTurn as BotTurnData & Record<string, unknown>;
        const p1 = (raw.player1 as Record<string, unknown> | undefined) ?? {};
        const p2 = (raw.player2 as Record<string, unknown> | undefined) ?? {};

        const prev = index > 0 ? this.normalizeTurn(this.config.turns[index - 1], index - 1) : null;
        const turnNumber = this.toNumber(raw.turnNumber, index + 1);
        const roundNumber = this.toNumber(raw.roundNumber, prev?.roundNumber ?? 1);

        const bot1HpSource = raw.bot1Hp ?? raw.player1HealthAfter ?? p1.hpAfter ?? p1.healthAfter;
        const bot2HpSource = raw.bot2Hp ?? raw.player2HealthAfter ?? p2.hpAfter ?? p2.healthAfter;
        const bot1Hp = this.toNumber(bot1HpSource, prev?.bot1Hp ?? this.player1MaxHp);
        const bot2Hp = this.toNumber(bot2HpSource, prev?.bot2Hp ?? this.player2MaxHp);

        const bot1EnergySource = raw.bot1Energy ?? raw.player1EnergyAfter ?? p1.energyAfter;
        const bot2EnergySource = raw.bot2Energy ?? raw.player2EnergyAfter ?? p2.energyAfter;
        const bot1Energy = this.toNumber(bot1EnergySource, prev?.bot1Energy ?? this.player1MaxEnergy);
        const bot2Energy = this.toNumber(bot2EnergySource, prev?.bot2Energy ?? this.player2MaxEnergy);

        if (!this.warnedAboutTurnFallbackData && (bot1HpSource == null || bot2HpSource == null || bot1EnergySource == null || bot2EnergySource == null)) {
            this.warnedAboutTurnFallbackData = true;
            console.warn("[BotBattleScene] Missing authoritative turn fields; using fallback values", {
                matchId: this.config.matchId,
                index,
                hasBot1Hp: bot1HpSource != null,
                hasBot2Hp: bot2HpSource != null,
                hasBot1Energy: bot1EnergySource != null,
                hasBot2Energy: bot2EnergySource != null,
            });
        }

        const bot1GuardMeter = this.toNumber(raw.bot1GuardMeter ?? raw.bot1Guard ?? raw.player1GuardMeter ?? raw.player1GuardAfter ?? p1.guardMeterAfter ?? p1.guardMeter, prev?.bot1GuardMeter ?? 0);
        const bot2GuardMeter = this.toNumber(raw.bot2GuardMeter ?? raw.bot2Guard ?? raw.player2GuardMeter ?? raw.player2GuardAfter ?? p2.guardMeterAfter ?? p2.guardMeter, prev?.bot2GuardMeter ?? 0);

        const explicitRoundStart = Boolean(raw.isRoundStart);
        const inferredRoundStart = turnNumber === 1 || (index === 0) || Boolean(prev?.isRoundEnd);
        const isRoundStart = explicitRoundStart || inferredRoundStart;

        const isRoundEnd = Boolean(raw.isRoundEnd) || Boolean(raw.isRoundOver);
        const isMatchEnd = Boolean(raw.isMatchEnd) || Boolean(raw.isMatchOver);
        const roundWinner = (raw.roundWinner === "player1" || raw.roundWinner === "player2")
            ? raw.roundWinner
            : (raw.roundWinner === "bot1" ? "player1" : raw.roundWinner === "bot2" ? "player2" : null);

        const surgeCardIdsRaw = (raw.surgeCardIds ?? raw.offeredCards ?? raw.powerSurgeCards) as unknown;
        const surgeCardIds = Array.isArray(surgeCardIdsRaw)
            ? surgeCardIdsRaw.filter((card): card is PowerSurgeCardId => typeof card === "string")
            : [];

        return {
            turnNumber,
            roundNumber,
            bot1Move: this.toMove(raw.bot1Move ?? raw.player1Move ?? p1.move),
            bot2Move: this.toMove(raw.bot2Move ?? raw.player2Move ?? p2.move),
            bot1Hp,
            bot2Hp,
            bot1Energy,
            bot2Energy,
            bot1GuardMeter,
            bot2GuardMeter,
            bot1DamageTaken: this.toNumber(raw.bot1DamageTaken ?? raw.player1DamageTaken ?? p1.damageTaken, Math.max(0, (prev?.bot1Hp ?? this.player1MaxHp) - bot1Hp)),
            bot2DamageTaken: this.toNumber(raw.bot2DamageTaken ?? raw.player2DamageTaken ?? p2.damageTaken, Math.max(0, (prev?.bot2Hp ?? this.player2MaxHp) - bot2Hp)),
            bot1DamageTakenProvided: raw.bot1DamageTaken != null || raw.player1DamageTaken != null || p1.damageTaken != null,
            bot2DamageTakenProvided: raw.bot2DamageTaken != null || raw.player2DamageTaken != null || p2.damageTaken != null,
            bot1HpRegen: this.toNumber(raw.bot1HpRegen ?? raw.player1HpRegen ?? p1.hpRegen, 0),
            bot2HpRegen: this.toNumber(raw.bot2HpRegen ?? raw.player2HpRegen ?? p2.hpRegen, 0),
            bot1Lifesteal: this.toNumber(raw.bot1Lifesteal ?? raw.player1Lifesteal ?? p1.lifesteal, 0),
            bot2Lifesteal: this.toNumber(raw.bot2Lifesteal ?? raw.player2Lifesteal ?? p2.lifesteal, 0),
            bot1EnergyDrained: this.toNumber(raw.bot1EnergyDrained ?? raw.player1EnergyDrained ?? p1.energyDrained, 0),
            bot2EnergyDrained: this.toNumber(raw.bot2EnergyDrained ?? raw.player2EnergyDrained ?? p2.energyDrained, 0),
            bot1IsStunned: Boolean(raw.bot1IsStunned ?? raw.player1IsStunned ?? p1.isStunned),
            bot2IsStunned: Boolean(raw.bot2IsStunned ?? raw.player2IsStunned ?? p2.isStunned),
            bot1Outcome: typeof (raw.bot1Outcome ?? raw.player1Outcome ?? p1.outcome) === "string" ? (raw.bot1Outcome ?? raw.player1Outcome ?? p1.outcome) as string : null,
            bot2Outcome: typeof (raw.bot2Outcome ?? raw.player2Outcome ?? p2.outcome) === "string" ? (raw.bot2Outcome ?? raw.player2Outcome ?? p2.outcome) as string : null,
            narrative: typeof (raw.narrative ?? raw.description) === "string" ? String(raw.narrative ?? raw.description) : "",
            isRoundStart,
            isRoundEnd,
            isMatchEnd,
            roundWinner,
            surgeCardIds,
            bot1SurgeSelection: typeof (raw.bot1SurgeSelection ?? raw.player1SurgeSelection) === "string" ? (raw.bot1SurgeSelection ?? raw.player1SurgeSelection) as PowerSurgeCardId : null,
            bot2SurgeSelection: typeof (raw.bot2SurgeSelection ?? raw.player2SurgeSelection) === "string" ? (raw.bot2SurgeSelection ?? raw.player2SurgeSelection) as PowerSurgeCardId : null,
        };
    }
}

interface NormalizedBotTurn {
    turnNumber: number;
    roundNumber: number;
    bot1Move: "punch" | "kick" | "block" | "special" | "stunned";
    bot2Move: "punch" | "kick" | "block" | "special" | "stunned";
    bot1Hp: number;
    bot2Hp: number;
    bot1Energy: number;
    bot2Energy: number;
    bot1GuardMeter: number;
    bot2GuardMeter: number;
    bot1DamageTaken: number;
    bot2DamageTaken: number;
    bot1DamageTakenProvided: boolean;
    bot2DamageTakenProvided: boolean;
    bot1HpRegen: number;
    bot2HpRegen: number;
    bot1Lifesteal: number;
    bot2Lifesteal: number;
    bot1EnergyDrained: number;
    bot2EnergyDrained: number;
    bot1IsStunned: boolean;
    bot2IsStunned: boolean;
    bot1Outcome: string | null;
    bot2Outcome: string | null;
    narrative: string;
    isRoundStart: boolean;
    isRoundEnd: boolean;
    isMatchEnd: boolean;
    roundWinner: "player1" | "player2" | null;
    surgeCardIds: PowerSurgeCardId[];
    bot1SurgeSelection: PowerSurgeCardId | null;
    bot2SurgeSelection: PowerSurgeCardId | null;
}

export default BotBattleScene;
