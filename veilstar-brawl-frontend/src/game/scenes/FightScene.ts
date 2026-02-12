/**
 * FightScene - Online multiplayer fight scene
 * Mirrors PracticeScene UI/UX but with network play via Supabase Realtime
 * Uses Stellar message signing for move verification
 * Implements per-player timers for Stellar transaction latency
 */

import Phaser from "phaser";
import { EventBus } from "@/game/EventBus";
import { GAME_DIMENSIONS, CHARACTER_POSITIONS, UI_POSITIONS } from "@/game/config";
import { getCharacterScale, getCharacterYOffset } from "@/game/config/sprite-config";
import { CombatEngine, BASE_MOVE_STATS } from "@/game/combat";
import { TextFactory } from "@/game/ui/TextFactory";
import type { PowerSurgeCardId } from "@/types/power-surge";
import {
    loadBackground,
    loadUIAssets,
    loadCharacterSprites,
    loadCommonAudio,
    loadCharacterAudio,
    createCharacterAnimations,
} from "@/game/utils/asset-loader";
import { getCharacter } from "@/data/characters";
import type { MoveType, Character } from "@/types/game";
import { buildMoveMessage } from "@/lib/stellar/move-transaction";
import type { RoundResolvedPayload, MoveSubmittedPayload, MoveConfirmedPayload } from "@/types/websocket";

// =============================================================================
// TYPES
// =============================================================================

export interface FightSceneConfig {
    matchId: string;
    player1Address: string;
    player2Address: string;
    player1Character: string;
    player2Character: string;
    playerRole: "player1" | "player2";
    matchFormat?: "best_of_3" | "best_of_5";
}

type FightPhase = "waiting" | "countdown" | "selecting" | "resolving" | "round_end" | "match_end";

// =============================================================================
// FIGHT SCENE
// =============================================================================

export class FightScene extends Phaser.Scene {
    // Configuration
    private config!: FightSceneConfig;
    private player1Character!: Character;
    private player2Character!: Character;

    // Combat Engine
    private combatEngine!: CombatEngine;

    // UI Elements
    private player1HealthBar!: Phaser.GameObjects.Graphics;
    private player2HealthBar!: Phaser.GameObjects.Graphics;
    private player1EnergyBar!: Phaser.GameObjects.Graphics;
    private player2EnergyBar!: Phaser.GameObjects.Graphics;
    private player1GuardMeter!: Phaser.GameObjects.Graphics;
    private player2GuardMeter!: Phaser.GameObjects.Graphics;
    private roundTimerText!: Phaser.GameObjects.Text;
    private roundScoreText!: Phaser.GameObjects.Text;
    private countdownText!: Phaser.GameObjects.Text;
    private turnIndicatorText!: Phaser.GameObjects.Text;
    private narrativeText!: Phaser.GameObjects.Text;
    private narrativeTimer?: Phaser.Time.TimerEvent;

    // Character sprites
    private player1Sprite!: Phaser.GameObjects.Sprite;
    private player2Sprite!: Phaser.GameObjects.Sprite;

    // Move buttons
    private moveButtons: Map<MoveType, Phaser.GameObjects.Container> = new Map();
    private selectedMove: MoveType | null = null;

    // Phase & Timer state
    private phase: FightPhase = "waiting";
    private moveDeadlineAt: number = 0;
    private countdownEndsAt: number = 0;
    private countdownPhaseNumber: number = 0;
    private turnTimer: number = 15;
    private timerExpiredHandled: boolean = false;
    private roundEndCountdownEndsAt: number = 0;

    // Network state
    private hasSubmittedMove: boolean = false;
    private opponentHasSubmitted: boolean = false;
    private isWaitingForOpponent: boolean = false;
    private currentRound: number = 1;
    private currentTurn: number = 1;

    // On-chain state (from match_starting / match_ended events)
    private onChainSessionId?: number;
    private onChainTxHash?: string;
    private contractId?: string;
    private onChainIndicatorText?: Phaser.GameObjects.Text;

    // Per-player timer (Stellar adaptation)
    private myTimerFrozen: boolean = false;
    private myTimerFrozenAt: number = 0;

    // Disconnect handling
    private opponentDisconnected: boolean = false;
    private disconnectTimeoutAt: number = 0;
    private disconnectTimerText?: Phaser.GameObjects.Text;

    // Power surge
    private activeSurges: {
        player1: PowerSurgeCardId | null;
        player2: PowerSurgeCardId | null;
    } = { player1: null, player2: null };
    private stunTweens: Map<"player1" | "player2", Phaser.Tweens.Tween> = new Map();

    // Audio settings
    private bgmVolume: number = 0.3;
    private sfxVolume: number = 0.5;

    // Settings menu
    private settingsContainer!: Phaser.GameObjects.Container;
    private isSettingsOpen: boolean = false;

    constructor() {
        super({ key: "FightScene" });
    }

    // ===========================================================================
    // LIFECYCLE
    // ===========================================================================

    init(data: FightSceneConfig): void {
        this.config = { ...data };
        this.resetFullState();
    }

    private resetFullState(): void {
        const char1 = getCharacter(this.config.player1Character);
        const char2 = getCharacter(this.config.player2Character);
        if (!char1 || !char2) {
            console.error("[FightScene] Invalid character IDs");
            return;
        }
        this.player1Character = char1;
        this.player2Character = char2;

        this.selectedMove = null;
        this.turnTimer = 15;
        this.phase = "waiting";
        this.moveButtons.clear();
        this.hasSubmittedMove = false;
        this.opponentHasSubmitted = false;
        this.isWaitingForOpponent = false;
        this.myTimerFrozen = false;
        this.currentRound = 1;
        this.currentTurn = 1;
        this.timerExpiredHandled = false;
        this.activeSurges = { player1: null, player2: null };
    }

    preload(): void {
        loadBackground(this, "arena-bg", "/assets/background_2.webp");
        loadUIAssets(this);

        const p1 = this.config?.player1Character || "dag-warrior";
        const p2 = this.config?.player2Character || "dag-warrior";
        loadCharacterSprites(this, [p1, p2]);
        loadCommonAudio(this);
        loadCharacterAudio(this, [p1, p2]);

        if (!this.cache.audio.exists("bgm_fight")) {
            this.load.audio("bgm_fight", "/assets/audio/fight.mp3");
        }
    }

    create(): void {
        this.loadAudioSettings();

        const matchFormat = this.config.matchFormat === "best_of_5" ? "best_of_5" : "best_of_3";
        this.combatEngine = new CombatEngine(
            this.player1Character.id,
            this.player2Character.id,
            matchFormat
        );

        createCharacterAnimations(this, [this.player1Character.id, this.player2Character.id]);

        // Build UI (same as PracticeScene)
        this.createBackground();
        this.createCharacterSprites();
        this.createHealthBars();
        this.createEnergyBars();
        this.createGuardMeters();
        this.createRoundTimer();
        this.createRoundScore();
        this.createMoveButtons();
        this.createNarrativeDisplay();
        this.createTurnIndicator();
        this.createCountdownOverlay();

        // Settings
        this.settingsContainer = this.add.container(0, 0);
        this.createSettingsButton();

        // Setup network event listeners
        this.setupEventListeners();

        // Sync UI
        this.syncUIWithCombatState();

        // BGM
        this.sound.pauseOnBlur = false;
        try {
            this.sound.play("bgm_fight", { loop: true, volume: this.bgmVolume });
        } catch (e) {
            console.warn("[FightScene] Could not play BGM:", e);
        }

        this.events.once("shutdown", this.handleShutdown, this);
        this.events.once("destroy", this.handleShutdown, this);

        EventBus.emit("fight_scene_ready", { matchId: this.config.matchId });
    }

