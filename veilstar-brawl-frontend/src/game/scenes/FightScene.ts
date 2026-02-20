/**
 * FightScene - Main battle arena for KaspaClash
 * Core Phaser scene for 1v1 fighting matches with full combat logic
 */

import Phaser from "phaser";
import { EventBus } from "../EventBus";
import { GAME_DIMENSIONS, CHARACTER_POSITIONS, UI_POSITIONS } from "../config";
import { getCharacterScale, getCharacterYOffset, getAnimationScale, getSoundDelay, getSFXKey } from "../config/sprite-config";
import { CombatEngine, BASE_MOVE_STATS } from "../combat";
import { calculateSurgeEffects, isBlockDisabled } from "../combat/SurgeEffects";
import { ChatPanel } from "../ui/ChatPanel";
import { StickerPicker, STICKER_LIST, type StickerId } from "../ui/StickerPicker";
import { TransactionToast } from "../ui/TransactionToast";
import { PowerSurgeCards } from "../ui/PowerSurgeCards";
import { SpectatorPowerSurgeCards } from "../ui/SpectatorPowerSurgeCards";
import type { PowerSurgeCardId } from "@/types/power-surge";
import { getDeterministicPowerSurgeCards, getRandomPowerSurgeCards, getPowerSurgeCard } from "@/types/power-surge";
import { SmartBotOpponent } from "@/lib/game/smart-bot-opponent";
import type { MoveType } from "@/types/game";
import type { CombatState } from "../combat";
import { PowerSurgeCardView } from "../ui/PowerSurgeCardView";
import { TextFactory } from "../ui/TextFactory";
import { preloadFightSceneAssets, createCharacterAnimations } from "../utils/asset-loader";

type PlayerRole = "player1" | "player2";
const API_BASE = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");
const PRIVATE_ROUNDS_ENABLED = (import.meta.env.VITE_ZK_PRIVATE_ROUNDS ?? "true") !== "false";
const PRIVATE_ROUND_PLAN_TURNS = 10;
const PRIVATE_ROUND_SERVER_MAX_ENERGY = 100;
const PRIVATE_ROUND_SERVER_ENERGY_REGEN = 8;
const ROUND_MOVE_TIMER_MS = 90000;
const DEBUG_MATCH_END_FLOW = (import.meta.env.VITE_DEBUG_MATCH_END_FLOW ?? "false") === "true";
const apiUrl = (path: string): string => `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`;

/**
 * Fight scene configuration.
 */
export interface FightSceneConfig {
  matchId: string;
  player1Address: string;
  player2Address: string;
  player1Character: string;
  player2Character: string;
  playerRole: PlayerRole; // Which player is the local user
  matchFormat?: "best_of_3" | "best_of_5";
  // For spectator mode
  isSpectator?: boolean;
  // For bot matches
  isBot?: boolean;
  // For reconnection
  isReconnect?: boolean;
  reconnectState?: {
    status: string;
    currentRound: number;
    player1Health: number;
    player2Health: number;
    player1RoundsWon: number;
    player2RoundsWon: number;
    player1Energy: number;
    player2Energy: number;
    moveDeadlineAt: number | null;
    pendingMoves: { player1: boolean; player2: boolean };
  };
}

/**
 * FightScene - The main battle arena with full combat logic.
 */
export class FightScene extends Phaser.Scene {
  // Scene configuration
  private config!: FightSceneConfig;

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
  private narrativeText!: Phaser.GameObjects.Text;
  private turnIndicatorText!: Phaser.GameObjects.Text;
  private privatePlanEnergyText?: Phaser.GameObjects.Text;
  private zkOnChainBadgeText?: Phaser.GameObjects.Text;
  private zkOnChainBadgeRound: number = 0;

  // Character sprites
  private player1Sprite!: Phaser.GameObjects.Sprite;
  private player2Sprite!: Phaser.GameObjects.Sprite;

  // Move buttons
  private moveButtons: Map<MoveType, Phaser.GameObjects.Container> = new Map();
  // Move selection
  private selectedMove: MoveType | null = null;
  private privateRoundPlannedMoves: Array<"punch" | "kick" | "block" | "special"> = [];
  private privateRoundPlanEnergyPreview: number = PRIVATE_ROUND_SERVER_MAX_ENERGY;
  private privateRoundPlanBaseEnergy: number = PRIVATE_ROUND_SERVER_MAX_ENERGY;
  private privateRoundPlanMaxEnergy: number = PRIVATE_ROUND_SERVER_MAX_ENERGY;

  // Timer - ALL timers use real-time deadlines (Date.now()) instead of Phaser timers
  // This ensures timers continue counting down even when the browser tab is backgrounded
  private turnTimer: number = 90;
  // REMOVED: private timerEvent - replaced by update() loop using moveDeadlineAt

  // State
  private phase: "waiting" | "countdown" | "selecting" | "resolving" | "round_end" | "match_end" = "waiting";
  private isWaitingForOpponent: boolean = false;
  private moveDeadlineAt: number = 0; // Server-synchronized move deadline timestamp
  private localMoveSubmitted: boolean = false; // Track if local player submitted move this round
  private moveInFlight: boolean = false; // Track if move transaction is being processed (wallet signing / API call)

  // Real-time deadline tracking (all use Date.now() so they work across tab switches)
  private countdownEndsAt: number = 0; // When the 3-2-1 FIGHT countdown ends
  private countdownPhaseNumber: number = 0; // Which countdown number was last displayed (3, 2, 1, 0=FIGHT)
  private roundEndCountdownEndsAt: number = 0; // When the "Next round in X" countdown ends
  private roundEndCountdownStartedAt: number = 0; // When the round-end countdown started
  private stunnedAutoSubmitAt: number = 0; // When to auto-submit stunned move
  private bothStunnedSkipAt: number = 0; // When to auto-skip both-stunned turn
  private timerExpiredHandled: boolean = false; // Prevent double-handling of timer expiry

  // Visibility change handler for catch-up on tab refocus
  private visibilityChangeHandler?: () => void;

  // Track EventBus subscriptions so we can reliably unsubscribe on shutdown.
  // Without this, stale listeners from previous FightScene instances can keep firing,
  // causing duplicated roundResolved handling and crashes (e.g. this.add/text drawImage null).
  private busDisposers: Array<() => void> = [];
  private hasCleanedUp: boolean = false;

  // Ordered playback queue for server-authoritative turn results.
  // Especially important in private rounds, where many turn resolutions can arrive back-to-back.
  private roundResolvedQueue: Array<any> = [];

  // Store round-end data for processing after countdown
  private roundEndData?: { p1Char: string; p2Char: string };

  // Disconnect handling
  private disconnectOverlay?: Phaser.GameObjects.Container;
  private disconnectTimerText?: Phaser.GameObjects.Text;
  private disconnectTimeoutAt: number = 0;
  private opponentDisconnected: boolean = false;

  // Audio settings
  private bgmVolume: number = 0.3;
  private sfxVolume: number = 0.5;
  private bgmSlider?: Phaser.GameObjects.Container;
  private sfxSlider?: Phaser.GameObjects.Container;

  // Server-synchronized state (production mode) - all game state comes from server
  private serverState: {
    player1Health: number;
    player1MaxHealth: number;
    player2Health: number;
    player2MaxHealth: number;
    player1Energy: number;
    player1MaxEnergy: number;
    player2Energy: number;
    player2MaxEnergy: number;
    player1GuardMeter: number;
    player2GuardMeter: number;
    player1RoundsWon: number;
    player2RoundsWon: number;
    currentRound: number;
    // Stun state - if true, player cannot act this turn
    player1IsStunned?: boolean;
    player2IsStunned?: boolean;
  } | null = null;

  // Pending round start payload (queued if received during round_end phase)
  private pendingRoundStart: {
    roundNumber: number;
    turnNumber: number;
    moveDeadlineAt: number;
    countdownSeconds: number;
    player1Health: number;
    player2Health: number;
    player1MaxHealth?: number;
    player2MaxHealth?: number;
    player1Energy: number;
    player2Energy: number;
    player1MaxEnergy?: number;
    player2MaxEnergy?: number;
    player1GuardMeter: number;
    player2GuardMeter: number;
    player1IsStunned?: boolean;
    player2IsStunned?: boolean;
  } | null = null;



  // Chat panel for in-game messaging
  private chatPanel?: ChatPanel;
  // Track processed chat messages to prevent duplicates
  private processedChatMessages: Set<string> = new Set();

  // Sticker picker for displaying stickers above character
  private stickerPicker?: StickerPicker;
  // Track sticker display containers for each player
  private localStickerDisplay?: Phaser.GameObjects.Container;
  private opponentStickerDisplay?: Phaser.GameObjects.Container;

  // Bot opponent handling
  private isBotMatch: boolean = false;
  private botOpponent?: SmartBotOpponent;

  // Animation synchronization state
  private isResolving: boolean = false;
  private pendingMatchEndPayload: any = null;

  // Transaction toast for showing confirmed transactions
  private activeTransactionToast?: TransactionToast;
  private moveConfirmedListener?: (data: unknown) => void;
  private privateRoundCommittedListener?: (data: unknown) => void;
  private zkProgressListener?: (data: unknown) => void;
  private zkWaitStickyUntil: number = 0;

  // Pending server state - holds the new HP/energy values during animations
  // This prevents the UI from showing new values before animations complete
  private pendingServerState: {
    player1Health: number;
    player1MaxHealth: number;
    player2Health: number;
    player2MaxHealth: number;
    player1Energy: number;
    player1MaxEnergy: number;
    player2Energy: number;
    player2MaxEnergy: number;
    player1GuardMeter: number;
    player2GuardMeter: number;
    player1RoundsWon: number;
    player2RoundsWon: number;
    currentRound: number;
    player1IsStunned?: boolean;
    player2IsStunned?: boolean;
  } | null = null;

  // Track stun visual effects
  private stunTweens: Map<"player1" | "player2", Phaser.Tweens.Tween> = new Map();

  // Power Surge state
  private powerSurgeUI?: PowerSurgeCards;
  private activeSurges: {
    player1: PowerSurgeCardId | null;
    player2: PowerSurgeCardId | null;
  } = { player1: null, player2: null };
  private surgeCardsShownThisRound: boolean = false;
  private lastSurgeRound: number = 0;

  // Spectator Power Surge state (read-only display for spectators)
  private spectatorSurgeUI: SpectatorPowerSurgeCards | null = null;
  private spectatorSurgeData: {
    roundNumber: number;
    cardIds: PowerSurgeCardId[];
    player1Selection: PowerSurgeCardId | null;
    player2Selection: PowerSurgeCardId | null;
  } | null = null;

  // Countdown deduplication - track the last turn we started a countdown for
  private lastCountdownStartedForTurn: string = "";
  private lastResolvedEventKey: string = "";
  private processedResolvedTurns: Set<string> = new Set();


  constructor() {
    super({ key: "FightScene" });
  }

  private isSceneUiReady(): boolean {
    try {
      const sysAny = this.sys as any;
      if (!sysAny || sysAny.isDestroyed) return false;

      const settings = sysAny.settings;
      const status = settings?.status;
      if (typeof status === "number" && status >= Phaser.Scenes.SHUTDOWN) {
        return false;
      }

      return !!this.add
        && !!this.tweens
        && !!this.time
        && !!sysAny.displayList
        && !!sysAny.updateList;
    } catch {
      return false;
    }
  }

  private isActiveText(text: Phaser.GameObjects.Text | undefined): text is Phaser.GameObjects.Text {
    const anyText = text as any;
    return !!anyText && !!anyText.active && !!anyText.scene && !!anyText.scene.sys;
  }

  private isPrivatePhaseThreeTimerLocked(): boolean {
    if (!PRIVATE_ROUNDS_ENABLED || !this.isActiveText(this.turnIndicatorText)) {
      return false;
    }

    const indicator = this.turnIndicatorText.text;
    return this.phase === "resolving"
      || indicator.startsWith("Phase 3/3")
      || indicator === "Waiting for next turn...";
  }

  private setPhaseThreeTimerTick(): void {
    if (!this.isActiveText(this.roundTimerText)) return;
    this.roundTimerText.setText("✓");
    this.roundTimerText.setColor("#22c55e");
  }

  private showZkWaitingStatus(message: string, color: string = "#22c55e", stickyMs: number = 0): void {
    if (!PRIVATE_ROUNDS_ENABLED || !this.isActiveText(this.turnIndicatorText)) return;
    if (!this.isWaitingForOpponent) return;
    if (this.phase !== "selecting" && this.phase !== "waiting") return;

    this.turnIndicatorText.setText(message);
    this.turnIndicatorText.setColor(color);

    if (stickyMs > 0) {
      this.zkWaitStickyUntil = Date.now() + stickyMs;
    }
  }

  private startZkWaitingTicker(initialMessage?: string, initialColor: string = "#f97316"): void {
    if (!PRIVATE_ROUNDS_ENABLED) return;
    if (initialMessage) this.showZkWaitingStatus(initialMessage, initialColor, 1800);
  }

  private stopZkWaitingTicker(): void {
    this.zkWaitStickyUntil = 0;
  }

  private debugMatchEndLog(message: string, extra?: unknown): void {
    if (!DEBUG_MATCH_END_FLOW) return;
    if (extra === undefined) {
      console.log(`[TERMDBG][FightScene] ${message}`);
      return;
    }
    console.log(`[TERMDBG][FightScene] ${message}`, extra);
  }

  private hasReachedTerminalScore(): boolean {
    if (!this.serverState) return false;
    const roundsToWin = this.combatEngine ? this.combatEngine.getState().roundsToWin : 2;
    return this.serverState.player1RoundsWon >= roundsToWin || this.serverState.player2RoundsWon >= roundsToWin;
  }

  private shouldIgnoreRoundStarting(): boolean {
    return this.phase === "match_end"
      || !!this.pendingMatchEndPayload
      || this.hasReachedTerminalScore();
  }

  /**
   * Check if this is a bot match
   */
  private checkIfBotMatch(): boolean {
    // Check if match config has is_bot flag (preferred method)
    if ('isBot' in this.config) {
      return this.config.isBot === true;
    }
    // Fallback: check for legacy bot_ prefix
    return this.config.player2Address.startsWith("bot_");
  }

  // Audio helper
  private playSFX(key: string): void {
    if (this.game.sound.locked) return;

    try {
      this.sound.play(key, { volume: this.sfxVolume });
      // Stop after 5 seconds max
      this.time.delayedCall(5000, () => {
        const sound = this.sound.get(key);
        if (sound && sound.isPlaying) {
          sound.stop();
        }
      });
    } catch (e) {
      console.warn(`Failed to play SFX: ${key}`, e);
    }
  }

  /**
   * Load audio settings from localStorage.
   */
  private loadAudioSettings(): void {
    try {
      const savedBgm = localStorage.getItem("kaspaclash_bgm_volume");
      const savedSfx = localStorage.getItem("kaspaclash_sfx_volume");
      if (savedBgm !== null) this.bgmVolume = parseFloat(savedBgm);
      if (savedSfx !== null) this.sfxVolume = parseFloat(savedSfx);
    } catch (e) {
      console.warn("Failed to load audio settings", e);
    }
  }

  /**
   * Save audio settings to localStorage.
   */
  private saveAudioSettings(): void {
    try {
      localStorage.setItem("kaspaclash_bgm_volume", this.bgmVolume.toString());
      localStorage.setItem("kaspaclash_sfx_volume", this.sfxVolume.toString());
    } catch (e) {
      console.warn("Failed to save audio settings", e);
    }
  }

  /**
   * Apply BGM volume to currently playing background music.
   */
  private applyBgmVolume(): void {
    const bgm = this.sound.get("bgm_fight");
    if (bgm && "setVolume" in bgm) {
      (bgm as Phaser.Sound.WebAudioSound).setVolume(this.bgmVolume);
    }
  }

  /**
   * Initialize scene with match data.
   */
  init(data: FightSceneConfig): void {
    this.config = { ...data };
    this.resetFullState();

    // Check if this is a bot match
    this.isBotMatch = this.checkIfBotMatch();
    if (this.isBotMatch) {
      // Extract bot name from address (or use default)
      const botName = this.config.player2Address.replace("bot_", "Bot_");
      this.botOpponent = new SmartBotOpponent(botName);
      console.log("[FightScene] Bot match detected:", botName);
    }
  }

  /**
   * Reset all state for new match.
   */
  private resetFullState(): void {
    this.selectedMove = null;
    this.turnTimer = 15;
    this.phase = "countdown";
    this.opponentDisconnected = false;
    this.disconnectTimeoutAt = 0;
    this.isWaitingForOpponent = false;
    this.serverState = null;
    this.zkOnChainBadgeRound = 0;
  }

  /**
   * Preload assets.
   * OPTIMIZED: Only loads the 2 characters needed for this match, not all 20!
   * This dramatically reduces loading time (from 140 spritesheets to just 14).
   */
  preload(): void {
    // Use optimized loading - only load the 2 characters in this match
    const player1Char = this.config?.player1Character || "soroban-sage";
    const player2Char = this.config?.player2Character || "soroban-sage";

    preloadFightSceneAssets(this, player1Char, player2Char);

    // Load stickers
    StickerPicker.preloadStickers(this);
  }

  /**
   * Create scene elements.
   */
  create(): void {
    // Ensure we always clean up global listeners when the scene shuts down.
    // Without this, old FightScene instances keep handling EventBus events.
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.cleanupScene, this);
    this.events.once(Phaser.Scenes.Events.DESTROY, this.cleanupScene, this);

    // Initialize combat engine
    this.combatEngine = new CombatEngine(
      this.config.player1Character || "soroban-sage",
      this.config.player2Character || "soroban-sage",
      "best_of_3"
    );

    // Create animations only for the characters in this match
    const player1Char = this.config?.player1Character || "soroban-sage";
    const player2Char = this.config?.player2Character || "soroban-sage";
    createCharacterAnimations(this, [player1Char, player2Char]);

    // Load audio settings from localStorage
    this.loadAudioSettings();

    // Play BGM - keep playing even when tab loses focus
    this.sound.pauseOnBlur = false;
    if (this.sound.get("bgm_fight")) {
      if (!this.sound.get("bgm_fight").isPlaying) {
        this.sound.play("bgm_fight", { loop: true, volume: this.bgmVolume });
      }
    } else {
      this.sound.play("bgm_fight", { loop: true, volume: this.bgmVolume });
    }

    // Background
    this.createBackground();

    // Character sprites
    this.createCharacterSprites();

    // UI Elements
    this.createHealthBars();
    this.createEnergyBars();
    this.createGuardMeters();
    this.createRoundTimer();
    this.createRoundScore();
    this.createMoveButtons();
    this.createNarrativeDisplay();
    this.createTurnIndicator();
    this.createCountdownOverlay();

    // UI - Settings and Dialogs (only for non-spectators)
    if (!this.config.isSpectator) {
      this.settingsContainer = this.add.container(0, 0);
      this.createSettingsButton();
      this.createSettingsMenu(); // Create hidden menu

    }

    // Create chat panel on the bottom right (only for non-spectators)
    if (!this.config.isSpectator) {
      this.chatPanel = new ChatPanel(this, {
        x: GAME_DIMENSIONS.WIDTH - 230,
        y: GAME_DIMENSIONS.HEIGHT - 340,
        width: 220,
        height: 320,
        playerRole: this.config.playerRole,
        onSendMessage: (message: string) => {
          // Display message locally for sender immediately
          this.chatPanel?.addMessage(this.config.playerRole, message, Date.now());
          // Emit event for React layer to send via channel
          EventBus.emit("game:sendChat", { message });
        },
      });

      // Create sticker picker (positioned left of chat)
      const playerSprite = this.config.playerRole === "player1" ? this.player1Sprite : this.player2Sprite;

      // Fetch owned stickers from database asynchronously
      this.fetchAndInitializeStickerPicker(playerSprite);
    }

    // Setup event listeners
    this.setupEventListeners();

    // Setup visibility change handler for tab-switch catch-up
    // This ensures timers continue correctly when the user switches tabs
    this.setupVisibilityChangeHandler();

    // Check if we have reconnect state passed via config
    console.log("[FightScene] create() - checking reconnect config");
    console.log("[FightScene] config.isReconnect:", this.config.isReconnect);
    console.log("[FightScene] config.reconnectState:", this.config.reconnectState);

    if (this.config.isReconnect && this.config.reconnectState) {
      console.log("[FightScene] Reconnect mode - applying server state from config");
      this.handleStateSync(this.config.reconnectState);
    } else {
      // Update UI with initial state
      console.log("[FightScene] Normal mode - waiting for server round_starting event");
      this.syncUIWithCombatState();

      // Don't start a client-side timer - wait for server's round_starting event
      // which includes moveDeadlineAt for synchronized timing across both players.
      // The server broadcasts round_starting when match_starting is sent.
      this.phase = "waiting";
      this.turnIndicatorText.setText("Waiting for round to start...");
      this.turnIndicatorText.setColor("#f97316");
      this.roundTimerText.setText("--");

      // Request round state from MatchGameClient in case we missed the broadcast
      // MatchGameClient will respond with game:roundStarting if the match is ready
      console.log("[FightScene] Requesting round state from MatchGameClient");
      EventBus.emit("fight:requestRoundState", { matchId: this.config.matchId });
    }

