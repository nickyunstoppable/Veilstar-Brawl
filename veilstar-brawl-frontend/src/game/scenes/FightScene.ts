/**
 * FightScene - Online multiplayer fight scene
 * Mirrors PracticeScene UI/UX but with network play via Supabase Realtime
 * Uses Stellar message signing for move verification
 * Implements per-player timers for Stellar transaction latency
 */

import Phaser from "phaser";
import { EventBus } from "@/game/EventBus";
import { GAME_DIMENSIONS, CHARACTER_POSITIONS, UI_POSITIONS } from "@/game/config";
import { getCharacterScale, getCharacterYOffset, getSFXKey, getSoundDelay } from "@/game/config/sprite-config";
import { CombatEngine, BASE_MOVE_STATS } from "@/game/combat";
import { calculateSurgeEffects, shouldStunOpponent } from "@/game/combat/SurgeEffects";
import { TextFactory } from "@/game/ui/TextFactory";
import { OnlinePowerSurgeCards } from "../ui/OnlinePowerSurgeCards";
import type { PowerSurgeCardId } from "@/types/power-surge";
import type { FightStateBroadcast } from "@/types/fight-state";
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

const API_BASE = import.meta.env.VITE_API_BASE_URL || "";

function coerceTimestampMs(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
    if (typeof value === "string") {
        const ts = new Date(value).getTime();
        if (!Number.isNaN(ts) && Number.isFinite(ts) && ts > 0) return ts;
        const asNumber = Number(value);
        if (Number.isFinite(asNumber) && asNumber > 0) return asNumber;
    }
    return null;
}

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
    private stunnedAutoSubmitAt: number = 0;
    private bothStunnedSkipAt: number = 0;

    // Deduplicate countdown / round starts (prevents double countdown on duplicate events)
    private lastCountdownStartedForTurn: string = "";

    // Pending round start payload (queued if received while resolving/round_end)
    private pendingRoundStart: any | null = null;

    // If we get fight_state_update during resolving, queue it to apply after animations
    private pendingFightStateUpdate: any | null = null;

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
    private disconnectOverlay?: Phaser.GameObjects.Container;

    // Visibility change handler (tab switch fast-forward)
    private visibilityChangeHandler?: () => void;

    // Power surge
    private activeSurges: {
        player1: PowerSurgeCardId | null;
        player2: PowerSurgeCardId | null;
    } = { player1: null, player2: null };
    private powerSurgeUI?: OnlinePowerSurgeCards;
    private surgeSelectionDeadlineAt: number = 0;
    private startSelectionAfterSurge: boolean = false;
    private lastSurgeRoundShown: number = 0;
    private stunTweens: Map<"player1" | "player2", Phaser.Tweens.Tween> = new Map();

    // Audio settings
    private bgmVolume: number = 0.3;
    private sfxVolume: number = 0.5;

    // Settings menu
    private settingsContainer!: Phaser.GameObjects.Container;
    private isSettingsOpen: boolean = false;
    private bgmSlider?: Phaser.GameObjects.Container;
    private sfxSlider?: Phaser.GameObjects.Container;
    private activeDialog?: Phaser.GameObjects.Container;
    private activeDialogBlocker?: Phaser.GameObjects.Rectangle;

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

        this.stunnedAutoSubmitAt = 0;
        this.bothStunnedSkipAt = 0;
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
        this.powerSurgeUI?.destroy();
        this.powerSurgeUI = undefined;
        this.surgeSelectionDeadlineAt = 0;
        this.startSelectionAfterSurge = false;
        this.lastSurgeRoundShown = 0;
        this.lastCountdownStartedForTurn = "";
        this.pendingRoundStart = null;
        this.pendingFightStateUpdate = null;
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
        this.createSettingsButton();
        this.createSettingsMenu();

        // Setup network event listeners
        this.setupEventListeners();

        // Fast-forward / catch-up on tab focus
        this.setupVisibilityChangeHandler();

        // Initial server-authoritative catch-up (important if first broadcast fired
        // before FightScene listeners were attached).
        this.fetchAndApplyServerSnapshot().catch((err) => {
            console.warn("[FightScene] Initial snapshot sync failed:", err);
        });

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
            const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1000));

            // When countdown hits 0, show FIGHT briefly, then enter selection
            if (remainingMs <= 0) {
                if (this.countdownPhaseNumber !== -1) {
                    this.countdownPhaseNumber = -1;
                    this.countdownText.setText("FIGHT!");
                    this.countdownText.setAlpha(1);
                    this.countdownText.setScale(1);
                    this.tweens.killTweensOf(this.countdownText);
                    this.tweens.add({
                        targets: this.countdownText,
                        scale: { from: 1.25, to: 1 },
                        alpha: { from: 1, to: 0.85 },
                        duration: 400,
                        ease: "Power2",
                    });
                }

                // Allow a small delay so the player actually sees FIGHT
                if (now >= this.countdownEndsAt + 500) {
                    this.countdownText.setAlpha(0);
                    this.countdownEndsAt = 0;

                    // If Power Surge selection is open, delay move selection until it completes.
                    if (this.powerSurgeUI) {
                        this.startSelectionAfterSurge = true;
                    } else {
                        this.startSelectionPhase();
                    }
                }
            } else {
                // Display 3-2-1 based on remainingSeconds
                if (remainingSeconds !== this.countdownPhaseNumber && remainingSeconds <= 3) {
                    this.countdownPhaseNumber = remainingSeconds;
                    this.countdownText.setText(remainingSeconds.toString());
                    this.countdownText.setAlpha(1);
                    this.tweens.killTweensOf(this.countdownText);
                    this.tweens.add({
                        targets: this.countdownText,
                        scale: { from: 1.5, to: 1 },
                        alpha: { from: 1, to: 0.6 },
                        duration: 800,
                        ease: "Power2",
                    });
                }
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

        // === STUNNED AUTO-SUBMIT / BOTH-STUNNED SKIP ===
        if (this.stunnedAutoSubmitAt > 0 && now >= this.stunnedAutoSubmitAt) {
            this.stunnedAutoSubmitAt = 0;
            this.handleStunnedAutoSubmit();
        }

        if (this.bothStunnedSkipAt > 0 && now >= this.bothStunnedSkipAt) {
            this.bothStunnedSkipAt = 0;
            this.handleBothStunnedSkip();
        }

        // === ROUND END COUNTDOWN ===
        if (this.phase === "round_end" && this.roundEndCountdownEndsAt > 0) {
            const remainingMs = this.roundEndCountdownEndsAt - now;
            const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1000));

            if (remainingMs <= 0) {
                this.roundEndCountdownEndsAt = 0;
                this.processRoundEndCountdownComplete();
            } else {
                this.countdownText.setText(`Next round starting in ${remainingSeconds}`);
                this.countdownText.setFontSize(32);
                this.countdownText.setColor("#40e0d0");
                this.countdownText.setAlpha(1);
            }
        }

        // === DISCONNECT TIMER ===
        if (this.opponentDisconnected && this.disconnectTimeoutAt > 0) {
            const remaining = Math.max(0, Math.ceil((this.disconnectTimeoutAt - now) / 1000));
            if (this.disconnectTimerText) this.disconnectTimerText.setText(`${remaining}s`);
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

        // If we receive a round_starting while still animating round_end/resolving, queue it.
        if (this.phase === "resolving" || this.phase === "round_end") {
            this.pendingRoundStart = payload;
            return;
        }

        const roundNumber = payload?.roundNumber ?? payload?.round_number;
        const turnNumber = payload?.turnNumber ?? payload?.turn_number;

        // Deduplicate countdown - prevent playing the same countdown twice
        const turnKey = `${roundNumber}-${turnNumber}`;
        if (this.lastCountdownStartedForTurn === turnKey) {
            console.log("[FightScene] Ignoring duplicate round_starting for", turnKey);
            return;
        }
        this.lastCountdownStartedForTurn = turnKey;

        this.currentRound = typeof roundNumber === "number" ? roundNumber : 1;
        this.currentTurn = typeof turnNumber === "number" ? turnNumber : 1;
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

        // Optional fields (server may omit in some broadcasts)
        if (payload.player1Energy !== undefined) {
            this.combatEngine.setPlayerEnergy("player1", payload.player1Energy);
        }
        if (payload.player2Energy !== undefined) {
            this.combatEngine.setPlayerEnergy("player2", payload.player2Energy);
        }
        if (payload.player1GuardMeter !== undefined) {
            this.combatEngine.setPlayerGuardMeter("player1", payload.player1GuardMeter);
        }
        if (payload.player2GuardMeter !== undefined) {
            this.combatEngine.setPlayerGuardMeter("player2", payload.player2GuardMeter);
        }
        if (payload.player1IsStunned !== undefined) {
            this.combatEngine.setPlayerStunned("player1", !!payload.player1IsStunned);
            this.toggleStunEffect("player1", !!payload.player1IsStunned);
        }
        if (payload.player2IsStunned !== undefined) {
            this.combatEngine.setPlayerStunned("player2", !!payload.player2IsStunned);
            this.toggleStunEffect("player2", !!payload.player2IsStunned);
        }

        // If the server omitted energy/guard (common on some round_starting broadcasts),
        // fetch the latest fight_state snapshot once to keep UI consistent.
        if (
            API_BASE &&
            (payload.player1Energy === undefined || payload.player2Energy === undefined ||
                payload.player1GuardMeter === undefined || payload.player2GuardMeter === undefined)
        ) {
            this.fetchAndApplyServerSnapshot().catch(() => { });
        }

        // Set up countdown → selection transition
        const moveDeadline = coerceTimestampMs(payload.moveDeadlineAt ?? payload.move_deadline_at);
        const countdownEnds = coerceTimestampMs(payload.countdownEndsAt ?? payload.countdown_ends_at);
        this.moveDeadlineAt = moveDeadline ?? (Date.now() + 20000);
        this.countdownEndsAt = countdownEnds ?? (Date.now() + 3000);
        this.countdownPhaseNumber = 0;
        this.phase = "countdown";
        this.playSFX("sfx_cd_fight");

        // Update round score
        this.updateRoundScore();
        this.syncUIWithCombatState();

        // Re-enable move buttons
        this.resetButtonVisuals();
        this.enableMoveButtons();

        // Power Surge selection (online) — shown at the start of each round (turn 1)
        this.maybeShowPowerSurgeForRound(this.currentRound, this.currentTurn);
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
    this.stunnedAutoSubmitAt = 0;
    this.bothStunnedSkipAt = 0;

        // During resolving, if we receive fight_state_update snapshots, queue them until animation ends
        this.pendingFightStateUpdate = null;

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

        // Sync final round score (server payload may provide either finalScore or flat fields)
        const p1Wins = payload?.finalScore?.player1RoundsWon ?? payload?.player1RoundsWon;
        const p2Wins = payload?.finalScore?.player2RoundsWon ?? payload?.player2RoundsWon;
        if (typeof p1Wins === "number") this.combatEngine.setPlayerRoundsWon("player1", p1Wins);
        if (typeof p2Wins === "number") this.combatEngine.setPlayerRoundsWon("player2", p2Wins);
        this.updateRoundScore();

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

        this.showDisconnectOverlay(payload.timeoutSeconds || 30);
    }

    private onPlayerReconnected(_payload: any): void {
        this.opponentDisconnected = false;
        this.disconnectTimeoutAt = 0;

        this.hideDisconnectOverlay();
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
        // Server-authoritative state sync (may arrive as { update: ... } or as a row-like object)
        // If we're mid-resolution animation, defer applying to avoid showing HP/energy changes early.
        if (this.phase === "resolving") {
            this.pendingFightStateUpdate = payload;
            return;
        }

        this.applyFightStateUpdate(payload);
    }

    private onPowerSurgeCards(_payload: any): void {
        console.log("[FightScene] Power surge cards received:", _payload);

        // Support both broadcast-style payloads and API-driven flow.
        // Expected broadcast payload shape:
        // { roundNumber, deadlineAt, player1Cards: string[], player2Cards: string[] }
        const roundNumber = _payload?.roundNumber;
        const deadlineAt = _payload?.deadlineAt;
        const cards = this.config.playerRole === "player1" ? _payload?.player1Cards : _payload?.player2Cards;

        if (typeof roundNumber !== "number" || !Array.isArray(cards) || cards.length === 0) return;
        if (roundNumber === this.lastSurgeRoundShown) return;

        const deadline = typeof deadlineAt === "number" ? deadlineAt : Date.now() + 10000;
        this.showPowerSurgeModal(roundNumber, cards as PowerSurgeCardId[], deadline);
    }

    private onPowerSurgeSelected(_payload: any): void {
        console.log("[FightScene] Power surge selected:", _payload);

        const player = _payload?.player as ("player1" | "player2" | undefined);
        const roundNumber = _payload?.roundNumber as (number | undefined);
        const cardId = _payload?.cardId as (PowerSurgeCardId | undefined);
        if (!player || !cardId) return;

        // Ignore selections from older rounds
        if (typeof roundNumber === "number" && roundNumber !== this.currentRound) return;

        this.activeSurges[player] = cardId;

        // Update modal state (if open)
        if (this.powerSurgeUI) {
            const isMe = player === this.config.playerRole;
            if (!isMe) {
                this.powerSurgeUI.setOpponentSelection(cardId);
            }
        }

        // If both picks are known, apply immediate effects locally (stun, etc)
        if (this.activeSurges.player1 && this.activeSurges.player2) {
            this.applyImmediateSurgeEffects();
        }
    }

    private async maybeShowPowerSurgeForRound(roundNumber: number, turnNumber: number): Promise<void> {
        // Only show at the start of a round (turn 1)
        if (turnNumber !== 1) return;
        if (roundNumber === this.lastSurgeRoundShown) return;

        // Don't show if already open
        if (this.powerSurgeUI) return;

        const playerAddress = this.config.playerRole === "player1"
            ? this.config.player1Address
            : this.config.player2Address;

        try {
            const base = API_BASE || window.location.origin;
            const url = new URL(`/api/matches/${this.config.matchId}/power-surge/cards`, base);
            url.searchParams.set("address", playerAddress);
            url.searchParams.set("roundNumber", String(roundNumber));

            const res = await fetch(url.toString(), { method: "GET" });
            if (!res.ok) {
                const body = await res.text().catch(() => "");
                console.warn(`[FightScene] Power surge cards request failed (${res.status}):`, body);
                return;
            }
            const data = await res.json();
            const cardIds = data?.cardIds as PowerSurgeCardId[] | undefined;
            const deadlineAt = data?.deadlineAt as number | undefined;
            if (!Array.isArray(cardIds) || cardIds.length === 0) return;

            const deadline = typeof deadlineAt === "number" ? deadlineAt : Date.now() + 10000;
            this.showPowerSurgeModal(roundNumber, cardIds, deadline);
        } catch (e) {
            console.warn("[FightScene] Failed to fetch power surge cards:", e);
        }
    }

    private showPowerSurgeModal(roundNumber: number, cardIds: PowerSurgeCardId[], deadlineAt: number): void {
        this.lastSurgeRoundShown = roundNumber;
        this.surgeSelectionDeadlineAt = deadlineAt;

        // Clear active surges for the new round
        this.activeSurges = { player1: null, player2: null };

        // Prevent move selection until modal completes
        this.disableMoveButtons();

        // Create modal
        this.powerSurgeUI = new OnlinePowerSurgeCards({
            scene: this,
            roundNumber,
            cardIds,
            deadlineAt,
            onCardSelected: (cardId: PowerSurgeCardId) => {
                this.activeSurges[this.config.playerRole] = cardId;
                EventBus.emit("fight:selectPowerSurge", {
                    matchId: this.config.matchId,
                    roundNumber,
                    playerRole: this.config.playerRole,
                    playerAddress: this.config.playerRole === "player1" ? this.config.player1Address : this.config.player2Address,
                    cardId,
                });
            },
            onTimeout: () => {
                const choice = cardIds[Math.floor(Math.random() * cardIds.length)];
                this.activeSurges[this.config.playerRole] = choice;
                EventBus.emit("fight:selectPowerSurge", {
                    matchId: this.config.matchId,
                    roundNumber,
                    playerRole: this.config.playerRole,
                    playerAddress: this.config.playerRole === "player1" ? this.config.player1Address : this.config.player2Address,
                    cardId: choice,
                });
                this.powerSurgeUI?.setPlayerSelection(choice);
            },
            onClose: () => {
                this.powerSurgeUI = undefined;
                this.surgeSelectionDeadlineAt = 0;

                // If countdown already finished while we were picking, start selection now
                if (this.startSelectionAfterSurge) {
                    this.startSelectionAfterSurge = false;
                    this.startSelectionPhase();
                } else {
                    // Otherwise buttons will be enabled when countdown finishes.
                }
            },
        });
    }

    private applyImmediateSurgeEffects(): void {
        const surgeResults = calculateSurgeEffects(this.activeSurges.player1, this.activeSurges.player2);
        const p1Stunned = shouldStunOpponent(surgeResults.player2Modifiers);
        const p2Stunned = shouldStunOpponent(surgeResults.player1Modifiers);

        this.combatEngine.setPlayerStunned("player1", p1Stunned);
        this.combatEngine.setPlayerStunned("player2", p2Stunned);
        this.toggleStunEffect("player1", p1Stunned);
        this.toggleStunEffect("player2", p2Stunned);

        const isP1 = this.config.playerRole === "player1";
        const amIStunned = isP1 ? p1Stunned : p2Stunned;
        const oppStunned = isP1 ? p2Stunned : p1Stunned;

        if (amIStunned && oppStunned) {
            this.turnIndicatorText.setText("BOTH PLAYERS STUNNED!");
            this.turnIndicatorText.setColor("#ff4444");
        } else if (amIStunned) {
            this.turnIndicatorText.setText("YOU ARE STUNNED!");
            this.turnIndicatorText.setColor("#ff4444");
        } else if (oppStunned) {
            this.turnIndicatorText.setText("OPPONENT IS STUNNED!");
            this.turnIndicatorText.setColor("#22c55e");
        }
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
                const animForMove = (move: MoveType): string => {
                    if (move === "block") return "block";
                    if (move === "stunned") return "idle";
                    return move;
                };

                // Play attack animations
                this.playCharacterAnim(this.player1Sprite, p1Char, animForMove(p1Move));
                this.playCharacterAnim(this.player2Sprite, p2Char, animForMove(p2Move));

                // Apply damage after attack frames
                this.time.delayedCall(800, () => {
                    const p1HealthAfter = payload.player1.healthAfter ?? (payload as any).player1HealthAfter;
                    const p2HealthAfter = payload.player2.healthAfter ?? (payload as any).player2HealthAfter;
                    const p1EnergyAfter = payload.player1.energyAfter ?? (payload as any).player1EnergyAfter;
                    const p2EnergyAfter = payload.player2.energyAfter ?? (payload as any).player2EnergyAfter;
                    const p1GuardAfter = (payload.player1 as any).guardMeterAfter ?? (payload as any).player1GuardAfter;
                    const p2GuardAfter = (payload.player2 as any).guardMeterAfter ?? (payload as any).player2GuardAfter;

                    // Update health from server data
                    if (p1HealthAfter !== undefined) this.combatEngine.setPlayerHealth("player1", p1HealthAfter);
                    if (p2HealthAfter !== undefined) this.combatEngine.setPlayerHealth("player2", p2HealthAfter);

                    // Update energy & guard
                    if (p1EnergyAfter !== undefined) this.combatEngine.setPlayerEnergy("player1", p1EnergyAfter);
                    if (p2EnergyAfter !== undefined) this.combatEngine.setPlayerEnergy("player2", p2EnergyAfter);

                    // Guard meter
                    if (p1GuardAfter !== undefined) this.combatEngine.setPlayerGuardMeter("player1", p1GuardAfter);
                    if (p2GuardAfter !== undefined) this.combatEngine.setPlayerGuardMeter("player2", p2GuardAfter);

                    // Stun
                    if ((payload.player1 as any).isStunned !== undefined) {
                        this.combatEngine.setPlayerStunned("player1", !!(payload.player1 as any).isStunned);
                        this.toggleStunEffect("player1", !!(payload.player1 as any).isStunned);
                    }
                    if ((payload.player2 as any).isStunned !== undefined) {
                        this.combatEngine.setPlayerStunned("player2", !!(payload.player2 as any).isStunned);
                        this.toggleStunEffect("player2", !!(payload.player2 as any).isStunned);
                    }

                    this.syncUIWithCombatState();

                    // Show damage numbers
                    if (payload.player1.damageDealt > 0) {
                        this.playHitImpact(this.player2Sprite);
                        this.showFloatingText(
                            `-${payload.player1.damageDealt}`,
                            this.player2Sprite.x, this.player2Sprite.y - 80, "#ff4444"
                        );
                    }
                    if (payload.player2.damageDealt > 0) {
                        this.playHitImpact(this.player1Sprite);
                        this.showFloatingText(
                            `-${payload.player2.damageDealt}`,
                            this.player1Sprite.x, this.player1Sprite.y - 80, "#ff4444"
                        );
                    }

                    const p1HpRegen = (payload.player1 as any).hpRegen ?? 0;
                    const p2HpRegen = (payload.player2 as any).hpRegen ?? 0;
                    const p1Lifesteal = (payload.player1 as any).lifesteal ?? 0;
                    const p2Lifesteal = (payload.player2 as any).lifesteal ?? 0;
                    const p1Drain = (payload.player1 as any).energyDrained ?? 0;
                    const p2Drain = (payload.player2 as any).energyDrained ?? 0;

                    if (p1HpRegen > 0) {
                        this.showFloatingText(`+${p1HpRegen} REGEN`, this.player1Sprite.x, this.player1Sprite.y - 120, "#22c55e");
                    }
                    if (p2HpRegen > 0) {
                        this.showFloatingText(`+${p2HpRegen} REGEN`, this.player2Sprite.x, this.player2Sprite.y - 120, "#22c55e");
                    }
                    if (p1Lifesteal > 0) {
                        this.showFloatingText(`+${p1Lifesteal} LIFESTEAL`, this.player1Sprite.x, this.player1Sprite.y - 145, "#34d399");
                    }
                    if (p2Lifesteal > 0) {
                        this.showFloatingText(`+${p2Lifesteal} LIFESTEAL`, this.player2Sprite.x, this.player2Sprite.y - 145, "#34d399");
                    }
                    if (p1Drain > 0) {
                        this.showFloatingText(`-${p1Drain} EN DRAIN`, this.player1Sprite.x, this.player1Sprite.y - 95, "#60a5fa");
                    }
                    if (p2Drain > 0) {
                        this.showFloatingText(`-${p2Drain} EN DRAIN`, this.player2Sprite.x, this.player2Sprite.y - 95, "#60a5fa");
                    }

                    if (p1Move === "block" && p2Move === "block") {
                        this.showFloatingText("CLASH!", GAME_DIMENSIONS.CENTER_X, GAME_DIMENSIONS.CENTER_Y - 40, "#fbbf24");
                    } else {
                        if (p1Move === "block" && payload.player2.damageDealt <= 0) {
                            this.showFloatingText("BLOCK!", this.player1Sprite.x, this.player1Sprite.y - 95, "#22c55e");
                        }
                        if (p2Move === "block" && payload.player1.damageDealt <= 0) {
                            this.showFloatingText("BLOCK!", this.player2Sprite.x, this.player2Sprite.y - 95, "#22c55e");
                        }
                    }

                    if (payload.player1.damageDealt > 0 || payload.player2.damageDealt > 0) {
                        this.cameras.main.shake(120, 0.004);
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

                            // Apply any deferred fight_state_update snapshot now that animations are done
                            if (this.pendingFightStateUpdate) {
                                this.applyFightStateUpdate(this.pendingFightStateUpdate);
                                this.pendingFightStateUpdate = null;
                            }

                            // Handle round/match end
                            if (payload.isMatchOver) {
                                // match_ended event will fire separately
                            } else if (payload.isRoundOver) {
                                // Track rounds won locally so UI matches server
                                if (payload.roundWinner === "player1") {
                                    const s = this.combatEngine.getState();
                                    this.combatEngine.setPlayerRoundsWon("player1", s.player1.roundsWon + 1);
                                } else if (payload.roundWinner === "player2") {
                                    const s = this.combatEngine.getState();
                                    this.combatEngine.setPlayerRoundsWon("player2", s.player2.roundsWon + 1);
                                }

                                this.phase = "round_end";
                                this.showRoundResult(payload.roundWinner);
                                this.updateRoundScore();
                                this.roundEndCountdownEndsAt = Date.now() + 5000;
                            }
                            // If neither, server will send next round_starting
                        },
                    });
                });
            },
        });
    }

    private applyPendingRoundStartIfAny(): void {
        if (!this.pendingRoundStart) return;
        const next = this.pendingRoundStart;
        this.pendingRoundStart = null;
        this.onRoundStarting(next);
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
        const drawDefaultBg = () => {
            bg.clear();
            bg.fillStyle(0x1a1a2e, 0.9);
            bg.fillRoundedRect(-width / 2, -height / 2, width, height, 12);
            bg.lineStyle(2, color, 0.8);
            bg.strokeRoundedRect(-width / 2, -height / 2, width, height, 12);
        };
        const drawHoverBg = () => {
            bg.clear();
            bg.fillStyle(0x1a1a2e, 0.95);
            bg.fillRoundedRect(-width / 2, -height / 2, width, height, 12);
            bg.lineStyle(3, color, 1);
            bg.strokeRoundedRect(-width / 2, -height / 2, width, height, 12);
        };
        drawDefaultBg();
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
            const canAfford = this.combatEngine.canAffordMove(this.config.playerRole, move);
            if (this.phase === "selecting" && !this.hasSubmittedMove && this.selectedMove !== move && canAfford) {
                this.playSFX("sfx_hover");
                this.tweens.add({
                    targets: container, y: y - 10, scaleX: 1.05, scaleY: 1.05,
                    duration: 200, ease: "Back.easeOut",
                });
                drawHoverBg();
            }
        });

        container.on("pointerout", () => {
            if (this.selectedMove !== move) {
                this.tweens.add({
                    targets: container, y, scaleX: 1, scaleY: 1,
                    duration: 200, ease: "Power2",
                });
                drawDefaultBg();
            }
        });

        return container;
    }

    private createNarrativeDisplay(): void {
        this.narrativeText = TextFactory.createNarrative(
            this,
            GAME_DIMENSIONS.CENTER_X,
            GAME_DIMENSIONS.CENTER_Y - 80,
            ""
        ).setOrigin(0.5).setAlpha(0);
    }

    private createTurnIndicator(): void {
        this.turnIndicatorText = TextFactory.createSubtitle(
            this,
            GAME_DIMENSIONS.CENTER_X,
            130,
            "Select your move!"
        ).setOrigin(0.5);
        this.turnIndicatorText.setColor("#40e0d0");
    }

    private createCountdownOverlay(): void {
        this.countdownText = TextFactory.createTitle(
            this,
            GAME_DIMENSIONS.CENTER_X,
            GAME_DIMENSIONS.CENTER_Y,
            ""
        ).setOrigin(0.5).setAlpha(0).setDepth(100);
        this.countdownText.setColor("#40e0d0");
    }

    // ===========================================================================
    // SETTINGS MENU (KaspaClash-style)
    // ===========================================================================

    private createSettingsButton(): void {
        const radius = 24;
        const x = 50;
        const y = GAME_DIMENSIONS.HEIGHT - 50;

        const container = this.add.container(x, y);
        container.setDepth(2000);

        const circle = this.add.graphics();
        circle.fillStyle(0x1a1a2e, 0.85);
        circle.fillCircle(0, 0, radius);
        circle.lineStyle(2, 0x40e0d0, 0.35);
        circle.strokeCircle(0, 0, radius);

        // Gear icon (simple)
        const gear = this.add.text(0, 0, "⚙", {
            fontFamily: "monospace",
            fontSize: "24px",
            color: "#40e0d0",
        }).setOrigin(0.5);

        container.add([circle, gear]);
        container.setSize(radius * 2, radius * 2);

        const hitArea = new Phaser.Geom.Circle(0, 0, radius);
        container.setInteractive(hitArea, Phaser.Geom.Circle.Contains);
        container.input!.cursor = "pointer";

        container.on("pointerover", () => {
            this.tweens.add({ targets: gear, rotation: 0.25, duration: 250, ease: "Power2" });
        });

        container.on("pointerout", () => {
            this.tweens.add({ targets: gear, rotation: 0, duration: 250, ease: "Power2" });
        });

        container.on("pointerdown", () => {
            this.toggleSettingsMenu();
        });
    }

    private createSettingsMenu(): void {
        const width = 280;
        const height = 260;

        const x = 50 + width / 2;
        const y = GAME_DIMENSIONS.HEIGHT - 50 - height / 2 - 20;

        this.settingsContainer = this.add.container(x, y);
        this.settingsContainer.setVisible(false);
        this.settingsContainer.setDepth(2001);

        const bg = this.add.graphics();
        bg.fillStyle(0x1a1a2e, 0.95);
        bg.fillRoundedRect(-width / 2, -height / 2, width, height, 12);
        bg.lineStyle(2, 0x40e0d0, 0.25);
        bg.strokeRoundedRect(-width / 2, -height / 2, width, height, 12);
        this.settingsContainer.add(bg);

        const title = this.add.text(0, -110, "SETTINGS", {
            fontFamily: "monospace",
            fontSize: "16px",
            color: "#9ca3af",
            fontStyle: "bold",
        }).setOrigin(0.5);
        this.settingsContainer.add(title);

        const audioLabel = this.add.text(0, -85, "AUDIO", {
            fontFamily: "monospace",
            fontSize: "12px",
            color: "#6b7280",
        }).setOrigin(0.5);
        this.settingsContainer.add(audioLabel);

        this.bgmSlider = this.createVolumeSlider(0, -55, "Music", this.bgmVolume, (value) => {
            this.bgmVolume = value;
            this.applyBgmVolume();
            this.saveAudioSettings();
        });
        this.settingsContainer.add(this.bgmSlider);

        this.sfxSlider = this.createVolumeSlider(0, -10, "SFX", this.sfxVolume, (value) => {
            this.sfxVolume = value;
            this.saveAudioSettings();
        });
        this.settingsContainer.add(this.sfxSlider);

        const separator = this.add.graphics();
        separator.lineStyle(1, 0x40e0d0, 0.15);
        separator.lineBetween(-110, 25, 110, 25);
        this.settingsContainer.add(separator);

        const forfeitBtn = this.createMenuButton(0, 80, "FORFEIT", 0xef4444, () => {
            this.toggleSettingsMenu();
            this.showConfirmationDialog(
                "FORFEIT MATCH",
                "Are you sure you want to forfeit?",
                "FORFEIT",
                0xef4444,
                () => this.forfeitMatch()
            );
        });
        this.settingsContainer.add(forfeitBtn);
    }

    private toggleSettingsMenu(): void {
        this.isSettingsOpen = !this.isSettingsOpen;
        this.settingsContainer.setVisible(this.isSettingsOpen);
        if (this.isSettingsOpen) {
            // Close any active dialog when opening menu
            if (this.activeDialog) {
                this.activeDialog.destroy();
                this.activeDialog = undefined;
            }
            if (this.activeDialogBlocker) {
                this.activeDialogBlocker.destroy();
                this.activeDialogBlocker = undefined;
            }
        }
    }

    private createVolumeSlider(
        x: number,
        y: number,
        label: string,
        initialValue: number,
        onChange: (value: number) => void
    ): Phaser.GameObjects.Container {
        const container = this.add.container(x, y);
        const sliderWidth = 140;
        const sliderHeight = 8;

        const labelText = this.add.text(-120, 0, label, {
            fontFamily: "monospace",
            fontSize: "12px",
            color: "#9ca3af",
        }).setOrigin(0, 0.5);
        container.add(labelText);

        const trackOffsetX = 10;
        const trackStartX = -sliderWidth / 2 + trackOffsetX;

        const trackBg = this.add.graphics();
        trackBg.fillStyle(0x0f172a, 1);
        trackBg.fillRoundedRect(trackStartX, -sliderHeight / 2, sliderWidth, sliderHeight, 4);
        container.add(trackBg);

        const trackFill = this.add.graphics();
        container.add(trackFill);

        const knob = this.add.graphics();
        container.add(knob);

        const percentText = this.add.text(sliderWidth / 2 + 25, 0, `${Math.round(initialValue * 100)}%`, {
            fontFamily: "monospace",
            fontSize: "11px",
            color: "#6b7280",
        }).setOrigin(0, 0.5);
        container.add(percentText);

        const updateSliderVisual = (value: number) => {
            trackFill.clear();
            knob.clear();

            const clamped = Math.max(0, Math.min(1, value));
            const fillWidth = sliderWidth * clamped;
            trackFill.fillStyle(0x40e0d0, 0.85);
            trackFill.fillRoundedRect(trackStartX, -sliderHeight / 2, fillWidth, sliderHeight, 4);

            const knobX = trackStartX + fillWidth;
            knob.fillStyle(0x40e0d0, 1);
            knob.fillCircle(knobX, 0, 7);
            knob.lineStyle(2, 0x000000, 0.35);
            knob.strokeCircle(knobX, 0, 7);

            percentText.setText(`${Math.round(clamped * 100)}%`);
        };

        updateSliderVisual(initialValue);

        const hitArea = this.add.rectangle(0, 0, 240, 30, 0x000000, 0);
        hitArea.setInteractive({ useHandCursor: true });
        container.add(hitArea);

        let isDragging = false;
        const calculateValue = (pointerX: number): number => {
            const localX = pointerX - (this.settingsContainer.x + container.x);
            const normalized = (localX - trackStartX) / sliderWidth;
            return Math.max(0, Math.min(1, normalized));
        };

        hitArea.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
            isDragging = true;
            const v = calculateValue(pointer.x);
            updateSliderVisual(v);
            onChange(v);
        });

        this.input.on("pointermove", (pointer: Phaser.Input.Pointer) => {
            if (!isDragging) return;
            const v = calculateValue(pointer.x);
            updateSliderVisual(v);
            onChange(v);
        });

        this.input.on("pointerup", () => {
            isDragging = false;
        });

        return container;
    }

    private createMenuButton(
        x: number,
        y: number,
        text: string,
        color: number,
        callback: () => void
    ): Phaser.GameObjects.Container {
        const width = 200;
        const height = 40;
        const container = this.add.container(x, y);

        const bg = this.add.graphics();
        bg.fillStyle(color, 0.2);
        bg.fillRoundedRect(-width / 2, -height / 2, width, height, 6);
        bg.lineStyle(1, color, 0.5);
        bg.strokeRoundedRect(-width / 2, -height / 2, width, height, 6);

        const label = this.add.text(0, 0, text, {
            fontFamily: "monospace",
            fontSize: "14px",
            color: "#ffffff",
            fontStyle: "bold",
        }).setOrigin(0.5);

        container.add([bg, label]);
        container.setSize(width, height);
        container.setInteractive({ useHandCursor: true });

        container.on("pointerover", () => {
            this.tweens.add({ targets: container, scaleX: 1.03, scaleY: 1.03, duration: 120, ease: "Power2" });
        });
        container.on("pointerout", () => {
            this.tweens.add({ targets: container, scaleX: 1, scaleY: 1, duration: 120, ease: "Power2" });
        });
        container.on("pointerdown", callback);

        return container;
    }

    private showConfirmationDialog(
        title: string,
        message: string,
        confirmText: string,
        confirmColor: number,
        onConfirm: () => void
    ): void {
        const blocker = this.add.rectangle(
            GAME_DIMENSIONS.CENTER_X,
            GAME_DIMENSIONS.CENTER_Y,
            GAME_DIMENSIONS.WIDTH,
            GAME_DIMENSIONS.HEIGHT,
            0x000000,
            0.7
        ).setInteractive();

        const dialogWidth = 520;
        const dialogHeight = 280;

        if (this.activeDialog) this.activeDialog.destroy();
        if (this.activeDialogBlocker) this.activeDialogBlocker.destroy();

        const container = this.add.container(GAME_DIMENSIONS.CENTER_X, GAME_DIMENSIONS.CENTER_Y);
        this.activeDialog = container;
        this.activeDialogBlocker = blocker;

        const bg = this.add.graphics();
        bg.fillStyle(0x1a1a2e, 1);
        bg.fillRoundedRect(-dialogWidth / 2, -dialogHeight / 2, dialogWidth, dialogHeight, 16);
        bg.lineStyle(2, 0x40e0d0, 0.35);
        bg.strokeRoundedRect(-dialogWidth / 2, -dialogHeight / 2, dialogWidth, dialogHeight, 16);

        const titleText = this.add.text(0, -80, title, {
            fontFamily: "monospace",
            fontSize: "26px",
            color: "#ffffff",
            fontStyle: "bold",
        }).setOrigin(0.5);

        const msgText = this.add.text(0, -20, message, {
            fontFamily: "monospace",
            fontSize: "18px",
            color: "#cccccc",
            align: "center",
            wordWrap: { width: 440 },
        }).setOrigin(0.5);

        const confirmBtn = this.createDialogButton(120, 80, 200, 52, confirmText, confirmColor, () => {
            blocker.destroy();
            container.destroy();
            this.activeDialog = undefined;
            this.activeDialogBlocker = undefined;
            onConfirm();
        });

        const cancelBtn = this.createDialogButton(-120, 80, 200, 52, "BACK", 0x6b7280, () => {
            blocker.destroy();
            container.destroy();
            this.activeDialog = undefined;
            this.activeDialogBlocker = undefined;
        });

        container.add([bg, titleText, msgText, confirmBtn, cancelBtn]);
        container.setDepth(2500);
        blocker.setDepth(2499);

        container.setScale(0);
        this.tweens.add({ targets: container, scale: 1, duration: 260, ease: "Back.easeOut" });
    }

    private createDialogButton(
        x: number,
        y: number,
        width: number,
        height: number,
        text: string,
        color: number,
        callback: () => void
    ): Phaser.GameObjects.Container {
        const container = this.add.container(x, y);
        const bg = this.add.graphics();
        bg.fillStyle(color, 1);
        bg.fillRoundedRect(-width / 2, -height / 2, width, height, 8);

        const label = this.add.text(0, 0, text, {
            fontFamily: "monospace",
            fontSize: "18px",
            color: "#ffffff",
            fontStyle: "bold",
        }).setOrigin(0.5);

        container.add([bg, label]);
        container.setSize(width, height);
        container.setInteractive({ useHandCursor: true });

        container.on("pointerover", () => {
            this.tweens.add({ targets: container, scaleX: 1.03, scaleY: 1.03, duration: 120, ease: "Power2" });
        });
        container.on("pointerout", () => {
            this.tweens.add({ targets: container, scaleX: 1, scaleY: 1, duration: 120, ease: "Power2" });
        });
        container.on("pointerdown", callback);

        return container;
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
        const pct = Math.min(1, Math.max(0, hp / (maxHp || 1)));
        const fillW = width * pct;
        const color = pct > 0.5 ? 0x22c55e : pct > 0.25 ? 0xf59e0b : 0xef4444;

        bar.clear();
        bar.fillStyle(color, 1);
        if (player === "player2") {
            bar.fillRoundedRect(pos.X + (width - fillW), pos.Y, fillW, 25, 4);
        } else {
            bar.fillRoundedRect(pos.X, pos.Y, fillW, 25, 4);
        }
    }

    private updateEnergyBar(player: "player1" | "player2", energy: number, maxEnergy: number): void {
        const bar = player === "player1" ? this.player1EnergyBar : this.player2EnergyBar;
        if (!bar) return;
        const pos = player === "player1" ? UI_POSITIONS.HEALTH_BAR.PLAYER1 : UI_POSITIONS.HEALTH_BAR.PLAYER2;
        const width = pos.WIDTH;
        const pct = Math.min(1, Math.max(0, energy / (maxEnergy || 1)));
        const fillW = width * pct;

        bar.clear();
        bar.fillStyle(0x3b82f6, 1);
        if (player === "player2") {
            bar.fillRoundedRect(pos.X + (width - fillW), pos.Y + 30, fillW, 12, 2);
        } else {
            bar.fillRoundedRect(pos.X, pos.Y + 30, fillW, 12, 2);
        }
    }

    private updateGuardMeter(player: "player1" | "player2", guard: number, maxGuard: number): void {
        const bar = player === "player1" ? this.player1GuardMeter : this.player2GuardMeter;
        if (!bar) return;
        const pos = player === "player1" ? UI_POSITIONS.HEALTH_BAR.PLAYER1 : UI_POSITIONS.HEALTH_BAR.PLAYER2;
        const width = pos.WIDTH;
        const pct = Math.min(1, Math.max(0, guard / (maxGuard || 1)));
        const fillW = width * pct;

        bar.clear();
        bar.fillStyle(0xfbbf24, 1);
        if (player === "player2") {
            bar.fillRect(pos.X + (width - fillW), pos.Y + 45, fillW, 6);
        } else {
            bar.fillRect(pos.X, pos.Y + 45, fillW, 6);
        }
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
        this.stunnedAutoSubmitAt = 0;
        this.bothStunnedSkipAt = 0;
        this.enableMoveButtons();
        this.turnIndicatorText.setText("Select your move!");
        this.turnIndicatorText.setColor("#40e0d0");

        // If Power Surge selection is still open, defer enabling controls.
        if (this.powerSurgeUI) {
            this.disableMoveButtons();
            return;
        }

        // If local player is stunned, disable inputs immediately
        const myPlayer = this.config.playerRole;
        const opponent = myPlayer === "player1" ? "player2" : "player1";
        const state = this.combatEngine.getState();
        const amIStunned = !!state[myPlayer].isStunned;
        const oppStunned = !!state[opponent].isStunned;

        if (amIStunned && oppStunned) {
            this.disableMoveButtons();
            this.turnIndicatorText.setText("BOTH PLAYERS STUNNED!");
            this.turnIndicatorText.setColor("#ff4444");
            this.bothStunnedSkipAt = Date.now() + 1200;
            return;
        }

        if (amIStunned) {
            this.disableMoveButtons();
            this.turnIndicatorText.setText("YOU ARE STUNNED!");
            this.turnIndicatorText.setColor("#ff4444");
            this.stunnedAutoSubmitAt = Date.now() + 1200;
        } else if (oppStunned) {
            this.turnIndicatorText.setText("OPPONENT IS STUNNED!");
            this.turnIndicatorText.setColor("#22c55e");
        }
    }

    private enableMoveButtons(): void {
        const myPlayer = this.config.playerRole;
        const opponent = myPlayer === "player1" ? "player2" : "player1";
        const state = this.combatEngine.getState();
        const amIStunned = !!state[myPlayer].isStunned;
        const oppStunned = !!state[opponent].isStunned;

        if (this.hasSubmittedMove || this.isWaitingForOpponent || amIStunned || (amIStunned && oppStunned)) {
            this.disableMoveButtons();
            return;
        }

        this.moveButtons.forEach((btn, move) => {
            const canAfford = this.combatEngine.canAffordMove(myPlayer, move);
            btn.setAlpha(canAfford ? 1 : 0.3);
            if (canAfford) btn.setInteractive();
            else btn.disableInteractive();
        });
    }

    private handleStunnedAutoSubmit(): void {
        if (this.phase !== "selecting" || this.hasSubmittedMove) return;
        this.showFloatingText("Stunned! Auto-submitting...", GAME_DIMENSIONS.CENTER_X, GAME_DIMENSIONS.HEIGHT - 150, "#ff4444");
        this.submitMoveToServer("block");
    }

    private handleBothStunnedSkip(): void {
        if (this.phase !== "selecting" || this.hasSubmittedMove) return;
        this.showFloatingText("Both stunned — auto-resolving...", GAME_DIMENSIONS.CENTER_X, GAME_DIMENSIONS.HEIGHT - 150, "#ff4444");
        this.submitMoveToServer("block");
    }

    /**
     * Toggle persistent stun visual effect (red pulse)
     */
    private toggleStunEffect(player: "player1" | "player2", enable: boolean): void {
        const sprite = player === "player1" ? this.player1Sprite : this.player2Sprite;
        const existingTween = this.stunTweens.get(player);

        if (enable) {
            if (!existingTween || !existingTween.isPlaying()) {
                const tween = this.tweens.add({
                    targets: sprite,
                    tint: 0xff4444,
                    yoyo: true,
                    repeat: -1,
                    duration: 300,
                    ease: "Sine.easeInOut",
                });
                this.stunTweens.set(player, tween);
            }
        } else {
            if (existingTween) {
                existingTween.stop();
                this.stunTweens.delete(player);
            }
            sprite.clearTint();
        }
    }

    // ===========================================================================
    // VISIBILITY FAST-FORWARD (tab-switch catch-up)
    // ===========================================================================

    private setupVisibilityChangeHandler(): void {
        if (this.visibilityChangeHandler) return;

        this.visibilityChangeHandler = () => {
            if (document.visibilityState === "visible") {
                this.fetchAndApplyServerSnapshot().catch((err) => {
                    console.warn("[FightScene] Failed to fast-forward from server snapshot:", err);
                });
            }
        };

        document.addEventListener("visibilitychange", this.visibilityChangeHandler);
    }

    private async fetchAndApplyServerSnapshot(): Promise<void> {
        const base = API_BASE || window.location.origin;
        const res = await fetch(`${base}/api/matches/${this.config.matchId}`);
        if (!res.ok) return;
        const data = await res.json();
        const row = data?.fightState;
        if (!row) return;

        // fightState row uses snake_case fields (see server/supabase/schema.sql)
        this.applyFightStateRow(row);
    }

    private applyFightStateRow(row: any): void {
        // Avoid applying mid-resolution animation; queue it.
        if (this.phase === "resolving") {
            this.pendingFightStateUpdate = row;
            return;
        }

        if (typeof row.current_round === "number") this.currentRound = row.current_round;
        if (typeof row.current_turn === "number") this.currentTurn = row.current_turn;
        if (typeof row.phase === "string") this.phase = row.phase as FightPhase;

        if (typeof row.player1_health === "number") this.combatEngine.setPlayerHealth("player1", row.player1_health);
        if (typeof row.player2_health === "number") this.combatEngine.setPlayerHealth("player2", row.player2_health);
        if (typeof row.player1_energy === "number") this.combatEngine.setPlayerEnergy("player1", row.player1_energy);
        if (typeof row.player2_energy === "number") this.combatEngine.setPlayerEnergy("player2", row.player2_energy);
        if (typeof row.player1_guard_meter === "number") this.combatEngine.setPlayerGuardMeter("player1", row.player1_guard_meter);
        if (typeof row.player2_guard_meter === "number") this.combatEngine.setPlayerGuardMeter("player2", row.player2_guard_meter);

        if (typeof row.player1_rounds_won === "number") this.combatEngine.setPlayerRoundsWon("player1", row.player1_rounds_won);
        if (typeof row.player2_rounds_won === "number") this.combatEngine.setPlayerRoundsWon("player2", row.player2_rounds_won);

        if (typeof row.player1_is_stunned === "boolean") {
            this.combatEngine.setPlayerStunned("player1", row.player1_is_stunned);
            this.toggleStunEffect("player1", row.player1_is_stunned);
        }
        if (typeof row.player2_is_stunned === "boolean") {
            this.combatEngine.setPlayerStunned("player2", row.player2_is_stunned);
            this.toggleStunEffect("player2", row.player2_is_stunned);
        }

        // Deadlines
        if (row.move_deadline_at) {
            const ts = new Date(row.move_deadline_at).getTime();
            if (!Number.isNaN(ts)) this.moveDeadlineAt = ts;
        }
        if (row.countdown_ends_at) {
            const ts = new Date(row.countdown_ends_at).getTime();
            if (!Number.isNaN(ts)) this.countdownEndsAt = ts;
        }

        // Submitted move flags
        const isP1 = this.config.playerRole === "player1";
        const mySubmitted = isP1 ? !!row.player1_has_submitted_move : !!row.player2_has_submitted_move;
        const oppSubmitted = isP1 ? !!row.player2_has_submitted_move : !!row.player1_has_submitted_move;
        this.hasSubmittedMove = mySubmitted;
        this.opponentHasSubmitted = oppSubmitted;
        this.myTimerFrozen = mySubmitted;

        this.syncUIWithCombatState();
        this.updateRoundScore();

        // Phase-specific UI adjustments
        if (this.phase === "selecting") {
            if (this.hasSubmittedMove) {
                this.disableMoveButtons();
                this.turnIndicatorText.setText("✓ SUBMITTED — Awaiting opponent...");
                this.turnIndicatorText.setColor("#22c55e");
            } else {
                this.resetButtonVisuals();
                this.enableMoveButtons();
                this.turnIndicatorText.setText("Select your move!");
                this.turnIndicatorText.setColor("#40e0d0");
            }
        }

        this.ensurePowerSurgePromptFromState();
    }

    private applyFightStateUpdate(payload: any): void {
        const update = (payload && typeof payload === "object" && "update" in payload)
            ? (payload as FightStateBroadcast).update
            : payload;

        const u: any = update;

        // Phase
        const nextPhase = u.phase ?? u.fight_phase;
        if (typeof nextPhase === "string") {
            this.phase = nextPhase as FightPhase;
        }

        // Round/turn
        const nextRound = u.currentRound ?? u.current_round;
        const nextTurn = u.currentTurn ?? u.current_turn;
        if (typeof nextRound === "number") this.currentRound = nextRound;
        if (typeof nextTurn === "number") this.currentTurn = nextTurn;

        // HP/energy/guard
        const p1Hp = u.player1Health ?? u.player1_health;
        const p2Hp = u.player2Health ?? u.player2_health;
        const p1En = u.player1Energy ?? u.player1_energy;
        const p2En = u.player2Energy ?? u.player2_energy;
        const p1Guard = u.player1GuardMeter ?? u.player1_guard_meter;
        const p2Guard = u.player2GuardMeter ?? u.player2_guard_meter;
        if (typeof p1Hp === "number") this.combatEngine.setPlayerHealth("player1", p1Hp);
        if (typeof p2Hp === "number") this.combatEngine.setPlayerHealth("player2", p2Hp);
        if (typeof p1En === "number") this.combatEngine.setPlayerEnergy("player1", p1En);
        if (typeof p2En === "number") this.combatEngine.setPlayerEnergy("player2", p2En);
        if (typeof p1Guard === "number") this.combatEngine.setPlayerGuardMeter("player1", p1Guard);
        if (typeof p2Guard === "number") this.combatEngine.setPlayerGuardMeter("player2", p2Guard);

        // Rounds won
        const p1Wins = u.player1RoundsWon ?? u.player1_rounds_won;
        const p2Wins = u.player2RoundsWon ?? u.player2_rounds_won;
        if (typeof p1Wins === "number") this.combatEngine.setPlayerRoundsWon("player1", p1Wins);
        if (typeof p2Wins === "number") this.combatEngine.setPlayerRoundsWon("player2", p2Wins);

        // Stun
        const p1Stunned = u.player1IsStunned ?? u.player1_is_stunned;
        const p2Stunned = u.player2IsStunned ?? u.player2_is_stunned;
        if (typeof p1Stunned === "boolean") {
            this.combatEngine.setPlayerStunned("player1", p1Stunned);
            this.toggleStunEffect("player1", p1Stunned);
        }
        if (typeof p2Stunned === "boolean") {
            this.combatEngine.setPlayerStunned("player2", p2Stunned);
            this.toggleStunEffect("player2", p2Stunned);
        }

        // Deadlines
        const md = u.moveDeadlineAt ?? u.move_deadline_at;
        const cd = u.countdownEndsAt ?? u.countdown_ends_at;
        if (typeof md === "number") this.moveDeadlineAt = md;
        if (typeof cd === "number") this.countdownEndsAt = cd;
        if (typeof md === "string") {
            const ts = new Date(md).getTime();
            if (!Number.isNaN(ts)) this.moveDeadlineAt = ts;
        }
        if (typeof cd === "string") {
            const ts = new Date(cd).getTime();
            if (!Number.isNaN(ts)) this.countdownEndsAt = ts;
        }

        // Submitted flags
        const p1Submitted = u.player1HasSubmittedMove ?? u.player1_has_submitted_move;
        const p2Submitted = u.player2HasSubmittedMove ?? u.player2_has_submitted_move;
        if (typeof p1Submitted === "boolean" || typeof p2Submitted === "boolean") {
            const isP1 = this.config.playerRole === "player1";
            const mySubmitted = isP1 ? !!p1Submitted : !!p2Submitted;
            const oppSubmitted = isP1 ? !!p2Submitted : !!p1Submitted;
            this.hasSubmittedMove = mySubmitted;
            this.opponentHasSubmitted = oppSubmitted;
            this.myTimerFrozen = mySubmitted;
        }

        this.syncUIWithCombatState();
        this.updateRoundScore();
        this.ensurePowerSurgePromptFromState();
    }

    private ensurePowerSurgePromptFromState(): void {
        if (this.powerSurgeUI) return;
        if (this.currentTurn !== 1) return;
        if (this.currentRound <= 0) return;
        if (this.lastSurgeRoundShown === this.currentRound) return;
        if (this.phase !== "countdown" && this.phase !== "selecting") return;

        this.maybeShowPowerSurgeForRound(this.currentRound, this.currentTurn).catch((err) => {
            console.warn("[FightScene] Failed to trigger power surge from state sync:", err);
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

            const bg = button.list[0] as Phaser.GameObjects.Graphics;
            let color = 0xffffff;
            if (move === "punch") color = 0xef4444;
            if (move === "kick") color = 0x06b6d4;
            if (move === "block") color = 0x22c55e;
            if (move === "special") color = 0xa855f7;

            if (move === selectedMove && isSelected) {
                this.tweens.add({
                    targets: button, alpha: 1, scaleX: 1.1, scaleY: 1.1,
                    y: GAME_DIMENSIONS.HEIGHT - 110, duration: 200, ease: "Back.easeOut",
                });

                bg.clear();
                bg.fillStyle(0x1a1a2e, 1);
                bg.fillRoundedRect(-70, -80, 140, 160, 12);
                bg.lineStyle(4, 0xffffff, 1);
                bg.strokeRoundedRect(-70, -80, 140, 160, 12);
            } else {
                this.tweens.add({
                    targets: button, alpha: isSelected ? 0.5 : 1, scaleX: 1, scaleY: 1,
                    y: GAME_DIMENSIONS.HEIGHT - 100, duration: 200, ease: "Power2",
                });

                bg.clear();
                bg.fillStyle(0x1a1a2e, 0.9);
                bg.fillRoundedRect(-70, -80, 140, 160, 12);
                bg.lineStyle(2, color, 0.8);
                bg.strokeRoundedRect(-70, -80, 140, 160, 12);
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

            const sfxKey = getSFXKey(charId, anim);
            const delay = getSoundDelay(charId, anim);
            if (sfxKey && this.cache.audio.exists(sfxKey)) {
                this.time.delayedCall(delay, () => {
                    if (!this.scene.isActive()) return;
                    this.playSFX(sfxKey);
                });
            }
        }
    }

    private playHitImpact(target: Phaser.GameObjects.Sprite): void {
        target.setTint(0xff5555);
        this.tweens.add({
            targets: target,
            alpha: { from: 1, to: 0.65 },
            yoyo: true,
            duration: 120,
            onComplete: () => {
                target.clearTint();
                target.setAlpha(1);
            },
        });
    }

    private showRoundResult(winner: string): void {
        const isMyWin = winner === this.config.playerRole;
        const text = winner === "draw" ? "DRAW!" : isMyWin ? "ROUND WON!" : "ROUND LOST!";
        const color = winner === "draw" ? "#ffd700" : isMyWin ? "#22c55e" : "#ef4444";

        this.countdownText.setText(text);
        this.countdownText.setFontSize(42);
        this.countdownText.setColor(color);
        this.countdownText.setAlpha(1);
        this.playSFX(isMyWin ? "sfx_victory" : "sfx_defeat");

        this.tweens.add({
            targets: this.countdownText,
            scale: { from: 1.5, to: 1 }, alpha: { from: 1, to: 0 },
            duration: 2000, ease: "Power2",
        });
    }

    private processRoundEndCountdownComplete(): void {
        this.countdownText.setAlpha(0);
        this.countdownText.setFontSize(72);
        this.applyPendingRoundStartIfAny();
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
        this.hideDisconnectOverlay();
        // Server should handle forfeit — just show message
        this.showFloatingText("Opponent forfeited!", GAME_DIMENSIONS.CENTER_X, GAME_DIMENSIONS.CENTER_Y, "#22c55e");
    }

    private showDisconnectOverlay(timeoutSeconds: number): void {
        if (this.disconnectOverlay) return;

        const overlay = this.add.container(GAME_DIMENSIONS.CENTER_X, GAME_DIMENSIONS.CENTER_Y);
        overlay.setDepth(3500);

        const blocker = this.add.rectangle(
            0,
            0,
            GAME_DIMENSIONS.WIDTH,
            GAME_DIMENSIONS.HEIGHT,
            0x000000,
            0.82
        );
        blocker.setInteractive();

        const panelW = 560;
        const panelH = 240;

        const bg = this.add.graphics();
        bg.fillStyle(0x1a1a2e, 1);
        bg.fillRoundedRect(-panelW / 2, -panelH / 2, panelW, panelH, 18);
        bg.lineStyle(2, 0xff4444, 0.35);
        bg.strokeRoundedRect(-panelW / 2, -panelH / 2, panelW, panelH, 18);

        const title = this.add.text(0, -70, "OPPONENT DISCONNECTED", {
            fontFamily: "monospace",
            fontSize: "24px",
            color: "#ff4444",
            fontStyle: "bold",
        }).setOrigin(0.5);

        const body = this.add.text(0, -20, "Waiting for reconnection...", {
            fontFamily: "monospace",
            fontSize: "16px",
            color: "#cccccc",
        }).setOrigin(0.5);

        const timer = this.add.text(0, 55, `${timeoutSeconds}s`, {
            fontFamily: "monospace",
            fontSize: "40px",
            color: "#ffffff",
            fontStyle: "bold",
            stroke: "#000000",
            strokeThickness: 6,
        }).setOrigin(0.5);

        overlay.add([blocker, bg, title, body, timer]);
        this.disconnectOverlay = overlay;
        this.disconnectTimerText = timer;

        overlay.setScale(0.95);
        overlay.setAlpha(0);
        this.tweens.add({ targets: overlay, alpha: 1, scale: 1, duration: 220, ease: "Power2" });
    }

    private hideDisconnectOverlay(): void {
        if (!this.disconnectOverlay) return;
        this.disconnectOverlay.destroy(true);
        this.disconnectOverlay = undefined;
        this.disconnectTimerText = undefined;
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

    private saveAudioSettings(): void {
        try {
            localStorage.setItem("veilstar_brawl_bgm_volume", this.bgmVolume.toString());
            localStorage.setItem("veilstar_brawl_sfx_volume", this.sfxVolume.toString());
        } catch {
            // ignore
        }
    }

    private applyBgmVolume(): void {
        const bgm = this.sound.get("bgm_fight");
        if (bgm && "setVolume" in bgm) {
            (bgm as Phaser.Sound.WebAudioSound).setVolume(this.bgmVolume);
        }
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
        this.applyBgmVolume();
        this.saveAudioSettings();
    }

    private handleShutdown(): void {
        const bgm = this.sound.get("bgm_fight");
        if (bgm?.isPlaying) bgm.stop();

        if (this.visibilityChangeHandler) {
            document.removeEventListener("visibilitychange", this.visibilityChangeHandler);
            this.visibilityChangeHandler = undefined;
        }
    }

    private forfeitMatch(): void {
        EventBus.emit("fight:forfeit", {
            matchId: this.config.matchId,
            playerRole: this.config.playerRole,
        });
    }
}