    // ===========================================================================
    // UPDATE LOOP (per-player timers)
    // ===========================================================================

    update(_time: number, _delta: number): void {
        const now = Date.now();

        // === COUNTDOWN PHASE ===
        if (this.phase === "countdown" && this.countdownEndsAt > 0) {
            const remainingMs = this.countdownEndsAt - now;
            const remainingSeconds = Math.ceil(remainingMs / 1000);

            if (remainingMs <= 0) {
                if (this.countdownPhaseNumber !== -1) {
                    this.countdownPhaseNumber = -1;
                    this.countdownText.setText("FIGHT!");
                    this.countdownText.setAlpha(1);
                    this.countdownText.setScale(1);
                    const selectionStartAt = this.countdownEndsAt + 500;
                    if (now >= selectionStartAt) {
                        this.countdownText.setAlpha(0);
                        this.countdownEndsAt = 0;
                        this.startSelectionPhase();
                    }
                } else if (now >= this.countdownEndsAt + 500) {
                    this.countdownText.setAlpha(0);
                    this.countdownEndsAt = 0;
                    this.startSelectionPhase();
                }
            } else if (remainingSeconds !== this.countdownPhaseNumber && remainingSeconds > 0 && remainingSeconds <= 3) {
                this.countdownPhaseNumber = remainingSeconds;
                this.countdownText.setText(remainingSeconds.toString());
                this.countdownText.setAlpha(1);
                this.tweens.killTweensOf(this.countdownText);
                this.tweens.add({
                    targets: this.countdownText,
                    scale: { from: 1.5, to: 1 },
                    alpha: { from: 1, to: 0.5 },
                    duration: 800,
                });
            }
        }

        // === SELECTING PHASE (per-player timer) ===
        if (this.phase === "selecting" && this.moveDeadlineAt > 0 && this.roundTimerText) {
            if (this.myTimerFrozen) {
                // Player has submitted — show frozen state
                this.roundTimerText.setText("✓");
                this.roundTimerText.setColor("#22c55e");
            } else {
                const remainingMs = this.moveDeadlineAt - now;
                this.turnTimer = Math.max(0, Math.ceil(remainingMs / 1000));
                this.roundTimerText.setText(`${this.turnTimer}`);
                this.roundTimerText.setColor(this.turnTimer <= 5 ? "#ff4444" : "#40e0d0");

                if (remainingMs <= 0 && !this.timerExpiredHandled) {
                    this.timerExpiredHandled = true;
                    this.onTimerExpired();
                }
            }
        }

        // === ROUND END COUNTDOWN ===
        if (this.phase === "round_end" && this.roundEndCountdownEndsAt > 0) {
            const remainingMs = this.roundEndCountdownEndsAt - now;
            const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1000));