    // Emit scene ready event
    EventBus.emit("scene:ready", this);
  }

  /**
   * Create global animations for characters.
   * Dynamically generates animations for all loaded character spritesheets.
   */
  private createAnimations(): void {
    // All 20 characters
    const allCharacters = [
      "aeon-guard", "bastion-hulk", "ledger-titan", "chrono-drifter",
      "cyber-ninja", "cyber-paladin", "soroban-sage", "gene-smasher",
      "hash-hunter", "heavy-loader", "kitsune-09", "nano-brawler",
      "neon-wraith", "prism-duelist", "razor-bot-7", "scrap-goliath",
      "sonic-striker", "technomancer", "viperblade", "void-reaper"
    ];
    const animationTypes = ["idle", "run", "punch", "kick", "block", "special", "dead"];

    allCharacters.forEach((charId) => {
      animationTypes.forEach((animType) => {
        const textureKey = `char_${charId}_${animType}`;
        const animKey = `${charId}_${animType}`;

        if (this.textures.exists(textureKey) && !this.anims.exists(animKey)) {
          // Get frame count from texture
          const frameCount = this.textures.get(textureKey).frameTotal - 1; // -1 for __BASE frame
          const endFrame = Math.max(0, frameCount - 1);

          this.anims.create({
            key: animKey,
            frames: this.anims.generateFrameNumbers(textureKey, { start: 0, end: endFrame }),
            frameRate: 24,
            repeat: animType === "idle" || animType === "run" ? -1 : 0,
          });
        }
      });

      // Fallback animations (hurt, victory, defeat -> map to idle)
      const idleKey = `char_${charId}_idle`;
      ['hurt', 'victory', 'defeat'].forEach(key => {
        const fallbackAnimKey = `${charId}_${key}`;
        if (!this.anims.exists(fallbackAnimKey) && this.textures.exists(idleKey)) {
          const frameCount = this.textures.get(idleKey).frameTotal - 1;
          const endFrame = Math.max(0, frameCount - 1);

          this.anims.create({
            key: fallbackAnimKey,
            frames: this.anims.generateFrameNumbers(idleKey, { start: 0, end: endFrame }),
            frameRate: 24,
            repeat: 0,
          });
        }
      });
    });
  }

  /**
   * Update loop - THE single source of truth for all time-based game logic.
   * Uses Date.now() so timers continue correctly even when the tab is backgrounded.
   * Phaser's clock pauses on tab switch, but Date.now() doesn't.
   */
  update(_time: number, _delta: number): void {
    const now = Date.now();
    this.updatePrivatePlanEnergyText();
    const isPrivatePhaseThreeTimerLocked = this.isPrivatePhaseThreeTimerLocked();

    if (isPrivatePhaseThreeTimerLocked) {
      this.setPhaseThreeTimerTick();
    }

    // === COUNTDOWN PHASE (3-2-1 FIGHT) ===
    if (this.phase === "countdown" && this.countdownEndsAt > 0) {
      const remainingMs = this.countdownEndsAt - now;
      const remainingSeconds = Math.ceil(remainingMs / 1000);

      if (remainingMs <= 0) {
        // Countdown finished - show FIGHT! briefly then start selection
        if (this.countdownPhaseNumber !== -1) {
          this.countdownPhaseNumber = -1;
          this.countdownText.setText("FIGHT!");
          this.countdownText.setAlpha(1);
          this.countdownText.setScale(1);
          // Start selection phase after 500ms
          const selectionStartAt = this.countdownEndsAt + 500;
          if (now >= selectionStartAt) {
            // Already past the FIGHT! display time, start immediately
            this.countdownText.setAlpha(0);
            this.countdownEndsAt = 0;
            this.startSynchronizedSelectionPhase(this.moveDeadlineAt);
          }
        } else if (now >= this.countdownEndsAt + 500) {
          // FIGHT! text display time is over
          this.countdownText.setAlpha(0);
          this.countdownEndsAt = 0;
          this.startSynchronizedSelectionPhase(this.moveDeadlineAt);
        }
      } else if (remainingSeconds !== this.countdownPhaseNumber && remainingSeconds > 0 && remainingSeconds <= 3) {
        // Show next countdown number
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

    // === SELECTING PHASE (move timer countdown) ===
    if (this.phase === "selecting" && this.moveDeadlineAt > 0 && this.roundTimerText && !isPrivatePhaseThreeTimerLocked) {
      const remainingMs = this.moveDeadlineAt - now;
      this.turnTimer = Math.max(0, Math.ceil(remainingMs / 1000));
      this.roundTimerText.setText(`${this.turnTimer}s`);
      this.updatePrivatePlanEnergyText();

      if (this.turnTimer <= 5) {
        this.roundTimerText.setColor("#ff4444");
      } else {
        this.roundTimerText.setColor("#40e0d0");
      }

      // Handle timer expiry
      if (remainingMs <= 0 && !this.timerExpiredHandled) {
        this.timerExpiredHandled = true;
        this.onTimerExpired();
      }
    }

    // === STUNNED AUTO-SUBMIT ===
    if (this.stunnedAutoSubmitAt > 0 && now >= this.stunnedAutoSubmitAt) {
      const submitAt = this.stunnedAutoSubmitAt;
      this.stunnedAutoSubmitAt = 0; // Clear to prevent re-trigger
      this.handleStunnedAutoSubmit();
    }

    // === BOTH STUNNED SKIP ===
    if (this.bothStunnedSkipAt > 0 && now >= this.bothStunnedSkipAt) {
      this.bothStunnedSkipAt = 0; // Clear to prevent re-trigger
      this.handleBothStunnedSkip();
    }

    // === ROUND END COUNTDOWN ===
    if (this.phase === "round_end" && this.roundEndCountdownEndsAt > 0) {
      const remainingMs = this.roundEndCountdownEndsAt - now;
      const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1000));

      if (remainingMs <= 0) {
        // Round-end countdown finished
        this.roundEndCountdownEndsAt = 0;
        this.processRoundEndCountdownComplete();
      } else {
        // Update countdown text
        this.countdownText.setText(`Next round starting in ${remainingSeconds}`);
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

  /**
   * Initialize sticker picker with full sticker access for all players.
   */
  private async fetchAndInitializeStickerPicker(playerSprite: Phaser.GameObjects.Sprite): Promise<void> {
    if (this.hasCleanedUp) return;

    const ownedStickerIds: StickerId[] = STICKER_LIST.map((sticker) => sticker.id);

    if (this.hasCleanedUp) return;

    // Create sticker picker with fetched data
    this.stickerPicker = new StickerPicker(this, {
      x: GAME_DIMENSIONS.WIDTH - 290,
      y: GAME_DIMENSIONS.HEIGHT - 50,
      playerSprite: playerSprite,
      ownedStickers: ownedStickerIds,
      onStickerSelected: (stickerId) => {
        console.log("[FightScene] Sticker selected:", stickerId);
        // Emit event to send sticker to opponent via React/Supabase
        EventBus.emit("game:sendSticker", { stickerId });
      },
    });

    // Listen for opponent stickers
    this.onBus("game:stickerMessage", (data: unknown) => {
      const payload = data as { sender: string; senderAddress: string; stickerId: string; timestamp: number };
      this.handleOpponentSticker(payload);
    });
  }

  /**
   * Handle sticker message from broadcast.
   * Displays the sticker above the sender's character (works for both self and opponent).
   */
  private handleOpponentSticker(payload: { sender: string; senderAddress: string; stickerId: string; timestamp: number }): void {
    console.log("[FightScene] Received sticker broadcast:", payload);

    // Determine which sprite to display on based on sender
    const isOwnSticker = payload.sender === this.config.playerRole;
    const targetSprite = payload.sender === "player1" ? this.player1Sprite : this.player2Sprite;
    if (!targetSprite) return;

    // Remove existing sticker for this player if any
    if (isOwnSticker) {
      if (this.localStickerDisplay) {
        this.localStickerDisplay.destroy();
        this.localStickerDisplay = undefined;
      }
    } else {
      if (this.opponentStickerDisplay) {
        this.opponentStickerDisplay.destroy();
        this.opponentStickerDisplay = undefined;
      }
    }

    const textureKey = `sticker_${payload.stickerId}`;
    if (!this.textures.exists(textureKey)) {
      console.warn("[FightScene] Sticker texture not found:", textureKey);
      return;
    }

    // Create container for sticker above the sender's character
    const container = this.add.container(targetSprite.x, targetSprite.y - 250);
    container.setDepth(1000);

    // Sticker image
    const stickerImg = this.add.image(0, 0, textureKey);
    const targetSize = 80;
    const scale = Math.min(targetSize / stickerImg.width, targetSize / stickerImg.height);
    stickerImg.setScale(scale);
    container.add(stickerImg);

    // Store reference
    if (isOwnSticker) {
      this.localStickerDisplay = container;
    } else {
      this.opponentStickerDisplay = container;
    }

    // Pop-in animation
    container.setScale(0);
    this.tweens.add({
      targets: container,
      scaleX: 1,
      scaleY: 1,
      duration: 300,
      ease: "Back.easeOut",
    });

    // Swaying animation
    this.tweens.add({
      targets: container,
      y: container.y - 8,
      angle: { from: -5, to: 5 },
      duration: 800,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });

    // Fade out and destroy after display duration (5 seconds)
    this.time.delayedCall(5000, () => {
      if (container && container.active) {
        this.tweens.add({
          targets: container,
          alpha: 0,
          y: container.y - 30,
          duration: 400,
          ease: "Quad.easeIn",
          onComplete: () => {
            container.destroy();
            if (isOwnSticker && this.localStickerDisplay === container) {
              this.localStickerDisplay = undefined;
            } else if (!isOwnSticker && this.opponentStickerDisplay === container) {
              this.opponentStickerDisplay = undefined;
            }
          },
        });
      }
    });
  }



  /**
   * Sync client with comprehensive fight state from server.
   * This handles all phases: countdown, selecting, resolving, round_end, match_end
   */
  private syncWithFightState(state: any): void {
    console.log("[FightScene] Syncing with comprehensive fight state:", state);

    // Don't sync state during animations - it would show HP/energy changes prematurely
    if (this.phase === "resolving") {
      console.log("[FightScene] Ignoring syncWithFightState during resolving phase to prevent premature UI updates");
      return;
    }

    const now = Date.now();

    // Update server state
    this.serverState = {
      player1Health: state.player1Health,
      player1MaxHealth: state.player1MaxHealth,
      player2Health: state.player2Health,
      player2MaxHealth: state.player2MaxHealth,
      player1Energy: state.player1Energy,
      player1MaxEnergy: state.player1MaxEnergy,
      player2Energy: state.player2Energy,
      player2MaxEnergy: state.player2MaxEnergy,
      player1GuardMeter: state.player1GuardMeter || 0,
      player2GuardMeter: state.player2GuardMeter || 0,
      player1RoundsWon: state.player1RoundsWon || 0,
      player2RoundsWon: state.player2RoundsWon || 0,
      currentRound: state.currentRound || 1,
      player1IsStunned: state.player1IsStunned || false,
      player2IsStunned: state.player2IsStunned || false,
    };

    // Update UI
    this.syncUIWithCombatState();

    // Apply stun effects
    this.toggleStunEffect("player1", state.player1IsStunned ?? false);
    this.toggleStunEffect("player2", state.player2IsStunned ?? false);

    // IMMEDIATELY disable move buttons if local player is stunned
    // This prevents the player from clicking moves before realizing they're stunned
    this.updateMoveButtonAffordability();

    // IMMEDIATELY show stun indicator text if local player is stunned
    const isPlayer1 = this.config.playerRole === "player1";
    const amIStunned = isPlayer1 ? (state.player1IsStunned ?? false) : (state.player2IsStunned ?? false);
    const isOpponentStunned = isPlayer1 ? (state.player2IsStunned ?? false) : (state.player1IsStunned ?? false);

    if (amIStunned && isOpponentStunned) {
      this.turnIndicatorText.setText("BOTH PLAYERS STUNNED!");
      this.turnIndicatorText.setColor("#ff4444");
    } else if (amIStunned) {
      this.turnIndicatorText.setText("YOU ARE STUNNED!");
      this.turnIndicatorText.setColor("#ff4444");
    }

    // Update round score
    const roundsToWin = this.combatEngine ? this.combatEngine.getState().roundsToWin : 2;
    this.roundScoreText.setText(
      `Round ${state.currentRound}  |  ${state.player1RoundsWon} - ${state.player2RoundsWon}  (First to ${roundsToWin})`
    );

    // Handle phase-specific logic
    switch (state.phase) {
      case "countdown": {
        // We're in countdown phase - calculate remaining countdown time
        const countdownEndsAt = state.countdownEndsAt ? new Date(state.countdownEndsAt).getTime() : now;
        const remainingCountdownMs = countdownEndsAt - now;

        if (remainingCountdownMs > 0) {
          // Resume countdown
          const remainingSeconds = Math.ceil(remainingCountdownMs / 1000);
          const moveDeadlineAt = state.moveDeadlineAt ? new Date(state.moveDeadlineAt).getTime() : now + ROUND_MOVE_TIMER_MS;
          this.phase = "countdown";
          this.moveDeadlineAt = moveDeadlineAt;
          this.showCountdownThenSync(remainingSeconds, moveDeadlineAt);
        } else {
          // Countdown already finished, go to selecting
          const moveDeadlineAt = state.moveDeadlineAt ? new Date(state.moveDeadlineAt).getTime() : now + ROUND_MOVE_TIMER_MS;
          this.moveDeadlineAt = moveDeadlineAt;
          if (moveDeadlineAt > now) {
            this.startSynchronizedSelectionPhase(moveDeadlineAt);
          } else {
            // Timer expired, wait for server
            this.phase = "waiting";
            this.turnIndicatorText.setText("Waiting for round to start...");
            this.turnIndicatorText.setColor("#f97316");
          }
        }
        break;
      }

      case "selecting": {
        // We're in selection phase - resume with remaining time
        const moveDeadlineAt = state.moveDeadlineAt ? new Date(state.moveDeadlineAt).getTime() : now;
        this.moveDeadlineAt = moveDeadlineAt;

        if (moveDeadlineAt > now) {
          // Check if we already submitted
          const myRole = this.config.playerRole;
          const hasSubmittedMove = myRole === "player1" ? state.player1HasSubmittedMove : state.player2HasSubmittedMove;

          if (hasSubmittedMove) {
            // We already submitted - show waiting state
            this.phase = "selecting";
            this.isWaitingForOpponent = true;
            if (PRIVATE_ROUNDS_ENABLED) {
              this.startZkWaitingTicker("Commitment submitted. Waiting for opponent...", "#f97316");
            } else {
              this.turnIndicatorText.setText("Waiting for opponent...");
              this.turnIndicatorText.setColor("#f97316");
            }
          } else {
            // We need to make a move
            this.stopZkWaitingTicker();
            this.startSynchronizedSelectionPhase(moveDeadlineAt);
          }
        } else {
          // Timer expired, wait for resolution
          this.phase = "waiting";
          this.turnIndicatorText.setText("Waiting for resolution...");
          this.turnIndicatorText.setColor("#f97316");
        }
        break;
      }

      case "resolving": {
        this.stopZkWaitingTicker();
        // We're in resolving phase - animations are playing
        const animationEndsAt = state.animationEndsAt ? new Date(state.animationEndsAt).getTime() : now;

        if (animationEndsAt > now) {
          // Wait for animation to finish, then next phase
          this.phase = "resolving";
          this.isResolving = true;
          if (PRIVATE_ROUNDS_ENABLED) {
            this.setMoveButtonsVisible(false);
          }
          this.turnIndicatorText.setText(PRIVATE_ROUNDS_ENABLED ? "Phase 3/3: Enjoy the fight!" : "Resolving turn...");
          this.turnIndicatorText.setColor("#f97316");

          // Set a timeout to request next state after animation completes
          const waitMs = animationEndsAt - now + 500; // Add 500ms buffer
          this.time.delayedCall(waitMs, () => {
            if (this.phase === "resolving") {
              EventBus.emit("fight:requestRoundState", { matchId: this.config.matchId });
            }
          });
        } else {
          // Animation finished, wait for next phase
          this.phase = "waiting";
          this.turnIndicatorText.setText("Waiting for next turn...");
          this.turnIndicatorText.setColor(PRIVATE_ROUNDS_ENABLED ? "#22c55e" : "#f97316");
          if (PRIVATE_ROUNDS_ENABLED) {
            this.setPhaseThreeTimerTick();
          }
          EventBus.emit("fight:requestRoundState", { matchId: this.config.matchId });
        }
        break;
      }

      case "round_end": {
        this.stopZkWaitingTicker();
        // Round just ended - show round end UI
        this.phase = "round_end";
        this.turnIndicatorText.setText("Round over!");
        this.turnIndicatorText.setColor("#f97316");

        // The server will broadcast round_starting when next round begins
        // Just wait for that event
        break;
      }

      case "match_end": {
        this.stopZkWaitingTicker();
        // Match is over
        this.phase = "match_end";
        this.turnIndicatorText.setText("Match over!");
        this.turnIndicatorText.setColor("#22c55e");

        // Fetch final match results
        this.fetchFinalMatchState();
        break;
      }

      default:
        this.stopZkWaitingTicker();
        // Unknown phase - wait for server
        this.phase = "waiting";
        this.turnIndicatorText.setText("Synchronizing...");
        this.turnIndicatorText.setColor("#f97316");
        EventBus.emit("fight:requestRoundState", { matchId: this.config.matchId });
    }
  }

  // ===========================================================================
  // VISIBILITY HANDLING - Treat tab switching as disconnect/reconnect
  // ===========================================================================

  /**
   * Fetch final match state when match ended during disconnect.
   */
  private async fetchFinalMatchState(): Promise<void> {
    try {
      const response = await fetch(apiUrl(`/api/matches/${this.config.matchId}`));
      if (!response.ok) return;

      const data = await response.json();
      const match = (data?.match ?? data) as any;
      const status = String(match?.status || "").toLowerCase();
      const fightPhase = String(match?.fight_phase ?? match?.fightPhase ?? "");

      const onChainSessionIdRaw = match?.onchain_session_id ?? match?.onChainSessionId ?? null;
      const onChainSessionId = typeof onChainSessionIdRaw === "number"
        ? onChainSessionIdRaw
        : (typeof onChainSessionIdRaw === "string" && onChainSessionIdRaw.trim() !== "" ? Number(onChainSessionIdRaw) : null);

      const onChainTxHash = String(match?.onchain_result_tx_hash ?? match?.onChainTxHash ?? match?.onChainTxHash ?? "").trim() || undefined;
      const contractId = String(match?.onchain_contract_id ?? match?.contractId ?? match?.onChainContractId ?? "").trim() || undefined;
      const isPrivateRoom = !!(match?.room_code ?? match?.roomCode);

      const player1RoundsWon = Number(
        match?.player1_rounds_won ?? match?.player1RoundsWon ?? match?.player1_roundsWon ?? 0,
      );
      const player2RoundsWon = Number(
        match?.player2_rounds_won ?? match?.player2RoundsWon ?? match?.player2_roundsWon ?? 0,
      );

      // Strict ZK mode can keep status=in_progress while fight_phase is match_end.
      const roundsToWin = match?.format === "best_of_5" ? 3 : 2;
      const isTerminalByStatus = status === "completed" || status === "cancelled";
      const isTerminalByPhase = fightPhase === "match_end";
      const isTerminalByScore = player1RoundsWon >= roundsToWin || player2RoundsWon >= roundsToWin;
      const isTerminal = isTerminalByStatus || isTerminalByPhase || isTerminalByScore;

      this.debugMatchEndLog("fetchFinalMatchState:check", {
        status,
        fightPhase,
        player1RoundsWon,
        player2RoundsWon,
        roundsToWin,
        isTerminal,
      });

      if (!isTerminal) return;

      console.log("[FightScene] Match ended (or terminal), triggering end screen");

      const winnerAddress = String(match?.winner_address ?? match?.winnerAddress ?? "").trim() || null;

      // Determine winner role based on winner address (preferred) or score fallback.
      let winner: "player1" | "player2" | null = null;
      if (winnerAddress === this.config.player1Address) {
        winner = "player1";
      } else if (winnerAddress === this.config.player2Address) {
        winner = "player2";
      } else if (!winnerAddress) {
        winner = player1RoundsWon > player2RoundsWon ? "player1" : player2RoundsWon > player1RoundsWon ? "player2" : null;
      }

      const normalizedReason = status === "cancelled" ? "forfeit" : "knockout";

      EventBus.emit("game:matchEnded", {
        matchId: this.config.matchId,
        winner,
        winnerAddress,
        reason: normalizedReason,
        finalScore: {
          player1RoundsWon,
          player2RoundsWon,
        },
        // Ratings are authoritative via match_ended broadcast; omit here.
        isPrivateRoom,
        onChainSessionId: Number.isFinite(onChainSessionId as any) ? (onChainSessionId as number) : undefined,
        onChainTxHash,
        contractId,
      });
    } catch (error) {
      console.error("[FightScene] Failed to fetch final match state:", error);
    }
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
          tint: 0xff4444, // Red tint
          yoyo: true,
          repeat: -1,     // Infinite loop
          duration: 300,
          ease: 'Sine.easeInOut'
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

  /**
   * Apply immediate post-surge UI effects.
   * Stun is server-authoritative and must only come from combat resolution
   * (e.g. punch vs special). Do not mutate stun flags here.
   */
  private applyImmediateSurgeEffects(): void {
    // Keep affordability in sync with non-stun surge effects (e.g. block disable).
    this.updateMoveButtonAffordability();
  }

  /**
   * Sync client state with server game state after reconnection.
   */
  private syncWithServerState(gameState: any): void {
    // Don't sync state during animations - it would show HP/energy changes prematurely
    if (this.phase === "resolving") {
      console.log("[FightScene] Ignoring syncWithServerState during resolving phase to prevent premature UI updates");
      return;
    }

    // Update server state
    if (this.serverState) {
      this.serverState.player1Health = gameState.player1Health;
      this.serverState.player2Health = gameState.player2Health;
      this.serverState.player1Energy = gameState.player1Energy;
      this.serverState.player2Energy = gameState.player2Energy;
      this.serverState.player1RoundsWon = gameState.player1RoundsWon;
      this.serverState.player2RoundsWon = gameState.player2RoundsWon;
      this.serverState.currentRound = gameState.currentRound;
    }

    // Update UI
    this.syncUIWithCombatState();

    // Update round score
    const roundsToWin = this.combatEngine ? this.combatEngine.getState().roundsToWin : 2;
    this.roundScoreText.setText(
      `Round ${gameState.currentRound}  |  ${gameState.player1RoundsWon} - ${gameState.player2RoundsWon}  (First to ${roundsToWin})`
    );
  }

  // ===========================================================================
  // BACKGROUND
  // ===========================================================================

  private createBackground(): void {
    // Use the background image
    if (this.textures.exists("arena-bg")) {
      const bg = this.add.image(GAME_DIMENSIONS.CENTER_X, GAME_DIMENSIONS.CENTER_Y, "arena-bg");
      // Scale to fit the game dimensions
      bg.setDisplaySize(GAME_DIMENSIONS.WIDTH, GAME_DIMENSIONS.HEIGHT);
    } else {
      // Fallback gradient if image not loaded
      const graphics = this.add.graphics();
      graphics.fillGradientStyle(0x0a0a0a, 0x0a0a0a, 0x1a1a2e, 0x1a1a2e, 1);
      graphics.fillRect(0, 0, GAME_DIMENSIONS.WIDTH, GAME_DIMENSIONS.HEIGHT);
    }
  }

  // ===========================================================================
  // CHARACTER SPRITES
  // ===========================================================================

  private createCharacterSprites(): void {
    const p1Char = this.config.player1Character || "soroban-sage";
    const p2Char = this.config.player2Character || "soroban-sage";

    // Using getCharacterScale from sprite-config.ts which calculates:
    // scale = targetHeight / idleFrameHeight (280px regular, 336px tanks)

    // Player 1 sprite (left side)
    const p1TextureKey = `char_${p1Char}_idle`;
    const p1BaseYOffset = 50;
    const p1ConfigOffset = getCharacterYOffset(p1Char, "idle");

    this.player1Sprite = this.add.sprite(
      CHARACTER_POSITIONS.PLAYER1.X,
      CHARACTER_POSITIONS.PLAYER1.Y - p1BaseYOffset + p1ConfigOffset,
      p1TextureKey
    );

    const p1Scale = getCharacterScale(p1Char);
    this.player1Sprite.setScale(p1Scale);
    this.player1Sprite.setOrigin(0.5, 0.5);
    if (this.anims.exists(`${p1Char}_idle`)) {
      this.player1Sprite.play(`${p1Char}_idle`);
    }

    // Player 2 sprite (right side, flipped)
    const p2TextureKey = `char_${p2Char}_idle`;
    const p2BaseYOffset = 50;
    const p2ConfigOffset = getCharacterYOffset(p2Char, "idle");

    this.player2Sprite = this.add.sprite(
      CHARACTER_POSITIONS.PLAYER2.X,
      CHARACTER_POSITIONS.PLAYER2.Y - p2BaseYOffset + p2ConfigOffset,
      p2TextureKey
    );

    const p2Scale = getCharacterScale(p2Char);
    this.player2Sprite.setScale(p2Scale);
    this.player2Sprite.setOrigin(0.5, 0.5);
    this.player2Sprite.setFlipX(true);
    if (this.anims.exists(`${p2Char}_idle`)) {
      this.player2Sprite.play(`${p2Char}_idle`);
    }

    // Add identifier above the local player
    this.createPlayerIndicator();
  }

  private createPlayerIndicator(): void {
    // Skip "YOU" indicator for spectators
    if (this.config.isSpectator) {
      return;
    }

    const isP1You = this.config.playerRole === "player1";
    const targetSprite = isP1You ? this.player1Sprite : this.player2Sprite;

    // Position above the character
    // Characters are approx 200-250px tall after scaling (450 * 0.45 = ~200)
    const x = targetSprite.x;
    const y = targetSprite.y - 160; // Adjust height based on scaling

    // Create container for the indicator
    const container = this.add.container(x, y);

    // "YOU" text
    const text = this.add.text(0, 0, "YOU", {
      fontFamily: "monospace",
      fontSize: "14px",
      color: "#22c55e",
      fontStyle: "bold",
      backgroundColor: "#00000080",
      padding: { x: 4, y: 2 }
    }).setOrigin(0.5);

    // Arrow pointing down
    const arrow = this.add.text(0, 20, "▼", {
      fontFamily: "monospace",
      fontSize: "14px",
      color: "#22c55e",
    }).setOrigin(0.5);

    container.add([text, arrow]);

    // Add a simple bobbing animation
    this.tweens.add({
      targets: container,
      y: y - 10,
      duration: 1000,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut"
    });
  }

  // ===========================================================================
  // HEALTH BARS
  // ===========================================================================

  private createHealthBars(): void {
    const barWidth = UI_POSITIONS.HEALTH_BAR.PLAYER1.WIDTH;
    const barHeight = 25;

    // Player 1 Health Bar
    this.createHealthBar(
      UI_POSITIONS.HEALTH_BAR.PLAYER1.X,
      UI_POSITIONS.HEALTH_BAR.PLAYER1.Y,
      barWidth,
      barHeight,
      "player1"
    );

    // Player 2 Health Bar
    this.createHealthBar(
      UI_POSITIONS.HEALTH_BAR.PLAYER2.X,
      UI_POSITIONS.HEALTH_BAR.PLAYER2.Y,
      barWidth,
      barHeight,
      "player2"
    );

    // Player labels with character names
    const state = this.combatEngine.getState();

    // Identify local player
    const isP1You = this.config.playerRole === "player1";
    const isP2You = this.config.playerRole === "player2";

    // Highlight local player
    const p1Color = isP1You ? "#22c55e" : "#40e0d0";
    const p2Color = isP2You ? "#22c55e" : "#40e0d0";

    const p1LabelStyle = { fontFamily: "monospace", fontSize: "12px", color: p1Color, fontStyle: isP1You ? "bold" : "normal" };
    const p2LabelStyle = { fontFamily: "monospace", fontSize: "12px", color: p2Color, fontStyle: isP2You ? "bold" : "normal" };

    this.add.text(
      UI_POSITIONS.HEALTH_BAR.PLAYER1.X,
      UI_POSITIONS.HEALTH_BAR.PLAYER1.Y - 18,
      `P1${isP1You ? " (YOU)" : ""}: ${state.player1.characterId.toUpperCase()} (${state.player1.maxHp} HP)`,
      p1LabelStyle
    );

    this.add.text(
      UI_POSITIONS.HEALTH_BAR.PLAYER2.X + barWidth,
      UI_POSITIONS.HEALTH_BAR.PLAYER2.Y - 18,
      `P2${isP2You ? " (YOU)" : ""}: ${state.player2.characterId.toUpperCase()} (${state.player2.maxHp} HP)`,
      { ...p2LabelStyle, align: "right" }
    ).setOrigin(1, 0);
  }

  private createHealthBar(
    x: number,
    y: number,
    width: number,
    height: number,
    player: "player1" | "player2"
  ): void {
    const graphics = this.add.graphics();
    graphics.fillStyle(0x333333, 1);
    graphics.fillRoundedRect(x, y, width, height, 4);
    graphics.lineStyle(2, 0x40e0d0, 1);
    graphics.strokeRoundedRect(x, y, width, height, 4);

    const healthGraphics = this.add.graphics();
    if (player === "player1") {
      this.player1HealthBar = healthGraphics;
    } else {
      this.player2HealthBar = healthGraphics;
    }
  }

  // ===========================================================================
  // ENERGY BARS
  // ===========================================================================

  private createEnergyBars(): void {
    const barWidth = UI_POSITIONS.HEALTH_BAR.PLAYER1.WIDTH;
    const barHeight = 12;
    const yOffset = 30; // Below health bar

    // Player 1 Energy Bar
    this.createEnergyBar(
      UI_POSITIONS.HEALTH_BAR.PLAYER1.X,
      UI_POSITIONS.HEALTH_BAR.PLAYER1.Y + yOffset,
      barWidth,
      barHeight,
      "player1"
    );

    // Player 2 Energy Bar
    this.createEnergyBar(
      UI_POSITIONS.HEALTH_BAR.PLAYER2.X,
      UI_POSITIONS.HEALTH_BAR.PLAYER2.Y + yOffset,
      barWidth,
      barHeight,
      "player2"
    );

    // Energy labels
    const labelStyle = { fontFamily: "monospace", fontSize: "10px", color: "#3b82f6" };
    this.add.text(
      UI_POSITIONS.HEALTH_BAR.PLAYER1.X + barWidth + 5,
      UI_POSITIONS.HEALTH_BAR.PLAYER1.Y + yOffset,
      "EN",
      labelStyle
    );
    this.add.text(
      UI_POSITIONS.HEALTH_BAR.PLAYER2.X - 20,
      UI_POSITIONS.HEALTH_BAR.PLAYER2.Y + yOffset,
      "EN",
      labelStyle
    );
  }

  private createEnergyBar(
    x: number,
    y: number,
    width: number,
    height: number,
    player: "player1" | "player2"
  ): void {
    const bg = this.add.graphics();
    bg.fillStyle(0x222222, 1);
    bg.fillRoundedRect(x, y, width, height, 2);
    bg.lineStyle(1, 0x3b82f6, 0.5);
    bg.strokeRoundedRect(x, y, width, height, 2);

    const energyGraphics = this.add.graphics();
    if (player === "player1") {
      this.player1EnergyBar = energyGraphics;
    } else {
      this.player2EnergyBar = energyGraphics;
    }
  }

  // ===========================================================================
  // GUARD METERS
  // ===========================================================================

  private createGuardMeters(): void {
    const barWidth = UI_POSITIONS.HEALTH_BAR.PLAYER1.WIDTH;
    const barHeight = 6;
    const yOffset = 45;

    // Player 1 Guard Meter
    this.createGuardMeter(
      UI_POSITIONS.HEALTH_BAR.PLAYER1.X,
      UI_POSITIONS.HEALTH_BAR.PLAYER1.Y + yOffset,
      barWidth,
      barHeight,
      "player1"
    );

    // Player 2 Guard Meter
    this.createGuardMeter(
      UI_POSITIONS.HEALTH_BAR.PLAYER2.X,
      UI_POSITIONS.HEALTH_BAR.PLAYER2.Y + yOffset,
      barWidth,
      barHeight,
      "player2"
    );
  }

  private createGuardMeter(
    x: number,
    y: number,
    width: number,
    height: number,
    player: "player1" | "player2"
  ): void {
    const bg = this.add.graphics();
    bg.fillStyle(0x111111, 1);
    bg.fillRect(x, y, width, height);

    const guardGraphics = this.add.graphics();
    if (player === "player1") {
      this.player1GuardMeter = guardGraphics;
    } else {
      this.player2GuardMeter = guardGraphics;
    }
  }

  // ===========================================================================
  // ROUND TIMER
  // ===========================================================================

  private createRoundTimer(): void {
    const timerBg = this.add.graphics();
    timerBg.fillStyle(0x1a1a2e, 0.9);
    timerBg.fillCircle(UI_POSITIONS.TIMER.X, UI_POSITIONS.TIMER.Y, 35);
    timerBg.lineStyle(3, 0x40e0d0, 1);
    timerBg.strokeCircle(UI_POSITIONS.TIMER.X, UI_POSITIONS.TIMER.Y, 35);

    timerBg.strokeCircle(UI_POSITIONS.TIMER.X, UI_POSITIONS.TIMER.Y, 35);

    this.roundTimerText = TextFactory.createTimer(
      this,
      UI_POSITIONS.TIMER.X,
      UI_POSITIONS.TIMER.Y,
      "20"
    ).setOrigin(0.5);
  }

  // ===========================================================================
  // ROUND SCORE
  // ===========================================================================

  private createRoundScore(): void {
    this.roundScoreText = TextFactory.createScore(
      this,
      UI_POSITIONS.ROUND_INDICATOR.X,
      UI_POSITIONS.ROUND_INDICATOR.Y,
      "Round 1  |  0 - 0  (First to 2)"
    ).setOrigin(0.5);
  }

  // ===========================================================================
  // SETTINGS MENU & GAME CONTROLS
  // ===========================================================================

  private settingsContainer!: Phaser.GameObjects.Container;
  private isSettingsOpen: boolean = false;
  private hasRequestedCancel: boolean = false;
  private activeDialog?: Phaser.GameObjects.Container;
  private activeDialogBlocker?: Phaser.GameObjects.Rectangle;

  private createSettingsButton(): void {
    const radius = 24;
    // Bottom Left position
    const x = 50;
    const y = GAME_DIMENSIONS.HEIGHT - 50;

    const container = this.add.container(x, y);
    container.setDepth(2000); // Ensure it's above everything else

    const circle = this.add.graphics();
    circle.fillStyle(0x1a1a2e, 0.8);
    circle.fillCircle(0, 0, radius);
    circle.lineStyle(2, 0x4b5563, 1);
    circle.strokeCircle(0, 0, radius);

    // Gear Icon (Simplified geometry)
    const gear = this.add.graphics();
    gear.fillStyle(0x9ca3af, 1);
    gear.fillCircle(0, 0, 8);
    for (let i = 0; i < 8; i++) {
      const angle = Phaser.Math.DegToRad(i * 45);
      const bx = Math.cos(angle) * 12;
      const by = Math.sin(angle) * 12;
      gear.fillCircle(bx, by, 4);
    }
    gear.fillCircle(0, 0, 4); // Center hole (filled with bg color in next step)

    const centerHole = this.add.graphics();
    centerHole.fillStyle(0x1a1a2e, 1);
    centerHole.fillCircle(0, 0, 5);

    container.add([circle, gear, centerHole]);
    container.setSize(radius * 2, radius * 2);

    // Interactive
    // Interactive
    // User reported hitbox is too up-left. Shifting it MORE down-right.
    const hitArea = new Phaser.Geom.Circle(25, 25, radius);
    container.setInteractive(hitArea, Phaser.Geom.Circle.Contains);
    // Add hand cursor manually since we used a custom hit area
    container.input!.cursor = 'pointer';

    container.on("pointerover", () => {
      circle.lineStyle(2, 0x3b82f6, 1);
      circle.strokeCircle(0, 0, radius);
      this.tweens.add({ targets: gear, angle: 90, duration: 500, ease: "Back.easeOut" });
    });

    container.on("pointerout", () => {
      circle.lineStyle(2, 0x4b5563, 1);
      circle.strokeCircle(0, 0, radius);
      this.tweens.add({ targets: gear, angle: 0, duration: 500, ease: "Back.easeOut" });
    });

    container.on("pointerdown", () => {
      this.toggleSettingsMenu();
    });
  }

  private createSettingsMenu(): void {
    const width = 280;
    const height = 320;

    // Position menu above the button (bottom-left area)
    const x = 50 + width / 2;
    const y = GAME_DIMENSIONS.HEIGHT - 50 - height / 2 - 20;

    this.settingsContainer = this.add.container(x, y);
    this.settingsContainer.setVisible(false);
    this.settingsContainer.setDepth(2001); // Higher than button

    // Menu Background
    const bg = this.add.graphics();
    bg.fillStyle(0x0f172a, 0.95);
    bg.fillRoundedRect(-width / 2, -height / 2, width, height, 12);
    bg.lineStyle(1, 0x334155, 1);
    bg.strokeRoundedRect(-width / 2, -height / 2, width, height, 12);
    this.settingsContainer.add(bg);

    // Header
    const title = this.add.text(0, -140, "SETTINGS", {
      fontFamily: "monospace",
      fontSize: "16px",
      color: "#9ca3af",
      fontStyle: "bold"
    }).setOrigin(0.5);
    this.settingsContainer.add(title);

    // --- Audio Section ---
    const audioLabel = this.add.text(0, -110, "AUDIO", {
      fontFamily: "monospace",
      fontSize: "12px",
      color: "#6b7280"
    }).setOrigin(0.5);
    this.settingsContainer.add(audioLabel);

    // BGM Volume Slider
    this.bgmSlider = this.createVolumeSlider(0, -75, "Music", this.bgmVolume, (value) => {
      this.bgmVolume = value;
      this.applyBgmVolume();
      this.saveAudioSettings();
    });
    this.settingsContainer.add(this.bgmSlider);

    // SFX Volume Slider
    this.sfxSlider = this.createVolumeSlider(0, -30, "SFX", this.sfxVolume, (value) => {
      this.sfxVolume = value;
      this.saveAudioSettings();
      // Play a test sound when adjusting
      this.playSFX("sfx_click");
    });
    this.settingsContainer.add(this.sfxSlider);

    // Separator line
    const separator = this.add.graphics();
    separator.lineStyle(1, 0x334155, 0.5);
    separator.lineBetween(-100, 10, 100, 10);
    this.settingsContainer.add(separator);

    // Cancel Match Button
    const cancelBtn = this.createMenuButton(0, 55, "CANCEL MATCH", 0x6b7280, () => {
      this.toggleSettingsMenu();
      this.showConfirmationDialog(
        "REQUEST CANCEL?",
        "Ask opponent to cancel match. If they agree, funds are refunded.",
        "SEND REQUEST",
        0x3b82f6,
        () => {
          this.hasRequestedCancel = true;
          EventBus.emit("request-cancel");
        }
      );
    });

    // Surrender Button
    const surrenderBtn = this.createMenuButton(0, 110, "SURRENDER", 0xef4444, () => {
      this.toggleSettingsMenu();
      this.showConfirmationDialog(
        "SURRENDER MATCH?",
        "You will forfeit this match and lose rating.",
        "SURRENDER",
        0xef4444,
        () => EventBus.emit("request-surrender")
      );
    });

    this.settingsContainer.add([cancelBtn, surrenderBtn]);
  }

  /**
   * Create a volume slider control.
   */
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
    const knobRadius = 10;

    // Track offset logic to center everything better
    // Previous: Label(-100), TrackOffset(+40), TextOffset(+50) was shifted right
    // New: Label(-120), TrackOffset(+10), TextOffset(+25)

    // Label
    const labelText = this.add.text(-120, 0, label, {
      fontFamily: "monospace",
      fontSize: "12px",
      color: "#9ca3af"
    }).setOrigin(0, 0.5);
    container.add(labelText);

    // Track start X
    // sliderWidth is 140. Half is 70.
    // -70 + 10 = -60. Track spans -60 to +80. Center is +10.
    const trackOffsetX = 10;
    const trackStartX = -sliderWidth / 2 + trackOffsetX;

    // Track background
    const trackBg = this.add.graphics();
    trackBg.fillStyle(0x1e293b, 1);
    trackBg.fillRoundedRect(trackStartX, -sliderHeight / 2, sliderWidth, sliderHeight, 4);
    container.add(trackBg);

    // Track fill (progress)
    const trackFill = this.add.graphics();
    container.add(trackFill);

    // Knob
    const knob = this.add.graphics();
    container.add(knob);

    // Percentage text
    // 70 + 25 = 95. Right of track end (80) by 15px.
    const percentText = this.add.text(sliderWidth / 2 + 25, 0, `${Math.round(initialValue * 100)}%`, {
      fontFamily: "monospace",
      fontSize: "11px",
      color: "#6b7280"
    }).setOrigin(0, 0.5);
    container.add(percentText);

    // Update visual based on value
    const updateSliderVisual = (value: number) => {
      const fillWidth = sliderWidth * value;
      const knobX = trackStartX + fillWidth;

      trackFill.clear();
      trackFill.fillStyle(0x3b82f6, 1);
      trackFill.fillRoundedRect(trackStartX, -sliderHeight / 2, fillWidth, sliderHeight, 4);

      knob.clear();
      knob.fillStyle(0x3b82f6, 1);
      knob.fillCircle(knobX, 0, knobRadius);
      knob.fillStyle(0x1e40af, 1);
      knob.fillCircle(knobX, 0, knobRadius - 3);

      percentText.setText(`${Math.round(value * 100)}%`);
    };

    updateSliderVisual(initialValue);

    // Make the entire track area interactive
    // Area covering label to text roughly: -120 to +120
    const hitArea = this.add.rectangle(0, 0, 240, 30, 0x000000, 0);
    hitArea.setInteractive({ useHandCursor: true });
    container.add(hitArea);

    // Drag handling
    let isDragging = false;

    const calculateValue = (pointerX: number): number => {
      // Need to account for the container's world position and the track's local position
      // Local X inside container
      const localX = pointerX - container.x - this.settingsContainer.x;
      const trackEndX = trackStartX + sliderWidth;
      const clampedX = Phaser.Math.Clamp(localX, trackStartX, trackEndX);
      return (clampedX - trackStartX) / sliderWidth;
    };

    hitArea.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      isDragging = true;
      const newValue = calculateValue(pointer.x);
      updateSliderVisual(newValue);
      onChange(newValue);
    });

    this.input.on("pointermove", (pointer: Phaser.Input.Pointer) => {
      if (isDragging) {
        const newValue = calculateValue(pointer.x);
        updateSliderVisual(newValue);
        onChange(newValue);
      }
    });

    this.input.on("pointerup", () => {
      isDragging = false;
    });

    return container;
  }

  private createMenuButton(x: number, y: number, text: string, color: number, callback: () => void): Phaser.GameObjects.Container {
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
      fontStyle: "bold"
    }).setOrigin(0.5);

    container.add([bg, label]);
    container.setSize(width, height);
    container.setInteractive({ useHandCursor: true });

    container.on("pointerover", () => {
      bg.clear();
      bg.fillStyle(color, 0.4);
      bg.fillRoundedRect(-width / 2, -height / 2, width, height, 6);
    });
    container.on("pointerout", () => {
      bg.clear();
      bg.fillStyle(color, 0.2);
      bg.fillRoundedRect(-width / 2, -height / 2, width, height, 6);
    });
    container.on("pointerdown", callback);

    return container;
  }

  private toggleSettingsMenu(): void {
    this.isSettingsOpen = !this.isSettingsOpen;
    this.settingsContainer.setVisible(this.isSettingsOpen);

    if (this.isSettingsOpen) {
      this.settingsContainer.setScale(0.9);
      this.settingsContainer.setAlpha(0);
      this.tweens.add({
        targets: this.settingsContainer,
        scale: 1,
        alpha: 1,
        duration: 200,
        ease: "Back.easeOut"
      });
    }
  }

  private showCancelRequestDialog(): void {
    this.showConfirmationDialog(
      "OPPONENT WANTS TO CANCEL",
      "Your opponent requested to cancel the match. Funds will be refunded.",
      "AGREE & CANCEL",
      0x22c55e, // Green for agree
      () => {
        this.hasRequestedCancel = true;
        EventBus.emit("request-cancel");
      }
    );
  }

  // ===========================================================================
  // GAME CONTROL BUTTONS (REPLACED BY SETTINGS MENU)
  // ===========================================================================
  private createGameControlButtons(): void {
    // Deprecated - Logic moved to Settings Menu
  }

  private showConfirmationDialog(
    title: string,
    message: string,
    confirmText: string,
    confirmColor: number,
    onConfirm: () => void
  ): void {
    // Semi-transparent background blocker
    const blocker = this.add.rectangle(
      GAME_DIMENSIONS.CENTER_X,
      GAME_DIMENSIONS.CENTER_Y,
      GAME_DIMENSIONS.WIDTH,
      GAME_DIMENSIONS.HEIGHT,
      0x000000,
      0.7
    ).setInteractive(); // Block clicks

    const dialogWidth = 500;
    const dialogHeight = 300;
    const x = GAME_DIMENSIONS.CENTER_X;
    const y = GAME_DIMENSIONS.CENTER_Y;

    // Close existing dialog if any
    if (this.activeDialog) {
      this.activeDialog.destroy();
      this.activeDialog = undefined;
    }
    if (this.activeDialogBlocker) {
      this.activeDialogBlocker.destroy();
      this.activeDialogBlocker = undefined;
    }

    const container = this.add.container(x, y);
    this.activeDialog = container;
    this.activeDialogBlocker = blocker;

    // Dialog Background
    const bg = this.add.graphics();
    bg.fillStyle(0x1a1a2e, 1);
    bg.fillRoundedRect(-dialogWidth / 2, -dialogHeight / 2, dialogWidth, dialogHeight, 16);
    bg.lineStyle(2, 0x3b82f6, 1);
    bg.strokeRoundedRect(-dialogWidth / 2, -dialogHeight / 2, dialogWidth, dialogHeight, 16);

    // Title
    const titleText = this.add.text(0, -80, title, {
      fontFamily: "monospace",
      fontSize: "28px",
      color: "#ffffff",
      fontStyle: "bold"
    }).setOrigin(0.5);

    // Message
    const msgText = this.add.text(0, -20, message, {
      fontFamily: "monospace",
      fontSize: "18px",
      color: "#cccccc",
      align: "center",
      wordWrap: { width: 400 }
    }).setOrigin(0.5);

    // Confirm Button
    const confirmBtn = this.createDialogButton(
      100,
      80,
      180,
      50,
      confirmText,
      confirmColor,
      () => {
        container.destroy();
        this.activeDialog = undefined;
        blocker.destroy();
        this.activeDialogBlocker = undefined;
        onConfirm();
      }
    );

    // Cancel Button
    const cancelBtn = this.createDialogButton(
      -100,
      80,
      180,
      50,
      "BACK",
      0x6b7280,
      () => {
        container.destroy();
        this.activeDialog = undefined;
        blocker.destroy();
        this.activeDialogBlocker = undefined;
      }
    );

    container.add([bg, titleText, msgText, confirmBtn, cancelBtn]);

    // Pop-in animation
    container.setScale(0);
    this.tweens.add({
      targets: container,
      scale: 1,
      duration: 300,
      ease: "Back.easeOut"
    });
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
      fontStyle: "bold"
    }).setOrigin(0.5);

    container.add([bg, label]);
    container.setSize(width, height);
    container.setInteractive({ useHandCursor: true });

    container.on("pointerover", () => {
      container.setScale(1.05);
    });
    container.on("pointerout", () => {
      container.setScale(1);
    });
    container.on("pointerdown", callback);

    return container;
  }

  // ===========================================================================
  // MOVE BUTTONS
  // ===========================================================================

  private createMoveButtons(): void {
    // Skip move buttons entirely for spectators
    if (this.config.isSpectator) {
      // Show spectator indicator instead of move buttons
      this.add.text(
        GAME_DIMENSIONS.CENTER_X,
        GAME_DIMENSIONS.HEIGHT - 80,
        "SPECTATOR MODE",
        { fontFamily: "monospace", fontSize: "18px", color: "#a855f7", fontStyle: "bold" }
      ).setOrigin(0.5);
      return;
    }

    const moves: MoveType[] = ["punch", "kick", "block", "special"];
    const buttonWidth = 140; // Narrower, taller card style
    const buttonHeight = 160;
    const spacing = 20;
    const totalWidth = moves.length * buttonWidth + (moves.length - 1) * spacing;
    const startX = (GAME_DIMENSIONS.WIDTH - totalWidth) / 2 + buttonWidth / 2;
    const y = GAME_DIMENSIONS.HEIGHT - 100;

    moves.forEach((move, index) => {
      const x = startX + index * (buttonWidth + spacing);
      const button = this.createMoveButton(x, y, buttonWidth, buttonHeight, move);
      this.moveButtons.set(move, button);
    });
  }

  private createMoveButton(
    x: number,
    y: number,
    width: number,
    height: number,
    move: MoveType
  ): Phaser.GameObjects.Container {
    const container = this.add.container(x, y);

    // Colors based on move type
    let color = 0xffffff;
    if (move === "punch") color = 0xef4444;      // Red
    if (move === "kick") color = 0x06b6d4;       // Cyan
    if (move === "block") color = 0x22c55e;      // Green
    if (move === "special") color = 0xa855f7;    // Purple

    // Background (Card style)
    const bg = this.add.graphics();
    bg.fillStyle(0x1a1a2e, 0.9);
    bg.fillRoundedRect(-width / 2, -height / 2, width, height, 12);
    bg.lineStyle(2, color, 0.8);
    bg.strokeRoundedRect(-width / 2, -height / 2, width, height, 12);
    container.add(bg);

    // Inner Glow (simulated with alpha rect)
    const glow = this.add.graphics();
    glow.fillStyle(color, 0.1);
    glow.fillRoundedRect(-width / 2 + 5, -height / 2 + 5, width - 10, height - 10, 8);
    container.add(glow);

    // Icon
    const iconKey = `move_${move}`;
    const icon = this.add.image(0, -20, iconKey);
    icon.setDisplaySize(64, 64);
    container.add(icon);

    // Move Name
    const nameText = this.add.text(0, 25, move.toUpperCase(), {
      fontFamily: "monospace",
      fontSize: "16px",
      color: "#ffffff",
      fontStyle: "bold",
    }).setOrigin(0.5);
    container.add(nameText);

    // Energy Cost
    const cost = BASE_MOVE_STATS[move].energyCost;
    const costColor = cost === 0 ? "#22c55e" : "#3b82f6";
    const costText = this.add.text(0, 48, `${cost} Energy`, {
      fontFamily: "monospace",
      fontSize: "12px",
      color: costColor,
    }).setOrigin(0.5);
    container.add(costText);

    // Advantage Text
    let advantage = "";
    if (move === "punch") advantage = "Beats Special";
    if (move === "kick") advantage = "Beats Punch";
    if (move === "block") advantage = "Reflects Kick";
    if (move === "special") advantage = "Beats Block";

    const advText = this.add.text(0, 65, advantage, {
      fontFamily: "monospace",
      fontSize: "10px",
      color: "#aaaaaa",
      fontStyle: "italic"
    }).setOrigin(0.5);
    container.add(advText);

    // Interactive
    const hitArea = new Phaser.Geom.Rectangle(-width / 2, -height / 2, width, height);
    container.setInteractive(hitArea, Phaser.Geom.Rectangle.Contains);

    // Hover effects
    container.on("pointerover", () => {
      if (this.phase === "selecting" && this.canAffordMoveForSelection(move)) {
        this.playSFX("sfx_hover");
        this.tweens.add({
          targets: container,
          y: y - 10,
          scaleX: 1.05,
          scaleY: 1.05,
          duration: 200,
          ease: "Back.easeOut",
        });
        bg.clear();
        bg.fillStyle(0x1a1a2e, 0.95);
        bg.fillRoundedRect(-width / 2, -height / 2, width, height, 12);
        bg.lineStyle(3, color, 1);
        bg.strokeRoundedRect(-width / 2, -height / 2, width, height, 12);
      }
    });

    container.on("pointerout", () => {
      if (this.selectedMove !== move) {
        this.tweens.add({
          targets: container,
          y: y,
          scaleX: 1,
          scaleY: 1,
          duration: 200,
          ease: "Power2",
        });
        bg.clear();
        bg.fillStyle(0x1a1a2e, 0.9);
        bg.fillRoundedRect(-width / 2, -height / 2, width, height, 12);
        bg.lineStyle(2, color, 0.8);
        bg.strokeRoundedRect(-width / 2, -height / 2, width, height, 12);
      }
    });

    container.on("pointerdown", () => {
      if (this.phase === "selecting") {
        this.playSFX("sfx_click");
        this.selectMove(move);
      }
    });

    return container;
  }

  private selectMove(move: MoveType): void {
    // Spectators cannot select moves
    if (this.config.isSpectator) {
      return;
    }

    // Check if player is stunned - cannot select moves when stunned
    const role = this.config.playerRole;
    const isStunned = (role === "player1" && this.serverState?.player1IsStunned) ||
      (role === "player2" && this.serverState?.player2IsStunned);

    if (isStunned) {
      this.showFloatingText("You are stunned!", GAME_DIMENSIONS.CENTER_X, GAME_DIMENSIONS.HEIGHT - 150, "#ff4444");
      return;
    }

    // Private rounds: Phase 2 is 10-move preplanning, then one submit/sign.
    if (PRIVATE_ROUNDS_ENABLED) {
      if (move === "stunned") {
        this.showFloatingText("Cannot preplan stunned", GAME_DIMENSIONS.CENTER_X, GAME_DIMENSIONS.HEIGHT - 150, "#ff4444");
        return;
      }

      if (this.privateRoundPlannedMoves.length >= PRIVATE_ROUND_PLAN_TURNS) {
        return;
      }

      this.syncPrivateRoundPlanEnergyPreview();
      if (!this.canAppendPrivateRoundMove(move)) {
        this.showFloatingText("Not enough energy for this step", GAME_DIMENSIONS.CENTER_X, GAME_DIMENSIONS.HEIGHT - 150, "#ff4444");
        return;
      }

      this.privateRoundPlannedMoves.push(move as "punch" | "kick" | "block" | "special");
      this.syncPrivateRoundPlanEnergyPreview();

      this.selectedMove = move;
      this.updateButtonState(move, true);

      const progress = `${this.privateRoundPlannedMoves.length}/${PRIVATE_ROUND_PLAN_TURNS}`;
      this.turnIndicatorText.setText(`Phase 2/3: Plan moves (${progress})`);
      this.turnIndicatorText.setColor("#40e0d0");
      this.updatePrivatePlanEnergyText();
      this.updateMoveButtonAffordability();

      if (this.privateRoundPlannedMoves.length >= PRIVATE_ROUND_PLAN_TURNS) {
        this.isWaitingForOpponent = true;
        this.localMoveSubmitted = true;
        this.moveInFlight = true;
        this.startZkWaitingTicker("Generating zk proof for 10-move plan...", "#f97316");

        this.moveButtons.forEach(btn => {
          btn.disableInteractive();
          btn.setAlpha(0.5);
        });

        EventBus.emit("game:submitRoundPlan", {
          matchId: this.config.matchId,
          roundNumber: this.serverState?.currentRound ?? 1,
          movePlan: this.privateRoundPlannedMoves,
          playerRole: this.config.playerRole,
        });
      }
      return;
    }

    const currentEnergy = role === "player1"
      ? (this.serverState?.player1Energy ?? this.combatEngine.getState().player1.energy)
      : (this.serverState?.player2Energy ?? this.combatEngine.getState().player2.energy);

    const moveCost = BASE_MOVE_STATS[move].energyCost;

    if (currentEnergy < moveCost) {
      this.showFloatingText("Not enough energy!", GAME_DIMENSIONS.CENTER_X, GAME_DIMENSIONS.HEIGHT - 150, "#ff4444");
      return;
    }

    this.selectedMove = move;
    this.updateButtonState(move, true);

    this.isWaitingForOpponent = true;
    this.turnIndicatorText.setText("Submitting move...");
    this.turnIndicatorText.setColor("#f97316");

    this.moveButtons.forEach(btn => {
      btn.disableInteractive();
      if (btn !== this.moveButtons.get(move)) {
        btn.setAlpha(0.5);
      }
    });

    this.handleSubmitMove({
      matchId: this.config.matchId,
      moveType: move,
      playerRole: this.config.playerRole,
    });
  }

  private getSelectionEnergy(role: "player1" | "player2"): number {
    if (PRIVATE_ROUNDS_ENABLED && this.phase === "selecting") {
      this.syncPrivateRoundPlanEnergyPreview(role);
      return this.privateRoundPlanEnergyPreview;
    }

    return role === "player1"
      ? (this.serverState?.player1Energy ?? 0)
      : (this.serverState?.player2Energy ?? 0);
  }

  /**
   * Energy cost used for UI affordability and private-round plan-energy simulation.
   *
   * In private rounds we preplan 10 moves and show a "Plan Energy" preview. That preview must
   * include deterministic surge energy costs (e.g. Finality Fist adds extra energy cost to special),
   * otherwise the UI can allow later steps (like Kick) that the server will resolve as Block.
   */
  private getPlannedMoveEnergyCost(move: MoveType): number {
    const baseCost = BASE_MOVE_STATS[move].energyCost;

    // Only private-round planning uses extra deterministic costs.
    if (!PRIVATE_ROUNDS_ENABLED || this.phase !== "selecting") {
      return baseCost;
    }

    if (move !== "special") return baseCost;

    const surgeEffects = calculateSurgeEffects(
      this.activeSurges.player1,
      this.activeSurges.player2,
    );

    const myRole = this.config.playerRole;
    const myMods = myRole === "player1" ? surgeEffects.player1Modifiers : surgeEffects.player2Modifiers;
    const extra = Math.max(0, Math.floor(Number(myMods.specialEnergyCost ?? 0)));
    return baseCost + extra;
  }

  private getPrivateRoundPlanningBaseEnergy(role: "player1" | "player2"): number {
    if (PRIVATE_ROUNDS_ENABLED) {
      const serverEnergy = role === "player1"
        ? this.serverState?.player1Energy
        : this.serverState?.player2Energy;
      if (typeof serverEnergy === "number" && Number.isFinite(serverEnergy)) {
        return Math.max(0, Math.min(PRIVATE_ROUND_SERVER_MAX_ENERGY, Math.floor(serverEnergy)));
      }
      return PRIVATE_ROUND_SERVER_MAX_ENERGY;
    }

    const serverEnergy = role === "player1"
      ? this.serverState?.player1Energy
      : this.serverState?.player2Energy;
    if (typeof serverEnergy === "number" && Number.isFinite(serverEnergy)) {
      return Math.max(0, Math.floor(serverEnergy));
    }

    const localState = this.combatEngine.getState();
    const localEnergy = role === "player1" ? localState.player1.energy : localState.player2.energy;
    if (typeof localEnergy === "number" && Number.isFinite(localEnergy)) {
      return Math.max(0, Math.floor(localEnergy));
    }

    return PRIVATE_ROUND_SERVER_MAX_ENERGY;
  }

  private getPrivateRoundPlanningMaxEnergy(role: "player1" | "player2"): number {
    if (PRIVATE_ROUNDS_ENABLED) {
      return PRIVATE_ROUND_SERVER_MAX_ENERGY;
    }

    const serverMaxEnergy = role === "player1"
      ? this.serverState?.player1MaxEnergy
      : this.serverState?.player2MaxEnergy;
    if (typeof serverMaxEnergy === "number" && Number.isFinite(serverMaxEnergy) && serverMaxEnergy > 0) {
      return Math.floor(serverMaxEnergy);
    }

    const localState = this.combatEngine.getState();
    const localMaxEnergy = role === "player1" ? localState.player1.maxEnergy : localState.player2.maxEnergy;
    if (typeof localMaxEnergy === "number" && Number.isFinite(localMaxEnergy) && localMaxEnergy > 0) {
      return Math.floor(localMaxEnergy);
    }

    return PRIVATE_ROUND_SERVER_MAX_ENERGY;
  }

  private simulatePrivateRoundPlanEnergy(
    plannedMoves: Array<"punch" | "kick" | "block" | "special">,
    role: "player1" | "player2",
  ): number {
    const maxEnergy = this.privateRoundPlanMaxEnergy > 0
      ? this.privateRoundPlanMaxEnergy
      : this.getPrivateRoundPlanningMaxEnergy(role);
    let energy = Math.min(maxEnergy, this.privateRoundPlanBaseEnergy);

    for (const plannedMove of plannedMoves) {
      const moveCost = this.getPlannedMoveEnergyCost(plannedMove);
      if (energy < moveCost) {
        break;
      }

      const afterCost = Math.max(0, energy - moveCost);
      energy = Math.min(maxEnergy, afterCost + PRIVATE_ROUND_SERVER_ENERGY_REGEN);
    }

    return Math.max(0, Math.floor(energy));
  }

  private getPrivateRoundPlanAffordablePrefixLength(
    plannedMoves: Array<"punch" | "kick" | "block" | "special">,
    role: "player1" | "player2",
  ): number {
    const maxEnergy = this.privateRoundPlanMaxEnergy > 0
      ? this.privateRoundPlanMaxEnergy
      : this.getPrivateRoundPlanningMaxEnergy(role);
    let energy = Math.min(maxEnergy, this.privateRoundPlanBaseEnergy);
    let affordableCount = 0;

    for (const plannedMove of plannedMoves) {
      const moveCost = this.getPlannedMoveEnergyCost(plannedMove);
      if (energy < moveCost) {
        break;
      }

      const afterCost = Math.max(0, energy - moveCost);
      energy = Math.min(maxEnergy, afterCost + PRIVATE_ROUND_SERVER_ENERGY_REGEN);
      affordableCount += 1;
    }

    return affordableCount;
  }

  private canAppendPrivateRoundMove(move: MoveType): boolean {
    if (move === "stunned") return false;

    const role = this.config.playerRole;
    if (!role) return false;

    const candidatePlan = [
      ...this.privateRoundPlannedMoves,
      move as "punch" | "kick" | "block" | "special",
    ];

    return this.getPrivateRoundPlanAffordablePrefixLength(candidatePlan, role) === candidatePlan.length;
  }

  private syncPrivateRoundPlanEnergyPreview(role?: "player1" | "player2"): void {
    if (!PRIVATE_ROUNDS_ENABLED || this.phase !== "selecting") {
      return;
    }

    const myRole = role ?? this.config.playerRole;
    if (!myRole) return;

    this.privateRoundPlanEnergyPreview = this.simulatePrivateRoundPlanEnergy(
      this.privateRoundPlannedMoves,
      myRole,
    );
  }

  private canAffordMoveForSelection(move: MoveType): boolean {
    const role = this.config.playerRole;
    if (!role) return false;
    this.syncPrivateRoundPlanEnergyPreview(role);
    const currentEnergy = this.getSelectionEnergy(role);
    return currentEnergy >= this.getPlannedMoveEnergyCost(move);
  }

  private updateButtonState(selectedMove: MoveType | null, isSelected: boolean): void {
    const moves: MoveType[] = ["punch", "kick", "block", "special"];
    const isUsableGraphics = (graphics: Phaser.GameObjects.Graphics | undefined): graphics is Phaser.GameObjects.Graphics => {
      if (!graphics) return false;
      const anyGraphics = graphics as any;
      return !!anyGraphics.active && !!anyGraphics.scene && !!anyGraphics.scene.sys;
    };

    moves.forEach((move) => {
      const button = this.moveButtons.get(move);
      if (!button) return;

      if (move === selectedMove && isSelected) {
        // Selected state
        this.tweens.add({
          targets: button,
          alpha: 1,
          scaleX: 1.1,
          scaleY: 1.1,
          y: GAME_DIMENSIONS.HEIGHT - 110, // Move up slightly
          duration: 200,
          ease: "Back.easeOut",
        });

        // Highlight effect
        const bg = button.list[0] as Phaser.GameObjects.Graphics;
        if (isUsableGraphics(bg)) {
          bg.clear();
          bg.fillStyle(0x1a1a2e, 1);
          bg.fillRoundedRect(-70, -80, 140, 160, 12);
          bg.lineStyle(4, 0xffffff, 1); // White border for selection
          bg.strokeRoundedRect(-70, -80, 140, 160, 12);
        }

      } else {
        // Unselected state
        const isAffordable = this.canAffordMoveForSelection(move);

        this.tweens.add({
          targets: button,
          alpha: isAffordable ? 1 : 0.3,
          scaleX: 1,
          scaleY: 1,
          y: GAME_DIMENSIONS.HEIGHT - 100,
          duration: 200,
          ease: "Power2",
        });

        // Reset style
        // Colors based on move type
        let color = 0xffffff;
        if (move === "punch") color = 0xef4444;
        if (move === "kick") color = 0x06b6d4;
        if (move === "block") color = 0x22c55e;
        if (move === "special") color = 0xa855f7;

        const bg = button.list[0] as Phaser.GameObjects.Graphics;
        if (isUsableGraphics(bg)) {
          bg.clear();
          bg.fillStyle(0x1a1a2e, 0.9);
          bg.fillRoundedRect(-70, -80, 140, 160, 12);
          bg.lineStyle(2, color, 0.8);
          bg.strokeRoundedRect(-70, -80, 140, 160, 12);
        }
      }
    });
  }

  private updateMoveButtonAffordability(): void {
    if (this.config.isSpectator || !this.config.playerRole || !this.serverState) return;

    const staleMoves: string[] = [];
    const isUsableButton = (button: Phaser.GameObjects.Container | undefined): button is Phaser.GameObjects.Container => {
      if (!button) return false;
      const anyButton = button as any;
      return !!anyButton.active && !!anyButton.scene && !!anyButton.scene.sys;
    };

    // Strict disable if stunned or waiting for opponent
    const role = this.config.playerRole;
    const isStunned = (role === "player1" && this.serverState.player1IsStunned) ||
      (role === "player2" && this.serverState.player2IsStunned);

    if (isStunned || this.isWaitingForOpponent) {
      this.moveButtons.forEach((button, move) => {
        if (!isUsableButton(button)) {
          staleMoves.push(String(move));
          return;
        }
        button.setAlpha(0.3);
        try {
          button.disableInteractive();
        } catch {
          staleMoves.push(String(move));
          return;
        }
        // Tint children (Image, Text)
        button.list.forEach((child: any) => {
          if (child?.setTint && child?.active) child.setTint(0x555555);
        });
      });
      staleMoves.forEach((move) => this.moveButtons.delete(move as MoveType));
      return;
    }

    // During private preplan, use projected energy after planned picks.
    const currentEnergy = this.getSelectionEnergy(role);

    // Check if block is disabled due to opponent's pruned-rage surge
    const surgeEffects = calculateSurgeEffects(
      this.activeSurges.player1,
      this.activeSurges.player2
    );
    const playerMods = role === "player1" ? surgeEffects.player1Modifiers : surgeEffects.player2Modifiers;
    const opponentMods = role === "player1" ? surgeEffects.player2Modifiers : surgeEffects.player1Modifiers;
    const blockDisabled = isBlockDisabled(playerMods, opponentMods);

    // Update each move button based on affordability
    this.moveButtons.forEach((button, move) => {
      if (!isUsableButton(button)) {
        staleMoves.push(String(move));
        return;
      }

      const isAffordable = PRIVATE_ROUNDS_ENABLED && this.phase === "selecting"
        ? this.canAppendPrivateRoundMove(move)
        : currentEnergy >= this.getPlannedMoveEnergyCost(move);

      // Check if this specific move should be disabled
      const shouldDisable = !isAffordable || (move === "block" && blockDisabled);

      // Apply visual feedback for unaffordable/disabled moves (same as stunned)
      if (shouldDisable) {
        button.setAlpha(0.3);
        try {
          button.disableInteractive();
        } catch {
          staleMoves.push(String(move));
          return;
        }
        // Tint children to grayscale
        button.list.forEach((child: any) => {
          if (child?.setTint && child?.active) child.setTint(0x555555);
        });
      } else {
        button.setAlpha(1);
        try {
          button.setInteractive();
        } catch {
          staleMoves.push(String(move));
          return;
        }
        // Clear tint
        button.list.forEach((child: any) => {
          if (child?.clearTint && child?.active) child.clearTint();
        });
      }
    });

    staleMoves.forEach((move) => this.moveButtons.delete(move as MoveType));
  }

  // ===========================================================================
  // NARRATIVE DISPLAY
  // ===========================================================================

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

    this.privatePlanEnergyText = TextFactory.createSubtitle(
      this,
      GAME_DIMENSIONS.CENTER_X,
      158,
      "",
    ).setOrigin(0.5).setVisible(false);

    this.zkOnChainBadgeText = TextFactory.createSubtitle(
      this,
      GAME_DIMENSIONS.CENTER_X,
      186,
      "",
    ).setOrigin(0.5).setVisible(false);
  }

  private resetZkOnChainBadge(roundNumber: number): void {
    this.zkOnChainBadgeRound = roundNumber;
    if (!this.zkOnChainBadgeText || !this.zkOnChainBadgeText.active) return;
    try {
      this.zkOnChainBadgeText.setVisible(false);
      this.zkOnChainBadgeText.setText("");
    } catch {
      // ignore renderer/text teardown races
    }
  }

  private setZkOnChainBadge(params: { roundNumber: number; message: string; color: string }): void {
    if (!PRIVATE_ROUNDS_ENABLED) return;
    if (!this.zkOnChainBadgeText || !this.zkOnChainBadgeText.active) return;

    // Ignore late/out-of-round updates.
    if (params.roundNumber !== this.zkOnChainBadgeRound) return;

    try {
      this.zkOnChainBadgeText.setVisible(true);
      this.zkOnChainBadgeText.setText(params.message);
      this.zkOnChainBadgeText.setColor(params.color);
    } catch {
      // ignore renderer/text teardown races
    }
  }

  private updatePrivatePlanEnergyText(): void {
    if (!this.privatePlanEnergyText || !this.privatePlanEnergyText.active) return;

    const shouldShow = PRIVATE_ROUNDS_ENABLED && this.phase === "selecting";
    if (!shouldShow) {
      this.privatePlanEnergyText.setVisible(false);
      return;
    }

    this.privatePlanEnergyText.setVisible(true);
    try {
      this.privatePlanEnergyText.setText(`Plan Energy: ${this.privateRoundPlanEnergyPreview}`);
      const warnThreshold = this.getPlannedMoveEnergyCost("special");
      this.privatePlanEnergyText.setColor(this.privateRoundPlanEnergyPreview < warnThreshold ? "#f59e0b" : "#3b82f6");
    } catch {
      // ignore renderer/text disposal edge cases
    }
  }

  private setMoveButtonsVisible(visible: boolean): void {
    this.moveButtons.forEach((button) => {
      this.tweens.killTweensOf(button);
      button.setVisible(visible);
      if (!visible) {
        try {
          button.disableInteractive();
        } catch {
          // ignore stale/destroyed button
        }
      }
    });
  }

  // ===========================================================================
  // COUNTDOWN OVERLAY
  // ===========================================================================

  private createCountdownOverlay(): void {
    this.countdownText = TextFactory.createTitle(
      this,
      GAME_DIMENSIONS.CENTER_X,
      GAME_DIMENSIONS.CENTER_Y,
      ""
    ).setOrigin(0.5).setAlpha(0);

    // Using cyan color for countdown specifically to match the old style but better
    this.countdownText.setColor("#40e0d0");
  }

  // ===========================================================================
  // GAME FLOW
  // ===========================================================================

  private startRound(): void {
    // Deduplicate countdown - prevent playing the same countdown twice
    const currentRound = this.combatEngine?.getState()?.currentRound ?? 1;
    const currentTurn = this.combatEngine?.getState()?.currentTurn ?? 1;
    const turnKey = `${currentRound}-${currentTurn}-local`;

    if (this.lastCountdownStartedForTurn === turnKey) {
      console.log(`[FightScene] *** DUPLICATE startRound() BLOCKED for turn ${turnKey}`);
      return;
    }
    this.lastCountdownStartedForTurn = turnKey;
    console.log(`[FightScene] startRound() for turn ${turnKey}`);

    this.phase = "countdown";

    // Play SFX first (full "3-2-1 Fight" sequence)
    this.playSFX("sfx_cd_fight");

    // Set up deadline-based countdown (update() loop handles the rest)
    const now = Date.now();
    this.countdownEndsAt = now + 3300; // 3 seconds + 300ms delay
    this.countdownPhaseNumber = 0;
    this.moveDeadlineAt = now + 3300 + ROUND_MOVE_TIMER_MS; // Countdown + selection time
  }

  // showCountdown() method is deprecated - countdown is now handled by update() loop
  private showCountdown(seconds: number): void {
    // Legacy method - no longer used
    // Countdown is now handled by the update() loop using real-time deadlines
    console.warn("[FightScene] showCountdown() is deprecated - use deadline-based approach");
  }

  private startSelectionPhase(): void {
    this.phase = "selecting";
    this.setMoveButtonsVisible(true);
    this.selectedMove = null;
    this.turnTimer = Math.floor(ROUND_MOVE_TIMER_MS / 1000);
    this.localMoveSubmitted = false;
    this.moveInFlight = false;
    this.isWaitingForOpponent = false;
    this.timerExpiredHandled = false;
    this.turnIndicatorText.setText("Select your move!");

    this.hasRequestedCancel = false;

    // Update button affordability and reset visuals
    this.resetButtonVisuals();
    this.updateMoveButtonAffordability();

    // Timer is now handled by update() loop using this.moveDeadlineAt and Date.now()
    // No Phaser TimerEvent needed - this works correctly across tab switches

    // Sync UI
    this.syncUIWithCombatState();
  }

  private resetButtonVisuals(): void {
    if (!this.isSceneUiReady()) return;

    const moves: MoveType[] = ["punch", "kick", "block", "special"];
    const y = GAME_DIMENSIONS.HEIGHT - 100;

    const isUsableGraphics = (graphics: Phaser.GameObjects.Graphics | undefined): graphics is Phaser.GameObjects.Graphics => {
      if (!graphics) return false;
      const anyGraphics = graphics as any;
      return !!anyGraphics.active && !!anyGraphics.scene && !!anyGraphics.scene.sys;
    };

    moves.forEach((move) => {
      const button = this.moveButtons.get(move);
      if (!button) return;

      // Reset transforms
      this.tweens.add({
        targets: button,
        alpha: 1,
        scaleX: 1,
        scaleY: 1,
        y: y,
        duration: 200,
        ease: "Power2",
      });

      // Reset styling
      let color = 0xffffff;
      if (move === "punch") color = 0xef4444;
      if (move === "kick") color = 0x06b6d4;
      if (move === "block") color = 0x22c55e;
      if (move === "special") color = 0xa855f7;

      const bg = button.list[0] as Phaser.GameObjects.Graphics;
  if (!isUsableGraphics(bg)) return;
      bg.clear();
      bg.fillStyle(0x1a1a2e, 0.9);
      bg.fillRoundedRect(-70, -80, 140, 160, 12);
      bg.lineStyle(2, color, 0.8);
      bg.strokeRoundedRect(-70, -80, 140, 160, 12);
    });
  }

  private onTimerExpired(): void {
    console.log(`[FightScene] *** onTimerExpired called - phase: ${this.phase}, localMoveSubmitted: ${this.localMoveSubmitted}, moveInFlight: ${this.moveInFlight}, Timestamp: ${Date.now()}`);

    // If phase changed away from selecting (e.g. round resolved), don't process
    if (this.phase !== "selecting") {
      console.warn(`[FightScene] *** Timer expired but phase is not 'selecting' (phase: ${this.phase}), returning early`);
      return;
    }

    // Mark as handled to prevent duplicate calls from update() loop
    this.timerExpiredHandled = true;

    if (PRIVATE_ROUNDS_ENABLED) {
      if (!this.localMoveSubmitted && !this.moveInFlight) {
        while (this.privateRoundPlannedMoves.length < PRIVATE_ROUND_PLAN_TURNS) {
          this.privateRoundPlannedMoves.push("block");
        }

        this.localMoveSubmitted = true;
        this.moveInFlight = true;
        this.turnIndicatorText.setText("Time's up. Submitting fallback plan...");
        this.turnIndicatorText.setColor("#f97316");
        this.isWaitingForOpponent = true;

        EventBus.emit("game:submitRoundPlan", {
          matchId: this.config.matchId,
          roundNumber: this.serverState?.currentRound ?? 1,
          movePlan: this.privateRoundPlannedMoves,
          playerRole: this.config.playerRole,
        });
      } else if (this.localMoveSubmitted && !this.moveInFlight && this.privateRoundPlannedMoves.length === PRIVATE_ROUND_PLAN_TURNS) {
        this.turnIndicatorText.setText("Opponent timed out. Finalizing round...");
        this.turnIndicatorText.setColor("#f97316");
        EventBus.emit("game:submitRoundPlan", {
          matchId: this.config.matchId,
          roundNumber: this.serverState?.currentRound ?? 1,
          movePlan: this.privateRoundPlannedMoves,
          playerRole: this.config.playerRole,
        });
      }
      return;
    }

    // Update UI to show timeout state
    if (this.localMoveSubmitted) {
      this.turnIndicatorText.setText("Enforcing deadline...");
      this.turnIndicatorText.setColor("#22c55e");
    } else if (this.moveInFlight) {
      // Move was clicked but transaction is still being processed.
      // The server-side move-timeout API has a grace period that will wait
      // for the transaction to land before penalizing.
      this.turnIndicatorText.setText("Confirming transaction...");
      this.turnIndicatorText.setColor("#f59e0b");
    } else {
      this.turnIndicatorText.setText("Time's up! Checking server...");
      this.turnIndicatorText.setColor("#ff8800");
    }

    // Emit timeout event for server-side enforcement
    // The server move-timeout API has a built-in grace period: if one player's
    // move is missing and the deadline just barely passed, it waits up to 10s
    // for the in-flight transaction to land before penalizing.
    console.log(`[FightScene] *** Emitting game:timerExpired event`);
    EventBus.emit("game:timerExpired", {
      matchId: this.config.matchId,
      playerRole: this.config.playerRole,
    });
  }

  private showRoundEnd(state: CombatState): void {
    this.phase = "round_end";

    const winnerText = state.roundWinner === "player1" ? "PLAYER 1 WINS ROUND!" : "PLAYER 2 WINS ROUND!";
    this.countdownText.setText(winnerText);
    this.countdownText.setFontSize(36);
    this.countdownText.setAlpha(1);

    // Update round score
    this.roundScoreText.setText(
      `Round ${state.currentRound}  |  ${state.player1.roundsWon} - ${state.player2.roundsWon}  (First to 2)`
    );

    this.time.delayedCall(2000, () => {
      this.countdownText.setAlpha(0);
      this.countdownText.setFontSize(72);

      // Start new round
      this.combatEngine.startNewRound();
      this.syncUIWithCombatState();
      this.roundScoreText.setText(
        `Round ${this.combatEngine.getState().currentRound}  |  ${state.player1.roundsWon} - ${state.player2.roundsWon}  (First to 2)`
      );
      this.startRound();
    });
  }

  private showMatchEnd(winner: "player1" | "player2"): void {
    this.phase = "match_end";

    const isLocalWinner = winner === this.config.playerRole;
    const winnerText = isLocalWinner ? "VICTORY!" : "DEFEAT";

    this.countdownText.setText(winnerText);
    this.countdownText.setFontSize(64);
    this.countdownText.setColor(isLocalWinner ? "#22c55e" : "#ef4444");
    this.countdownText.setAlpha(1);

    // Play SFX
    this.playSFX(isLocalWinner ? "sfx_victory" : "sfx_defeat");

    // Play victory/dead animations with correct scaling
    const p1Char = this.config.player1Character || "soroban-sage";
    const p2Char = this.config.player2Character || "soroban-sage";

    // Helper to apply animation and scale safely
    const playEndAnim = (sprite: Phaser.GameObjects.Sprite, charId: string, animType: "victory" | "dead") => {
      const animKey = `${charId}_${animType}`;
      const scale = getAnimationScale(charId, animType);

      // Update scale for the specific animation
      sprite.setScale(scale);

      if (this.anims.exists(animKey)) {
        sprite.play(animKey);
      } else {
        console.warn(`[FightScene] Missing animation: ${animKey}, falling back to idle`);
        const idleKey = `${charId}_idle`;
        if (this.anims.exists(idleKey)) sprite.play(idleKey);
      }
    };

    if (winner === "player1") {
      playEndAnim(this.player1Sprite, p1Char, "victory");
      playEndAnim(this.player2Sprite, p2Char, "dead");
    } else {
      playEndAnim(this.player1Sprite, p1Char, "dead");
      playEndAnim(this.player2Sprite, p2Char, "victory");
    }

    // Victory celebration jump animation for the winner
    const winnerSprite = winner === "player1" ? this.player1Sprite : this.player2Sprite;
    this.tweens.add({
      targets: winnerSprite,
      y: winnerSprite.y - 30,
      duration: 500,
      yoyo: true,
      repeat: 2,
      ease: "Sine.easeOut",
    });
  }

  /**
   * Handle match cancellation (e.g., both players disconnected).
   * Shows cancellation overlay with refund information.
   */
  private handleMatchCancellation(payload: any): void {
    console.log("[FightScene] Handling match cancellation:", payload);

    // Transition to match end phase
    this.phase = "match_end";

    // Clear any deadline-based timers
    this.timerExpiredHandled = true;
    this.stunnedAutoSubmitAt = 0;
    this.bothStunnedSkipAt = 0;
    this.roundEndCountdownEndsAt = 0;
    this.countdownEndsAt = 0;

    // Hide move selection UI
    this.moveButtons.forEach((button) => button.setVisible(false));

    // Build cancellation message
    const refundStats = payload.refundStats || {};
    const totalRefunded = refundStats.totalRefunded || 0;
    const hasErrors = refundStats.errors && refundStats.errors.length > 0;
    const userBet = payload.userBet;

    let message = payload.message || "Both players disconnected";
    message += "\\n\\n";

    // Show personalized bet refund info if user had a bet
    if (userBet && userBet.amount > 0) {
      message += `YOUR BET: ${userBet.amount} KAS refunded`;
      message += `\\n(Predicted: ${userBet.prediction === "player1" ? "Player 1" : "Player 2"})`;
      message += "\\n\\n";
    }

    if (totalRefunded > 0) {
      message += `Total refunds: ${totalRefunded} transactions`;
      if (refundStats.stakesRefunded > 0) {
        message += `\\n- Entry stakes: ${refundStats.stakesRefunded} players`;
      }
      if (refundStats.betsRefunded > 0) {
        message += `\\n- Spectator bets: ${refundStats.betsRefunded} bettors`;
      }
    } else {
      message += "No refunds required";
    }

    if (hasErrors) {
      message += "\\n\\n[!] Some refunds failed - Contact support";
    }

    // Show cancellation overlay
    this.showCancellationOverlay(message, userBet);
  }

  /**
   * Show cancellation overlay with refund information.
   */
  private showCancellationOverlay(message: string, userBet?: { amount: number; prediction: string }): void {
    // Create dark overlay
    const overlay = this.add.rectangle(
      GAME_DIMENSIONS.CENTER_X,
      GAME_DIMENSIONS.CENTER_Y,
      GAME_DIMENSIONS.WIDTH,
      GAME_DIMENSIONS.HEIGHT,
      0x000000,
      0.85
    );

    // Create container
    const container = this.add.container(GAME_DIMENSIONS.CENTER_X, GAME_DIMENSIONS.CENTER_Y);

    // Background panel - taller if user has a bet
    const panelHeight = userBet ? 480 : 400;
    const bg = this.add.rectangle(0, 0, 700, panelHeight, 0x1a1a2e, 1);
    bg.setStrokeStyle(3, 0xff6b35);
    container.add(bg);

    // Title
    const title = this.add.text(0, -150, "MATCH CANCELLED", {
      fontFamily: "Orbitron",
      fontSize: "36px",
      color: "#ff6b35",
      fontStyle: "bold",
    }).setOrigin(0.5);
    container.add(title);

    // If user had a bet, show highlighted refund box
    let messageYOffset = -20;
    if (userBet && userBet.amount > 0) {
      const refundBox = this.add.rectangle(0, -70, 600, 80, 0x22c55e, 0.15);
      refundBox.setStrokeStyle(2, 0x22c55e);
      container.add(refundBox);

      const refundTitle = this.add.text(0, -95, "YOUR BET REFUNDED", {
        fontFamily: "Orbitron",
        fontSize: "16px",
        color: "#22c55e",
        fontStyle: "bold",
      }).setOrigin(0.5);
      container.add(refundTitle);

      const refundAmount = this.add.text(0, -65, `${userBet.amount} KAS`, {
        fontFamily: "Orbitron",
        fontSize: "28px",
        color: "#22c55e",
        fontStyle: "bold",
      }).setOrigin(0.5);
      container.add(refundAmount);

      const predictionText = this.add.text(0, -35, `Predicted: ${userBet.prediction === "player1" ? "Player 1" : "Player 2"}`, {
        fontFamily: "Exo 2",
        fontSize: "14px",
        color: "#888888",
      }).setOrigin(0.5);
      container.add(predictionText);

      messageYOffset = 40;
    }

    // Message
    const messageText = this.add.text(0, messageYOffset, message, {
      fontFamily: "Exo 2",
      fontSize: "16px",
      color: "#ffffff",
      align: "center",
      wordWrap: { width: 600 },
    }).setOrigin(0.5);
    container.add(messageText);

    // Return button
    const buttonY = userBet ? 180 : 140;
    const buttonBg = this.add.rectangle(0, buttonY, 250, 50, 0xff6b35, 1);
    const buttonText = this.add.text(0, buttonY, "Return to Home", {
      fontFamily: "Orbitron",
      fontSize: "20px",
      color: "#000000",
      fontStyle: "bold",
    }).setOrigin(0.5);

    buttonBg.setInteractive({ useHandCursor: true });
    buttonBg.on("pointerover", () => buttonBg.setFillStyle(0xffaa00));
    buttonBg.on("pointerout", () => buttonBg.setFillStyle(0xff6b35));
    buttonBg.on("pointerdown", () => {
      window.location.href = "/";
    });

    container.add([buttonBg, buttonText]);

    // Animate in
    overlay.setAlpha(0);
    container.setScale(0.8).setAlpha(0);

    this.tweens.add({
      targets: overlay,
      alpha: 0.85,
      duration: 300,
    });

    this.tweens.add({
      targets: container,
      scale: 1,
      alpha: 1,
      duration: 400,
      ease: "Back.easeOut",
    });
  }

  private showRematchButton(): void {
    const buttonWidth = 200;
    const buttonHeight = 50;
    const x = GAME_DIMENSIONS.CENTER_X;
    const y = GAME_DIMENSIONS.HEIGHT - 200;

    const container = this.add.container(x, y);

    const bg = this.add.graphics();
    bg.fillStyle(0x22c55e, 1);
    bg.fillRoundedRect(-buttonWidth / 2, -buttonHeight / 2, buttonWidth, buttonHeight, 8);

    const text = this.add.text(0, 0, "REMATCH", {
      fontFamily: "monospace",
      fontSize: "20px",
      color: "#ffffff",
      fontStyle: "bold",
    }).setOrigin(0.5);

    container.add([bg, text]);
    container.setSize(buttonWidth, buttonHeight);
    container.setInteractive({ useHandCursor: true });

    container.on("pointerdown", () => {
      // Restart the scene
      this.scene.restart(this.config);
    });
  }

  // ===========================================================================
  // UI SYNC
  // ===========================================================================

  private syncUIWithCombatState(): void {
    // If there's a pending server state (set during animation resolution),
    // apply it now - this is when we want the UI to show the new values
    if (this.pendingServerState) {
      console.log("[FightScene] Applying pendingServerState to serverState");
      this.serverState = this.pendingServerState;
      this.pendingServerState = null;
    }

    // Prefer server state if available
    if (this.serverState) {
      // Use server-provided state (authoritative)
      this.updateHealthBarDisplay("player1", this.serverState.player1Health, this.serverState.player1MaxHealth);
      this.updateHealthBarDisplay("player2", this.serverState.player2Health, this.serverState.player2MaxHealth);
      this.updateEnergyBarDisplay("player1", this.serverState.player1Energy, this.serverState.player1MaxEnergy);
      this.updateEnergyBarDisplay("player2", this.serverState.player2Energy, this.serverState.player2MaxEnergy);
      this.updateGuardMeterDisplay("player1", this.serverState.player1GuardMeter);
      this.updateGuardMeterDisplay("player2", this.serverState.player2GuardMeter);
    } else {
      // Fallback to local combat engine state
      const state = this.combatEngine.getState();
      this.updateHealthBarDisplay("player1", state.player1.hp, state.player1.maxHp);
      this.updateHealthBarDisplay("player2", state.player2.hp, state.player2.maxHp);
      this.updateEnergyBarDisplay("player1", state.player1.energy, state.player1.maxEnergy);
      this.updateEnergyBarDisplay("player2", state.player2.energy, state.player2.maxEnergy);
      this.updateGuardMeterDisplay("player1", state.player1.guardMeter);
      this.updateGuardMeterDisplay("player2", state.player2.guardMeter);
    }

    // Update timer color
    this.roundTimerText.setColor("#40e0d0");

    // Update move button affordability - Removed
    // this.updateMoveButtonAffordability();

    // Emit UI update for React Overlay
    EventBus.emit("ui:update", {
      energy: (this.config.playerRole === "player1") ?
        ((this.serverState?.player1Energy ?? this.combatEngine.getState().player1.energy)) :
        ((this.serverState?.player2Energy ?? this.combatEngine.getState().player2.energy)),
      maxEnergy: (this.config.playerRole === "player1") ?
        ((this.serverState?.player1MaxEnergy ?? this.combatEngine.getState().player1.maxEnergy)) :
        ((this.serverState?.player2MaxEnergy ?? this.combatEngine.getState().player2.maxEnergy)),
      health: (this.config.playerRole === "player1") ?
        ((this.serverState?.player1Health ?? this.combatEngine.getState().player1.hp)) :
        ((this.serverState?.player2Health ?? this.combatEngine.getState().player2.hp)),
      maxHealth: (this.config.playerRole === "player1") ?
        ((this.serverState?.player1MaxHealth ?? this.combatEngine.getState().player1.maxHp)) :
        ((this.serverState?.player2MaxHealth ?? this.combatEngine.getState().player2.maxHp)),
    });
  }

  private updateHealthBarDisplay(player: "player1" | "player2", hp: number, maxHp: number): void {
    const graphics = player === "player1" ? this.player1HealthBar : this.player2HealthBar;
    if (!graphics) return; // Guard against uninitialized graphics

    const barWidth = UI_POSITIONS.HEALTH_BAR.PLAYER1.WIDTH;
    const barHeight = 25;
    // Clamp percentage to [0, 1] to prevent bar overflow
    const healthPercent = Math.min(1, Math.max(0, hp) / (maxHp || 1));
    const innerWidth = (barWidth - 4) * healthPercent;

    const x = player === "player1" ? UI_POSITIONS.HEALTH_BAR.PLAYER1.X : UI_POSITIONS.HEALTH_BAR.PLAYER2.X;
    const y = player === "player1" ? UI_POSITIONS.HEALTH_BAR.PLAYER1.Y : UI_POSITIONS.HEALTH_BAR.PLAYER2.Y;

    graphics.clear();

    let color = 0x00ff88;
    if (healthPercent <= 0.25) color = 0xff4444;
    else if (healthPercent <= 0.5) color = 0xffaa00;

    graphics.fillStyle(color, 1);
    if (player === "player2") {
      graphics.fillRoundedRect(x + 2 + (barWidth - 4 - innerWidth), y + 2, innerWidth, barHeight - 4, 3);
    } else {
      graphics.fillRoundedRect(x + 2, y + 2, innerWidth, barHeight - 4, 3);
    }
  }

  private updateEnergyBarDisplay(player: "player1" | "player2", energy: number, maxEnergy: number): void {
    const graphics = player === "player1" ? this.player1EnergyBar : this.player2EnergyBar;
    if (!graphics) return; // Guard against uninitialized graphics

    const barWidth = UI_POSITIONS.HEALTH_BAR.PLAYER1.WIDTH;
    const barHeight = 12;
    const yOffset = 30;
    // Clamp percentage to [0, 1] to prevent bar overflow
    const energyPercent = Math.min(1, Math.max(0, energy) / (maxEnergy || 1));
    const innerWidth = (barWidth - 2) * energyPercent;

    const x = player === "player1" ? UI_POSITIONS.HEALTH_BAR.PLAYER1.X : UI_POSITIONS.HEALTH_BAR.PLAYER2.X;
    const y = (player === "player1" ? UI_POSITIONS.HEALTH_BAR.PLAYER1.Y : UI_POSITIONS.HEALTH_BAR.PLAYER2.Y) + yOffset;

    graphics.clear();
    graphics.fillStyle(0x3b82f6, 1);

    if (player === "player2") {
      graphics.fillRoundedRect(x + 1 + (barWidth - 2 - innerWidth), y + 1, innerWidth, barHeight - 2, 2);
    } else {
      graphics.fillRoundedRect(x + 1, y + 1, innerWidth, barHeight - 2, 2);
    }
  }

  private updateGuardMeterDisplay(player: "player1" | "player2", guardMeter: number): void {
    const graphics = player === "player1" ? this.player1GuardMeter : this.player2GuardMeter;
    if (!graphics) return; // Guard against uninitialized graphics

    const barWidth = UI_POSITIONS.HEALTH_BAR.PLAYER1.WIDTH;
    const barHeight = 6;
    const yOffset = 45;
    // Clamp percentage to [0, 1] to prevent bar overflow
    const guardPercent = Math.min(1, Math.max(0, guardMeter) / 100);
    const innerWidth = barWidth * guardPercent;

    const x = player === "player1" ? UI_POSITIONS.HEALTH_BAR.PLAYER1.X : UI_POSITIONS.HEALTH_BAR.PLAYER2.X;
    const y = (player === "player1" ? UI_POSITIONS.HEALTH_BAR.PLAYER1.Y : UI_POSITIONS.HEALTH_BAR.PLAYER2.Y) + yOffset;

    graphics.clear();

    // Color based on guard level (orange = danger of breaking)
    let color = 0xf97316;
    if (guardPercent >= 0.75) color = 0xef4444;

    graphics.fillStyle(color, 1);
    if (player === "player2") {
      graphics.fillRect(x + (barWidth - innerWidth), y, innerWidth, barHeight);
    } else {
      graphics.fillRect(x, y, innerWidth, barHeight);
    }
  }

  // ===========================================================================
  // HELPERS
  // ===========================================================================

  private showFloatingText(text: string, x: number, y: number, color: string): void {
    const floatingText = this.add.text(x, y, text, {
      fontFamily: "monospace",
      fontSize: "24px",
      color: color,
      fontStyle: "bold",
    }).setOrigin(0.5);

    this.tweens.add({
      targets: floatingText,
      y: y - 50,
      alpha: 0,
      duration: 1000,
      onComplete: () => floatingText.destroy(),
    });
  }

  private onBus(event: string, callback: (data: unknown) => void): void {
    EventBus.on(event as any, callback as any, this);
    this.busDisposers.push(() => {
      try {
        EventBus.off(event as any, callback as any, this);
      } catch {
        // ignore
      }
    });
  }

  private enqueueRoundResolved(payload: any): void {
    this.roundResolvedQueue.push(payload);

    // Keep playback deterministic even if events arrive slightly out of order.
    this.roundResolvedQueue.sort((a, b) => {
      const ar = Number(a?.roundNumber ?? 0);
      const br = Number(b?.roundNumber ?? 0);
      if (ar !== br) return ar - br;
      const at = Number(a?.turnNumber ?? 0);
      const bt = Number(b?.turnNumber ?? 0);
      return at - bt;
    });

    this.tryPlayNextResolvedTurn();
  }

  private tryPlayNextResolvedTurn(): void {
    if (this.hasCleanedUp) return;
    if (this.isResolving) return;

    const next = this.roundResolvedQueue.shift();
    if (!next) return;

    this.handleServerRoundResolved(next);
  }

  private cleanupScene(): void {
    if (this.hasCleanedUp) return;
    this.hasCleanedUp = true;

    if (this.visibilityChangeHandler) {
      document.removeEventListener("visibilitychange", this.visibilityChangeHandler);
      this.visibilityChangeHandler = undefined;
    }

    // Stop any ZK tickers/toasts.
    try {
      this.stopZkWaitingTicker();
    } catch {
      // ignore
    }

    if (this.activeTransactionToast) {
      try {
        this.activeTransactionToast.close();
      } catch {
        // ignore
      }
      this.activeTransactionToast = undefined;
    }

    // Unsubscribe from EventBus events registered by this scene instance.
    const disposers = this.busDisposers.splice(0);
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // ignore
      }
    }
  }

  private setupEventListeners(): void {
    // Listen for round start (triggered by React wrapper)
    this.onBus("round:start", (data: unknown) => {
      this.startRound();
    });

    this.onBus("game:opponentRejected", () => {
      // Deprecated - handled by game:moveRejected now
    });

    // ========================================
    // PRODUCTION MODE EVENTS (from realtime channel)
    // ========================================

    // Listen for opponent's move submission (show "opponent ready" indicator)
    this.onBus("game:moveSubmitted", (data: unknown) => {
      const payload = data as { player: string };
      const isOpponentMove =
        (this.config.playerRole === "player1" && payload.player === "player2") ||
        (this.config.playerRole === "player2" && payload.player === "player1");

      if (isOpponentMove) {
        this.isWaitingForOpponent = false;
        this.turnIndicatorText.setText("Opponent locked in!");
        this.turnIndicatorText.setColor("#22c55e");
      }
    });

    // Listen for move in-flight (player clicked move, transaction is being processed)
    this.onBus("game:moveInFlight", (data: unknown) => {
      const payload = data as { player: string; cancelled?: boolean };
      if (payload.player === this.config.playerRole) {
        if (payload.cancelled) {
          console.log(`[FightScene] Move in-flight cancelled for ${payload.player}`);
          this.moveInFlight = false;
          if (this.turnIndicatorText?.text === "Submitting move...") {
            this.isWaitingForOpponent = false;
            this.turnIndicatorText.setText("Select your move!");
            this.turnIndicatorText.setColor("#40e0d0");
            this.selectedMove = null;
            this.updateMoveButtonAffordability();
          }
        } else {
          console.log(`[FightScene] Move in-flight for ${payload.player}`);
          this.moveInFlight = true;
        }
      }
    });

    // Listen for move confirmation (when player signs transaction)
    this.moveConfirmedListener = (data: unknown) => {
      if (!this.isSceneUiReady()) return;
      if (!this.isActiveText(this.turnIndicatorText)) return;

      const payload = data as { player: string; txId?: string; onChainTxHash?: string };

      // If we confirmed our move, update UI but KEEP the timer running
      // We need the timer to expire to enforce deadline if opponent doesn't submit
      if (payload.player === this.config.playerRole) {
        // Mark that we submitted (tracked locally for UI purposes)
        this.localMoveSubmitted = true;
        this.moveInFlight = false; // Transaction completed successfully

        // Update UI to show waiting state, but don't destroy the timer
        if (PRIVATE_ROUNDS_ENABLED) {
          this.startZkWaitingTicker("Commitment sent. Waiting for opponent...", "#22c55e");
        } else {
          this.turnIndicatorText.setText("Waiting for opponent...");
          this.turnIndicatorText.setColor("#22c55e");
        }

        // Show transaction toast if we have a tx hash
        const txId = payload.txId || payload.onChainTxHash;
        if (txId) {
          this.showTransactionToast(txId);
        }
      }
    };
    this.onBus("game:moveConfirmed", this.moveConfirmedListener);

    // Private turn flow status updates (ZK commit/reveal each turn)
    this.privateRoundCommittedListener = (data: unknown) => {
      if (!this.isSceneUiReady()) return;
      if (!this.isActiveText(this.turnIndicatorText)) return;

      const payload = data as {
        bothCommitted?: boolean;
        bothRevealed?: boolean;
        player1Committed?: boolean;
        player2Committed?: boolean;
      };

      if (this.phase !== "selecting") return;

      if (payload.bothRevealed) {
        if (PRIVATE_ROUNDS_ENABLED) {
          this.stopZkWaitingTicker();
          this.phase = "resolving";
          this.isWaitingForOpponent = true;
          this.time.delayedCall(0, () => {
            if (this.isSceneUiReady()) this.setMoveButtonsVisible(false);
          });
          this.turnIndicatorText.setText("Phase 3/3: Enjoy the fight!");
          this.turnIndicatorText.setColor("#22c55e");
          if (this.isActiveText(this.roundTimerText)) {
            this.roundTimerText.setText("✓");
            this.roundTimerText.setColor("#22c55e");
          }
        } else {
          this.turnIndicatorText.setText("Both moves submitted. Resolving turn...");
          this.turnIndicatorText.setColor("#22c55e");
        }
        return;
      }

      if (payload.bothCommitted) {
        if (PRIVATE_ROUNDS_ENABLED) {
          this.showZkWaitingStatus("Both commitments locked. Finalizing zk checks...", "#22c55e", 2000);
          this.stopZkWaitingTicker();
          this.phase = "resolving";
          this.isWaitingForOpponent = true;
          this.time.delayedCall(0, () => {
            if (this.isSceneUiReady()) this.setMoveButtonsVisible(false);
          });
          this.turnIndicatorText.setText("Phase 3/3: Enjoy the fight!");
          this.turnIndicatorText.setColor("#22c55e");
          if (this.isActiveText(this.roundTimerText)) {
            this.roundTimerText.setText("✓");
            this.roundTimerText.setColor("#22c55e");
          }
        } else {
          this.turnIndicatorText.setText("Both moves committed. Waiting to resolve...");
          this.turnIndicatorText.setColor("#22c55e");
        }
        return;
      }

      if (payload.player1Committed || payload.player2Committed) {
        this.startZkWaitingTicker("Commitment recorded. Waiting for opponent...", "#22c55e");
      }
    };
    this.onBus("game:privateRoundCommitted", this.privateRoundCommittedListener);

    this.zkProgressListener = (data: unknown) => {
      if (!PRIVATE_ROUNDS_ENABLED) return;
      if (!this.isSceneUiReady()) return;

      const payload = data as { message?: string; color?: string; stickyMs?: number; stage?: string; roundNumber?: number };
      if (!payload?.message) return;

      // Important: on-chain verification can complete while Phase 3 animations are playing.
      // Those progress events should NOT override the Phase 3 narration/indicator, otherwise
      // the UI looks like it "jumps" or desyncs mid-move.
      // We still allow the on-chain badge to update, but we suppress ticker/status updates.
      const isMidResolution = this.isResolving || this.phase === "resolving";

      const currentRound = this.serverState?.currentRound ?? this.combatEngine?.getState()?.currentRound ?? 1;
      const payloadRound = Number(payload.roundNumber ?? currentRound);

      if (payload.stage === "onchain_verify_submitting") {
        this.setZkOnChainBadge({
          roundNumber: payloadRound,
          message: "⏳ On-chain verify pending...",
          color: "#f97316",
        });
      }

      if (payload.stage === "onchain_verify_ok") {
        this.setZkOnChainBadge({
          roundNumber: payloadRound,
          message: "✓ On-chain verified",
          color: "#22c55e",
        });
      }

      if (payload.stage === "onchain_verify_failed" || payload.stage === "onchain_verify_exception") {
        this.setZkOnChainBadge({
          roundNumber: payloadRound,
          message: "✗ On-chain verify failed",
          color: "#ef4444",
        });
      }

      if (isMidResolution) return;

      this.startZkWaitingTicker();
      this.showZkWaitingStatus(payload.message, payload.color || "#22c55e", payload.stickyMs || 1600);
    };
    this.onBus("game:zkProgress", this.zkProgressListener);

    // Listen for round resolution (from server combat resolver)
    this.onBus("game:roundResolved", (data: unknown) => {
      const raw = data as any;
      const eventRoundNumber = Number(raw.roundNumber ?? this.serverState?.currentRound ?? 1);
      const eventTurnNumber = Number(raw.turnNumber ?? this.combatEngine?.getState()?.currentTurn ?? 1);

      const currentState = this.serverState;
      const localState = this.combatEngine.getState();

      const player1Health = raw.player1Health ?? raw.player1HealthAfter ?? raw.player1?.healthAfter ?? currentState?.player1Health ?? localState.player1.hp;
      const player2Health = raw.player2Health ?? raw.player2HealthAfter ?? raw.player2?.healthAfter ?? currentState?.player2Health ?? localState.player2.hp;
      const player1Energy = raw.player1Energy ?? raw.player1EnergyAfter ?? raw.player1?.energyAfter ?? currentState?.player1Energy ?? localState.player1.energy;
      const player2Energy = raw.player2Energy ?? raw.player2EnergyAfter ?? raw.player2?.energyAfter ?? currentState?.player2Energy ?? localState.player2.energy;
      const player1GuardMeter = raw.player1GuardMeter ?? raw.player1GuardAfter ?? raw.player1?.guardMeterAfter ?? currentState?.player1GuardMeter ?? localState.player1.guardMeter;
      const player2GuardMeter = raw.player2GuardMeter ?? raw.player2GuardAfter ?? raw.player2?.guardMeterAfter ?? currentState?.player2GuardMeter ?? localState.player2.guardMeter;

      const normalizedRoundWinner = raw.roundWinner === "draw" ? null : (raw.roundWinner ?? null);
      const isRoundOver = Boolean(raw.isRoundOver);

      const fallbackP1RoundsWon = (() => {
        const base = currentState?.player1RoundsWon ?? 0;
        if (isRoundOver && normalizedRoundWinner === "player1") {
          return base + 1;
        }
        return base;
      })();

      const fallbackP2RoundsWon = (() => {
        const base = currentState?.player2RoundsWon ?? 0;
        if (isRoundOver && normalizedRoundWinner === "player2") {
          return base + 1;
        }
        return base;
      })();

      const payload = {
        roundNumber: eventRoundNumber,
        turnNumber: eventTurnNumber,
        player1: {
          move: (raw.player1?.move ?? raw.player1Move ?? "block") as MoveType,
          damageDealt: Number(raw.player1?.damageDealt ?? raw.player1DamageDealt ?? 0),
          damageTaken: Number(raw.player1?.damageTaken ?? raw.player2?.damageDealt ?? raw.player2DamageDealt ?? 0),
          outcome: raw.player1?.outcome,
          hpRegen: Number(raw.player1?.hpRegen ?? 0),
          lifesteal: Number(raw.player1?.lifesteal ?? 0),
          energyDrained: Number(raw.player1?.energyDrained ?? 0),
        },
        player2: {
          move: (raw.player2?.move ?? raw.player2Move ?? "block") as MoveType,
          damageDealt: Number(raw.player2?.damageDealt ?? raw.player2DamageDealt ?? 0),
          damageTaken: Number(raw.player2?.damageTaken ?? raw.player1?.damageDealt ?? raw.player1DamageDealt ?? 0),
          outcome: raw.player2?.outcome,
          hpRegen: Number(raw.player2?.hpRegen ?? 0),
          lifesteal: Number(raw.player2?.lifesteal ?? 0),
          energyDrained: Number(raw.player2?.energyDrained ?? 0),
        },
        player1Health: Number(player1Health),
        player2Health: Number(player2Health),
        player1MaxHealth: Number(raw.player1MaxHealth ?? currentState?.player1MaxHealth ?? localState.player1.maxHp),
        player2MaxHealth: Number(raw.player2MaxHealth ?? currentState?.player2MaxHealth ?? localState.player2.maxHp),
        player1Energy: Number(player1Energy),
        player2Energy: Number(player2Energy),
        player1MaxEnergy: Number(raw.player1MaxEnergy ?? currentState?.player1MaxEnergy ?? localState.player1.maxEnergy),
        player2MaxEnergy: Number(raw.player2MaxEnergy ?? currentState?.player2MaxEnergy ?? localState.player2.maxEnergy),
        player1GuardMeter: Number(player1GuardMeter),
        player2GuardMeter: Number(player2GuardMeter),
        roundWinner: normalizedRoundWinner as "player1" | "player2" | null,
        isRoundOver,
        isMatchOver: Boolean(raw.isMatchOver),
        matchWinner: (raw.matchWinner ?? null) as "player1" | "player2" | null,
        narrative: raw.narrative ?? "",
        player1RoundsWon: Number(raw.player1RoundsWon ?? fallbackP1RoundsWon),
        player2RoundsWon: Number(raw.player2RoundsWon ?? fallbackP2RoundsWon),
      };

      this.debugMatchEndLog(`roundResolved normalized r${payload.roundNumber} t${payload.turnNumber}`, {
        rawIsMatchOver: raw.isMatchOver,
        normalizedIsMatchOver: payload.isMatchOver,
        rawMatchWinner: raw.matchWinner,
        normalizedMatchWinner: payload.matchWinner,
        rawRounds: {
          p1: raw.player1RoundsWon,
          p2: raw.player2RoundsWon,
        },
        normalizedRounds: {
          p1: payload.player1RoundsWon,
          p2: payload.player2RoundsWon,
        },
        phase: this.phase,
      });

      const dedupeKey = `${payload.roundNumber}-${payload.turnNumber}-${payload.player1Health}-${payload.player2Health}-${payload.player1Energy}-${payload.player2Energy}`;
      const turnKey = `${payload.roundNumber}-${payload.turnNumber}`;
      if (this.processedResolvedTurns.has(turnKey)) {
        console.log(`[FightScene] Duplicate roundResolved ignored for turn ${turnKey}`);
        return;
      }
      if (this.lastResolvedEventKey === dedupeKey && (this.isResolving || this.phase === "resolving")) {
        console.log(`[FightScene] Duplicate roundResolved ignored for key ${dedupeKey}`);
        return;
      }
      this.lastResolvedEventKey = dedupeKey;
      this.processedResolvedTurns.add(turnKey);

      // Queue and play sequentially to prevent overlapping resolutions.
      this.enqueueRoundResolved(payload);
    });

    // Listen for match ended (from server)
    this.onBus("game:matchEnded", (data: unknown) => {
      const payload = data as {
        winner: "player1" | "player2";
        winnerAddress: string;
        reason: string;
        finalScore?: {
          player1RoundsWon?: number;
          player2RoundsWon?: number;
        };
        player1RoundsWon?: number;
        player2RoundsWon?: number;
        ratingChanges?: {
          winner: { before: number; after: number; change: number };
          loser: { before: number; after: number; change: number };
        };
        isPrivateRoom?: boolean;
        onChainSessionId?: number;
        onChainTxHash?: string;
        contractId?: string;
      };

      // Guard: ignore duplicate match_ended events (e.g. broadcast arriving after
      // forfeiter already processed locally from the API response)
      if (this.phase === "match_end") {
        console.log("[FightScene] Ignoring duplicate game:matchEnded - already in match_end phase");
        return;
      }

      if (this.isResolving) {
        console.log("[FightScene] Match ended while resolving round - queueing payload");
        this.pendingMatchEndPayload = payload;
      } else {
        this.processMatchEnd(payload);
      }
    });

    // Listen for round starting (synchronized timing from server)
    this.onBus("game:roundStarting", (data: unknown) => {
      const payload = data as {
        roundNumber: number;
        turnNumber: number;
        moveDeadlineAt: number;
        countdownSeconds: number;
        player1Health: number;
        player2Health: number;
        player1Energy: number;
        player2Energy: number;
        player1GuardMeter: number;
        player2GuardMeter: number;
      };

      if (this.shouldIgnoreRoundStarting()) {
        this.debugMatchEndLog(`roundStarting ignored r${payload.roundNumber} t${payload.turnNumber}`, {
          phase: this.phase,
          pendingMatchEndPayload: !!this.pendingMatchEndPayload,
          serverScore: {
            p1: this.serverState?.player1RoundsWon ?? 0,
            p2: this.serverState?.player2RoundsWon ?? 0,
          },
        });
        console.log(
          `[FightScene] Ignoring late game:roundStarting after terminal state - phase=${this.phase}, score=${this.serverState?.player1RoundsWon ?? 0}-${this.serverState?.player2RoundsWon ?? 0}`,
        );
        return;
      }

      console.log(`[FightScene] *** game:roundStarting received - Round ${payload.roundNumber}, Turn ${payload.turnNumber}, Current Phase: ${this.phase}, Timestamp: ${Date.now()}`);
      console.log(`[FightScene] *** Deadline in payload: ${payload.moveDeadlineAt}, Time until deadline: ${Math.floor((payload.moveDeadlineAt - Date.now()) / 1000)}s`);
      this.startRoundFromServer(payload);
    });

    // Listen for opponent move rejection
    this.onBus("game:moveRejected", (data: unknown) => {
      // Spectators should never react to move rejection events
      if (this.config.isSpectator) return;

      const payload = data as { player: "player1" | "player2"; rejectedAt: number };

      // Only show message if opponent rejected (not us)
      // AND we haven't already requested cancel (avoids circular dialog when opponent agrees)
      if (payload.player !== this.config.playerRole && !this.hasRequestedCancel) {
        // Show the Cancel Request Dialog instead of just a message
        this.showCancelRequestDialog();
      }
    });

    // Listen for Power Surge selections (from realtime channel)
    this.onBus("game:powerSurgeSelected", (data: unknown) => {
      const payload = data as {
        player: "player1" | "player2";
        cardId: PowerSurgeCardId;
        roundNumber: number;
        txId?: string;
        onChainTxHash?: string;
      };
      console.log("[FightScene] Power Surge selected event:", payload);

      if (payload.player === this.config.playerRole) {
        const txId = payload.txId || payload.onChainTxHash;
        if (txId) {
          this.showTransactionToast(txId);
        }
      }

      this.handleOpponentSurgeSelected(payload);
    });

    // Listen for Power Surge cards offered (from realtime channel) - spectator mode
    if (this.config.isSpectator) {
      this.onBus("game:powerSurgeCards", (data: unknown) => {
        const payload = data as {
          matchId: string;
          roundNumber: number;
          cardIds: string[];
          deadline: number;
        };
        console.log("[FightScene] Spectator received surge cards broadcast:", payload);
        if (!this.spectatorSurgeData || this.spectatorSurgeData.roundNumber !== payload.roundNumber) {
          this.spectatorSurgeData = {
            roundNumber: payload.roundNumber,
            cardIds: payload.cardIds as PowerSurgeCardId[],
            player1Selection: null,
            player2Selection: null,
          };
        } else {
          this.spectatorSurgeData.cardIds = payload.cardIds as PowerSurgeCardId[];
        }
        this.tryShowSpectatorSurgeUI();
      });
    }

    // Listen for match cancellation (both players rejected OR both disconnected)
    this.onBus("game:matchCancelled", (data: unknown) => {
      const payload = data as {
        matchId: string;
        reason: string;
        message: string;
        redirectTo?: string;
        refundsProcessed?: boolean;
        refundStats?: {
          totalRefunded: number;
          stakesRefunded: number;
          betsRefunded: number;
          errors: string[];
        };
        userBet?: {
          amount: number;
          prediction: string;
        };
      };

      console.log("[FightScene] Match cancelled:", payload);
      console.log("[FightScene] refundsProcessed:", payload.refundsProcessed);
      console.log("[FightScene] refundsProcessed !== undefined:", payload.refundsProcessed !== undefined);

      this.phase = "match_end";

      // Close any active dialogs (e.g., "Opponent Wants to Cancel")
      if (this.activeDialog) {
        this.activeDialog.destroy();
        this.activeDialog = undefined;
      }
      if (this.activeDialogBlocker) {
        this.activeDialogBlocker.destroy();
        this.activeDialogBlocker = undefined;
      }

      // Stop any deadline-based timers
      this.timerExpiredHandled = true;
      this.stunnedAutoSubmitAt = 0;
      this.bothStunnedSkipAt = 0;
      this.roundEndCountdownEndsAt = 0;
      this.countdownEndsAt = 0;

      // If this is a disconnect refund scenario, show detailed overlay
      if (payload.refundsProcessed !== undefined) {
        console.log("[FightScene] Calling handleMatchCancellation");
        this.handleMatchCancellation(payload);
        return;
      }

      // Otherwise, show simple cancellation message (transaction rejection)
      console.log("[FightScene] Showing simple cancellation message");

      // Safety check: ensure text objects exist
      if (this.countdownText && this.countdownText.active) {
        this.countdownText.setText("MATCH CANCELLED");
        this.countdownText.setFontSize(36);
        this.countdownText.setColor("#f97316");
        this.countdownText.setAlpha(1);
      }

      if (this.narrativeText && this.narrativeText.active) {
        this.narrativeText.setText("Both players rejected transactions.\nRedirecting to matchmaking...");
        this.narrativeText.setAlpha(1);
      }

      // Disable all buttons - Not needed, UI handles this
    });

    // Listen for opponent disconnect
    this.onBus("game:playerDisconnected", (data: unknown) => {
      const payload = data as {
        player: "player1" | "player2";
        address: string;
        disconnectedAt: number;
        timeoutSeconds: number;
      };

      // Only show overlay if opponent disconnected
      if (payload.player !== this.config.playerRole) {
        this.showDisconnectOverlay(payload.timeoutSeconds);
      }
    });

    // Listen for opponent reconnect
    this.onBus("game:playerReconnected", (data: unknown) => {
      const payload = data as {
        player: "player1" | "player2";
        address: string;
        reconnectedAt: number;
      };

      // Only hide overlay if it was the opponent who reconnected
      if (payload.player !== this.config.playerRole) {
        this.hideDisconnectOverlay();
      }
    });

    // Listen for state sync (reconnection)
    this.onBus("game:stateSync", (data: unknown) => {
      const state = data as {
        status: string;
        currentRound: number;
        player1Health: number;
        player2Health: number;
        player1RoundsWon: number;
        player2RoundsWon: number;
        player1Energy: number;
        player2Energy: number;
        moveDeadlineAt: number | null;
        pendingMoves: { player1: boolean; player2: boolean };
      };
      this.handleStateSync(state);
    });

    // Listen for comprehensive fight state updates from server
    this.onBus("game:fightStateUpdate", (data: unknown) => {
      const payload = data as { matchId: string; update: any; timestamp: number };
      console.log("[FightScene] Received fight state update:", payload);

      // Only process updates for our match
      if (payload.matchId !== this.config.matchId) return;

      // If we receive a phase update, sync appropriately
      if (payload.update && payload.update.phase) {
        // Use the comprehensive sync method
        this.syncWithFightState({
          ...this.serverState,
          ...payload.update,
          // Convert timestamps
          moveDeadlineAt: payload.update.moveDeadlineAt,
          countdownEndsAt: payload.update.countdownEndsAt,
          animationEndsAt: payload.update.animationEndsAt,
        });
      }
    });

    // Listen for local rejection waiting (we rejected, waiting for opponent)
    this.onBus("game:rejectionWaiting", (data: unknown) => {
      // Spectators should never see rejection waiting state
      if (this.config.isSpectator) return;

      const payload = data as { message: string };
      const message = payload?.message?.trim() || "Waiting for opponent...";
      this.isWaitingForOpponent = true;
      try {
        this.showFloatingText(message, GAME_DIMENSIONS.CENTER_X, GAME_DIMENSIONS.CENTER_Y - 100, "#f97316");
      } catch {
        // ignore
      }
      this.turnIndicatorText.setText(message);
      this.turnIndicatorText.setColor("#f97316");
      // this.moveButtons.forEach(btn => btn.setAlpha(0.4).disableInteractive());
    });

    // Listen for move error (e.g. wallet rejected but failed to record rejection)
    // This allows the user to try again if the rejection recording failed
    this.onBus("game:moveError", (data: unknown) => {
      // Spectators should never see move error state
      if (this.config.isSpectator) return;

      const payload = data as { error: string };
      console.log("[FightScene] Move error:", payload.error);

      const message = payload.error?.trim() || "Action failed";
      this.turnIndicatorText.setText(message);
      this.turnIndicatorText.setColor("#ef4444");

      this.time.delayedCall(2400, () => {
        if (this.phase === "selecting" && !this.isWaitingForOpponent) {
          this.turnIndicatorText.setText("Select your move!");
          this.turnIndicatorText.setColor("#40e0d0");
        }
      });

      // Clear in-flight state since the transaction failed
      this.moveInFlight = false;

      // If we are "waiting for opponent" due to submitting, but it failed locally
      // We should reset the UI to allow retry
      // BUT if we successfully recorded rejection (which emits game:rejectionWaiting), we shouldn't reset.
      // So only reset if we are NOT in the confirmed waiting state

      // If we are "waiting for opponent" due to submitting, but it failed locally
      // We should reset the UI to allow retry
      // BUT if we successfully recorded rejection (which emits game:rejectionWaiting), we shouldn't reset.
      // So only reset if we are NOT in the confirmed waiting state
      if (this.turnIndicatorText.text === "Submitting move...") {
        this.isWaitingForOpponent = false;
        this.turnIndicatorText.setText("Select your move!");
        this.turnIndicatorText.setColor("#40e0d0");

        // React UI handles enablement based on state reset
        this.selectedMove = null;

        // Update local buttons
        this.updateMoveButtonAffordability();
      }
    });

    // Listen for incoming chat messages from opponent only
    // (we display our own messages locally in onSendMessage)
    this.onBus("game:chatMessage", (data: unknown) => {
      const payload = data as { sender: string; senderAddress: string; message: string; timestamp: number };

      // Skip messages from ourselves - we already displayed them locally
      if (payload.sender === this.config.playerRole) {
        return;
      }

      // Create unique key for deduplication
      const messageKey = `${payload.sender}-${payload.timestamp}-${payload.message}`;

      // Skip if we've already processed this message
      if (this.processedChatMessages.has(messageKey)) {
        console.log("[FightScene] Skipping duplicate chat message:", messageKey);
        return;
      }

      // Mark as processed
      this.processedChatMessages.add(messageKey);

      // Clean up old messages after 30 seconds to prevent memory leak
      setTimeout(() => {
        this.processedChatMessages.delete(messageKey);
      }, 30000);

      if (this.chatPanel) {
        this.chatPanel.addMessage(
          payload.sender as "player1" | "player2",
          payload.message,
          payload.timestamp
        );
      }
    });
  }

  /**
   * Submit move logic wrapper
   */
  private handleSubmitMove(payload: any): void {
    EventBus.emit("game:submitMove", payload);
  }

  /**
   * Show a transaction confirmation toast notification.
   * Displays the transaction ID with a link to the Kaspa explorer.
   */
  /**
   * Show transaction toast notification
   */
  private showTransactionToast(txId: string): void {
    if (!this.isSceneUiReady()) return;

    // Close any existing toast first
    if (this.activeTransactionToast) {
      this.activeTransactionToast.close();
      this.activeTransactionToast = undefined;
    }

    // Determine player address for network detection
    const playerAddress = this.config.playerRole === "player1"
      ? this.config.player1Address
      : this.config.player2Address;

    // Position toast in top-right corner with some padding
    const toastX = GAME_DIMENSIONS.WIDTH - 180;
    const toastY = 180;

    try {
      this.activeTransactionToast = new TransactionToast({
        scene: this,
        x: toastX,
        y: toastY,
        txId: txId,
        playerAddress: playerAddress,
        duration: 3000, // 3 seconds
        onClose: () => {
          this.activeTransactionToast = undefined;
        },
      });
    } catch (error) {
      console.warn("[FightScene] Skipping transaction toast due to scene teardown race", error);
      this.activeTransactionToast = undefined;
    }
  }

  /**
   * Show disconnect overlay with countdown.
   */
  private showDisconnectOverlay(timeoutSeconds: number): void {
    if (this.hasCleanedUp || this.phase === "match_end" || !this.scene.isActive()) return;

    this.opponentDisconnected = true;
    this.disconnectTimeoutAt = Date.now() + timeoutSeconds * 1000;

    // Create overlay if it doesn't exist
    if (!this.disconnectOverlay) {
      try {
        this.disconnectOverlay = this.add.container(0, 0);
      } catch {
        return;
      }
      this.disconnectOverlay.setDepth(1000);

      // Semi-transparent background
      const bg = this.add.graphics();
      bg.fillStyle(0x000000, 0.7);
      bg.fillRect(0, 0, GAME_DIMENSIONS.WIDTH, GAME_DIMENSIONS.HEIGHT);
      this.disconnectOverlay.add(bg);

      // Title
      const title = this.add.text(
        GAME_DIMENSIONS.CENTER_X,
        GAME_DIMENSIONS.CENTER_Y - 80,
        "OPPONENT DISCONNECTED",
        {
          fontFamily: "Orbitron, sans-serif",
          fontSize: "32px",
          color: "#f97316",
          fontStyle: "bold",
        }
      ).setOrigin(0.5);
      this.disconnectOverlay.add(title);

      // Timer text
      this.disconnectTimerText = this.add.text(
        GAME_DIMENSIONS.CENTER_X,
        GAME_DIMENSIONS.CENTER_Y,
        `Waiting for reconnection: ${timeoutSeconds}s`,
        {
          fontFamily: "Orbitron, sans-serif",
          fontSize: "24px",
          color: "#ffffff",
        }
      ).setOrigin(0.5);
      this.disconnectOverlay.add(this.disconnectTimerText);

      // Info text
      const info = this.add.text(
        GAME_DIMENSIONS.CENTER_X,
        GAME_DIMENSIONS.CENTER_Y + 60,
        "If opponent doesn't return, you win!",
        {
          fontFamily: "monospace",
          fontSize: "16px",
          color: "#888888",
        }
      ).setOrigin(0.5);
      this.disconnectOverlay.add(info);
    }

    this.disconnectOverlay.setVisible(true);

    // Disconnect countdown is now handled by the update() loop using this.disconnectTimeoutAt
    // No Phaser TimerEvent needed - works correctly across tab switches
  }

  /**
   * Hide disconnect overlay (opponent reconnected).
   */
  private hideDisconnectOverlay(): void {
    this.opponentDisconnected = false;
    this.disconnectTimeoutAt = 0;

    if (this.disconnectOverlay) {
      this.disconnectOverlay.setVisible(false);
    }

    // Show reconnection message
    this.showFloatingText("Opponent reconnected!", GAME_DIMENSIONS.CENTER_X, GAME_DIMENSIONS.CENTER_Y - 50, "#22c55e");
  }

  /**
   * Handle disconnect timeout - claim victory.
   */
  private handleDisconnectTimeout(): void {
    this.disconnectTimeoutAt = 0; // Clear to prevent re-triggering from update()

    // Update overlay to show claiming victory
    if (this.disconnectTimerText) {
      this.disconnectTimerText.setText("Claiming victory...");
    }

    // Call timeout API to claim victory
    EventBus.emit("game:claimTimeoutVictory", {
      matchId: this.config.matchId,
    });
  }

  /**
   * Handle state sync for reconnection.
   */
  private handleStateSync(state: {
    status: string;
    currentRound: number;
    player1Health: number;
    player2Health: number;
    player1RoundsWon: number;
    player2RoundsWon: number;
    player1Energy: number;
    player2Energy: number;
    moveDeadlineAt: number | null;
    pendingMoves: { player1: boolean; player2: boolean };
  }): void {
    console.log("[FightScene] Restoring state from sync:", state);

    // Don't sync state during animations - it would show HP/energy changes prematurely
    if (this.phase === "resolving") {
      console.log("[FightScene] Ignoring handleStateSync during resolving phase to prevent premature UI updates");
      return;
    }

    // Get max values from local engine for defaults
    const localState = this.combatEngine.getState();

    // Update server state
    this.serverState = {
      player1Health: state.player1Health,
      player1MaxHealth: localState.player1.maxHp,
      player2Health: state.player2Health,
      player2MaxHealth: localState.player2.maxHp,
      player1Energy: state.player1Energy,
      player1MaxEnergy: localState.player1.maxEnergy,
      player2Energy: state.player2Energy,
      player2MaxEnergy: localState.player2.maxEnergy,
      player1GuardMeter: 0,
      player2GuardMeter: 0,
      player1RoundsWon: state.player1RoundsWon,
      player2RoundsWon: state.player2RoundsWon,
      currentRound: state.currentRound,
    };

    // Update UI
    this.syncUIWithCombatState();
    this.roundScoreText.setText(
      `Round ${state.currentRound}  |  ${state.player1RoundsWon} - ${state.player2RoundsWon}  (First to 2)`
    );

    // If there's an active move deadline, start/continue the selection phase
    console.log("[FightScene] handleStateSync - checking deadline:");
    console.log("[FightScene]   moveDeadlineAt:", state.moveDeadlineAt);
    console.log("[FightScene]   Date.now():", Date.now());
    console.log("[FightScene]   deadline > now?:", state.moveDeadlineAt ? state.moveDeadlineAt > Date.now() : false);
    console.log("[FightScene]   pendingMoves:", state.pendingMoves);
    console.log("[FightScene]   playerRole:", this.config.playerRole);

    if (state.moveDeadlineAt && state.moveDeadlineAt > Date.now()) {
      // Store the deadline for visibility resync
      this.moveDeadlineAt = state.moveDeadlineAt;

      const myRole = this.config.playerRole;
      const hasPendingMove = myRole === "player1" ? state.pendingMoves.player1 : state.pendingMoves.player2;

      console.log("[FightScene]   hasPendingMove:", hasPendingMove);

      if (hasPendingMove) {
        // We already submitted a move - wait for opponent
        console.log("[FightScene] Decision: Already submitted move, waiting for opponent");
        this.phase = "selecting";
        this.isWaitingForOpponent = true;
        this.turnIndicatorText.setText("Waiting for opponent...");
        this.turnIndicatorText.setColor("#f97316");

        // Notify UI
        EventBus.emit("ui:update", { isWaitingForOpponent: true });
      } else {
        // We need to make a move - start synchronized selection with server deadline
        console.log("[FightScene] Decision: Need to make move, starting synchronized selection phase");
        this.startSynchronizedSelectionPhase(state.moveDeadlineAt);
      }
    } else {
      // No active deadline - wait for server's round_starting event
      console.log("[FightScene] Decision: No active deadline, waiting for server round_starting event");
      this.phase = "waiting";
      this.turnIndicatorText.setText("Waiting for round to start...");
      this.turnIndicatorText.setColor("#f97316");
      this.roundTimerText.setText("--");
    }
  }

  /**
   * Start round from server broadcast (production mode - synchronized timing).
   * @param payload - Server round start data
   * @param skipCountdown - If true, skip the 3-2-1 FIGHT countdown (used when processing queued events after our own countdown)
   */
  private startRoundFromServer(payload: {
    roundNumber: number;
    turnNumber: number;
    moveDeadlineAt: number;
    countdownSeconds: number;
    player1Health: number;
    player2Health: number;
    player1MaxHealth?: number;
    player2MaxHealth?: number;
    player1Energy: number;
    player2Energy: number;
    player1MaxEnergy?: number;
    player2MaxEnergy?: number;
    player1GuardMeter: number;
    player2GuardMeter: number;
    player1IsStunned?: boolean;
    player2IsStunned?: boolean;
  }, skipCountdown: boolean = false): void {
    if (this.shouldIgnoreRoundStarting()) {
      this.debugMatchEndLog(`startRoundFromServer ignored r${payload.roundNumber} t${payload.turnNumber}`, {
        phase: this.phase,
        pendingMatchEndPayload: !!this.pendingMatchEndPayload,
        serverScore: {
          p1: this.serverState?.player1RoundsWon ?? 0,
          p2: this.serverState?.player2RoundsWon ?? 0,
        },
      });
      console.log(
        `[FightScene] startRoundFromServer ignored (terminal state) - phase=${this.phase}, score=${this.serverState?.player1RoundsWon ?? 0}-${this.serverState?.player2RoundsWon ?? 0}`,
      );
      return;
    }

    console.log(`[FightScene] *** startRoundFromServer called - Round ${payload.roundNumber}, Turn ${payload.turnNumber}`);
    console.log(`[FightScene] *** Current phase: ${this.phase}, skipCountdown: ${skipCountdown}, isResolving: ${this.isResolving}, Timestamp: ${Date.now()}`);
    console.log(`[FightScene] *** pendingRoundStart exists: ${!!this.pendingRoundStart}`);

    // Queue the round_starting event if we're currently in an animation sequence.
    // Use isResolving flag to detect active animations (set in handleServerRoundResolved).
    // Also queue during specific phases that have pending animations:
    // - "resolving": attack animations playing
    // - "round_end": death animation, result text, or round countdown showing
    // - "countdown": already showing 3-2-1 FIGHT (avoid double countdown)
    // 
    // NOTE: Do NOT queue during initial "waiting" phase (scene just loaded, waiting for first round_starting)
    // because there's no animation sequence to process the queue.
    const shouldQueue = this.isResolving ||
      this.phase === "resolving" ||
      this.phase === "round_end" ||
      this.phase === "countdown";

    if (shouldQueue) {
      console.log(`[FightScene] *** QUEUEING round start - isResolving: ${this.isResolving}, phase: ${this.phase}`);
      this.pendingRoundStart = payload;
      return;
    }

    console.log(`[FightScene] *** PROCESSING round start immediately - phase allows it`);

    // Clear any pending deadline-based timers
    this.timerExpiredHandled = true;
    this.stunnedAutoSubmitAt = 0;
    this.bothStunnedSkipAt = 0;

    // Reset move submission flags so buttons re-enable for the new round/turn
    this.isWaitingForOpponent = false;
    this.localMoveSubmitted = false;
    this.moveInFlight = false;
    this.privateRoundPlannedMoves = [];
    this.privateRoundPlanEnergyPreview = PRIVATE_ROUND_SERVER_MAX_ENERGY;
    this.privateRoundPlanBaseEnergy = PRIVATE_ROUND_SERVER_MAX_ENERGY;
    this.privateRoundPlanMaxEnergy = PRIVATE_ROUND_SERVER_MAX_ENERGY;

    // Store the deadline for synchronized timing
    this.moveDeadlineAt = payload.moveDeadlineAt;
    this.turnTimer = Math.floor(ROUND_MOVE_TIMER_MS / 1000);
    this.roundTimerText.setText(`${this.turnTimer}s`);
    this.roundTimerText.setColor("#40e0d0");

    // Get max values from local engine initially (server should provide these)
    const localState = this.combatEngine.getState();

    // Determine max values (prefer server, fallback to local)
    const p1MaxHealth = payload.player1MaxHealth ?? localState.player1.maxHp;
    const p2MaxHealth = payload.player2MaxHealth ?? localState.player2.maxHp;
    const p1MaxEnergy = PRIVATE_ROUNDS_ENABLED
      ? PRIVATE_ROUND_SERVER_MAX_ENERGY
      : (payload.player1MaxEnergy ?? localState.player1.maxEnergy);
    const p2MaxEnergy = PRIVATE_ROUNDS_ENABLED
      ? PRIVATE_ROUND_SERVER_MAX_ENERGY
      : (payload.player2MaxEnergy ?? localState.player2.maxEnergy);

    // At turn 1 (start of round), health and energy should always be at max
    // The server might send incorrect default values (e.g., 100 instead of character-specific max)
    const isRoundStart = payload.turnNumber === 1;
    const p1Health = isRoundStart ? p1MaxHealth : payload.player1Health;
    const p2Health = isRoundStart ? p2MaxHealth : payload.player2Health;
    const p1Energy = PRIVATE_ROUNDS_ENABLED
      ? Math.max(
        0,
        Math.min(
          p1MaxEnergy,
          Number.isFinite(Number(payload.player1Energy)) ? Number(payload.player1Energy) : p1MaxEnergy,
        ),
      )
      : (isRoundStart ? p1MaxEnergy : payload.player1Energy);
    const p2Energy = PRIVATE_ROUNDS_ENABLED
      ? Math.max(
        0,
        Math.min(
          p2MaxEnergy,
          Number.isFinite(Number(payload.player2Energy)) ? Number(payload.player2Energy) : p2MaxEnergy,
        ),
      )
      : (isRoundStart ? p2MaxEnergy : payload.player2Energy);

    // Store server state (authoritative)
    this.serverState = {
      player1Health: p1Health,
      player1MaxHealth: p1MaxHealth,
      player2Health: p2Health,
      player2MaxHealth: p2MaxHealth,
      player1Energy: p1Energy,
      player1MaxEnergy: p1MaxEnergy,
      player2Energy: p2Energy,
      player2MaxEnergy: p2MaxEnergy,
      player1GuardMeter: payload.player1GuardMeter,
      player2GuardMeter: payload.player2GuardMeter,
      player1RoundsWon: this.serverState?.player1RoundsWon ?? 0,
      player2RoundsWon: this.serverState?.player2RoundsWon ?? 0,
      currentRound: payload.roundNumber,
      // Stun state from server
      player1IsStunned: payload.player1IsStunned ?? false,
      player2IsStunned: payload.player2IsStunned ?? false,
    };

    // Sync UI with server state (updates HP bars, round info, etc.)
    this.syncUIWithCombatState();

    // Apply persistent stun visual effects
    this.toggleStunEffect("player1", this.serverState.player1IsStunned ?? false);
    this.toggleStunEffect("player2", this.serverState.player2IsStunned ?? false);

    // IMMEDIATELY disable move buttons if local player is stunned
    // This prevents the player from clicking moves during countdown/Power Surge selection
    // when they don't yet realize they're stunned
    this.updateMoveButtonAffordability();

    // IMMEDIATELY show stun indicator text if local player is stunned
    // This gives instant visual feedback that the player cannot act
    const isPlayer1 = this.config.playerRole === "player1";
    const amIStunned = isPlayer1 ? this.serverState.player1IsStunned : this.serverState.player2IsStunned;
    const isOpponentStunned = isPlayer1 ? this.serverState.player2IsStunned : this.serverState.player1IsStunned;

    if (amIStunned && isOpponentStunned) {
      this.turnIndicatorText.setText("BOTH PLAYERS STUNNED!");
      this.turnIndicatorText.setColor("#ff4444");
      // Flash the stun message
      this.tweens.add({
        targets: this.turnIndicatorText,
        alpha: { from: 1, to: 0.5 },
        duration: 300,
        yoyo: true,
        repeat: 2,
      });
    } else if (amIStunned) {
      this.turnIndicatorText.setText("YOU ARE STUNNED!");
      this.turnIndicatorText.setColor("#ff4444");
      // Flash the stun message
      this.tweens.add({
        targets: this.turnIndicatorText,
        alpha: { from: 1, to: 0.5 },
        duration: 300,
        yoyo: true,
        repeat: 2,
      });
    }

    if (skipCountdown) {
      // Skip the 3-2-1 FIGHT countdown - go directly to selection phase
      // This is used when we already showed our own 5-second countdown
      // BUT we still need to show Power Surge cards for the new round!
      console.log("[FightScene] Skipping countdown - but still need to show Power Surge cards");
      this.showPowerSurgeCardsAndStartSelection(payload.roundNumber, payload.moveDeadlineAt);
    } else {
      // Show the 3-2-1 FIGHT countdown
      this.phase = "countdown";
      this.showCountdownThenSync(payload.countdownSeconds, payload.moveDeadlineAt);
    }
  }

  /**
   * Show Power Surge cards and then start selection phase (used when skipping countdown).
   * This ensures Power Surge cards are shown even when we skip the 3-2-1 FIGHT countdown.
   */
  private async showPowerSurgeCardsAndStartSelection(roundNumber: number, moveDeadlineAt: number): Promise<void> {
    // Check if we need to show Power Surge cards for this round
    const shouldShowSurge = !this.surgeCardsShownThisRound && this.lastSurgeRound !== roundNumber;

    if (shouldShowSurge) {
      console.log(`[FightScene] Showing Power Surge cards for round ${roundNumber} (skip countdown path)`);
      await this.showPowerSurgeCards(roundNumber, moveDeadlineAt);
    }

    // Now start the selection phase
    this.startSynchronizedSelectionPhase(moveDeadlineAt);
  }

  /**
   * Show countdown then start synchronized selection phase.
   * At the START of each round (turn 1), show Power Surge cards first.
   * Uses real-time deadlines so countdown works correctly across tab switches.
   */
  private async showCountdownThenSync(countdownSeconds: number, moveDeadlineAt: number): Promise<void> {
    // Check if this is the start of a new round (turn 1)
    // We show Power Surge cards before the countdown
    const currentRound = this.serverState?.currentRound ?? 1;
    const currentTurn = this.combatEngine?.getState()?.currentTurn ?? 1;

    // Deduplicate countdown - prevent playing the same countdown twice for the same turn
    const turnKey = `${currentRound}-${currentTurn}-${moveDeadlineAt}`;
    if (this.lastCountdownStartedForTurn === turnKey) {
      console.log(`[FightScene] *** DUPLICATE COUNTDOWN BLOCKED for turn ${turnKey}`);
      return;
    }
    this.lastCountdownStartedForTurn = turnKey;
    console.log(`[FightScene] Starting countdown for turn ${turnKey}`);

    const shouldShowSurge = !this.surgeCardsShownThisRound && this.lastSurgeRound !== currentRound;

    if (shouldShowSurge) {
      console.log(`[FightScene] Showing Power Surge cards for round ${currentRound} before countdown`);

      // Show Power Surge cards (this blocks until complete or timeout)
      try {
        await this.showPowerSurgeCards(currentRound, moveDeadlineAt);
      } catch (error) {
        console.error("[FightScene] Power Surge flow failed, continuing round start:", error);
      }
    }

    // Some server payloads omit countdownSeconds; default to 3 to avoid noisy warnings and
    // keep the start-of-round pacing consistent.
    const normalizedCountdownSeconds = Number.isFinite(countdownSeconds)
      ? Math.max(0, Math.floor(countdownSeconds))
      : 3;

    if (normalizedCountdownSeconds <= 0) {
      // No countdown, start immediately
      this.startSynchronizedSelectionPhase(moveDeadlineAt);
      return;
    }

    // Set up deadline-based countdown - update() loop handles the rest
    // This uses Date.now() so it works correctly even when tab is backgrounded
    const now = Date.now();
    this.countdownEndsAt = now + (normalizedCountdownSeconds * 1000);
    this.countdownPhaseNumber = 0; // Will be set by update() loop
    this.phase = "countdown";
    this.moveDeadlineAt = moveDeadlineAt;

    // Play SFX
    this.playSFX("sfx_cd_fight");

    // If tab was backgrounded and we're already past the countdown, update() will handle it
  }

  /**
   * Start selection phase with synchronized timer from server deadline.
   */
  private async startSynchronizedSelectionPhase(moveDeadlineAt: number): Promise<void> {
    console.log(`[FightScene] *** startSynchronizedSelectionPhase called - deadline: ${moveDeadlineAt}, Timestamp: ${Date.now()}`);
    console.log(`[FightScene] *** Time until deadline: ${Math.floor((moveDeadlineAt - Date.now()) / 1000)}s`);
    this.stopZkWaitingTicker();

    // Clear any previous deadline-based timers
    this.timerExpiredHandled = false;
    this.stunnedAutoSubmitAt = 0;
    this.bothStunnedSkipAt = 0;

    const currentRound = this.serverState?.currentRound ?? this.combatEngine?.getState()?.currentRound ?? 1;
    this.resetZkOnChainBadge(currentRound);

    // Check if Power Surge selection is still ongoing - BOTH players must complete
    // Check database to see if both players have submitted their Power Surge selections
    const areBothSurgesComplete = await this.checkBothSurgesComplete(currentRound);

    if (!areBothSurgesComplete) {
      console.log(`[FightScene] *** Waiting for both players to complete Power Surge selections`);
      this.phase = "waiting";
      this.setMoveButtonsVisible(false);
      this.turnIndicatorText.setText("Phase 1/3: Waiting for both Power Surge picks...");
      this.turnIndicatorText.setColor("#fbbf24");
      this.roundTimerText.setText("--");
      this.roundTimerText.setColor("#fbbf24");
      // Retry after 500ms
      this.time.delayedCall(500, () => {
        this.startSynchronizedSelectionPhase(moveDeadlineAt);
      });
      return;
    }

    console.log(`[FightScene] *** Both players completed Power Surge selections - starting Phase 2 timer`);

    this.phase = "selecting";
    this.setMoveButtonsVisible(true);
    this.selectedMove = null;
    this.isWaitingForOpponent = false;
    this.localMoveSubmitted = false; // Reset for new round
    this.moveInFlight = false;
    this.privateRoundPlannedMoves = [];
    this.privateRoundPlanBaseEnergy = PRIVATE_ROUNDS_ENABLED
      ? this.getPrivateRoundPlanningBaseEnergy(this.config.playerRole)
      : (this.config.playerRole
        ? this.getPrivateRoundPlanningBaseEnergy(this.config.playerRole)
        : PRIVATE_ROUND_SERVER_MAX_ENERGY);
    this.privateRoundPlanMaxEnergy = PRIVATE_ROUNDS_ENABLED
      ? PRIVATE_ROUND_SERVER_MAX_ENERGY
      : (this.config.playerRole
        ? this.getPrivateRoundPlanningMaxEnergy(this.config.playerRole)
        : PRIVATE_ROUND_SERVER_MAX_ENERGY);
    this.syncPrivateRoundPlanEnergyPreview();

    try {
      this.turnIndicatorText.setText(PRIVATE_ROUNDS_ENABLED ? "Phase 2/3: Plan moves (0/10)" : "Select your move!");
      this.turnIndicatorText.setColor("#40e0d0");
    } catch {
      // ignore renderer/text teardown races
    }
    this.updatePrivatePlanEnergyText();

    // React UI handles button state and affordability

    // SAFETY FALLBACK: Protects against clock sync issues or edge cases
    // Server now only adds Power Surge time (15s) on the first turn of each round.
    const now = Date.now();
    let remainingMs = moveDeadlineAt - now;
    const currentTurn = this.combatEngine?.getState()?.currentTurn ?? 1;

    if (PRIVATE_ROUNDS_ENABLED && currentTurn === 1 && remainingMs < ROUND_MOVE_TIMER_MS - 5000) {
      console.log(`[FightScene] Rebased round-start timer from ${Math.floor(remainingMs / 1000)}s to full ${Math.floor(ROUND_MOVE_TIMER_MS / 1000)}s`);
      moveDeadlineAt = now + ROUND_MOVE_TIMER_MS;
      remainingMs = ROUND_MOVE_TIMER_MS;
    }

    // If less than 15 seconds remaining (shouldn't happen with proper server timing), extend the deadline
    if (remainingMs < 15000) {
      console.log(`[FightScene] Safety fallback: deadline too close (${Math.floor(remainingMs / 1000)}s), extending to full timer`);
      moveDeadlineAt = now + ROUND_MOVE_TIMER_MS; // Give full move timer
      remainingMs = ROUND_MOVE_TIMER_MS;
    }

    this.turnTimer = Math.max(1, Math.floor((moveDeadlineAt - now) / 1000));
    console.log(`[FightScene] *** Initial timer value: ${this.turnTimer}s, deadline: ${moveDeadlineAt}`);

    // Reset button visuals and affordability (default state)
    this.resetButtonVisuals();
    this.updateMoveButtonAffordability();

    // Check if we are stunned
    const isPlayer1 = this.config.playerRole === "player1";
    let amIStunned = isPlayer1
      ? this.serverState?.player1IsStunned
      : this.serverState?.player2IsStunned;

    let isOpponentStunned = isPlayer1
      ? this.serverState?.player2IsStunned
      : this.serverState?.player1IsStunned;

    // DON'T anticipate stun from surges - trust the server state entirely
    // The server correctly handles Mempool Congest on turn 1 and clears it afterward
    // Client-side anticipation was causing the persistent stun visual bug
    // The CombatEngine applies Mempool Congest stun ONLY on turn 1 (currentTurn === 1),
    // then clears the stun after that turn. The server broadcasts the correct stun state
    // via the round_starting event, so we just read from serverState.

    const bothStunned = amIStunned && isOpponentStunned;

    if (bothStunned) {
      // BOTH players are stunned - show special message and auto-skip
      // No transaction required since neither player can make a choice
      this.turnIndicatorText.setText("BOTH PLAYERS STUNNED!");
      this.turnIndicatorText.setColor("#ff4444");
      this.roundTimerText.setText("---");
      this.roundTimerText.setColor("#ff4444");

      // Show narrative explaining what's happening
      this.narrativeText.setText("Both players are stunned!\nSkipping this turn...");
      this.narrativeText.setAlpha(1);
      this.narrativeText.setColor("#ff4444");

      // Flash the stun message
      this.tweens.add({
        targets: this.turnIndicatorText,
        alpha: { from: 1, to: 0.5 },
        duration: 300,
        yoyo: true,
        repeat: -1, // Keep flashing until turn resolves
      });

      // Disable all buttons
      this.moveButtons.forEach(btn => {
        btn.setAlpha(0.3);
        btn.disableInteractive();
        btn.list.forEach((child: any) => {
          if (child.setTint) child.setTint(0x555555);
        });
      });

      // Apply visual stun effects to both characters
      this.toggleStunEffect("player1", true);
      this.toggleStunEffect("player2", true);

      console.log(`[FightScene] Both players stunned - calling skip-stunned-turn API after 2.5s`);

      // Use deadline-based auto-skip (handled by update() loop)
      // This works correctly even when tab is backgrounded
      this.bothStunnedSkipAt = Date.now() + 2500;

      return;
    } else if (amIStunned) {
      // Player is stunned - show message and disable buttons
      this.turnIndicatorText.setText("YOU ARE STUNNED!");
      this.turnIndicatorText.setColor("#ff4444");
      this.roundTimerText.setColor("#ff4444");

      // Show narrative explaining what's happening
      this.narrativeText.setText("You are stunned and cannot act this turn!");
      this.narrativeText.setAlpha(1);
      this.narrativeText.setColor("#ff4444");

      // Flash the stun message
      this.tweens.add({
        targets: this.turnIndicatorText,
        alpha: { from: 1, to: 0.5 },
        duration: 300,
        yoyo: true,
        repeat: -1, // Keep flashing until turn resolves
      });

      // Disable all buttons visually and interactively
      this.moveButtons.forEach(btn => {
        btn.setAlpha(0.3);
        btn.disableInteractive();
        btn.list.forEach((child: any) => {
          if (child.setTint) child.setTint(0x555555);
        });
      });

      // Apply visual stun effect
      this.toggleStunEffect(this.config.playerRole, true);

      // Auto-submit a move after 2 seconds WITHOUT requiring a transaction
      // Uses deadline-based approach (handled by update() loop) so it works across tab switches
      console.log(`[FightScene] Player is stunned - auto-submitting 'stunned' move via API after 2s (no transaction)`);
      this.stunnedAutoSubmitAt = Date.now() + 2000;
    } else if (isOpponentStunned) {
      // Opponent is stunned - show positive message
      this.turnIndicatorText.setText("OPPONENT IS STUNNED!");
      this.turnIndicatorText.setColor("#22c55e");

      // Show narrative
      this.narrativeText.setText("Your opponent is stunned!\nChoose your move wisely!");
      this.narrativeText.setAlpha(1);
      this.narrativeText.setColor("#22c55e");

      // Fade out narrative after 2 seconds
      this.tweens.add({
        targets: this.narrativeText,
        alpha: 0,
        delay: 2000,
        duration: 500
      });

      // Apply visual stun effect to opponent
      const opponentRole = this.config.playerRole === "player1" ? "player2" : "player1";
      this.toggleStunEffect(opponentRole, true);
    } else {
      // Normal state
      if (PRIVATE_ROUNDS_ENABLED) {
        this.turnIndicatorText.setText("Phase 2/3: Plan moves (0/10)");
        this.turnIndicatorText.setColor("#40e0d0");
      } else {
        this.turnIndicatorText.setText("Select your move!");
        this.turnIndicatorText.setColor("#40e0d0");
      }
    }

    // Apply visual stun effect based on SERVER-CONFIRMED stun state only
    // This prevents visual stun from persisting incorrectly across turns
    // The server correctly tracks when stun starts (turn 1 for Mempool Congest) and ends (after stunned turn)
    if (this.serverState?.player1IsStunned) {
      this.toggleStunEffect("player1", true);
    } else {
      this.toggleStunEffect("player1", false);
    }
    if (this.serverState?.player2IsStunned) {
      this.toggleStunEffect("player2", true);
    } else {
      this.toggleStunEffect("player2", false);
    }

    // Store the deadline for the update() loop to use
    // The timer countdown and expiry are now handled by update() using Date.now()
    // This works correctly even when the browser tab is backgrounded
    this.moveDeadlineAt = moveDeadlineAt;
    this.timerExpiredHandled = false;

    this.roundTimerText.setText(`${this.turnTimer}s`);
    this.roundTimerText.setColor("#40e0d0");
    this.updatePrivatePlanEnergyText();


  }

  /**
   * Handle server-resolved round (production mode).
   */
  private handleServerRoundResolved(payload: {
    roundNumber?: number;
    turnNumber?: number;
    player1: { move: MoveType; damageDealt: number; damageTaken: number; outcome?: string; isStunned?: boolean; hpRegen?: number; lifesteal?: number; energyDrained?: number };
    player2: { move: MoveType; damageDealt: number; damageTaken: number; outcome?: string; isStunned?: boolean; hpRegen?: number; lifesteal?: number; energyDrained?: number };
    player1Health: number;
    player2Health: number;
    player1MaxHealth?: number;
    player2MaxHealth?: number;
    player1Energy: number;
    player2Energy: number;
    player1MaxEnergy?: number;
    player2MaxEnergy?: number;
    player1GuardMeter: number;
    player2GuardMeter: number;
    roundWinner: "player1" | "player2" | null;
    isRoundOver: boolean;
    isMatchOver: boolean;
    matchWinner: "player1" | "player2" | null;
    narrative: string;
    player1RoundsWon: number;
    player2RoundsWon: number;
  }): void {
    try {
      console.log(`[FightScene] *** handleServerRoundResolved - Setting phase to 'resolving', Timestamp: ${Date.now()}`);
      console.log(`[FightScene] *** pendingRoundStart before setting phase: ${!!this.pendingRoundStart}`);

      // Set resolving flag to prevent match end from interrupting animations
      this.isResolving = true;
      this.phase = "resolving";
      if (PRIVATE_ROUNDS_ENABLED) {
        this.setMoveButtonsVisible(false);
        if (this.isActiveText(this.turnIndicatorText)) {
          this.turnIndicatorText.setText("Phase 3/3: Enjoy the fight!");
          this.turnIndicatorText.setColor("#f97316");
        }
      }

      // Clear any pending deadline-based timers to prevent them firing during animations
      this.timerExpiredHandled = true;
      this.stunnedAutoSubmitAt = 0;
      this.bothStunnedSkipAt = 0;

      // Get max values from local engine for fallback (server should provide these)
      const localState = this.combatEngine.getState();

      // Store previous health for damage calculation
      const prevP1Health = this.serverState?.player1Health ?? payload.player1Health;
      const prevP2Health = this.serverState?.player2Health ?? payload.player2Health;

      // Store PENDING server state - don't apply to serverState yet!
      // This prevents UI from showing new HP/energy values before animations complete.
      // The pendingServerState will be applied when syncUIWithCombatState() is called
      // after the attack animations finish.
      this.pendingServerState = {
        player1Health: payload.player1Health,
        player1MaxHealth: payload.player1MaxHealth ?? localState.player1.maxHp,
        player2Health: payload.player2Health,
        player2MaxHealth: payload.player2MaxHealth ?? localState.player2.maxHp,
        player1Energy: payload.player1Energy,
        player1MaxEnergy: payload.player1MaxEnergy ?? localState.player1.maxEnergy,
        player2Energy: payload.player2Energy,
        player2MaxEnergy: payload.player2MaxEnergy ?? localState.player2.maxEnergy,
        player1GuardMeter: payload.player1GuardMeter,
        player2GuardMeter: payload.player2GuardMeter,
        player1RoundsWon: payload.player1RoundsWon,
        player2RoundsWon: payload.player2RoundsWon,
        currentRound: this.serverState?.currentRound ?? 1,
        // Stun is a *turn-start* status in this game flow.
        // The roundResolved payload may reflect "stunned next" (e.g., guard break), and applying
        // it immediately makes the defender look stunned right after the narrative shows
        // "Special beats Block" � which feels like a desync.
        // We keep current stun state here and rely on the next round_starting/stateSync to
        // introduce stun at the correct time.
        player1IsStunned: this.serverState?.player1IsStunned ?? false,
        player2IsStunned: this.serverState?.player2IsStunned ?? false,
      };

      // Capture stun-at-turn-start state from the last round_starting payload.
      // This is the authoritative indicator for who must miss THIS turn.
      const p1StunnedAtTurnStart = Boolean(this.serverState?.player1IsStunned);
      const p2StunnedAtTurnStart = Boolean(this.serverState?.player2IsStunned);

      const p1Char = this.config.player1Character || "soroban-sage";
      const p2Char = this.config.player2Character || "soroban-sage";

    // Using centralized getAnimationScale(charId, animType) from sprite-config.ts
    // All scale values are managed in MANUAL_SCALE_OVERRIDES or calculated dynamically

      // Store original positions
      const p1OriginalX = CHARACTER_POSITIONS.PLAYER1.X;
      const p2OriginalX = CHARACTER_POSITIONS.PLAYER2.X;
      const meetingPointX = GAME_DIMENSIONS.CENTER_X;

    // Resolve effective moves for playback.
    // If a player was stunned at turn start, force their move to "stunned"
    // even when payload.move still contains a preplanned choice.
      const p1Move: MoveType = p1StunnedAtTurnStart ? "stunned" : payload.player1.move;
      const p2Move: MoveType = p2StunnedAtTurnStart ? "stunned" : payload.player2.move;

    if ((p1StunnedAtTurnStart && payload.player1.move !== "stunned") || (p2StunnedAtTurnStart && payload.player2.move !== "stunned")) {
      console.warn(
        `[FightScene] Applying local stun move override for playback (turn-start stun): ` +
        `p1 ${payload.player1.move} -> ${p1Move}, p2 ${payload.player2.move} -> ${p2Move}`
      );
    }

      // Check stun state for this turn's animation flow.
      const p1IsStunned = p1Move === "stunned" || payload.player1.outcome === "stunned";
      const p2IsStunned = p2Move === "stunned" || payload.player2.outcome === "stunned";

    // Prepare targets
    let p1TargetX = meetingPointX - 50;
    let p2TargetX = meetingPointX + 50;

    if (p1IsStunned) {
      p1TargetX = p1OriginalX;
      p2TargetX = p1OriginalX + 150; // Run to P1
    } else if (p2IsStunned) {
      p2TargetX = p2OriginalX;
      p1TargetX = p2OriginalX - 150; // Run to P2
    }

    // Phase 1: Both characters run toward target with run scale (only if not stunned)
    if (!p1IsStunned && this.anims.exists(`${p1Char}_run`)) {
      const p1RunScale = getAnimationScale(p1Char, "run");
      this.player1Sprite.setScale(p1RunScale);
      this.player1Sprite.play(`${p1Char}_run`);
      this.toggleStunEffect("player1", false);
    } else if (p1IsStunned) {
      // Stunned player stays in idle and shows stun effect
      if (this.anims.exists(`${p1Char}_idle`)) {
        const p1IdleScale = getAnimationScale(p1Char, "idle");
        this.player1Sprite.setScale(p1IdleScale);
        this.player1Sprite.play(`${p1Char}_idle`);
      }
      // Visual stun indicator - pulsing red tint
      // Visual stun indicator - persistent red pulse
      this.toggleStunEffect("player1", true);
    }
    if (!p2IsStunned && this.anims.exists(`${p2Char}_run`)) {
      const p2RunScale = getAnimationScale(p2Char, "run");
      this.player2Sprite.setScale(p2RunScale);
      this.player2Sprite.play(`${p2Char}_run`);
      this.toggleStunEffect("player2", false);
    } else if (p2IsStunned) {
      // Stunned player stays in idle and shows stun effect
      if (this.anims.exists(`${p2Char}_idle`)) {
        const p2IdleScale = getAnimationScale(p2Char, "idle");
        this.player2Sprite.setScale(p2IdleScale);
        this.player2Sprite.play(`${p2Char}_idle`);
      }
      // Visual stun indicator - pulsing red tint
      // Visual stun indicator - persistent red pulse
      this.toggleStunEffect("player2", true);
    }

      // Tween both characters toward targets
      this.tweens.add({
        targets: this.player1Sprite,
        x: p1TargetX,
        duration: p1IsStunned ? 0 : 600,
        ease: 'Power2',
      });

      this.tweens.add({
        targets: this.player2Sprite,
        x: p2TargetX,
        duration: p2IsStunned ? 0 : 600,
        ease: 'Power2',
        onComplete: () => {
        // Sequential Animation Logic using Promises
        // Use server-provided pre-regen damageTaken for hit VFX.
        // Net HP delta can be 0 when regen/lifesteal offsets damage, which makes
        // stunned turns look like they dealt no damage.
        const p1ActualDamage = Math.max(0, Math.floor(payload.player1?.damageTaken ?? 0));
        const p2ActualDamage = Math.max(0, Math.floor(payload.player2?.damageTaken ?? 0));

        const getAnimDurationMs = (animKey: string, fallbackMs: number): number => {
          try {
            if (!this.anims.exists(animKey)) return fallbackMs;
            const anim = this.anims.get(animKey) as any;
            const duration = Number(anim?.duration);
            if (Number.isFinite(duration) && duration > 0) return Math.ceil(duration);

            const frames = Array.isArray(anim?.frames) ? anim.frames.length : Number(anim?.frames?.length ?? 0);
            const frameRate = Number(anim?.frameRate ?? 24);
            if (Number.isFinite(frames) && frames > 0 && Number.isFinite(frameRate) && frameRate > 0) {
              return Math.ceil((frames / frameRate) * 1000);
            }
          } catch {
            // ignore and fall back
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

        const surgeForPlayback = calculateSurgeEffects(this.activeSurges.player1, this.activeSurges.player2);
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

        const PUNCH_KICK_HIT_MS = 1200;
        const HIT_IMPACT_MS = 300;

        // Helper: P1 Attack
        const runP1Attack = () => {
          return new Promise<void>((resolve) => {
            if (p1IsStunned) {
              resolve(); // Skip if stunned
              return;
            }

            const animKey = `${p1Char}_${p1Move}`;
            const animDurationMs = getAnimDurationMs(animKey, PUNCH_KICK_HIT_MS);
            const baseSpacingMs = (p1Move === "punch" || p1Move === "kick") ? PUNCH_KICK_HIT_MS : animDurationMs;
            const hitSpacingMs = Math.max(baseSpacingMs, animDurationMs);
            const impactMs = Math.min(HIT_IMPACT_MS, Math.max(120, Math.floor(animDurationMs * 0.25)));

            const shouldRepeat = (p1Move === "punch" || p1Move === "kick") && p1HitCount > 1;
            const hitCount = shouldRepeat ? p1HitCount : 1;
            const damageParts = splitDamageIntoHits(p2ActualDamage, hitCount);

            for (let i = 0; i < hitCount; i++) {
              const startOffset = i * hitSpacingMs;

              this.time.delayedCall(startOffset, () => {
                if (this.anims.exists(animKey) || p1Move === "block") {
                  const scale = getAnimationScale(p1Char, p1Move);
                  this.player1Sprite.setScale(scale);
                  if (this.anims.exists(animKey)) this.player1Sprite.play(animKey);

                  const sfxKey = getSFXKey(p1Char, p1Move);
                  const delay = getSoundDelay(p1Char, p1Move);
                  if (delay > 0) {
                    this.time.delayedCall(delay, () => this.playSFX(sfxKey));
                  } else {
                    this.playSFX(sfxKey);
                  }
                }
              });

              this.time.delayedCall(startOffset + impactMs, () => {
                const part = damageParts[i] ?? 0;
                if (part > 0) {
                  this.showFloatingText(`-${part}`, p2TargetX, CHARACTER_POSITIONS.PLAYER2.Y - 130, "#ff4444");
                  this.tweens.add({
                    targets: this.player2Sprite,
                    alpha: 0.5,
                    yoyo: true,
                    duration: 50,
                    repeat: 3
                  });
                } else if (i === 0 && payload.player2.outcome === "missed") {
                  this.showFloatingText("DODGE!", p2TargetX, CHARACTER_POSITIONS.PLAYER2.Y - 130, "#8800ff");
                }
              });
            }

            const afterLastHitOffset = (hitCount - 1) * hitSpacingMs;

            if (payload.player2.energyDrained && payload.player2.energyDrained > 0) {
              this.time.delayedCall(afterLastHitOffset + 500, () => {
                this.showFloatingText(
                  `-${Math.round(payload.player2.energyDrained!)} EN`,
                  p2TargetX,
                  CHARACTER_POSITIONS.PLAYER2.Y - 100,
                  "#3b82f6"
                );
              });
            }

            const p1TotalHeal = (payload.player1.hpRegen || 0) + (payload.player1.lifesteal || 0);
            if (p1TotalHeal > 0) {
              this.time.delayedCall(afterLastHitOffset + 700, () => {
                this.showFloatingText(
                  `+${Math.round(p1TotalHeal)} HP`,
                  p1TargetX,
                  CHARACTER_POSITIONS.PLAYER1.Y - 100,
                  "#00ff88"
                );
              });
            }

            const totalMs = afterLastHitOffset + animDurationMs;
            this.time.delayedCall(totalMs, () => resolve());
          });
        };

        // Helper: P2 Attack
        const runP2Attack = () => {
          return new Promise<void>((resolve) => {
            if (p2IsStunned) {
              resolve();
              return;
            }

            const animKey = `${p2Char}_${p2Move}`;
            const animDurationMs = getAnimDurationMs(animKey, PUNCH_KICK_HIT_MS);
            const baseSpacingMs = (p2Move === "punch" || p2Move === "kick") ? PUNCH_KICK_HIT_MS : animDurationMs;
            const hitSpacingMs = Math.max(baseSpacingMs, animDurationMs);
            const impactMs = Math.min(HIT_IMPACT_MS, Math.max(120, Math.floor(animDurationMs * 0.25)));

            const shouldRepeat = (p2Move === "punch" || p2Move === "kick") && p2HitCount > 1;
            const hitCount = shouldRepeat ? p2HitCount : 1;
            const damageParts = splitDamageIntoHits(p1ActualDamage, hitCount);

            for (let i = 0; i < hitCount; i++) {
              const startOffset = i * hitSpacingMs;

              this.time.delayedCall(startOffset, () => {
                if (this.anims.exists(animKey) || p2Move === "block") {
                  const scale = getAnimationScale(p2Char, p2Move);
                  this.player2Sprite.setScale(scale);
                  if (this.anims.exists(animKey)) this.player2Sprite.play(animKey);

                  const sfxKey = getSFXKey(p2Char, p2Move);
                  const p2Delay = getSoundDelay(p2Char, p2Move);
                  if (p2Delay > 0) {
                    this.time.delayedCall(p2Delay, () => this.playSFX(sfxKey));
                  } else {
                    this.playSFX(sfxKey);
                  }
                }
              });

              this.time.delayedCall(startOffset + impactMs, () => {
                const part = damageParts[i] ?? 0;
                if (part > 0) {
                  this.showFloatingText(`-${part}`, p1TargetX, CHARACTER_POSITIONS.PLAYER1.Y - 130, "#ff4444");
                  this.tweens.add({
                    targets: this.player1Sprite,
                    alpha: 0.5,
                    yoyo: true,
                    duration: 50,
                    repeat: 3
                  });
                } else if (i === 0 && payload.player1.outcome === "missed") {
                  this.showFloatingText("DODGE!", p1TargetX, CHARACTER_POSITIONS.PLAYER1.Y - 130, "#8800ff");
                }
              });
            }

            const afterLastHitOffset = (hitCount - 1) * hitSpacingMs;

            if (payload.player1.energyDrained && payload.player1.energyDrained > 0) {
              this.time.delayedCall(afterLastHitOffset + 500, () => {
                this.showFloatingText(
                  `-${Math.round(payload.player1.energyDrained!)} EN`,
                  p1TargetX,
                  CHARACTER_POSITIONS.PLAYER1.Y - 100,
                  "#3b82f6"
                );
              });
            }

            const p2TotalHeal = (payload.player2.hpRegen || 0) + (payload.player2.lifesteal || 0);
            if (p2TotalHeal > 0) {
              this.time.delayedCall(afterLastHitOffset + 700, () => {
                this.showFloatingText(
                  `+${Math.round(p2TotalHeal)} HP`,
                  p2TargetX,
                  CHARACTER_POSITIONS.PLAYER2.Y - 100,
                  "#00ff88"
                );
              });
            }

            const totalMs = afterLastHitOffset + animDurationMs;
            this.time.delayedCall(totalMs, () => resolve());
          });
        };

        // Execute Sequence
        (async () => {
          // Check for block interaction (Scenario 1 & 2: Attack vs Block, Block vs Block)
          // Assumption: "Block" moves are identified by explicit "block" move type.
          const isConcurrent = p1Move === "block" || p2Move === "block";

          if (isConcurrent) {
            // Run both simultaneously
            await Promise.all([runP1Attack(), runP2Attack()]);
          } else {
            // Sequential (Attack vs Attack)
            // P1 goes first
            await runP1Attack();
            // Then P2
            await runP2Attack();
          }

          // Use server-provided narrative (authoritative)
          const narrative = payload.narrative || "Both attacks were blocked or missed!";
          this.narrativeText.setText(narrative);
          this.narrativeText.setAlpha(1);

          // Update UI/Health Bars
          this.syncUIWithCombatState();

          this.roundScoreText.setText(
            `Round ${this.serverState?.currentRound ?? 1}  |  ${payload.player1RoundsWon} - ${payload.player2RoundsWon}  (First to 2)`
          );

          // Run back animations
          if (!p1IsStunned && this.anims.exists(`${p1Char}_run`)) {
            const p1RunScale = getAnimationScale(p1Char, "run");
            this.player1Sprite.setScale(p1RunScale);
            this.player1Sprite.play(`${p1Char}_run`);
          }
          if (!p2IsStunned && this.anims.exists(`${p2Char}_run`)) {
            const p2RunScale = getAnimationScale(p2Char, "run");
            this.player2Sprite.setScale(p2RunScale);
            this.player2Sprite.play(`${p2Char}_run`);
            this.player2Sprite.setFlipX(true); // Ensure facing correct way
          }

          // Tween back
          this.tweens.add({
            targets: this.player1Sprite,
            x: p1OriginalX,
            duration: p1IsStunned ? 0 : 600,
            ease: 'Power2',
          });

          this.tweens.add({
            targets: this.player2Sprite,
            x: p2OriginalX,
            duration: p2IsStunned ? 0 : 600,
            ease: 'Power2',
            onComplete: () => {
              const REST_MS = 1000;

              // Phase 5: Return to idle immediately once both fighters are back.
              if (!payload.isMatchOver) {
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

                this.tweens.add({
                  targets: this.narrativeText,
                  alpha: 0,
                  duration: 300,
                });
              }

              // Keep isResolving true during the short rest so we don't instantly start the next
              // turn (which looks like "middle ? back ? immediately middle again").
              this.time.delayedCall(REST_MS, () => {
                // If match is over, do not continue turn flow.
                if (payload.isMatchOver) {
                  this.isResolving = false;
                  console.log("[FightScene] Match is over - skipping next turn flow");

                  if (this.pendingMatchEndPayload) {
                    console.log("[FightScene] Processing queued match end payload");
                    this.processMatchEnd(this.pendingMatchEndPayload);
                    this.pendingMatchEndPayload = null;
                  } else {
                    console.warn("[FightScene] No pendingMatchEndPayload on isMatchOver; fetching final match state as fallback");
                    void this.fetchFinalMatchState();
                  }
                  return;
                }

                // Apply stun carry *for the next turn* after the current animations have finished.
                if (!payload.isRoundOver && this.serverState) {
                  this.serverState.player1IsStunned = Boolean(payload.player1?.isStunned);
                  this.serverState.player2IsStunned = Boolean(payload.player2?.isStunned);
                  this.toggleStunEffect("player1", this.serverState.player1IsStunned ?? false);
                  this.toggleStunEffect("player2", this.serverState.player2IsStunned ?? false);
                }

                // Unset resolving flag after rest.
                this.isResolving = false;

                // If another resolved turn is already queued (common in private rounds), play it now.
                if (!payload.isRoundOver && this.roundResolvedQueue.length > 0) {
                  this.tryPlayNextResolvedTurn();
                  return;
                }

                // Round ended ? show round end UI.
                if (payload.isRoundOver) {
                  this.showRoundEndFromServer(payload.roundWinner, payload.player1RoundsWon, payload.player2RoundsWon);
                  return;
                }

                // Otherwise, wait for the next round_starting payload (public rounds).
                this.selectedMove = null;
                if (this.pendingRoundStart) {
                  console.log(`[FightScene] *** Processing queued pendingRoundStart after animations`);
                  const queuedPayload = this.pendingRoundStart;
                  this.pendingRoundStart = null;
                  this.phase = "selecting";
                  this.startRoundFromServer(queuedPayload, false);
                } else {
                  this.phase = "waiting";
                  if (this.isActiveText(this.turnIndicatorText)) {
                    this.turnIndicatorText.setText("Waiting for next turn...");
                    this.turnIndicatorText.setColor(PRIVATE_ROUNDS_ENABLED ? "#22c55e" : "#888888");
                  }
                  if (PRIVATE_ROUNDS_ENABLED) {
                    this.setPhaseThreeTimerTick();
                  }
                }
              });
            }
          });
        })();
      },
    });
    } catch (err) {
      console.error("[FightScene] handleServerRoundResolved crashed:", err);
      this.isResolving = false;

      // If the match was supposed to be over, still attempt to transition.
      if (payload.isMatchOver) {
        void this.fetchFinalMatchState();
      }
    }
  }

  /**
   * Process match end payload (separated to allow queuing).
   */
  private processMatchEnd(payload: {
    winner: "player1" | "player2";
    winnerAddress: string;
    reason: string;
    finalScore?: {
      player1RoundsWon?: number;
      player2RoundsWon?: number;
    };
    player1RoundsWon?: number;
    player2RoundsWon?: number;
    ratingChanges?: {
      winner: { before: number; after: number; change: number };
      loser: { before: number; after: number; change: number };
    };
    isPrivateRoom?: boolean;
    onChainSessionId?: number;
    onChainTxHash?: string;
    contractId?: string;
  }): void {
    // Use helper for SFX and Animations
    this.showMatchEnd(payload.winner);

    // Use a shorter delay for forfeits so the result feels instant
    // Normal match endings (knockout/rounds_won) keep the full 5s for animations
    const delayMs = payload.reason === "forfeit" ? 1500 : 5000;

    this.time.delayedCall(delayMs, () => {
      const player1RoundsWon =
        payload.finalScore?.player1RoundsWon ??
        payload.player1RoundsWon ??
        this.serverState?.player1RoundsWon ??
        0;
      const player2RoundsWon =
        payload.finalScore?.player2RoundsWon ??
        payload.player2RoundsWon ??
        this.serverState?.player2RoundsWon ??
        0;

      const normalizedReason =
        payload.reason === "knockout" ||
        payload.reason === "timeout" ||
        payload.reason === "forfeit"
          ? payload.reason
          : "decision";

      const isWinner = payload.winner === this.config.playerRole;

      EventBus.emit("fight:matchResult", {
        isWinner,
        ratingChanges: payload.ratingChanges,
        isPrivateRoom: payload.isPrivateRoom,
        onChainSessionId: payload.onChainSessionId,
        onChainTxHash: payload.onChainTxHash,
        contractId: payload.contractId,
      });

      this.scene.start("ResultsScene", {
        isWinner,
        playerRole: this.config.playerRole,
        matchId: this.config.matchId,
        player1RoundsWon,
        player2RoundsWon,
        reason: normalizedReason,
        ratingChanges: payload.ratingChanges,
        isPrivateRoom: payload.isPrivateRoom,
        onChainSessionId: payload.onChainSessionId,
        onChainTxHash: payload.onChainTxHash,
        contractId: payload.contractId,
      });
    });
  }

  /**
   * Show round end from server data (production mode).
   * Plays death animation on loser, shows result text, countdown, then resets for next round.
   */
  private showRoundEndFromServer(
    roundWinner: "player1" | "player2" | null,
    p1Wins: number,
    p2Wins: number
  ): void {
    this.phase = "round_end";

    const p1Char = this.config.player1Character || "soroban-sage";
    const p2Char = this.config.player2Character || "soroban-sage";

    // Handle DRAW case (both characters ran out of HP in the same turn)
    if (roundWinner === null) {
      // Both characters died - play dead animation on both
      if (this.anims.exists(`${p1Char}_dead`)) {
        this.player1Sprite.setScale(getAnimationScale(p1Char, "dead"));
        this.player1Sprite.play(`${p1Char}_dead`);
      }
      if (this.anims.exists(`${p2Char}_dead`)) {
        this.player2Sprite.setScale(getAnimationScale(p2Char, "dead"));
        this.player2Sprite.play(`${p2Char}_dead`);
      }

      // Wait for death animation to complete (36 frames at 24fps = 1.5s)
      this.time.delayedCall(1500, () => {
        // Show draw result text
        this.countdownText.setText("DOUBLE KO - DRAW!");
        this.countdownText.setFontSize(42);
        this.countdownText.setColor("#fbbf24");
        this.countdownText.setAlpha(1);

        // Play neutral SFX
        this.playSFX("sfx_defeat");

        // After showing result text for 1.5s, start the countdown
        this.time.delayedCall(1500, () => {
          this.startRoundCountdown(p1Char, p2Char);
        });
      });
      return;
    }

    // Normal win/loss case
    const isLocalWinner = roundWinner === this.config.playerRole;

    // Play dead animation on the loser
    const loser = roundWinner === "player1" ? "player2" : "player1";
    const loserChar = loser === "player1" ? p1Char : p2Char;
    const loserSprite = loser === "player1" ? this.player1Sprite : this.player2Sprite;

    // Play dead animation on loser if it exists
    // Use centralized scale from sprite-config.ts
    if (this.anims.exists(`${loserChar}_dead`)) {
      loserSprite.setScale(getAnimationScale(loserChar, "dead"));
      loserSprite.play(`${loserChar}_dead`);
    }

    // Wait for death animation to complete (36 frames at 24fps = 1.5s)
    this.time.delayedCall(1500, () => {
      // Show round result text for this player
      const resultText = isLocalWinner ? "YOU WON THIS ROUND!" : "YOU LOST THIS ROUND";
      this.countdownText.setText(resultText);
      this.countdownText.setFontSize(42);
      this.countdownText.setColor(isLocalWinner ? "#22c55e" : "#ef4444");
      this.countdownText.setAlpha(1);

      // Play SFX
      if (isLocalWinner) {
        this.playSFX("sfx_victory");
      } else {
        this.playSFX("sfx_defeat");
      }
      this.countdownText.setFontSize(42);
      this.countdownText.setColor(isLocalWinner ? "#22c55e" : "#ef4444");
      this.countdownText.setAlpha(1);

      // After showing result text for 1.5s, start the countdown
      this.time.delayedCall(1500, () => {
        this.startRoundCountdown(p1Char, p2Char);
      });
    });
  }

  /**
   * Start the countdown to the next round.
   * Uses real-time deadline so it works correctly across tab switches.
   * The actual countdown display is handled by the update() loop.
   */
  private startRoundCountdown(p1Char: string, p2Char: string): void {
    const now = Date.now();
    // 5 second countdown + 1 second for the final "1" to display
    this.roundEndCountdownEndsAt = now + 6000;
    this.roundEndCountdownStartedAt = now;
    this.roundEndData = { p1Char, p2Char };

    // Initial display
    this.countdownText.setText("Next round starting in 5");
    this.countdownText.setFontSize(32);
    this.countdownText.setColor("#40e0d0");
    this.countdownText.setAlpha(1);

    // The update() loop handles the rest using this.roundEndCountdownEndsAt
  }

  /**
   * Called by update() when round-end countdown reaches zero.
   * Resets sprites and processes pending round start.
   */
  private processRoundEndCountdownComplete(): void {
    const p1Char = this.roundEndData?.p1Char || this.config.player1Character || "soroban-sage";
    const p2Char = this.roundEndData?.p2Char || this.config.player2Character || "soroban-sage";
    this.roundEndData = undefined;

    // Hide countdown text
    this.countdownText.setAlpha(0);
    this.countdownText.setFontSize(72);

    // Reset both sprites to idle animations with proper scales
    if (this.anims.exists(`${p1Char}_idle`)) {
      this.player1Sprite.setScale(getAnimationScale(p1Char, "idle"));
      this.player1Sprite.play(`${p1Char}_idle`);
    }
    if (this.anims.exists(`${p2Char}_idle`)) {
      this.player2Sprite.setScale(getAnimationScale(p2Char, "idle"));
      this.player2Sprite.play(`${p2Char}_idle`);
    }

    // Reset selected move for next round
    this.selectedMove = null;

    // Clear active surges from previous round (including stun visual effects)
    this.clearSurgeEffects();

    // Change phase to allow processing queued events
    this.phase = "selecting";

    // Process pending round start if we received one during the round_end sequence
    if (this.pendingRoundStart) {
      console.log("[FightScene] *** Processing queued round start after round end countdown");
      const payload = this.pendingRoundStart;
      this.pendingRoundStart = null;
      // Skip the 3-2-1 FIGHT countdown since we already showed our 5-second countdown
      this.startRoundFromServer(payload, true);
    } else {
      console.warn(`[FightScene] *** WARNING: No pendingRoundStart after round end countdown! Waiting for round_starting event`);
      // No pending event, just wait
      this.turnIndicatorText.setText("Starting next round...");
      this.turnIndicatorText.setColor("#888888");
    }
  }

  // ===========================================================================
  // POWER SURGE SYSTEM
  // ===========================================================================

  /**
   * Check if both players have completed their Power Surge selections for this round.
   * Returns true only when both player selections are known.
   */
  private async checkBothSurgesComplete(roundNumber: number): Promise<boolean> {
    if (this.activeSurges.player1 && this.activeSurges.player2) {
      return true;
    }

    if (PRIVATE_ROUNDS_ENABLED) {
      return false;
    }

    try {
      const { getSupabaseClient } = await import("@/lib/supabase/client");
      const supabase = getSupabaseClient();

      const { data: surge, error } = await supabase
        .from("power_surges")
        .select("player1_card_id, player2_card_id")
        .eq("match_id", this.config.matchId)
        .eq("round_number", roundNumber)
        .maybeSingle();

      if (error) {
        console.warn(`[FightScene] Failed to read surge completion for round ${roundNumber}:`, error);
        return false;
      }

      if (!surge) {
        return false;
      }

      // Check if both players have selected (both card_id fields are set)
      const surgeRow = surge as any;
      const bothComplete = !!(surgeRow?.player1_card_id && surgeRow?.player2_card_id);
      console.log(`[FightScene] Surge completion check: p1=${!!surgeRow?.player1_card_id}, p2=${!!surgeRow?.player2_card_id}, both=${bothComplete}`);

      return bothComplete;
    } catch (error) {
      console.error("[FightScene] Error checking surge completion:", error);
      return false;
    }
  }

  /**
   * Show Power Surge card selection UI at the start of a round.
   * Called when turn 1 of a new round begins.
   * 
   * @param roundNumber - Current round number (1-5)
   * @param moveDeadlineAt - Server's move deadline timestamp
   * @returns Promise that resolves when surge selection is complete or times out
   */
  private async showPowerSurgeCards(roundNumber: number, moveDeadlineAt: number): Promise<void> {
    // Spectators see a read-only display of power surge cards
    if (this.config.isSpectator) {
      console.log("[FightScene] Setting up spectator Power Surge for round", roundNumber);
      // Initialize spectator surge data - will be shown when both players have selected
      this.spectatorSurgeData = {
        roundNumber,
        cardIds: [],
        player1Selection: null,
        player2Selection: null,
      };
      // Fetch the offered cards from the API
      try {
        const response = await fetch(apiUrl(`/api/matches/${this.config.matchId}/power-surge?round=${roundNumber}&reveal=true`));
        if (response.ok) {
          const data = await response.json();
          const offeredCards = data.data?.offeredCards || [];
          if (offeredCards.length > 0 && this.spectatorSurgeData) {
            this.spectatorSurgeData.cardIds = offeredCards;
            console.log("[FightScene] Spectator got surge cards:", offeredCards);
            // Also check if selections are already in (late join scenario)
            const p1Sel = data.data?.player1Selection;
            const p2Sel = data.data?.player2Selection;
            if (p1Sel?.cardId && p1Sel.cardId !== "hidden") {
              this.spectatorSurgeData.player1Selection = p1Sel.cardId;
            }
            if (p2Sel?.cardId && p2Sel.cardId !== "hidden") {
              this.spectatorSurgeData.player2Selection = p2Sel.cardId;
            }
            this.tryShowSpectatorSurgeUI();
          }
        }
      } catch (error) {
        console.error("[FightScene] Spectator failed to fetch surge cards:", error);
      }
      return;
    }

    // Avoid showing twice for the same round
    if (this.surgeCardsShownThisRound && this.lastSurgeRound === roundNumber) {
      console.log("[FightScene] Power Surge already shown for this round");
      return;
    }

    this.turnIndicatorText.setText("Phase 1/3: Pick your Power Surge");
    this.turnIndicatorText.setColor("#fbbf24");

    // Fetch surge cards from API or generate locally
    let cardIds: PowerSurgeCardId[] = [];
    let fetchedFromServer = false;
    let playerAlreadySelected = false;

    if (PRIVATE_ROUNDS_ENABLED) {
      const cards = getDeterministicPowerSurgeCards(this.config.matchId, roundNumber, 3);
      cardIds = cards.map(c => c.id);
      fetchedFromServer = true;
    }

    // Try fetching multiple times with a small delay to handle race conditions
    // (in case opponent is creating the row right now)
    for (let attempt = 0; attempt < 3 && !PRIVATE_ROUNDS_ENABLED; attempt++) {
      try {
        const response = await fetch(apiUrl(`/api/matches/${this.config.matchId}/power-surge?round=${roundNumber}`));
        if (response.ok) {
          const data = await response.json();
          cardIds = data.data?.offeredCards || [];

          // Check if current player has already selected a surge card
          // This handles the case where user refreshes after selecting
          const myRole = this.config.playerRole;
          const mySelection = myRole === "player1"
            ? data.data?.player1Selection
            : data.data?.player2Selection;

          if (mySelection && mySelection.ready) {
            console.log(`[FightScene] Player already selected surge card for round ${roundNumber}, skipping UI`);
            playerAlreadySelected = true;
            this.surgeCardsShownThisRound = true;
            this.lastSurgeRound = roundNumber;
            return;
          }

          if (cardIds.length > 0) {
            fetchedFromServer = true;
            console.log(`[FightScene] Fetched surge cards from server (attempt ${attempt + 1}):`, cardIds);
            break;
          }
        }
      } catch (error) {
        console.error("[FightScene] Failed to fetch surge cards:", error);
      }

      // If no cards yet and not the last attempt, wait a bit and retry
      if (!fetchedFromServer && attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 300)); // Wait 300ms before retry
      }
    }

    // Mark as shown now that we're proceeding
    this.surgeCardsShownThisRound = true;
    this.lastSurgeRound = roundNumber;

    // If no cards from server after retries, generate locally
    if (!fetchedFromServer || cardIds.length === 0) {
      console.log("[FightScene] No cards from server after retries, generating locally");
      const cards = getRandomPowerSurgeCards(3);
      cardIds = cards.map(c => c.id);
    }

    if (cardIds.length === 0) {
      console.log("[FightScene] No surge cards available");
      return;
    }

    console.log(`[FightScene] Showing Power Surge cards for round ${roundNumber}:`, cardIds);

    // Calculate deadline (7 seconds from now, but not exceeding move deadline)
    const surgeDeadline = Math.min(Date.now() + 15000, moveDeadlineAt - 1000);

    const playerAddress = this.config.playerRole === "player1"
      ? this.config.player1Address
      : this.config.player2Address;

    return new Promise((resolve) => {
      // Create and show the Power Surge UI
      this.powerSurgeUI = new PowerSurgeCards({
        scene: this,
        matchId: this.config.matchId,
        roundNumber,
        cardIds,
        playerAddress,
        deadline: surgeDeadline,
        waitForOpponent: !PRIVATE_ROUNDS_ENABLED,
        onCardSelected: async (cardId: PowerSurgeCardId) => {
          await new Promise<void>((resolve, reject) => {
            const timeout = this.time.delayedCall(30000, () => {
              try {
                EventBus.off("game:powerSurgeSelected", onSelected as any, this);
                EventBus.off("game:powerSurgeError", onError as any, this);
              } catch {
                // ignore
              }
              reject(new Error("Power Surge confirmation timed out"));
            });

            const onSelected = (data: unknown) => {
              const payload = data as {
                player?: "player1" | "player2";
                cardId?: PowerSurgeCardId;
                roundNumber?: number;
              };

              if (
                payload.player === this.config.playerRole
                && payload.cardId === cardId
                && payload.roundNumber === roundNumber
              ) {
                timeout.remove(false);
                try {
                  EventBus.off("game:powerSurgeSelected", onSelected as any, this);
                  EventBus.off("game:powerSurgeError", onError as any, this);
                } catch {
                  // ignore
                }
                resolve();
              }
            };

            const onError = (data: unknown) => {
              const payload = data as {
                player?: "player1" | "player2";
                cardId?: PowerSurgeCardId;
                roundNumber?: number;
                error?: string;
              };

              if (
                payload.player === this.config.playerRole
                && payload.cardId === cardId
                && payload.roundNumber === roundNumber
              ) {
                timeout.remove(false);
                try {
                  EventBus.off("game:powerSurgeSelected", onSelected as any, this);
                  EventBus.off("game:powerSurgeError", onError as any, this);
                } catch {
                  // ignore
                }
                reject(new Error(payload.error || "Power Surge selection failed"));
              }
            };

            this.onBus("game:powerSurgeSelected", onSelected as any);
            this.onBus("game:powerSurgeError", onError as any);
            EventBus.emit("fight:selectPowerSurge", {
              matchId: this.config.matchId,
              roundNumber,
              playerRole: this.config.playerRole,
              playerAddress,
              cardId,
            });
          });

          // Store local active surge
          this.activeSurges[this.config.playerRole as "player1" | "player2"] = cardId;

          // Emit event for combat engine
          EventBus.emit("surge:applied", {
            player: this.config.playerRole,
            cardId,
            roundNumber,
          });
        },
        onTimeout: () => {
          console.log("[FightScene] Power Surge selection timed out");
          // No surge selected - that's okay
        },
        onClose: async () => {
          try {
            this.powerSurgeUI = undefined;

            // REVEAL: Now that the UI is closed, reveal opponent's surge if they chose one
            const opponentRole = this.config.playerRole === "player1" ? "player2" : "player1";
            let opponentSurgeId = this.activeSurges[opponentRole];

            // If we don't have opponent's surge from broadcast, fetch from database
            if (!opponentSurgeId && !PRIVATE_ROUNDS_ENABLED) {
              console.log(`[FightScene] No opponent surge in memory, fetching from database...`);
              try {
                const response = await fetch(apiUrl(`/api/matches/${this.config.matchId}/power-surge?round=${roundNumber}&reveal=true`));
                if (response.ok) {
                  const data = await response.json();
                  const opponentKey = opponentRole === "player1" ? "player1Selection" : "player2Selection";
                  const opponentSelection = data.data?.[opponentKey];
                  if (opponentSelection && opponentSelection.cardId && opponentSelection.cardId !== "hidden") {
                    opponentSurgeId = opponentSelection.cardId as PowerSurgeCardId;
                    this.activeSurges[opponentRole] = opponentSurgeId;
                    console.log(`[FightScene] Fetched opponent surge from DB: ${opponentSurgeId}`);
                  }
                }
              } catch (error) {
                console.error("[FightScene] Failed to fetch opponent surge:", error);
              }
            }

            if (opponentSurgeId) {
              const card = getPowerSurgeCard(opponentSurgeId);
              if (card) {
                console.log(`[FightScene] REVEALING opponent surge: ${card.name}`);
                this.showSurgeCardReveal(opponentRole, opponentSurgeId);
                this.applySurgeVisualEffect(opponentRole, card);
              }
            }

            // APPLY STUN EFFECTS from Power Surge cards immediately
            // This ensures stun is applied before startSynchronizedSelectionPhase is called
            this.applyImmediateSurgeEffects();
          } catch (error) {
            console.error("[FightScene] Error during Power Surge close handler:", error);
          } finally {
            resolve();
          }
        },
      });
    });
  }

  /**
   * Handle power surge selection from opponent (via realtime broadcast).
   */
  private async handleOpponentSurgeSelected(payload: {
    player: "player1" | "player2";
    cardId: PowerSurgeCardId;
    roundNumber: number;
  }): Promise<void> {
    if (this.hasCleanedUp || this.phase === "match_end" || !this.scene.isActive()) return;

    // Spectators: record both players' selections for the read-only display
    if (this.config.isSpectator) {
      console.log(`[FightScene] Spectator received surge selection: ${payload.player} chose ${payload.cardId} (round ${payload.roundNumber})`);
      this.activeSurges[payload.player] = payload.cardId;

      if (this.spectatorSurgeData && this.spectatorSurgeData.roundNumber === payload.roundNumber) {
        if (payload.player === "player1") {
          this.spectatorSurgeData.player1Selection = payload.cardId;
        } else {
          this.spectatorSurgeData.player2Selection = payload.cardId;
        }
        this.tryShowSpectatorSurgeUI();
      } else {
        // No surge data yet (cards haven't been fetched). Create it and fetch cards.
        this.spectatorSurgeData = {
          roundNumber: payload.roundNumber,
          cardIds: [],
          player1Selection: payload.player === "player1" ? payload.cardId : null,
          player2Selection: payload.player === "player2" ? payload.cardId : null,
        };
        // Fetch offered cards
        try {
          const response = await fetch(apiUrl(`/api/matches/${this.config.matchId}/power-surge?round=${payload.roundNumber}&reveal=true`));
          if (response.ok) {
            const data = await response.json();
            const offeredCards = data.data?.offeredCards || [];
            if (offeredCards.length > 0 && this.spectatorSurgeData) {
              this.spectatorSurgeData.cardIds = offeredCards;
              // Also pick up any selections already returned
              const p1Sel = data.data?.player1Selection;
              const p2Sel = data.data?.player2Selection;
              if (p1Sel?.cardId && p1Sel.cardId !== "hidden" && !this.spectatorSurgeData.player1Selection) {
                this.spectatorSurgeData.player1Selection = p1Sel.cardId;
              }
              if (p2Sel?.cardId && p2Sel.cardId !== "hidden" && !this.spectatorSurgeData.player2Selection) {
                this.spectatorSurgeData.player2Selection = p2Sel.cardId;
              }
              this.tryShowSpectatorSurgeUI();
            }
          }
        } catch (error) {
          console.error("[FightScene] Spectator failed to fetch surge cards:", error);
        }
      }
      return;
    }

    // Deduplicate repeated broadcast events (e.g., optimistic client broadcast + server broadcast)
    if (this.activeSurges[payload.player] === payload.cardId) {
      console.log(`[FightScene] Duplicate surge event ignored for ${payload.player}: ${payload.cardId}`);
      return;
    }

    const isOpponent = payload.player !== this.config.playerRole;

    // Store selection
    this.activeSurges[payload.player] = payload.cardId;

    // CHECK FOR IMMEDIATE STUN EFFECT (Mempool Congest)
    // If we are already in selecting phase, disable buttons immediately
    if (this.phase === "selecting") {
      const card = getPowerSurgeCard(payload.cardId);
      const isOpponent = payload.player !== this.config.playerRole;

      // If opponent picked a stun card, I am stunned
      const isStunCard = card?.effectType === "opponent_stun";
      if (isOpponent && isStunCard) {
        console.log(`[FightScene] Late stun apply from handleOpponentSurgeSelected: ${card?.name ?? payload.cardId}`);
        try {
          this.turnIndicatorText.setText("YOU ARE STUNNED!");
          this.turnIndicatorText.setColor("#ff4444");
          this.roundTimerText.setColor("#ff4444");
        } catch {
          // ignore renderer/text teardown races
        }

        this.moveButtons.forEach(btn => {
          btn.setAlpha(0.3);
          btn.disableInteractive();
        });
      }
    }

    if (isOpponent) {
      console.log(`[FightScene] Opponent surge recorded: ${payload.player} chose ${payload.cardId}`);

      // Fetch the authoritative cards from the server now that opponent has selected
      // This ensures we're working with the same card set
      if (this.powerSurgeUI && !PRIVATE_ROUNDS_ENABLED) {
        try {
          const response = await fetch(apiUrl(`/api/matches/${this.config.matchId}/power-surge?round=${payload.roundNumber}`));
          if (response.ok) {
            const data = await response.json();
            const serverCards = data.data?.offeredCards || [];
            if (serverCards.length > 0) {
              console.log(`[FightScene] Refreshing UI with server cards:`, serverCards);
              this.powerSurgeUI.refreshCards(serverCards);
            }
          }
        } catch (error) {
          console.error("[FightScene] Failed to fetch server cards:", error);
        }

        this.powerSurgeUI.showOpponentReady(true);
      }
      return;
    }

    // Handle our own selection display
    const card = getPowerSurgeCard(payload.cardId);
    if (card) {
      const message = `You activated ${card.name}!`;

      this.showSurgeCardReveal(payload.player, payload.cardId);

      // Visual effect is applied by showSurgeCardReveal().

      // NOTE: We do NOT apply immediate visual stun for Mempool Congest here.
      // The stun effect only applies on turn 1 of the round, not immediately on card selection.
      // The visual stun will be applied when the round actually starts and stun state is confirmed.
      const isStunCard = card.effectType === "opponent_stun";
      if (isStunCard) {
        console.log(`[FightScene] Mempool Congest selected - stun will apply on turn 1`);
        // Just show a brief text notification
        this.narrativeText.setText(`${card.name} will stun opponent on Turn 1!`);
        this.narrativeText.setAlpha(1);
        this.tweens.add({
          targets: this.narrativeText,
          alpha: 0,
          delay: 2000,
          duration: 500
        });
      }
    }
  }

  /**
   * Try to show spectator power surge UI once we have cards and both selections.
   * Called after receiving surge data from API or broadcast events.
   */
  private tryShowSpectatorSurgeUI(): void {
    if (!this.spectatorSurgeData) return;
    const { cardIds, player1Selection, player2Selection, roundNumber } = this.spectatorSurgeData;

    // Need all three: the offered cards AND both player selections
    if (cardIds.length === 0 || !player1Selection || !player2Selection) {
      console.log("[FightScene] Spectator surge data incomplete, waiting...", {
        hasCards: cardIds.length > 0,
        p1: player1Selection,
        p2: player2Selection,
      });
      return;
    }

    console.log("[FightScene] Showing spectator Power Surge UI for round", roundNumber);

    // Clean up any existing spectator surge UI
    if (this.spectatorSurgeUI) {
      this.spectatorSurgeUI.destroy();
      this.spectatorSurgeUI = null;
    }

    // Create the read-only spectator power surge display
    this.spectatorSurgeUI = new SpectatorPowerSurgeCards({
      scene: this,
      roundNumber,
      cardIds,
      player1Selection,
      player2Selection,
      player1SpriteY: this.player1Sprite.y,
      player2SpriteY: this.player2Sprite.y,
      player1Sprite: this.player1Sprite,
      player2Sprite: this.player2Sprite,
      player1Label: "P1",
      player2Label: "P2",
      onComplete: () => {
        this.spectatorSurgeUI = null;
        this.spectatorSurgeData = null;
      },
    });
  }

  /**
   * Show a card reveal popup above the character's head.
   * Replaces the old text-only reveal.
   */
  private showSurgeCardReveal(player: "player1" | "player2", cardId: string): void {
    if (this.hasCleanedUp || this.phase === "match_end" || !this.scene.isActive()) return;

    const card = getPowerSurgeCard(cardId as PowerSurgeCardId);
    if (!card) return;

    const targetSprite = player === "player1" ? this.player1Sprite : this.player2Sprite;
    if (!targetSprite) return;

    // Create container above character
    // Use PowerSurgeCardView for unified design
    let container: Phaser.GameObjects.Container;
    try {
      container = PowerSurgeCardView.create({
        scene: this,
        card,
        x: targetSprite.x,
        y: targetSprite.y - 280,
        scale: 0.7, // Slightly smaller than selection screen
      });
    } catch (error) {
      console.warn("[FightScene] Skipping surge reveal due to scene teardown race", error);
      return;
    }

    container.setDepth(2000); // Higher than standard UI but lower than overlays
    container.setScale(0); // Start hidden for pop-up

    // "OPPONENT SURGE" or "YOUR SURGE" label
    const isOpponent = player !== this.config.playerRole;
    const labelText = isOpponent ? "OPPONENT SURGE" : "YOUR SURGE";
    const labelColor = isOpponent ? "#ff4444" : "#22c55e";

    try {
      const label = this.add.text(0, -PowerSurgeCardView.CARD_HEIGHT / 2 - 30, labelText, {
        fontFamily: "monospace",
        fontSize: "20px",
        color: labelColor,
        fontStyle: "bold",
        stroke: "#000000",
        strokeThickness: 4,
      });
      label.setOrigin(0.5);
      container.add(label);
    } catch {
      // ignore
    }

    // Animation: Pop in
    this.tweens.add({
      targets: container,
      scaleX: 0.7, // Target scale (must match creation scale)
      scaleY: 0.7,
      duration: 500,
      ease: "Back.easeOut",
      onComplete: () => {
        // Hold for 5 seconds
        this.time.delayedCall(5000, () => {
          if (container && container.active) {
            // Fade out
            this.tweens.add({
              targets: container,
              alpha: 0,
              y: container.y - 50,
              duration: 500,
              onComplete: () => container.destroy(),
            });
          }
        });
      },
    });

    // Apply surge visual effect to sprite (matches PracticeScene behavior)
    this.applySurgeVisualEffect(player, card);
  }

  /**
   * Apply visual effects for an active surge.
   */
  private applySurgeVisualEffect(
    player: "player1" | "player2",
    card: ReturnType<typeof getPowerSurgeCard>
  ): void {
    if (!card) return;
    if (this.hasCleanedUp || this.phase === "match_end" || !this.scene.isActive()) return;

    const sprite = player === "player1" ? this.player1Sprite : this.player2Sprite;

    // Apply a colored tint based on the card's glow color
    const tintColor = card.glowColor;

    // Flash effect
    this.tweens.add({
      targets: sprite,
      tint: tintColor,
      duration: 200,
      yoyo: true,
      repeat: 2,
      onComplete: () => {
        // Keep a subtle persistent tint for the round
        sprite.setTint(Phaser.Display.Color.Interpolate.ColorWithColor(
          Phaser.Display.Color.IntegerToColor(0xffffff),
          Phaser.Display.Color.IntegerToColor(tintColor),
          100,
          20 // 20% blend
        ).color);
      },
    });

    // Particle burst at character position
    this.createSurgeParticles(sprite.x, sprite.y, tintColor);
  }

  /**
   * Create particle effect for surge activation.
   */
  private createSurgeParticles(x: number, y: number, color: number): void {
    if (this.hasCleanedUp || this.phase === "match_end" || !this.scene.isActive()) return;

    for (let i = 0; i < 15; i++) {
      let particle: Phaser.GameObjects.Graphics;
      try {
        particle = this.add.graphics();
      } catch {
        return;
      }
      particle.fillStyle(color, 1);
      particle.fillCircle(0, 0, 3 + Math.random() * 3);
      particle.setPosition(x, y);
      particle.setDepth(500);

      const angle = Math.random() * Math.PI * 2;
      const speed = 50 + Math.random() * 100;
      const targetX = x + Math.cos(angle) * speed;
      const targetY = y + Math.sin(angle) * speed - 50; // Upward bias

      this.tweens.add({
        targets: particle,
        x: targetX,
        y: targetY,
        alpha: 0,
        scale: 0,
        duration: 600 + Math.random() * 400,
        ease: "Quad.easeOut",
        onComplete: () => particle.destroy(),
      });
    }
  }

  /**
   * Get active surge effects for combat resolution.
   * Called by combat engine to apply surge modifiers.
   */
  public getActiveSurgeEffects(): {
    player1: PowerSurgeCardId | null;
    player2: PowerSurgeCardId | null;
  } {
    return { ...this.activeSurges };
  }

  /**
   * Clear surge effects at end of round.
   */
  private clearSurgeEffects(): void {
    this.activeSurges = { player1: null, player2: null };
    this.surgeCardsShownThisRound = false;

    // Clear any visual tints
    this.player1Sprite.clearTint();
    this.player2Sprite.clearTint();

    // CRITICAL: Stop any active stun tweens to prevent visual stun persisting
    this.toggleStunEffect("player1", false);
    this.toggleStunEffect("player2", false);
  }

  // ===========================================================================
  // DEADLINE-BASED STUN HANDLERS (called by update() loop)
  // ===========================================================================

  /**
   * Handle auto-submission of stunned move.
   * Called by update() when stunnedAutoSubmitAt deadline is reached.
   * Works correctly even if the tab was backgrounded.
   */
  private handleStunnedAutoSubmit(): void {
    if (this.localMoveSubmitted || this.phase !== "selecting") return;

    this.localMoveSubmitted = true;
    this.isWaitingForOpponent = true;
    this.turnIndicatorText.setText("Waiting for opponent...");

    // Fade out narrative
    this.tweens.add({
      targets: this.narrativeText,
      alpha: 0,
      duration: 500
    });

    if (PRIVATE_ROUNDS_ENABLED) {
      const fallbackPlan: Array<"punch" | "kick" | "block" | "special"> = Array(PRIVATE_ROUND_PLAN_TURNS).fill("block");
      EventBus.emit("game:submitRoundPlan", {
        matchId: this.config.matchId,
        roundNumber: this.serverState?.currentRound ?? 1,
        movePlan: fallbackPlan,
        playerRole: this.config.playerRole,
      });
      return;
    }

    // Submit stunned move via API - no transaction required
    fetch(apiUrl(`/api/matches/${this.config.matchId}/submit-stunned-move`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        playerRole: this.config.playerRole,
      }),
    }).then(() => {
      // After our stunned move is submitted, trigger bot to make its move
      if (this.isBotMatch) {
        console.log("[FightScene] Stunned move submitted, triggering bot auto-move");
        fetch(apiUrl(`/api/matches/${this.config.matchId}/bot-auto-move`), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stunned: true }),
        }).catch(err => {
          console.error("[FightScene] Failed to trigger bot auto-move:", err);
        });
      }
    }).catch(err => {
      console.error("[FightScene] Failed to submit stunned move:", err);
    });
  }

  /**
   * Handle both-stunned turn skip.
   * Called by update() when bothStunnedSkipAt deadline is reached.
   * Works correctly even if the tab was backgrounded.
   */
  private handleBothStunnedSkip(): void {
    if (this.phase !== "selecting") return;

    this.localMoveSubmitted = true;
    this.isWaitingForOpponent = true;
    this.turnIndicatorText.setText("Resolving stunned turn...");

    // Fade out narrative
    this.tweens.add({
      targets: this.narrativeText,
      alpha: 0,
      duration: 500
    });

    if (PRIVATE_ROUNDS_ENABLED) {
      const fallbackPlan: Array<"punch" | "kick" | "block" | "special"> = Array(PRIVATE_ROUND_PLAN_TURNS).fill("block");
      EventBus.emit("game:submitRoundPlan", {
        matchId: this.config.matchId,
        roundNumber: this.serverState?.currentRound ?? 1,
        movePlan: fallbackPlan,
        playerRole: this.config.playerRole,
      });
      return;
    }

    // Call API to skip the stunned turn - no transaction required
    fetch(apiUrl(`/api/matches/${this.config.matchId}/skip-stunned-turn`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        playerRole: this.config.playerRole,
      }),
    }).catch(err => {
      console.error("[FightScene] Failed to skip stunned turn:", err);
    });
  }

  // ===========================================================================
  // VISIBILITY CHANGE HANDLER - Catch-up on tab refocus
  // ===========================================================================

  /**
   * Set up the document visibility change listener.
   * When a user switches back to the tab, this ensures the game catches up
   * with real time immediately instead of waiting for the next Phaser update tick.
   * 
   * Called from create().
   */
  private setupVisibilityChangeHandler(): void {
    this.visibilityChangeHandler = () => {
      if (document.visibilityState === "visible") {
        if (this.hasCleanedUp) return;
        if (!this.sys || (this.sys as any).isDestroyed) return;
        if (!this.scene.isActive()) return;

        console.log("[FightScene] Tab became visible - catching up with real time");

        // Do a minimal, safe catch-up without calling Scene.update() directly.
        // Calling update() here can run while the renderer/textures are mid-resume.
        try {
          this.updatePrivatePlanEnergyText();
        } catch {
          // ignore
        }

        // If we're in selecting phase and deadline has passed, trigger timeout immediately
        if (this.phase === "selecting" && this.moveDeadlineAt > 0) {
          const remaining = this.moveDeadlineAt - Date.now();
          if (this.isActiveText(this.roundTimerText)) {
            const secs = Math.max(0, Math.ceil(remaining / 1000));
            this.roundTimerText.setText(`${secs}s`);
          }
          if (remaining <= 0 && !this.timerExpiredHandled) {
            console.log("[FightScene] Tab refocus: deadline already passed, triggering timeout");
            this.timerExpiredHandled = true;
            this.onTimerExpired();
          }
        }

        // If countdown should have ended, force completion
        if (this.phase === "countdown" && this.countdownEndsAt > 0 && Date.now() >= this.countdownEndsAt + 500) {
          console.log("[FightScene] Tab refocus: countdown already ended, jumping to selection");
          if (this.isActiveText(this.countdownText)) {
            this.countdownText.setAlpha(0);
          }
          this.countdownEndsAt = 0;
          this.startSynchronizedSelectionPhase(this.moveDeadlineAt);
        }

        // If round-end countdown should have ended, force completion
        if (this.phase === "round_end" && this.roundEndCountdownEndsAt > 0 && Date.now() >= this.roundEndCountdownEndsAt) {
          console.log("[FightScene] Tab refocus: round-end countdown already ended, processing");
          this.roundEndCountdownEndsAt = 0;
          this.processRoundEndCountdownComplete();
        }
      }
    };

    document.addEventListener("visibilitychange", this.visibilityChangeHandler);
  }

  /**
   * Clean up visibility change listener when scene is destroyed.
   */
  destroy(): void {
    this.cleanupScene();
  }
}

export default FightScene;