            if (remainingMs <= 0) {
                this.roundEndCountdownEndsAt = 0;
            } else {
                this.countdownText.setText(`Next round in ${remainingSeconds}`);
                this.countdownText.setFontSize(32);
                this.countdownText.setColor("#40e0d0");
                this.countdownText.setAlpha(1);
            }
        }

        // === DISCONNECT TIMER ===
        if (this.opponentDisconnected && this.disconnectTimeoutAt > 0) {
            const remaining = Math.max(0, Math.ceil((this.disconnectTimeoutAt - now) / 1000));
            if (this.disconnectTimerText) {
                this.disconnectTimerText.setText(`Waiting for reconnection: ${remaining}s`);
            }
            if (remaining <= 0) {
                this.handleDisconnectTimeout();
            }
        }
    }

    // ===========================================================================
    // NETWORK EVENT LISTENERS
    // ===========================================================================

    private setupEventListeners(): void {
        // Server → Scene events (via EventBus from useGameChannel)
        EventBus.on("game:roundStarting", this.onRoundStarting, this);
        EventBus.on("game:moveSubmitted", this.onMoveSubmitted, this);
        EventBus.on("game:moveConfirmed", this.onMoveConfirmed, this);
        EventBus.on("game:roundResolved", this.onRoundResolved, this);
        EventBus.on("game:matchEnded", this.onMatchEnded, this);
        EventBus.on("game:matchStarting", this.onMatchStarting, this);
        EventBus.on("game:playerDisconnected", this.onPlayerDisconnected, this);
        EventBus.on("game:playerReconnected", this.onPlayerReconnected, this);
        EventBus.on("game:moveRejected", this.onMoveRejected, this);
        EventBus.on("game:matchCancelled", this.onMatchCancelled, this);
        EventBus.on("game:chatMessage", this.onChatMessage, this);
        EventBus.on("game:stickerMessage", this.onStickerMessage, this);
        EventBus.on("game:fightStateUpdate", this.onFightStateUpdate, this);
        EventBus.on("game:powerSurgeCards", this.onPowerSurgeCards, this);
        EventBus.on("game:powerSurgeSelected", this.onPowerSurgeSelected, this);

        // React → Scene events
        EventBus.on("scene:toggleAudio", this.toggleAudio, this);
        EventBus.on("scene:forfeit", this.forfeitMatch, this);

        // Cleanup on shutdown
        this.events.once("shutdown", () => {
            EventBus.off("game:roundStarting", this.onRoundStarting, this);
            EventBus.off("game:moveSubmitted", this.onMoveSubmitted, this);
            EventBus.off("game:moveConfirmed", this.onMoveConfirmed, this);
            EventBus.off("game:roundResolved", this.onRoundResolved, this);
            EventBus.off("game:matchEnded", this.onMatchEnded, this);
            EventBus.off("game:matchStarting", this.onMatchStarting, this);
            EventBus.off("game:playerDisconnected", this.onPlayerDisconnected, this);
            EventBus.off("game:playerReconnected", this.onPlayerReconnected, this);
            EventBus.off("game:moveRejected", this.onMoveRejected, this);
            EventBus.off("game:matchCancelled", this.onMatchCancelled, this);
            EventBus.off("game:chatMessage", this.onChatMessage, this);
            EventBus.off("game:stickerMessage", this.onStickerMessage, this);
            EventBus.off("game:fightStateUpdate", this.onFightStateUpdate, this);
            EventBus.off("game:powerSurgeCards", this.onPowerSurgeCards, this);
            EventBus.off("game:powerSurgeSelected", this.onPowerSurgeSelected, this);
            EventBus.off("scene:toggleAudio", this.toggleAudio, this);
            EventBus.off("scene:forfeit", this.forfeitMatch, this);
        });
    }

    // ===========================================================================
    // SERVER EVENT HANDLERS
    // ===========================================================================

    private onRoundStarting(payload: any): void {
        console.log("[FightScene] round_starting:", payload);

        this.currentRound = payload.roundNumber;
        this.currentTurn = payload.turnNumber;
        this.hasSubmittedMove = false;
        this.opponentHasSubmitted = false;
        this.myTimerFrozen = false;
        this.isWaitingForOpponent = false;
        this.timerExpiredHandled = false;
        this.selectedMove = null;

        // Sync combat state from server
        if (payload.player1Health !== undefined) {
            this.combatEngine.setPlayerHealth("player1", payload.player1Health);
        }
        if (payload.player2Health !== undefined) {
            this.combatEngine.setPlayerHealth("player2", payload.player2Health);
        }

        // Set up countdown → selection transition
        this.moveDeadlineAt = payload.moveDeadlineAt || (Date.now() + 20000);
        this.countdownEndsAt = payload.countdownEndsAt || (Date.now() + 3000);
        this.countdownPhaseNumber = 3;
        this.phase = "countdown";

        // Update round score
        this.updateRoundScore();
        this.syncUIWithCombatState();

        // Re-enable move buttons
        this.resetButtonVisuals();
        this.enableMoveButtons();
    }

    private onMoveSubmitted(data: any): void {
        const payload = data as MoveSubmittedPayload;
        const isMyMove = payload.player === this.config.playerRole;
        if (!isMyMove) {
            this.opponentHasSubmitted = true;
            this.turnIndicatorText.setText("Opponent submitted!");
            this.turnIndicatorText.setColor("#22c55e");
        }
    }

    private onMoveConfirmed(data: any): void {
        const payload = data as MoveConfirmedPayload;
        console.log("[FightScene] move_confirmed:", payload);
        const isMyMove = payload.player === this.config.playerRole;
        if (isMyMove) {
            this.hasSubmittedMove = true;
        } else {
            this.opponentHasSubmitted = true;
        }
    }

    private onRoundResolved(data: any): void {
        const payload = data as RoundResolvedPayload;
        console.log("[FightScene] round_resolved:", payload);
        this.phase = "resolving";

        // Disable buttons during resolution
        this.disableMoveButtons();

        // Get moves from payload
        const p1Move = payload.player1.move as MoveType;
        const p2Move = payload.player2.move as MoveType;

        // Play resolution animation
        this.playResolutionAnimation(p1Move, p2Move, payload);
    }

    private onMatchEnded(payload: any): void {
        console.log("[FightScene] match_ended:", payload);
        this.phase = "match_end";
        this.disableMoveButtons();

        // Capture on-chain data from the match_ended event
        if (payload.onChainSessionId) this.onChainSessionId = payload.onChainSessionId;
        if (payload.onChainTxHash) this.onChainTxHash = payload.onChainTxHash;
        if (payload.contractId) this.contractId = payload.contractId;

        const winner = payload.winner;
        const isWinner = winner === this.config.playerRole;

        this.showMatchFlashAndTransition(isWinner, payload);
    }

    private onMatchStarting(payload: any): void {
        console.log("[FightScene] match_starting:", payload);

        // Capture on-chain contract data
        if (payload.onChainSessionId) {
            this.onChainSessionId = payload.onChainSessionId;
            this.showOnChainIndicator();
        }
        if (payload.contractId) this.contractId = payload.contractId;
    }

    private onPlayerDisconnected(payload: any): void {
        this.opponentDisconnected = true;
        this.disconnectTimeoutAt = Date.now() + (payload.timeoutSeconds || 30) * 1000;

        this.disconnectTimerText = TextFactory.createLabel(
            this, GAME_DIMENSIONS.CENTER_X, 60, "Opponent disconnected...", {
            fontSize: "16px", color: "#ff4444",
        }
        ).setOrigin(0.5);
    }

    private onPlayerReconnected(_payload: any): void {
        this.opponentDisconnected = false;
        this.disconnectTimeoutAt = 0;
        if (this.disconnectTimerText) {
            this.disconnectTimerText.destroy();
            this.disconnectTimerText = undefined;
        }
    }

    private onMoveRejected(payload: any): void {
        if (payload.player !== this.config.playerRole) {
            this.showFloatingText("Opponent rejected tx!", GAME_DIMENSIONS.CENTER_X, 100, "#ff4444");
        }
    }

    private onMatchCancelled(_payload: any): void {
        this.phase = "match_end";
        this.showFloatingText("Match cancelled", GAME_DIMENSIONS.CENTER_X, GAME_DIMENSIONS.CENTER_Y, "#ff4444");
    }

    private onChatMessage(payload: any): void {
        if (payload.sender !== this.config.playerRole) {
            this.showFloatingText(payload.message, GAME_DIMENSIONS.CENTER_X, 120, "#40e0d0");
        }
    }

    private onStickerMessage(payload: any): void {
        // Show sticker above opponent character
        const isOpponent = payload.sender !== this.config.playerRole;
        const sprite = isOpponent
            ? (this.config.playerRole === "player1" ? this.player2Sprite : this.player1Sprite)
            : (this.config.playerRole === "player1" ? this.player1Sprite : this.player2Sprite);

        this.showFloatingText(`[${payload.stickerId}]`, sprite.x, sprite.y - 150, "#ffd700");
    }

    private onFightStateUpdate(payload: any): void {
        // Server-authoritative state sync
        if (payload.update) {
            const u = payload.update;
            if (u.player1Health !== undefined) this.combatEngine.setPlayerHealth("player1", u.player1Health);
            if (u.player2Health !== undefined) this.combatEngine.setPlayerHealth("player2", u.player2Health);
            this.syncUIWithCombatState();
        }
    }

    private onPowerSurgeCards(_payload: any): void {
        // TODO: Show power surge card selection UI
        console.log("[FightScene] Power surge cards received:", _payload);
    }

    private onPowerSurgeSelected(_payload: any): void {
        // TODO: Handle opponent's power surge selection
        console.log("[FightScene] Power surge selected:", _payload);
    }

    // ===========================================================================
    // MOVE SUBMISSION (Stellar signing)
    // ===========================================================================

    private selectMove(move: MoveType): void {
        if (this.phase !== "selecting" || this.hasSubmittedMove) return;

        const state = this.combatEngine.getState();
        const myPlayer = this.config.playerRole;

        // Check stunned
        if (state[myPlayer].isStunned) {
            this.showFloatingText("You are stunned!", GAME_DIMENSIONS.CENTER_X, GAME_DIMENSIONS.HEIGHT - 150, "#ff4444");
            return;
        }

        // Check affordable
        if (!this.combatEngine.canAffordMove(myPlayer, move)) {
            this.showFloatingText("Not enough energy!", GAME_DIMENSIONS.CENTER_X, GAME_DIMENSIONS.HEIGHT - 150, "#ff4444");
            return;
        }

        // Deselect previous
        if (this.selectedMove) {
            this.updateButtonState(this.selectedMove, false);
        }

        this.selectedMove = move;
        this.updateButtonState(move, true);

        // Build and sign move message
        this.submitMoveToServer(move);
    }

    private async submitMoveToServer(move: MoveType): Promise<void> {
        this.hasSubmittedMove = true;
        this.myTimerFrozen = true;
        this.myTimerFrozenAt = Date.now();

        // Disable buttons
        this.disableMoveButtons();

        // Update turn indicator
        this.turnIndicatorText.setText("✓ SUBMITTED — Awaiting opponent...");
        this.turnIndicatorText.setColor("#22c55e");

        // Build message for signing
        const message = buildMoveMessage(
            this.config.matchId,
            this.currentRound,
            move
        );

        // Emit move to server via EventBus → useGameChannel
        EventBus.emit("fight:submitMove", {
            matchId: this.config.matchId,
            roundNumber: this.currentRound,
            turnNumber: this.currentTurn,
            move,
            message,
            playerRole: this.config.playerRole,
            playerAddress: this.config.playerRole === "player1"
                ? this.config.player1Address
                : this.config.player2Address,
        });
    }

    private onTimerExpired(): void {
        if (this.hasSubmittedMove) return;

        // Auto-submit random move
        const moves: MoveType[] = ["punch", "kick", "block", "special"];
        const randomMove = moves[Math.floor(Math.random() * moves.length)];
        console.log("[FightScene] Timer expired, auto-submitting:", randomMove);
        this.selectMove(randomMove);
    }

    // ===========================================================================
    // RESOLUTION ANIMATION
    // ===========================================================================

    private playResolutionAnimation(
        p1Move: MoveType,
        p2Move: MoveType,
        payload: RoundResolvedPayload
    ): void {
        const p1Char = this.player1Character.id;
        const p2Char = this.player2Character.id;

        // Show narrative text
        if (payload.narrative) {
            this.showNarrative(payload.narrative);
        }

        // Animate both characters moving to center
        const centerX = GAME_DIMENSIONS.CENTER_X;
        const p1OrigX = CHARACTER_POSITIONS.PLAYER1.X;
        const p2OrigX = CHARACTER_POSITIONS.PLAYER2.X;

        // Run to center
        this.playCharacterAnim(this.player1Sprite, p1Char, "run");
        this.playCharacterAnim(this.player2Sprite, p2Char, "run");

        this.tweens.add({
            targets: this.player1Sprite,
            x: centerX - 80,
            duration: 600,
            ease: "Power2",
        });

        this.tweens.add({
            targets: this.player2Sprite,
            x: centerX + 80,
            duration: 600,
            ease: "Power2",
            onComplete: () => {
                // Play attack animations
                this.playCharacterAnim(this.player1Sprite, p1Char, p1Move === "block" ? "block" : p1Move);
                this.playCharacterAnim(this.player2Sprite, p2Char, p2Move === "block" ? "block" : p2Move);

                // Apply damage after attack frames
                this.time.delayedCall(800, () => {
                    // Update health from server data
                    this.combatEngine.setPlayerHealth("player1", payload.player1.healthAfter);
                    this.combatEngine.setPlayerHealth("player2", payload.player2.healthAfter);

                    // Update energy & guard
                    if (payload.player1.energyAfter !== undefined) {
                        this.combatEngine.setPlayerEnergy("player1", payload.player1.energyAfter);
                    }
                    if (payload.player2.energyAfter !== undefined) {
                        this.combatEngine.setPlayerEnergy("player2", payload.player2.energyAfter);
                    }

                    this.syncUIWithCombatState();

                    // Show damage numbers
                    if (payload.player1.damageDealt > 0) {
                        this.showFloatingText(
                            `-${payload.player1.damageDealt}`,
                            this.player2Sprite.x, this.player2Sprite.y - 80, "#ff4444"
                        );
                    }
                    if (payload.player2.damageDealt > 0) {
                        this.showFloatingText(
                            `-${payload.player2.damageDealt}`,
                            this.player1Sprite.x, this.player1Sprite.y - 80, "#ff4444"
                        );
                    }
                });

                // Run back after animations
                this.time.delayedCall(1200, () => {
                    this.playCharacterAnim(this.player1Sprite, p1Char, "run");
                    this.playCharacterAnim(this.player2Sprite, p2Char, "run");

                    this.tweens.add({
                        targets: this.player1Sprite,
                        x: p1OrigX,
                        duration: 600,
                        ease: "Power2",
                    });

                    this.tweens.add({
                        targets: this.player2Sprite,
                        x: p2OrigX,
                        duration: 600,
                        ease: "Power2",
                        onComplete: () => {
                            // Back to idle
                            this.playCharacterAnim(this.player1Sprite, p1Char, "idle");
                            this.playCharacterAnim(this.player2Sprite, p2Char, "idle");

                            // Handle round/match end
                            if (payload.isMatchOver) {
                                // match_ended event will fire separately
                            } else if (payload.isRoundOver) {
                                this.phase = "round_end";
                                this.showRoundResult(payload.roundWinner);
                            }
                            // If neither, server will send next round_starting
                        },
                    });
                });
            },
        });
    }

    // ===========================================================================
    // UI CREATION (mirrors PracticeScene)
    // ===========================================================================

    private createBackground(): void {
        if (this.textures.exists("arena-bg")) {
            const bg = this.add.image(GAME_DIMENSIONS.CENTER_X, GAME_DIMENSIONS.CENTER_Y, "arena-bg");
            bg.setDisplaySize(GAME_DIMENSIONS.WIDTH, GAME_DIMENSIONS.HEIGHT);
        } else {
            const graphics = this.add.graphics();
            graphics.fillGradientStyle(0x0a0a0a, 0x0a0a0a, 0x1a1a2e, 0x1a1a2e, 1);
            graphics.fillRect(0, 0, GAME_DIMENSIONS.WIDTH, GAME_DIMENSIONS.HEIGHT);
        }
    }

    private createCharacterSprites(): void {
        const p1Char = this.player1Character.id;
        const p2Char = this.player2Character.id;

        const p1TextureKey = `char_${p1Char}_idle`;
        const p1YOffset = getCharacterYOffset(p1Char, "idle");
        this.player1Sprite = this.add.sprite(
            CHARACTER_POSITIONS.PLAYER1.X,
            CHARACTER_POSITIONS.PLAYER1.Y - 50 + p1YOffset,
            p1TextureKey
        );
        this.player1Sprite.setScale(getCharacterScale(p1Char));
        this.player1Sprite.setOrigin(0.5, 0.5);
        if (this.anims.exists(`${p1Char}_idle`)) {
            this.player1Sprite.play(`${p1Char}_idle`);
        }

        const p2TextureKey = `char_${p2Char}_idle`;
        const p2YOffset = getCharacterYOffset(p2Char, "idle");
        this.player2Sprite = this.add.sprite(
            CHARACTER_POSITIONS.PLAYER2.X,
            CHARACTER_POSITIONS.PLAYER2.Y - 50 + p2YOffset,
            p2TextureKey
        );
        this.player2Sprite.setScale(getCharacterScale(p2Char));
        this.player2Sprite.setOrigin(0.5, 0.5);
        this.player2Sprite.setFlipX(true);
        if (this.anims.exists(`${p2Char}_idle`)) {
            this.player2Sprite.play(`${p2Char}_idle`);
        }

        this.createPlayerIndicator();
    }

    private createPlayerIndicator(): void {
        const mySprite = this.config.playerRole === "player1" ? this.player1Sprite : this.player2Sprite;
        const x = mySprite.x;
        const y = mySprite.y - 160;
        const container = this.add.container(x, y);

        const text = this.add.text(0, 0, "YOU", {
            fontFamily: "monospace", fontSize: "14px", color: "#22c55e",
            fontStyle: "bold", backgroundColor: "#00000080", padding: { x: 4, y: 2 },
        }).setOrigin(0.5);

        const arrow = TextFactory.createLabel(this, 0, 20, "▼", {
            fontSize: "14px", color: "#22c55e",
        }).setOrigin(0.5);

        container.add([text, arrow]);
        this.tweens.add({
            targets: container, y: y - 10, duration: 1000,
            yoyo: true, repeat: -1, ease: "Sine.easeInOut",
        });
    }

    private createHealthBars(): void {
        const barWidth = UI_POSITIONS.HEALTH_BAR.PLAYER1.WIDTH;
        const barHeight = 25;

        this.createHealthBar(UI_POSITIONS.HEALTH_BAR.PLAYER1.X, UI_POSITIONS.HEALTH_BAR.PLAYER1.Y, barWidth, barHeight, "player1");
        this.createHealthBar(UI_POSITIONS.HEALTH_BAR.PLAYER2.X, UI_POSITIONS.HEALTH_BAR.PLAYER2.Y, barWidth, barHeight, "player2");

        const state = this.combatEngine.getState();
        const isP1 = this.config.playerRole === "player1";

        // P1 label — highlight if it's local player
        const p1Label = isP1
            ? `P1 (YOU): ${state.player1.characterId.toUpperCase()} (${state.player1.maxHp} HP)`
            : `P1: ${state.player1.characterId.toUpperCase()} (${state.player1.maxHp} HP)`;
        this.add.text(UI_POSITIONS.HEALTH_BAR.PLAYER1.X, UI_POSITIONS.HEALTH_BAR.PLAYER1.Y - 18,
            p1Label,
            {
                fontFamily: "monospace", fontSize: "12px",
                color: isP1 ? "#22c55e" : "#40e0d0",
                fontStyle: isP1 ? "bold" : "normal",
            }
        );

        // P2 label — highlight if it's local player
        const p2Label = !isP1
            ? `P2 (YOU): ${state.player2.characterId.toUpperCase()} (${state.player2.maxHp} HP)`
            : `P2: ${state.player2.characterId.toUpperCase()} (${state.player2.maxHp} HP)`;
        this.add.text(UI_POSITIONS.HEALTH_BAR.PLAYER2.X + barWidth, UI_POSITIONS.HEALTH_BAR.PLAYER2.Y - 18,
            p2Label,
            {
                fontFamily: "monospace", fontSize: "12px",
                color: !isP1 ? "#22c55e" : "#40e0d0",
                fontStyle: !isP1 ? "bold" : "normal",
            }
        ).setOrigin(1, 0);
    }

    private createHealthBar(x: number, y: number, width: number, height: number, player: "player1" | "player2"): void {
        const graphics = this.add.graphics();
        graphics.fillStyle(0x333333, 1);
        graphics.fillRoundedRect(x, y, width, height, 4);
        graphics.lineStyle(2, 0x40e0d0, 1);
        graphics.strokeRoundedRect(x, y, width, height, 4);

        const healthGraphics = this.add.graphics();
        if (player === "player1") this.player1HealthBar = healthGraphics;
        else this.player2HealthBar = healthGraphics;
    }

    private createEnergyBars(): void {
        const barWidth = UI_POSITIONS.HEALTH_BAR.PLAYER1.WIDTH;
        const barHeight = 12;
        const yOffset = 30;

        this.createEnergyBar(UI_POSITIONS.HEALTH_BAR.PLAYER1.X, UI_POSITIONS.HEALTH_BAR.PLAYER1.Y + yOffset, barWidth, barHeight, "player1");
        this.createEnergyBar(UI_POSITIONS.HEALTH_BAR.PLAYER2.X, UI_POSITIONS.HEALTH_BAR.PLAYER2.Y + yOffset, barWidth, barHeight, "player2");

        // "EN" labels
        this.add.text(UI_POSITIONS.HEALTH_BAR.PLAYER1.X - 22, UI_POSITIONS.HEALTH_BAR.PLAYER1.Y + yOffset, "EN", {
            fontFamily: "monospace", fontSize: "10px", color: "#3b82f6",
        });
        this.add.text(UI_POSITIONS.HEALTH_BAR.PLAYER2.X + barWidth + 4, UI_POSITIONS.HEALTH_BAR.PLAYER2.Y + yOffset, "EN", {
            fontFamily: "monospace", fontSize: "10px", color: "#3b82f6",
        });
    }

    private createEnergyBar(x: number, y: number, width: number, height: number, player: "player1" | "player2"): void {
        const bg = this.add.graphics();
        bg.fillStyle(0x222222, 1);
        bg.fillRoundedRect(x, y, width, height, 2);
        bg.lineStyle(1, 0x3b82f6, 0.5);
        bg.strokeRoundedRect(x, y, width, height, 2);

        const energyGraphics = this.add.graphics();
        if (player === "player1") this.player1EnergyBar = energyGraphics;
        else this.player2EnergyBar = energyGraphics;
    }

    private createGuardMeters(): void {
        const barWidth = UI_POSITIONS.HEALTH_BAR.PLAYER1.WIDTH;
        const barHeight = 6;
        const yOffset = 45;

        this.createGuardMeter(UI_POSITIONS.HEALTH_BAR.PLAYER1.X, UI_POSITIONS.HEALTH_BAR.PLAYER1.Y + yOffset, barWidth, barHeight, "player1");
        this.createGuardMeter(UI_POSITIONS.HEALTH_BAR.PLAYER2.X, UI_POSITIONS.HEALTH_BAR.PLAYER2.Y + yOffset, barWidth, barHeight, "player2");
    }

    private createGuardMeter(x: number, y: number, width: number, height: number, player: "player1" | "player2"): void {
        const bg = this.add.graphics();
        bg.fillStyle(0x111111, 1);
        bg.fillRect(x, y, width, height);

        const guardGraphics = this.add.graphics();
        if (player === "player1") this.player1GuardMeter = guardGraphics;
        else this.player2GuardMeter = guardGraphics;
    }

    private createRoundTimer(): void {
        const timerBg = this.add.graphics();
        timerBg.fillStyle(0x1a1a2e, 0.9);
        timerBg.fillCircle(UI_POSITIONS.TIMER.X, UI_POSITIONS.TIMER.Y, 35);
        timerBg.lineStyle(3, 0x40e0d0, 1);
        timerBg.strokeCircle(UI_POSITIONS.TIMER.X, UI_POSITIONS.TIMER.Y, 35);

        this.roundTimerText = TextFactory.createTimer(this, UI_POSITIONS.TIMER.X, UI_POSITIONS.TIMER.Y, "20").setOrigin(0.5);
    }

    private createRoundScore(): void {
        const roundsToWin = this.config.matchFormat === "best_of_5" ? 3 : 2;
        this.roundScoreText = TextFactory.createScore(
            this, UI_POSITIONS.ROUND_INDICATOR.X, UI_POSITIONS.ROUND_INDICATOR.Y,
            `Round 1  •  0 - 0  (First to ${roundsToWin})`
        ).setOrigin(0.5);
    }

    private createMoveButtons(): void {
        const moves: MoveType[] = ["punch", "kick", "block", "special"];
        const buttonWidth = 140;
        const buttonHeight = 160;
        const spacing = 20;
        const totalWidth = moves.length * buttonWidth + (moves.length - 1) * spacing;
        const startX = (GAME_DIMENSIONS.WIDTH - totalWidth) / 2 + buttonWidth / 2;
        const y = GAME_DIMENSIONS.HEIGHT - 100;

        TextFactory.createSubtitle(this, GAME_DIMENSIONS.CENTER_X, y - 95, "YOUR MOVE")
            .setOrigin(0.5).setColor("#40e0d0");

        moves.forEach((move, index) => {
            const x = startX + index * (buttonWidth + spacing);
            const button = this.createMoveButton(x, y, buttonWidth, buttonHeight, move);
            this.moveButtons.set(move, button);
        });
    }

    private createMoveButton(x: number, y: number, width: number, height: number, move: MoveType): Phaser.GameObjects.Container {
        const container = this.add.container(x, y);

        let color = 0xffffff;
        if (move === "punch") color = 0xef4444;
        if (move === "kick") color = 0x06b6d4;
        if (move === "block") color = 0x22c55e;
        if (move === "special") color = 0xa855f7;

        const bg = this.add.graphics();
        bg.fillStyle(0x1a1a2e, 0.9);
        bg.fillRoundedRect(-width / 2, -height / 2, width, height, 12);
        bg.lineStyle(2, color, 0.8);
        bg.strokeRoundedRect(-width / 2, -height / 2, width, height, 12);
        container.add(bg);

        const glow = this.add.graphics();
        glow.fillStyle(color, 0.1);
        glow.fillRoundedRect(-width / 2 + 5, -height / 2 + 5, width - 10, height - 10, 8);
        container.add(glow);

        const iconKey = `move_${move}`;
        const icon = this.add.image(0, -20, iconKey);
        icon.setDisplaySize(64, 64);
        container.add(icon);

        const nameText = this.add.text(0, 25, move.toUpperCase(), {
            fontFamily: "monospace", fontSize: "16px", color: "#ffffff", fontStyle: "bold",
        }).setOrigin(0.5);
        container.add(nameText);

        const cost = BASE_MOVE_STATS[move].energyCost;
        const costColor = cost === 0 ? "#22c55e" : "#3b82f6";
        const costText = this.add.text(0, 48, `${cost} Energy`, {
            fontFamily: "monospace", fontSize: "12px", color: costColor,
        }).setOrigin(0.5);
        container.add(costText);

        // Advantage text (what this move beats)
        const advantages: Record<string, string> = {
            punch: "Beats Kick",
            kick: "Beats Block",
            block: "Beats Punch",
            special: "Beats P+K",
        };
        const advantageText = this.add.text(0, 65, advantages[move] || "", {
            fontFamily: "monospace", fontSize: "10px", color: "#aaaaaa",
            fontStyle: "italic",
        }).setOrigin(0.5);
        container.add(advantageText);

        const hitArea = new Phaser.Geom.Rectangle(-width / 2, -height / 2, width, height);
        container.setInteractive(hitArea, Phaser.Geom.Rectangle.Contains);

        container.on("pointerdown", () => {
            if (this.phase === "selecting" && !this.hasSubmittedMove) {
                this.playSFX("sfx_click");
                this.selectMove(move);
            }
        });

        container.on("pointerover", () => {
            if (this.phase === "selecting" && !this.hasSubmittedMove) {
                this.playSFX("sfx_hover");
                this.tweens.add({
                    targets: container, y: y - 10, scaleX: 1.05, scaleY: 1.05,
                    duration: 200, ease: "Back.easeOut",
                });
            }
        });

        container.on("pointerout", () => {
            if (this.selectedMove !== move) {
                this.tweens.add({
                    targets: container, y, scaleX: 1, scaleY: 1,
                    duration: 200, ease: "Power2",
                });
            }
        });

        return container;
    }

    private createNarrativeDisplay(): void {
        this.narrativeText = TextFactory.createLabel(
            this, GAME_DIMENSIONS.CENTER_X, GAME_DIMENSIONS.CENTER_Y - 80, "", {
            fontSize: "18px", color: "#ffffff",
        }
        ).setOrigin(0.5).setAlpha(0);
    }

    private createTurnIndicator(): void {
        this.turnIndicatorText = TextFactory.createLabel(
            this, GAME_DIMENSIONS.CENTER_X, 130, "Select your move!", {
            fontSize: "14px", color: "#40e0d0",
        }
        ).setOrigin(0.5);
    }

    private createCountdownOverlay(): void {
        this.countdownText = this.add.text(
            GAME_DIMENSIONS.CENTER_X, GAME_DIMENSIONS.CENTER_Y, "", {
            fontFamily: "monospace", fontSize: "72px", color: "#40e0d0",
            fontStyle: "bold", stroke: "#000000", strokeThickness: 6,
        }
        ).setOrigin(0.5).setAlpha(0).setDepth(100);
    }

    private createSettingsButton(): void {
        const x = 50;
        const y = GAME_DIMENSIONS.HEIGHT - 50;
        const radius = 24;

        // Circle background
        const bg = this.add.graphics();
        bg.fillStyle(0x1a1a2e, 0.9);
        bg.fillCircle(x, y, radius);
        bg.lineStyle(2, 0x40e0d0, 0.5);
        bg.strokeCircle(x, y, radius);

        const btn = this.add.text(x, y, "⚙", {
            fontFamily: "monospace", fontSize: "24px", color: "#40e0d0",
        }).setOrigin(0.5);

        const hitArea = new Phaser.Geom.Circle(x, y, radius);
        bg.setInteractive(hitArea, Phaser.Geom.Circle.Contains);

        bg.on("pointerover", () => {
            this.tweens.add({ targets: btn, rotation: 0.3, duration: 300, ease: "Power2" });
        });
        bg.on("pointerout", () => {
            this.tweens.add({ targets: btn, rotation: 0, duration: 300, ease: "Power2" });
        });
        bg.on("pointerdown", () => {
            this.toggleSettingsMenu();
        });
    }

    private toggleSettingsMenu(): void {
        if (this.isSettingsOpen) {
            this.settingsContainer.setVisible(false);
            this.isSettingsOpen = false;
            return;
        }

        this.isSettingsOpen = true;
        this.settingsContainer.removeAll(true);

        const panelX = 20;
        const panelY = GAME_DIMENSIONS.HEIGHT - 200;
        const panelW = 220;
        const panelH = 140;

        const bg = this.add.graphics();
        bg.fillStyle(0x1a1a2e, 0.95);
        bg.fillRoundedRect(panelX, panelY, panelW, panelH, 10);
        bg.lineStyle(2, 0x40e0d0, 0.5);
        bg.strokeRoundedRect(panelX, panelY, panelW, panelH, 10);
        this.settingsContainer.add(bg);

        // BGM volume label + toggle
        const bgmLabel = this.add.text(panelX + 15, panelY + 15, `BGM: ${this.bgmVolume > 0 ? "ON" : "OFF"}`, {
            fontFamily: "monospace", fontSize: "14px", color: "#40e0d0",
        }).setInteractive({ useHandCursor: true });
        bgmLabel.on("pointerdown", () => {
            this.bgmVolume = this.bgmVolume > 0 ? 0 : 0.3;
            bgmLabel.setText(`BGM: ${this.bgmVolume > 0 ? "ON" : "OFF"}`);
            const bgm = this.sound.get("bgm_fight");
            if (bgm && "setVolume" in bgm) (bgm as Phaser.Sound.WebAudioSound).setVolume(this.bgmVolume);
            try { localStorage.setItem("veilstar_brawl_bgm_volume", this.bgmVolume.toString()); } catch { }
        });
        this.settingsContainer.add(bgmLabel);

        // SFX volume label + toggle
        const sfxLabel = this.add.text(panelX + 15, panelY + 45, `SFX: ${this.sfxVolume > 0 ? "ON" : "OFF"}`, {
            fontFamily: "monospace", fontSize: "14px", color: "#40e0d0",
        }).setInteractive({ useHandCursor: true });
        sfxLabel.on("pointerdown", () => {
            this.sfxVolume = this.sfxVolume > 0 ? 0 : 0.5;
            sfxLabel.setText(`SFX: ${this.sfxVolume > 0 ? "ON" : "OFF"}`);
            try { localStorage.setItem("veilstar_brawl_sfx_volume", this.sfxVolume.toString()); } catch { }
        });
        this.settingsContainer.add(sfxLabel);

        // Forfeit button
        const forfeitBtn = this.add.text(panelX + 15, panelY + 85, "FORFEIT MATCH", {
            fontFamily: "monospace", fontSize: "13px", color: "#ef4444",
            fontStyle: "bold",
        }).setInteractive({ useHandCursor: true });
        forfeitBtn.on("pointerdown", () => {
            this.forfeitMatch();
            this.isSettingsOpen = false;
            this.settingsContainer.setVisible(false);
        });
        this.settingsContainer.add(forfeitBtn);

        // Close button
        const closeBtn = this.add.text(panelX + panelW - 15, panelY + 10, "✕", {
            fontFamily: "monospace", fontSize: "16px", color: "#888888",
        }).setOrigin(1, 0).setInteractive({ useHandCursor: true });
        closeBtn.on("pointerdown", () => {
            this.isSettingsOpen = false;
            this.settingsContainer.setVisible(false);
        });
        this.settingsContainer.add(closeBtn);

        this.settingsContainer.setVisible(true);
        this.settingsContainer.setDepth(200);
    }

    // ===========================================================================
    // UI HELPERS
    // ===========================================================================

    private syncUIWithCombatState(): void {
        const state = this.combatEngine.getState();
        this.updateHealthBar("player1", state.player1.hp, state.player1.maxHp);
        this.updateHealthBar("player2", state.player2.hp, state.player2.maxHp);
        this.updateEnergyBar("player1", state.player1.energy, state.player1.maxEnergy);
        this.updateEnergyBar("player2", state.player2.energy, state.player2.maxEnergy);
        this.updateGuardMeter("player1", state.player1.guardMeter, 100);
        this.updateGuardMeter("player2", state.player2.guardMeter, 100);
    }

    private updateHealthBar(player: "player1" | "player2", hp: number, maxHp: number): void {
        const bar = player === "player1" ? this.player1HealthBar : this.player2HealthBar;
        if (!bar) return;
        const pos = player === "player1" ? UI_POSITIONS.HEALTH_BAR.PLAYER1 : UI_POSITIONS.HEALTH_BAR.PLAYER2;
        const width = pos.WIDTH;
        const pct = Math.max(0, hp / maxHp);
        const fillW = width * pct;
        const color = pct > 0.5 ? 0x22c55e : pct > 0.25 ? 0xf59e0b : 0xef4444;

        bar.clear();
        bar.fillStyle(color, 1);
        bar.fillRoundedRect(pos.X, pos.Y, fillW, 25, 4);
    }

    private updateEnergyBar(player: "player1" | "player2", energy: number, maxEnergy: number): void {
        const bar = player === "player1" ? this.player1EnergyBar : this.player2EnergyBar;
        if (!bar) return;
        const pos = player === "player1" ? UI_POSITIONS.HEALTH_BAR.PLAYER1 : UI_POSITIONS.HEALTH_BAR.PLAYER2;
        const width = pos.WIDTH;
        const pct = Math.max(0, energy / maxEnergy);
        const fillW = width * pct;

        bar.clear();
        bar.fillStyle(0x3b82f6, 1);
        bar.fillRoundedRect(pos.X, pos.Y + 30, fillW, 12, 2);
    }

    private updateGuardMeter(player: "player1" | "player2", guard: number, maxGuard: number): void {
        const bar = player === "player1" ? this.player1GuardMeter : this.player2GuardMeter;
        if (!bar) return;
        const pos = player === "player1" ? UI_POSITIONS.HEALTH_BAR.PLAYER1 : UI_POSITIONS.HEALTH_BAR.PLAYER2;
        const width = pos.WIDTH;
        const pct = Math.max(0, guard / maxGuard);
        const fillW = width * pct;

        bar.clear();
        bar.fillStyle(0xfbbf24, 1);
        bar.fillRect(pos.X, pos.Y + 45, fillW, 6);
    }

    private updateRoundScore(): void {
        if (!this.roundScoreText) return;
        const state = this.combatEngine.getState();
        const roundsToWin = this.config.matchFormat === "best_of_5" ? 3 : 2;
        this.roundScoreText.setText(
            `Round ${this.currentRound}  •  ${state.player1.roundsWon} - ${state.player2.roundsWon}  (First to ${roundsToWin})`
        );
    }

    private startSelectionPhase(): void {
        this.phase = "selecting";
        this.enableMoveButtons();
        this.turnIndicatorText.setText("Select your move!");
        this.turnIndicatorText.setColor("#40e0d0");
    }

    private enableMoveButtons(): void {
        const myPlayer = this.config.playerRole;
        this.moveButtons.forEach((btn, move) => {
            const canAfford = this.combatEngine.canAffordMove(myPlayer, move);
            btn.setAlpha(canAfford ? 1 : 0.3);
            if (canAfford) btn.setInteractive();
            else btn.disableInteractive();
        });
    }

    private disableMoveButtons(): void {
        this.moveButtons.forEach((btn) => {
            btn.setAlpha(0.4);
            btn.disableInteractive();
        });
    }

    private resetButtonVisuals(): void {
        const y = GAME_DIMENSIONS.HEIGHT - 100;
        const moves: MoveType[] = ["punch", "kick", "block", "special"];

        moves.forEach((move) => {
            const button = this.moveButtons.get(move);
            if (!button) return;
            this.tweens.add({ targets: button, alpha: 1, scaleX: 1, scaleY: 1, y, duration: 200, ease: "Power2" });
        });
    }

    private updateButtonState(selectedMove: MoveType | null, isSelected: boolean): void {
        const moves: MoveType[] = ["punch", "kick", "block", "special"];
        moves.forEach((move) => {
            const button = this.moveButtons.get(move);
            if (!button) return;
            if (move === selectedMove && isSelected) {
                this.tweens.add({
                    targets: button, alpha: 1, scaleX: 1.1, scaleY: 1.1,
                    y: GAME_DIMENSIONS.HEIGHT - 110, duration: 200, ease: "Back.easeOut",
                });
            } else {
                this.tweens.add({
                    targets: button, alpha: isSelected ? 0.5 : 1, scaleX: 1, scaleY: 1,
                    y: GAME_DIMENSIONS.HEIGHT - 100, duration: 200, ease: "Power2",
                });
            }
        });
    }

    private showNarrative(text: string): void {
        this.narrativeText.setText(text);
        this.narrativeText.setAlpha(1);
        if (this.narrativeTimer) this.narrativeTimer.destroy();
        this.narrativeTimer = this.time.delayedCall(3000, () => {
            this.tweens.add({ targets: this.narrativeText, alpha: 0, duration: 500 });
        });
    }

    private showFloatingText(text: string, x: number, y: number, color: string): void {
        const floatText = TextFactory.createLabel(this, x, y, text, {
            fontSize: "18px", color, fontStyle: "bold",
        }).setOrigin(0.5).setDepth(200);

        this.tweens.add({
            targets: floatText, y: y - 60, alpha: 0, duration: 1500,
            ease: "Power2", onComplete: () => floatText.destroy(),
        });
    }

    private playCharacterAnim(sprite: Phaser.GameObjects.Sprite, charId: string, anim: string): void {
        const animKey = `${charId}_${anim}`;
        if (this.anims.exists(animKey)) {
            sprite.play(animKey, true);
        }
    }

    private showRoundResult(winner: string): void {
        const isMyWin = winner === this.config.playerRole;
        const text = winner === "draw" ? "DRAW!" : isMyWin ? "ROUND WON!" : "ROUND LOST!";
        const color = winner === "draw" ? "#ffd700" : isMyWin ? "#22c55e" : "#ef4444";

        this.countdownText.setText(text);
        this.countdownText.setFontSize(48);
        this.countdownText.setColor(color);
        this.countdownText.setAlpha(1);

        this.tweens.add({
            targets: this.countdownText,
            scale: { from: 1.5, to: 1 }, alpha: { from: 1, to: 0 },
            duration: 2000, ease: "Power2",
        });
    }

    private showMatchFlashAndTransition(isWinner: boolean, payload: any): void {
        const text = isWinner ? "VICTORY!" : "DEFEAT!";
        const color = isWinner ? "#F0B71F" : "#ef4444";

        // Full-screen overlay flash
        const overlay = this.add.graphics();
        overlay.fillStyle(0x000000, 0.7);
        overlay.fillRect(0, 0, GAME_DIMENSIONS.WIDTH, GAME_DIMENSIONS.HEIGHT);
        overlay.setDepth(300);

        const flashText = this.add.text(GAME_DIMENSIONS.CENTER_X, GAME_DIMENSIONS.CENTER_Y, text, {
            fontFamily: "Orbitron, monospace", fontSize: "80px", color, fontStyle: "bold",
            stroke: "#000000", strokeThickness: 8,
        }).setOrigin(0.5).setDepth(301).setScale(0.5).setAlpha(0);

        this.tweens.add({
            targets: flashText,
            alpha: 1,
            scale: 1.2,
            duration: 600,
            ease: "Back.out",
            onComplete: () => {
                this.tweens.add({
                    targets: flashText,
                    scale: 1,
                    duration: 300,
                    ease: "Power2",
                });
            },
        });

        // Transition to ResultsScene after a brief delay
        this.time.delayedCall(2500, () => {
            // Emit to React layer for cleanup
            EventBus.emit("fight:matchResult", { isWinner, ...payload });

            this.scene.start("ResultsScene", {
                isWinner,
                playerRole: this.config.playerRole,
                matchId: this.config.matchId,
                player1RoundsWon: payload.player1RoundsWon ?? 0,
                player2RoundsWon: payload.player2RoundsWon ?? 0,
                reason: payload.reason,
                ratingChanges: payload.ratingChanges,
                onChainSessionId: payload.onChainSessionId ?? this.onChainSessionId,
                onChainTxHash: payload.onChainTxHash ?? this.onChainTxHash,
                contractId: payload.contractId ?? this.contractId,
            });
        });
    }

    private handleDisconnectTimeout(): void {
        this.opponentDisconnected = false;
        this.disconnectTimeoutAt = 0;
        // Server should handle forfeit — just show message
        this.showFloatingText("Opponent forfeited!", GAME_DIMENSIONS.CENTER_X, GAME_DIMENSIONS.CENTER_Y, "#22c55e");
    }

    private showOnChainIndicator(): void {
        if (this.onChainIndicatorText) return; // Already shown

        const label = `⛓ On-Chain Session #${this.onChainSessionId}`;
        this.onChainIndicatorText = this.add.text(GAME_DIMENSIONS.WIDTH - 15, GAME_DIMENSIONS.HEIGHT - 15, label, {
            fontFamily: "monospace", fontSize: "10px", color: "#22c55e",
            backgroundColor: "#00000080", padding: { x: 6, y: 3 },
        }).setOrigin(1, 1).setDepth(50).setAlpha(0.7);
    }

    // ===========================================================================
    // AUDIO
    // ===========================================================================

    private loadAudioSettings(): void {
        try {
            const savedBgm = localStorage.getItem("veilstar_brawl_bgm_volume");
            const savedSfx = localStorage.getItem("veilstar_brawl_sfx_volume");
            if (savedBgm !== null) this.bgmVolume = parseFloat(savedBgm);
            if (savedSfx !== null) this.sfxVolume = parseFloat(savedSfx);
        } catch (e) { /* ignore */ }
    }

    private playSFX(key: string): void {
        if (this.game.sound.locked) return;
        try {
            this.sound.play(key, { volume: this.sfxVolume });
            this.time.delayedCall(5000, () => {
                const sound = this.sound.get(key);
                if (sound?.isPlaying) sound.stop();
            });
        } catch (e) {
            console.warn(`Failed to play SFX: ${key}`, e);
        }
    }

    private toggleAudio(): void {
        this.bgmVolume = this.bgmVolume > 0 ? 0 : 0.3;
        this.sfxVolume = this.sfxVolume > 0 ? 0 : 0.5;
        const bgm = this.sound.get("bgm_fight");
        if (bgm && "setVolume" in bgm) {
            (bgm as Phaser.Sound.WebAudioSound).setVolume(this.bgmVolume);
        }
        try {
            localStorage.setItem("veilstar_brawl_bgm_volume", this.bgmVolume.toString());
            localStorage.setItem("veilstar_brawl_sfx_volume", this.sfxVolume.toString());
        } catch (e) { /* ignore */ }
    }

    private handleShutdown(): void {
        const bgm = this.sound.get("bgm_fight");
        if (bgm?.isPlaying) bgm.stop();
    }

    private forfeitMatch(): void {
        EventBus.emit("fight:forfeit", {
            matchId: this.config.matchId,
            playerRole: this.config.playerRole,
        });
    }
}
