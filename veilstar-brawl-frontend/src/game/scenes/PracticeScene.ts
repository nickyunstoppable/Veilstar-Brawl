/**
 * PracticeScene - Offline practice mode against AI
 * Mirrors FightScene UI/UX exactly, but with local AI instead of network play
 * Includes Power Surge cards with precomputed AI selections
 */

import Phaser from "phaser";
import { EventBus } from "@/game/EventBus";
import { GAME_DIMENSIONS, CHARACTER_POSITIONS, UI_POSITIONS } from "@/game/config";
import { getCharacterScale, getAnimationScale, getCharacterYOffset, getSoundDelay, getSFXKey } from "@/game/config/sprite-config";
import { CombatEngine, BASE_MOVE_STATS } from "@/game/combat";
import { calculateSurgeEffects, isBlockDisabled, shouldStunOpponent } from "@/game/combat/SurgeEffects";
import { SmartBotOpponent } from "@/lib/game/smart-bot-opponent";
import { getAIThinkTime } from "@/lib/game/ai-difficulty";
import { OfflinePowerSurgeCards } from "@/game/ui/OfflinePowerSurgeCards";
import type { PowerSurgeCardId } from "@/types/power-surge";
import { PowerSurgeCardView } from "../ui/PowerSurgeCardView";
import { getRandomPowerSurgeCards, getPowerSurgeCard } from "@/types/power-surge";
import { TextFactory } from "@/game/ui/TextFactory";
import {
  loadBackground,
  loadUIAssets,
  loadCharacterSprites,
  loadCommonAudio,
  loadCharacterAudio,
  createCharacterAnimations,
} from "@/game/utils/asset-loader";

// For backward compatibility with difficulty settings
export type AIDifficulty = "easy" | "medium" | "hard";
import { getCharacter, getRandomCharacter } from "@/data/characters";
import type { MoveType, Character } from "@/types/game";
import { isMobileDevice } from "@/utils/device";

const PRACTICE_PLAN_TURNS = 10;
const PRACTICE_PLAN_TIMER_SECONDS = 90;
const PRACTICE_PLAN_MAX_ENERGY = 100;
const PRACTICE_PLAN_ENERGY_REGEN = 8;

/**
 * Practice scene configuration.
 */
export interface PracticeSceneConfig {
  playerCharacterId: string;
  aiDifficulty: AIDifficulty;
  matchFormat?: "best_of_3" | "best_of_5";
}

/**
 * PracticeScene - Mirrors FightScene UI/UX for offline AI battles.
 */
export class PracticeScene extends Phaser.Scene {
  // Configuration
  private config!: PracticeSceneConfig;
  private playerCharacter!: Character;
  private aiCharacter!: Character;
  private ai!: SmartBotOpponent;

  // Combat Engine (same as FightScene)
  private combatEngine!: CombatEngine;

  // UI Elements (mirroring FightScene exactly)
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

  // Decorative text
  private modeText?: Phaser.GameObjects.Text;
  private aiInfoText?: Phaser.GameObjects.Text;

  // Character sprites
  private player1Sprite!: Phaser.GameObjects.Sprite;
  private player2Sprite!: Phaser.GameObjects.Sprite;

  // Move buttons (same structure as FightScene)
  private moveButtons: Map<MoveType, Phaser.GameObjects.Container> = new Map();
  private selectedMove: MoveType | null = null;
  private privateRoundPlannedMoves: Array<"punch" | "kick" | "block" | "special"> = [];
  private aiPlannedMoves: Array<"punch" | "kick" | "block" | "special"> = [];
  private privateRoundPlanEnergyPreview: number = PRACTICE_PLAN_MAX_ENERGY;

  // Timer
  private turnTimer: number = PRACTICE_PLAN_TIMER_SECONDS;
  private timerEvent?: Phaser.Time.TimerEvent;

  // State (same phases as FightScene)
  private phase: "countdown" | "selecting" | "resolving" | "round_end" | "match_end" = "countdown";

  // Match result overlay
  private matchResultOverlay!: Phaser.GameObjects.Container;

  // Audio settings
  private bgmVolume: number = 0.3;
  private sfxVolume: number = 0.5;
  private bgmSlider?: Phaser.GameObjects.Container;
  private sfxSlider?: Phaser.GameObjects.Container;

  // Settings menu
  private settingsContainer!: Phaser.GameObjects.Container;
  private isSettingsOpen: boolean = false;

  // Visibility sync for tab switching
  private visibilityChangeHandler: (() => void) | null = null;
  private wasPlayingBeforeHidden: boolean = false;

  // Power Surge state - precomputed for all rounds
  private powerSurgeUI?: OfflinePowerSurgeCards;
  private precomputedDecks: Map<number, PowerSurgeCardId[]> = new Map(); // round -> cards
  private precomputedAISelections: Map<number, PowerSurgeCardId> = new Map(); // round -> AI selection
  private activeSurges: {
    player1: PowerSurgeCardId | null;
    player2: PowerSurgeCardId | null;
  } = { player1: null, player2: null };
  private surgeCardsShownThisRound: boolean = false;
  private lastSurgeRound: number = 0;
  private stunTweens: Map<"player1" | "player2", Phaser.Tweens.Tween> = new Map(); // Track stun tweens for cleanup

  constructor() {
    super({ key: "PracticeScene" });
  }


  /**
   * Initialize scene with configuration.
   */
  init(data: PracticeSceneConfig): void {
    this.config = data;
    this.resetFullState();
  }

  /**
   * Reset all state for new match.
   */
  private resetFullState(): void {
    // Get characters
    this.playerCharacter = getCharacter(this.config.playerCharacterId) ?? getRandomCharacter();
    this.aiCharacter = getRandomCharacter();

    // Ensure AI doesn't pick same character as player
    while (this.aiCharacter.id === this.playerCharacter.id) {
      this.aiCharacter = getRandomCharacter();
    }

    // Create AI opponent
    this.ai = new SmartBotOpponent(`AI_${this.aiCharacter.name}`);

    // Reset state
    this.selectedMove = null;
    this.turnTimer = PRACTICE_PLAN_TIMER_SECONDS;
    this.phase = "countdown";
    this.moveButtons.clear();
    this.privateRoundPlannedMoves = [];
    this.aiPlannedMoves = [];
    this.privateRoundPlanEnergyPreview = PRACTICE_PLAN_MAX_ENERGY;

    // Precompute Power Surge decks and AI selections for all rounds
    this.precomputePowerSurgeDecks();
  }

  /**
   * Precompute Power Surge card decks and AI selections for all rounds.
   * This ensures consistent cards across the match and instant AI decisions.
   */
  private precomputePowerSurgeDecks(): void {
    this.precomputedDecks.clear();
    this.precomputedAISelections.clear();
    this.activeSurges = { player1: null, player2: null };
    this.surgeCardsShownThisRound = false;
    this.lastSurgeRound = 0;

    // Determine max rounds based on match format
    const maxRounds = this.config.matchFormat === "best_of_5" ? 5 : 3;

    // Generate unique decks for each round
    const usedCards: PowerSurgeCardId[] = [];
    for (let round = 1; round <= maxRounds; round++) {
      // Get 3 random cards (optionally excluding previously used cards)
      const deck = getRandomPowerSurgeCards(3, usedCards);
      const deckIds = deck.map(c => c.id);
      this.precomputedDecks.set(round, deckIds);

      // AI picks a random card from the deck
      const aiChoice = deckIds[Math.floor(Math.random() * deckIds.length)];
      this.precomputedAISelections.set(round, aiChoice);

      // Track used cards to avoid repeats (optional - can remove for more variety)
      // usedCards.push(...deckIds);
    }

    console.log("[PracticeScene] Precomputed surge decks:", Object.fromEntries(this.precomputedDecks));
    console.log("[PracticeScene] Precomputed AI selections:", Object.fromEntries(this.precomputedAISelections));
  }

  /**
   * Preload assets.
   * OPTIMIZED: Only loads the player and AI character, not all 20!
   */
  preload(): void {
    // Load dojo background (unique to practice mode)
    loadBackground(this, "arena-bg", "/assets/dojo.webp");

    // Load UI assets
    loadUIAssets(this);

    // Load only the player and AI character - not all 20!
    const playerChar = this.config?.playerCharacterId || "dag-warrior";
    const aiChar = this.aiCharacter?.id || "dag-warrior";
    loadCharacterSprites(this, [playerChar, aiChar]);

    // Load audio
    loadCommonAudio(this);
    loadCharacterAudio(this, [playerChar, aiChar]);

    // Load dojo-specific BGM
    if (!this.cache.audio.exists("bgm_dojo")) {
      this.load.audio("bgm_dojo", "/assets/audio/dojo.mp3");
    }
  }

  /**
   * Create scene elements.
   */
  create(): void {
    // Load audio settings from localStorage
    this.loadAudioSettings();

    // Initialize combat engine (same as FightScene)
    const matchFormat = this.config.matchFormat === "best_of_5" ? "best_of_5" : "best_of_3";
    this.combatEngine = new CombatEngine(
      this.playerCharacter.id,
      this.aiCharacter.id,
      matchFormat
    );

    // Create animations only for the 2 characters in this match
    createCharacterAnimations(this, [this.playerCharacter.id, this.aiCharacter.id]);

    // Background
    this.createBackground();

    // Character sprites
    this.createCharacterSprites();

    // UI Elements (mirroring FightScene)
    this.createHealthBars();
    this.createEnergyBars();
    this.createGuardMeters();
    this.createRoundTimer();
    this.createRoundScore();
    this.createMoveButtons();
    this.createNarrativeDisplay();
    this.createTurnIndicator();
    this.createCountdownOverlay();

    // UI - Settings
    this.settingsContainer = this.add.container(0, 0);
    this.createSettingsButton();
    this.createSettingsMenu();

    // Setup event listeners
    this.setupEventListeners();

    // Sync UI with initial state
    this.syncUIWithCombatState();

    // Start the round
    this.startRound();

    EventBus.emit("practice_scene_ready");

    // Play BGM - keep playing even when tab loses focus
    this.sound.pauseOnBlur = false;
    if (this.sound.get("bgm_dojo")) {
      if (!this.sound.get("bgm_dojo").isPlaying) {
        this.sound.play("bgm_dojo", { loop: true, volume: this.bgmVolume });
      }
    } else {
      this.sound.play("bgm_dojo", { loop: true, volume: this.bgmVolume });
    }

    // Handle scene shutdown - stop BGM
    this.events.once("shutdown", this.handleShutdown, this);
    this.events.once("destroy", this.handleShutdown, this);

    // Setup visibility handler for tab switching
    this.setupVisibilityHandler();
  }

  // ===========================================================================
  // VISIBILITY SYNC (TAB SWITCHING)
  // ===========================================================================

  /**
   * Setup visibility change handler for pause/resume on tab switching.
   */
  private setupVisibilityHandler(): void {
    if (typeof document === "undefined") return;

    this.visibilityChangeHandler = () => {
      if (document.visibilityState === "hidden") {
        // Tab hidden - pause timers
        console.log("[PracticeScene] Tab hidden, pausing timers");
        this.wasPlayingBeforeHidden = this.phase === "selecting";
        if (this.timerEvent && !this.timerEvent.paused) {
          this.timerEvent.paused = true;
        }
      } else if (document.visibilityState === "visible") {
        // Tab visible - resume timers
        console.log("[PracticeScene] Tab visible, resuming timers");
        if (this.timerEvent && this.timerEvent.paused && this.wasPlayingBeforeHidden) {
          this.timerEvent.paused = false;
        }
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
   * Helper to play SFX with duration cap (5s max) and configurable volume
   */
  private playSFX(key: string): void {
    if (this.game.sound.locked) {
      // Audio might be locked by browser policies, can't force it
      return;
    }

    try {
      this.sound.play(key, { volume: this.sfxVolume });
      // Stop after 5 seconds max (enough for countdown)
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
      const savedBgm = localStorage.getItem("veilstar_brawl_bgm_volume");
      const savedSfx = localStorage.getItem("veilstar_brawl_sfx_volume");
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
      localStorage.setItem("veilstar_brawl_bgm_volume", this.bgmVolume.toString());
      localStorage.setItem("veilstar_brawl_sfx_volume", this.sfxVolume.toString());
    } catch (e) {
      console.warn("Failed to save audio settings", e);
    }
  }

  /**
   * Apply BGM volume to currently playing background music.
   */
  private applyBgmVolume(): void {
    const bgm = this.sound.get("bgm_dojo");
    if (bgm && "setVolume" in bgm) {
      (bgm as Phaser.Sound.WebAudioSound).setVolume(this.bgmVolume);
    }
  }

  /**
   * Handle scene shutdown - stop BGM.
   */
  private handleShutdown(): void {
    const bgm = this.sound.get("bgm_dojo");
    if (bgm && bgm.isPlaying) {
      bgm.stop();
    }
  }

  /**
   * Create character animations.
   * Dynamically generates animations for all loaded character spritesheets.
   */
  private createAnimations(): void {
    // All 20 characters
    const allCharacters = [
      "aeon-guard", "bastion-hulk", "block-bruiser", "chrono-drifter",
      "cyber-ninja", "cyber-paladin", "dag-warrior", "gene-smasher",
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
   * Update loop.
   */
  update(_time: number, _delta: number): void {
    if (this.phase === "selecting" && this.roundTimerText) {
      this.roundTimerText.setText(`${Math.ceil(this.turnTimer)}`);
    }
  }



  // ===========================================================================
  // BACKGROUND
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

    // Practice mode indicator
    this.modeText = TextFactory.createLabel(this, GAME_DIMENSIONS.CENTER_X, 20, "PRACTICE MODE", {
      fontSize: "12px",
      color: "#888888",
    }).setOrigin(0.5);

    // AI difficulty indicator
    this.aiInfoText = TextFactory.createLabel(this, GAME_DIMENSIONS.CENTER_X, 38, `AI: ${this.config.aiDifficulty.toUpperCase()}`, {
      fontSize: "11px",
      color: "#666666",
    }).setOrigin(0.5);

    // Initial layout check
    this.updateLayout();
    // Listen for resize events to handle rotation
    this.scale.on('resize', this.updateLayout, this);
  }



  /**
   * Update layout based on screen size.
   * Hides decorative text on mobile/small screens.
   */
  private updateLayout(): void {
    // Hide on mobile devices OR small screens
    const shouldHide = isMobileDevice() || window.innerWidth < 1024 || window.innerHeight < 600;

    if (this.modeText) this.modeText.setVisible(!shouldHide);
    if (this.aiInfoText) this.aiInfoText.setVisible(!shouldHide);
  }

  // ===========================================================================
  // CHARACTER SPRITES
  // ===========================================================================

  private createCharacterSprites(): void {
    const p1Char = this.playerCharacter.id;
    const p2Char = this.aiCharacter.id;

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
    const x = this.player1Sprite.x;
    const y = this.player1Sprite.y - 160;

    const container = this.add.container(x, y);

    const text = this.add.text(0, 0, "YOU", {
      fontFamily: "monospace",
      fontSize: "14px",
      color: "#22c55e",
      fontStyle: "bold",
      backgroundColor: "#00000080",
      padding: { x: 4, y: 2 }
    }).setOrigin(0.5);

    const arrow = TextFactory.createLabel(this, 0, 20, "▼", {
      fontSize: "14px",
      color: "#22c55e",
    }).setOrigin(0.5);

    container.add([text, arrow]);

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
  // HEALTH BARS (same as FightScene)
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

    // Player labels
    const state = this.combatEngine.getState();

    this.add.text(
      UI_POSITIONS.HEALTH_BAR.PLAYER1.X,
      UI_POSITIONS.HEALTH_BAR.PLAYER1.Y - 18,
      `YOU: ${state.player1.characterId.toUpperCase()} (${state.player1.maxHp} HP)`,
      { fontFamily: "monospace", fontSize: "12px", color: "#22c55e", fontStyle: "bold" }
    );

    this.add.text(
      UI_POSITIONS.HEALTH_BAR.PLAYER2.X + barWidth,
      UI_POSITIONS.HEALTH_BAR.PLAYER2.Y - 18,
      `AI: ${state.player2.characterId.toUpperCase()} (${state.player2.maxHp} HP)`,
      { fontFamily: "monospace", fontSize: "12px", color: "#40e0d0" }
    ).setOrigin(1, 0);
  }

  private createHealthBar(
    x: number, y: number, width: number, height: number, player: "player1" | "player2"
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
  // ENERGY BARS (same as FightScene)
  // ===========================================================================

  private createEnergyBars(): void {
    const barWidth = UI_POSITIONS.HEALTH_BAR.PLAYER1.WIDTH;
    const barHeight = 12;
    const yOffset = 30;

    this.createEnergyBar(
      UI_POSITIONS.HEALTH_BAR.PLAYER1.X,
      UI_POSITIONS.HEALTH_BAR.PLAYER1.Y + yOffset,
      barWidth,
      barHeight,
      "player1"
    );

    this.createEnergyBar(
      UI_POSITIONS.HEALTH_BAR.PLAYER2.X,
      UI_POSITIONS.HEALTH_BAR.PLAYER2.Y + yOffset,
      barWidth,
      barHeight,
      "player2"
    );
  }

  private createEnergyBar(
    x: number, y: number, width: number, height: number, player: "player1" | "player2"
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
  // GUARD METERS (same as FightScene)
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
  // ROUND TIMER (same as FightScene)
  // ===========================================================================

  private createRoundTimer(): void {
    const timerBg = this.add.graphics();
    timerBg.fillStyle(0x1a1a2e, 0.9);
    timerBg.fillCircle(UI_POSITIONS.TIMER.X, UI_POSITIONS.TIMER.Y, 35);
    timerBg.lineStyle(3, 0x40e0d0, 1);
    timerBg.strokeCircle(UI_POSITIONS.TIMER.X, UI_POSITIONS.TIMER.Y, 35);

    this.roundTimerText = TextFactory.createTimer(
      this,
      UI_POSITIONS.TIMER.X,
      UI_POSITIONS.TIMER.Y,
      `${PRACTICE_PLAN_TIMER_SECONDS}`
    ).setOrigin(0.5);
  }

  // ===========================================================================
  // ROUND SCORE (same as FightScene)
  // ===========================================================================

  private createRoundScore(): void {
    const roundsToWin = this.config.matchFormat === "best_of_5" ? 3 : 2;
    this.roundScoreText = TextFactory.createScore(
      this,
      UI_POSITIONS.ROUND_INDICATOR.X,
      UI_POSITIONS.ROUND_INDICATOR.Y,
      `Round 1  •  0 - 0  (First to ${roundsToWin})`
    ).setOrigin(0.5);
  }

  // ===========================================================================
  // MOVE BUTTONS (same as FightScene)
  // ===========================================================================

  private createMoveButtons(): void {
    const moves: MoveType[] = ["punch", "kick", "block", "special"];
    const buttonWidth = 140; // Narrower, taller card style
    const buttonHeight = 160;
    const spacing = 20;
    const totalWidth = moves.length * buttonWidth + (moves.length - 1) * spacing;
    const startX = (GAME_DIMENSIONS.WIDTH - totalWidth) / 2 + buttonWidth / 2;
    const y = GAME_DIMENSIONS.HEIGHT - 100;

    // Label
    TextFactory.createSubtitle(
      this,
      GAME_DIMENSIONS.CENTER_X,
      y - 95,
      "YOUR MOVE"
    ).setOrigin(0.5).setColor("#40e0d0");

    moves.forEach((move, index) => {
      const x = startX + index * (buttonWidth + spacing);
      const button = this.createMoveButton(x, y, buttonWidth, buttonHeight, move);
      this.moveButtons.set(move, button);
    });
  }

  private createMoveButton(
    x: number, y: number, width: number, height: number, move: MoveType
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
        this.sound.play("sfx_hover", { volume: 0.5 });
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
        this.sound.play("sfx_click", { volume: 0.5 });
        this.selectMove(move);
      }
    });

    return container;
  }



  /* getMoveInfoText removed */

  private selectMove(move: MoveType): void {
    // Check if player is stunned - cannot select moves when stunned
    const state = this.combatEngine.getState();
    if (state.player1.isStunned) {
      this.showFloatingText("You are stunned!", GAME_DIMENSIONS.CENTER_X, GAME_DIMENSIONS.HEIGHT - 150, "#ff4444");
      return;
    }

    if (move === "stunned") {
      this.showFloatingText("Cannot preplan stunned", GAME_DIMENSIONS.CENTER_X, GAME_DIMENSIONS.HEIGHT - 150, "#ff4444");
      return;
    }

    if (this.privateRoundPlannedMoves.length >= PRACTICE_PLAN_TURNS) {
      return;
    }

    const moveCost = this.getPlannedMoveEnergyCost(move, "player1");
    if (this.privateRoundPlanEnergyPreview < moveCost) {
      this.showFloatingText("Not enough energy!", GAME_DIMENSIONS.CENTER_X, GAME_DIMENSIONS.HEIGHT - 150, "#ff4444");
      return;
    }

    this.privateRoundPlannedMoves.push(move as "punch" | "kick" | "block" | "special");
    const afterCost = Math.max(0, this.privateRoundPlanEnergyPreview - moveCost);
    this.privateRoundPlanEnergyPreview = Math.min(PRACTICE_PLAN_MAX_ENERGY, afterCost + PRACTICE_PLAN_ENERGY_REGEN);

    this.selectedMove = move;
    this.updateButtonState(move, true);
    this.updateMoveButtonAffordability();

    const progress = `${this.privateRoundPlannedMoves.length}/${PRACTICE_PLAN_TURNS}`;
    this.turnIndicatorText.setText(`Phase 2/3: Plan moves (${progress})`);
    this.turnIndicatorText.setColor("#40e0d0");

    if (this.privateRoundPlannedMoves.length >= PRACTICE_PLAN_TURNS) {
      if (this.timerEvent) {
        this.timerEvent.destroy();
        this.timerEvent = undefined;
      }
      this.startPlannedFightPlayback();
    }
  }

  private getPlannedMoveEnergyCost(
    move: MoveType,
    role: "player1" | "player2"
  ): number {
    const baseCost = BASE_MOVE_STATS[move].energyCost;
    if (move !== "special") return baseCost;

    const surgeEffects = calculateSurgeEffects(
      this.activeSurges.player1,
      this.activeSurges.player2,
    );

    const roleMods = role === "player1"
      ? surgeEffects.player1Modifiers
      : surgeEffects.player2Modifiers;
    const extra = Math.max(0, Math.floor(Number(roleMods.specialEnergyCost ?? 0)));
    return baseCost + extra;
  }

  private canAffordMoveForSelection(move: MoveType): boolean {
    if (move === "stunned") return false;
    if (this.privateRoundPlannedMoves.length >= PRACTICE_PLAN_TURNS) return false;
    return this.privateRoundPlanEnergyPreview >= this.getPlannedMoveEnergyCost(move, "player1");
  }

  private buildAIPlan(): Array<"punch" | "kick" | "block" | "special"> {
    const state = this.combatEngine.getState();
    let aiEnergyPreview = state.player2.energy;
    const plan: Array<"punch" | "kick" | "block" | "special"> = [];

    for (let i = 0; i < PRACTICE_PLAN_TURNS; i++) {
      let move = this.ai.decide().move;
      if (move === "stunned") move = "block";

      const typedMove = move as "punch" | "kick" | "block" | "special";
      const moveCost = this.getPlannedMoveEnergyCost(typedMove, "player2");
      const finalMove = aiEnergyPreview < moveCost ? "block" : typedMove;
      const finalCost = this.getPlannedMoveEnergyCost(finalMove, "player2");

      aiEnergyPreview = Math.min(
        PRACTICE_PLAN_MAX_ENERGY,
        Math.max(0, aiEnergyPreview - finalCost) + PRACTICE_PLAN_ENERGY_REGEN,
      );

      plan.push(finalMove);
    }

    return plan;
  }

  private startPlannedFightPlayback(): void {
    if (this.privateRoundPlannedMoves.length < PRACTICE_PLAN_TURNS) {
      while (this.privateRoundPlannedMoves.length < PRACTICE_PLAN_TURNS) {
        this.privateRoundPlannedMoves.push("block");
      }
    }

    this.aiPlannedMoves = this.buildAIPlan();
    this.phase = "resolving";

    this.turnIndicatorText.setText("Phase 3/3: Enjoy the fight!");
    this.turnIndicatorText.setColor("#22c55e");
    this.roundTimerText.setText("✓");
    this.roundTimerText.setColor("#22c55e");

    this.moveButtons.forEach(btn => btn.setAlpha(0.3).disableInteractive());

    this.time.delayedCall(250, () => {
      const playerMove = this.privateRoundPlannedMoves.shift();
      const aiMove = this.aiPlannedMoves.shift();
      if (!playerMove || !aiMove) {
        this.startSelectionPhase();
        return;
      }
      this.resolveRound(playerMove, aiMove);
    });
  }

  private updateButtonState(selectedMove: MoveType | null, isSelected: boolean): void {
    const moves: MoveType[] = ["punch", "kick", "block", "special"];

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
          y: GAME_DIMENSIONS.HEIGHT - 110,
          duration: 200,
          ease: "Back.easeOut",
        });

        // Highlight effect
        const bg = button.list[0] as Phaser.GameObjects.Graphics;
        bg.clear();
        bg.fillStyle(0x1a1a2e, 1);
        bg.fillRoundedRect(-70, -80, 140, 160, 12);
        bg.lineStyle(4, 0xffffff, 1);
        bg.strokeRoundedRect(-70, -80, 140, 160, 12);

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
        let color = 0xffffff;
        if (move === "punch") color = 0xef4444;
        if (move === "kick") color = 0x06b6d4;
        if (move === "block") color = 0x22c55e;
        if (move === "special") color = 0xa855f7;

        const bg = button.list[0] as Phaser.GameObjects.Graphics;
        bg.clear();
        bg.fillStyle(0x1a1a2e, 0.9);
        bg.fillRoundedRect(-70, -80, 140, 160, 12);
        bg.lineStyle(2, color, 0.8);
        bg.strokeRoundedRect(-70, -80, 140, 160, 12);
      }
    });
  }

  private resetButtonVisuals(): void {
    const moves: MoveType[] = ["punch", "kick", "block", "special"];
    const y = GAME_DIMENSIONS.HEIGHT - 100;

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
      bg.clear();
      bg.fillStyle(0x1a1a2e, 0.9);
      bg.fillRoundedRect(-70, -80, 140, 160, 12);
      bg.lineStyle(2, color, 0.8);
      bg.strokeRoundedRect(-70, -80, 140, 160, 12);
    });
  }

  private updateMoveButtonAffordability(): void {
    const moves: MoveType[] = ["punch", "kick", "block", "special"];

    // Check if player is stunned
    const state = this.combatEngine.getState();
    const isStunned = state.player1.isStunned || false;

    // If stunned, disable all buttons
    if (isStunned) {
      moves.forEach((move) => {
        const container = this.moveButtons.get(move);
        if (container) {
          container.setAlpha(0.3);
          container.disableInteractive();
          container.list.forEach((child: any) => {
            if (child.setTint) child.setTint(0x555555);
          });
        }
      });
      return;
    }

    // Check if block is disabled due to opponent's surge effect (e.g., Pruned Rage)
    const surgeEffects = calculateSurgeEffects(this.activeSurges.player1, this.activeSurges.player2);
    const blockDisabled = isBlockDisabled(surgeEffects.player1Modifiers, surgeEffects.player2Modifiers);

    moves.forEach((move) => {
      const canAfford = this.canAffordMoveForSelection(move);
      const container = this.moveButtons.get(move);
      if (container) {
        // Check if this specific move should be disabled
        const shouldDisable = !canAfford || (move === "block" && blockDisabled);

        if (shouldDisable) {
          container.setAlpha(0.3);
          container.disableInteractive();
          // Tint children to grayscale for visual feedback
          container.list.forEach((child: any) => {
            if (child.setTint) child.setTint(0x555555);
          });
        } else {
          container.setAlpha(1);
          container.setInteractive();
          // Clear tint
          container.list.forEach((child: any) => {
            if (child.clearTint) child.clearTint();
          });
        }
      }
    });
  }

  // ===========================================================================
  // TURN INDICATOR (Updated)
  // ===========================================================================


  private createNarrativeDisplay(): void {
    // Use TextFactory for consistent styling (same as FightScene outcome text)
    this.narrativeText = TextFactory.createNarrative(
      this,
      GAME_DIMENSIONS.CENTER_X,
      GAME_DIMENSIONS.CENTER_Y - 80,
      ""
    ).setOrigin(0.5).setAlpha(0);
  }

  private createTurnIndicator(): void {
    this.turnIndicatorText = this.add.text(
      GAME_DIMENSIONS.CENTER_X,
      130,
      "Select your move!",
      { fontFamily: "monospace", fontSize: "14px", color: "#888888" }
    ).setOrigin(0.5);
  }

  // ===========================================================================
  // COUNTDOWN OVERLAY
  // ===========================================================================

  private createCountdownOverlay(): void {
    this.countdownText = this.add.text(
      GAME_DIMENSIONS.CENTER_X,
      GAME_DIMENSIONS.CENTER_Y,
      "",
      { fontFamily: "monospace", fontSize: "72px", color: "#40e0d0", fontStyle: "bold" }
    ).setOrigin(0.5).setAlpha(0);
  }

  // ===========================================================================
  // GAME FLOW (same as FightScene)
  // ===========================================================================

  private startRound(): void {
    this.phase = "countdown";
    this.turnIndicatorText.setText("Phase 1/3: Pick your Power Surge");
    this.turnIndicatorText.setColor("#fbbf24");

    // Get current round number
    const state = this.combatEngine.getState();
    const currentRound = state.currentRound;

    // Show Power Surge cards first, then countdown
    this.showPowerSurgeCards(currentRound).then(() => {
      // IMMEDIATELY apply stun effects from Power Surge cards
      // This ensures stunned players see the effect before the selection phase
      this.applyImmediateSurgeEffects();

      // Clear any narrative text from previous round
      if (this.narrativeText) {
        this.narrativeText.setAlpha(0);
        this.narrativeText.setText("");
      }
      if (this.narrativeTimer) {
        this.narrativeTimer.destroy();
        this.narrativeTimer = undefined;
      }

      // Play SFX first (full "3-2-1 Fight" sequence)
      this.playSFX("sfx_cd_fight");

      // Delay visual countdown slightly to match audio timing (approx 0.3s before "3" appears)
      this.time.delayedCall(300, () => {
        this.showCountdown(3);
      });
    });
  }

  /**
   * Show Power Surge card selection UI.
   * Uses precomputed deck and AI selection for this round.
   */
  private async showPowerSurgeCards(roundNumber: number): Promise<void> {
    // Avoid showing twice for the same round
    if (this.surgeCardsShownThisRound && this.lastSurgeRound === roundNumber) {
      console.log("[PracticeScene] Power Surge already shown for this round");
      return;
    }

    this.surgeCardsShownThisRound = true;
    this.lastSurgeRound = roundNumber;

    // Get precomputed deck and AI selection
    const cardIds = this.precomputedDecks.get(roundNumber);
    const aiSelection = this.precomputedAISelections.get(roundNumber);

    if (!cardIds || cardIds.length === 0 || !aiSelection) {
      console.log("[PracticeScene] No surge cards for this round");
      return;
    }

    console.log(`[PracticeScene] Showing Power Surge cards for round ${roundNumber}:`, cardIds);
    console.log(`[PracticeScene] AI pre-selected: ${aiSelection}`);

    return new Promise((resolve) => {
      // Calculate deadline (10 seconds from now)
      const deadline = Date.now() + 10000;

      this.powerSurgeUI = new OfflinePowerSurgeCards({
        scene: this,
        roundNumber,
        cardIds,
        aiSelectedCardId: aiSelection,
        deadline,
        onCardSelected: (cardId: PowerSurgeCardId) => {
          console.log(`[PracticeScene] Player selected surge: ${cardId}`);
          this.activeSurges.player1 = cardId;
        },
        onTimeout: () => {
          console.log("[PracticeScene] Power Surge selection timed out");
          // No surge selected
        },
        onClose: (playerSelection: PowerSurgeCardId | null, aiSelectionId: PowerSurgeCardId) => {
          this.powerSurgeUI = undefined;

          // Store active surges
          this.activeSurges.player1 = playerSelection;
          this.activeSurges.player2 = aiSelectionId;

          // Show AI's selection reveal
          if (aiSelectionId) {
            const card = getPowerSurgeCard(aiSelectionId);
            if (card) {
              console.log(`[PracticeScene] AI surge: ${card.name}`);
              this.showSurgeCardReveal("player2", aiSelectionId);
            }
          }

          // Show player's selection reveal (if selected)
          if (playerSelection) {
            const card = getPowerSurgeCard(playerSelection);
            if (card) {
              this.showSurgeCardReveal("player1", playerSelection);
            }
          }

          resolve();
        },
      });
    });
  }

  /**
   * Show a card reveal popup above the character's head.
   * Replaces the old text-only reveal.
   */
  private showSurgeCardReveal(player: "player1" | "player2", cardId: PowerSurgeCardId): void {
    const card = getPowerSurgeCard(cardId);
    if (!card) return;

    const targetSprite = player === "player1" ? this.player1Sprite : this.player2Sprite;
    if (!targetSprite) return;

    // Create container above character
    // Use PowerSurgeCardView for unified design
    const container = PowerSurgeCardView.create({
      scene: this,
      card,
      x: targetSprite.x,
      y: targetSprite.y - 280,
      scale: 0.7,
    });

    container.setDepth(2000); // Higher than standard UI but lower than overlays
    container.setScale(0); // Start hidden for pop-up

    // "OPPONENT SURGE" or "YOUR SURGE" label
    // In practice mode, "OPPONENT" is AI.
    const isOpponent = player === "player2";
    const labelText = isOpponent ? "AI SURGE" : "YOUR SURGE"; // Custom label for AI
    const labelColor = isOpponent ? "#40e0d0" : "#22c55e";

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

    // Animation: Pop in
    this.tweens.add({
      targets: container,
      scaleX: 0.7,
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
    // Apply surge visual effect to sprite
    this.applySurgeVisualEffect(player, card);
  }

  /**
   * Apply visual glow effect to a character sprite when surge is active.
   */
  private applySurgeVisualEffect(player: "player1" | "player2", card: { glowColor: number }): void {
    const sprite = player === "player1" ? this.player1Sprite : this.player2Sprite;
    const tintColor = card.glowColor;

    // Flash effect (matching FightScene)
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

  private createSurgeParticles(x: number, y: number, color: number): void {
    for (let i = 0; i < 15; i++) {
      const particle = this.add.graphics();
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
   * Apply immediate stun effects from Power Surge cards.
   * This is called BEFORE the countdown starts to ensure stunned players
   * see the effect and have their buttons disabled immediately.
   */
  private applyImmediateSurgeEffects(): void {
    // Calculate surge effects
    const surgeResults = calculateSurgeEffects(this.activeSurges.player1, this.activeSurges.player2);
    const p1Mods = surgeResults.player1Modifiers;
    const p2Mods = surgeResults.player2Modifiers;

    // Apply stun to combat engine state immediately
    // The visual effects will be shown when startSelectionPhase() is called
    // Player 1's surge can stun Player 2, and vice versa
    if (shouldStunOpponent(p1Mods)) {
      // Player 1 picked a stun card (like Mempool Congest) -> stun Player 2 (AI)
      this.combatEngine.setPlayerStunned("player2", true);
      console.log("[PracticeScene] AI is stunned by player's Mempool Congest");
    }
    if (shouldStunOpponent(p2Mods)) {
      // Player 2 (AI) picked a stun card -> stun Player 1
      this.combatEngine.setPlayerStunned("player1", true);
      console.log("[PracticeScene] Player is stunned by AI's Mempool Congest");
    }
  }

  /**
   * Show stun visual effect on a player (red pulsing tint).
   * This is called during selection phase when a player is stunned.
   */
  private showStunVisualEffect(player: "player1" | "player2"): void {
    const sprite = player === "player1" ? this.player1Sprite : this.player2Sprite;

    // Stop any existing stun tween for this player
    const existingTween = this.stunTweens.get(player);
    if (existingTween) {
      existingTween.stop();
    }

    // Red pulsing tint effect - store reference for cleanup
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

  private showCountdown(seconds: number): void {
    let count = seconds;

    const updateCountdown = () => {
      if (count > 0) {
        this.countdownText.setText(count.toString());
        this.countdownText.setAlpha(1);

        this.tweens.add({
          targets: this.countdownText,
          scale: { from: 1.5, to: 1 },
          alpha: { from: 1, to: 0.5 },
          duration: 800,
          onComplete: () => {
            count--;
            if (count > 0) {
              updateCountdown();
            } else {
              // SFX already played at start
              this.countdownText.setText("FIGHT!");
              this.countdownText.setAlpha(1);
              this.tweens.add({
                targets: this.countdownText,
                alpha: 0,
                duration: 500,
                delay: 500,
                onComplete: () => {
                  this.startSelectionPhase();
                },
              });
            }
          },
        });
      }
    };

    updateCountdown();
  }

  private startSelectionPhase(): void {
    // Destroy existing timer
    if (this.timerEvent) {
      this.timerEvent.destroy();
      this.timerEvent = undefined;
    }

    this.phase = "selecting";
    this.selectedMove = null;
    this.turnTimer = PRACTICE_PLAN_TIMER_SECONDS;
    this.privateRoundPlannedMoves = [];
    this.aiPlannedMoves = [];

    // Get current state to check if player is stunned
    const state = this.combatEngine.getState();
    this.privateRoundPlanEnergyPreview = state.player1.energy;

    // Clear stun visual effects for players who are no longer stunned
    // This happens after a stunned turn completes
    if (!state.player1.isStunned) {
      const p1Tween = this.stunTweens.get("player1");
      if (p1Tween) {
        p1Tween.stop();
        this.stunTweens.delete("player1");
        this.player1Sprite.clearTint();
      }
    }
    if (!state.player2.isStunned) {
      const p2Tween = this.stunTweens.get("player2");
      if (p2Tween) {
        p2Tween.stop();
        this.stunTweens.delete("player2");
        this.player2Sprite.clearTint();
      }
    }

    // Check if player is stunned
    if (state.player1.isStunned && state.player2.isStunned) {
      // BOTH players are stunned - show message and auto-resolve
      this.turnIndicatorText.setText("BOTH PLAYERS STUNNED!");
      this.turnIndicatorText.setColor("#ff4444");
      this.roundTimerText.setText("---");
      this.roundTimerText.setColor("#ff4444");

      // Show narrative explaining what's happening
      this.narrativeText.setText("Both players are stunned!\nSkipping this turn...");
      this.narrativeText.setAlpha(1);
      this.narrativeText.setColor("#ff4444");

      // Show visual stun effects on both
      this.showStunVisualEffect("player1");
      this.showStunVisualEffect("player2");

      // Disable all buttons visually
      this.moveButtons.forEach(btn => {
        btn.setAlpha(0.3);
        btn.disableInteractive();
        btn.list.forEach((child: any) => {
          if (child.setTint) child.setTint(0x555555);
        });
      });

      // Flash the stun message
      this.tweens.add({
        targets: this.turnIndicatorText,
        alpha: { from: 1, to: 0.5 },
        duration: 300,
        yoyo: true,
        repeat: 3,
      });

      // Auto-resolve after 2.5 seconds
      this.time.delayedCall(2500, () => {
        // Fade out narrative
        this.tweens.add({
          targets: this.narrativeText,
          alpha: 0,
          duration: 500
        });
        // Both stunned - use 'stunned' move for both
        this.resolveRound("stunned", "stunned");
      });
      return;
    } else if (state.player1.isStunned) {
      // Player is stunned - show message and disable buttons
      this.turnIndicatorText.setText("YOU ARE STUNNED!");
      this.turnIndicatorText.setColor("#ff4444");
      this.roundTimerText.setColor("#ff4444");

      // Show narrative explaining what's happening
      this.narrativeText.setText("You are stunned and cannot act this turn!");
      this.narrativeText.setAlpha(1);
      this.narrativeText.setColor("#ff4444");

      // Show visual stun effect on player
      this.showStunVisualEffect("player1");

      // Disable all buttons visually
      this.moveButtons.forEach(btn => {
        btn.setAlpha(0.3);
        btn.disableInteractive();
        btn.list.forEach((child: any) => {
          if (child.setTint) child.setTint(0x555555);
        });
      });

      // Flash the stun message
      this.tweens.add({
        targets: this.turnIndicatorText,
        alpha: { from: 1, to: 0.5 },
        duration: 300,
        yoyo: true,
        repeat: 3,
      });

      // AI makes its decision after 2 seconds (player can't act)
      const thinkTime = Math.max(2000, getAIThinkTime(this.config.aiDifficulty));
      this.time.delayedCall(thinkTime, () => {
        // Fade out narrative
        this.tweens.add({
          targets: this.narrativeText,
          alpha: 0,
          duration: 500
        });

        // Update AI context with stunned state before deciding
        this.ai.updateContext({
          botHealth: state.player2.hp,
          botMaxHealth: state.player2.maxHp,
          botEnergy: state.player2.energy,
          botMaxEnergy: state.player2.maxEnergy,
          botGuardMeter: state.player2.guardMeter,
          botIsStunned: state.player2.isStunned || false,
          botIsStaggered: state.player2.isStaggered || false,
          opponentHealth: state.player1.hp,
          opponentMaxHealth: state.player1.maxHp,
          opponentEnergy: state.player1.energy,
          opponentMaxEnergy: state.player1.maxEnergy,
          opponentGuardMeter: state.player1.guardMeter,
          opponentIsStunned: true,
          opponentIsStaggered: state.player1.isStaggered || false,
          roundNumber: state.currentRound,
          turnNumber: state.currentTurn,
          botRoundsWon: state.player2.roundsWon,
          opponentRoundsWon: state.player1.roundsWon,
        });
        const decision = this.ai.decide();
        const aiMove = decision.move;
        // Player is stunned - use 'stunned' move
        this.resolveRound("stunned", aiMove);
      });
      return;
    }

    // Normal selection phase (player not stunned)
    // Check if opponent is stunned
    if (state.player2.isStunned) {
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

      // Show visual stun effect on bot
      this.showStunVisualEffect("player2");
    } else {
      this.turnIndicatorText.setText(`Phase 2/3: Plan moves (0/${PRACTICE_PLAN_TURNS})`);
      this.turnIndicatorText.setColor("#40e0d0");
    }
    this.roundTimerText.setColor("#40e0d0");
    this.roundTimerText.setText(`${this.turnTimer}`);

    // Reset button visuals and affordability
    this.resetButtonVisuals();
    this.updateMoveButtonAffordability();

    // Start timer
    this.timerEvent = this.time.addEvent({
      delay: 1000,
      callback: () => {
        if (this.phase !== "selecting") return;

        this.turnTimer--;
        if (this.turnTimer <= 5) {
          this.roundTimerText.setColor("#ff4444");
        }
        if (this.turnTimer <= 0) {
          this.onTimerExpired();
        }
      },
      repeat: this.turnTimer - 1,
    });

    // Update AI context
    this.ai.updateContext({
      botHealth: state.player2.hp,
      botMaxHealth: state.player2.maxHp,
      botEnergy: state.player2.energy,
      botMaxEnergy: state.player2.maxEnergy,
      botGuardMeter: state.player2.guardMeter,
      botIsStunned: state.player2.isStunned || false,
      botIsStaggered: state.player2.isStaggered || false,
      opponentHealth: state.player1.hp,
      opponentMaxHealth: state.player1.maxHp,
      opponentEnergy: state.player1.energy,
      opponentMaxEnergy: state.player1.maxEnergy,
      opponentGuardMeter: state.player1.guardMeter,
      opponentIsStunned: state.player1.isStunned || false,
      opponentIsStaggered: state.player1.isStaggered || false,
      roundNumber: state.currentRound,
      turnNumber: state.currentTurn,
      botRoundsWon: state.player2.roundsWon,
      opponentRoundsWon: state.player1.roundsWon,
    });
  }

  private onTimerExpired(): void {
    if (this.phase !== "selecting") return;

    if (this.timerEvent) {
      this.timerEvent.destroy();
      this.timerEvent = undefined;
    }

    while (this.privateRoundPlannedMoves.length < PRACTICE_PLAN_TURNS) {
      this.privateRoundPlannedMoves.push("block");
    }

    this.turnIndicatorText.setText("Time's up! Auto-completing plan...");
    this.turnIndicatorText.setColor("#ff8800");
    this.startPlannedFightPlayback();
  }

  private aiMakeDecision(): void {
    // Update AI context with current state
    const state = this.combatEngine.getState();
    this.ai.updateContext({
      botHealth: state.player2.hp,
      botMaxHealth: state.player2.maxHp,
      botEnergy: state.player2.energy,
      botMaxEnergy: state.player2.maxEnergy,
      botGuardMeter: state.player2.guardMeter,
      botIsStunned: state.player2.isStunned || false,
      botIsStaggered: state.player2.isStaggered || false,
      opponentHealth: state.player1.hp,
      opponentMaxHealth: state.player1.maxHp,
      opponentEnergy: state.player1.energy,
      opponentMaxEnergy: state.player1.maxEnergy,
      opponentGuardMeter: state.player1.guardMeter,
      opponentIsStunned: state.player1.isStunned || false,
      opponentIsStaggered: state.player1.isStaggered || false,
      roundNumber: state.currentRound,
      turnNumber: state.currentTurn,
      botRoundsWon: state.player2.roundsWon,
      opponentRoundsWon: state.player1.roundsWon,
    });

    const decision = this.ai.decide();
    const aiMove = decision.move;

    // Record player's move to AI memory
    this.ai.recordPlayerMove(this.selectedMove!);

    // Resolve the turn
    this.resolveRound(this.selectedMove!, aiMove);
  }

  private resolveRound(playerMove: MoveType, aiMove: MoveType): void {
    this.phase = "resolving";
    this.turnIndicatorText.setText("Phase 3/3: Enjoy the fight!");
    this.turnIndicatorText.setColor("#22c55e");

    // Store previous health for damage calculation
    const prevState = this.combatEngine.getState();
    const prevP1Health = prevState.player1.hp;
    const prevP2Health = prevState.player2.hp;

    // Execute moves in combat engine - returns TurnResult
    // Pass active surge effects so they are applied during combat resolution
    const turnResult = this.combatEngine.resolveTurn(
      playerMove,
      aiMove,
      this.activeSurges.player1,
      this.activeSurges.player2
    );

    // Get updated state
    const state = this.combatEngine.getState();

    const p1Char = this.playerCharacter.id;
    const p2Char = this.aiCharacter.id;

    // Using getAnimationScale(charId, animType) from sprite-config.ts for consistent sizing
    // Scale = targetHeight / frameHeight (280px regular, 336px tanks)

    // Store original positions
    const p1OriginalX = CHARACTER_POSITIONS.PLAYER1.X;
    const p2OriginalX = CHARACTER_POSITIONS.PLAYER2.X;
    const meetingPointX = GAME_DIMENSIONS.CENTER_X;

    // Check if either player was stunned (outcome "stunned" means they missed this turn)
    const p1WasStunned = turnResult.player1.outcome === "stunned";
    const p2WasStunned = turnResult.player2.outcome === "stunned";

    // Determine movement targets based on stun state
    let p1TargetX: number;
    let p2TargetX: number;

    if (p1WasStunned && !p2WasStunned) {
      // Player 1 is stunned - AI runs to player 1's position
      p1TargetX = p1OriginalX; // Player stays in place
      p2TargetX = p1OriginalX + 100; // AI runs to player's position
    } else if (p2WasStunned && !p1WasStunned) {
      // Player 2 (AI) is stunned - Player runs to AI's position
      p1TargetX = p2OriginalX - 100; // Player runs to AI's position
      p2TargetX = p2OriginalX; // AI stays in place
    } else {
      // Normal case - both meet in the middle
      p1TargetX = meetingPointX - 50;
      p2TargetX = meetingPointX + 50;
    }

    // Phase 1: Run animations (only for non-stunned characters)
    if (!p1WasStunned && this.anims.exists(`${p1Char}_run`)) {
      const p1RunScale = getAnimationScale(p1Char, 'run');
      this.player1Sprite.setScale(p1RunScale);
      this.player1Sprite.play(`${p1Char}_run`);
    } else if (p1WasStunned) {
      // Stunned player stays in idle and shows stun effect
      if (this.anims.exists(`${p1Char}_idle`)) {
        const p1IdleScale = getAnimationScale(p1Char, 'idle');
        this.player1Sprite.setScale(p1IdleScale);
        this.player1Sprite.play(`${p1Char}_idle`);
      }
      // Visual stun indicator - pulsing red tint
      this.tweens.add({
        targets: this.player1Sprite,
        tint: 0xff6666,
        yoyo: true,
        repeat: 3,
        duration: 200,
        onComplete: () => this.player1Sprite.clearTint()
      });
    }
    if (!p2WasStunned && this.anims.exists(`${p2Char}_run`)) {
      const p2RunScale = getAnimationScale(p2Char, 'run');
      this.player2Sprite.setScale(p2RunScale);
      this.player2Sprite.play(`${p2Char}_run`);
    } else if (p2WasStunned) {
      // Stunned player stays in idle and shows stun effect
      if (this.anims.exists(`${p2Char}_idle`)) {
        const p2IdleScale = getAnimationScale(p2Char, 'idle');
        this.player2Sprite.setScale(p2IdleScale);
        this.player2Sprite.play(`${p2Char}_idle`);
      }
      // Visual stun indicator - pulsing red tint
      this.tweens.add({
        targets: this.player2Sprite,
        tint: 0xff6666,
        yoyo: true,
        repeat: 3,
        duration: 200,
        onComplete: () => this.player2Sprite.clearTint()
      });
    }

    // Tween to target positions
    this.tweens.add({
      targets: this.player1Sprite,
      x: p1TargetX,
      duration: 600,
      ease: 'Power2',
    });

    this.tweens.add({
      targets: this.player2Sprite,
      x: p2TargetX,
      duration: 600,
      ease: 'Power2',
      onComplete: () => {
        // Calculate actual damage from HP difference (before animations)
        const p1ActualDamage = Math.max(0, prevP1Health - this.combatEngine.getState().player1.hp);
        const p2ActualDamage = Math.max(0, prevP2Health - this.combatEngine.getState().player2.hp);

        const splitDamageIntoHits = (total: number, hits: number): number[] => {
          const safeHits = Math.max(1, Math.floor(hits));
          const safeTotal = Math.max(0, Math.floor(total));
          const base = Math.floor(safeTotal / safeHits);
          const remainder = safeTotal % safeHits;
          return Array.from({ length: safeHits }, (_, i) => base + (i < remainder ? 1 : 0));
        };

        const surgeForPlayback = calculateSurgeEffects(this.activeSurges.player1, this.activeSurges.player2);
        const p1HitCount = (!p1WasStunned
          && surgeForPlayback.player1Modifiers.doubleHit
          && surgeForPlayback.player1Modifiers.doubleHitMoves.includes(playerMove))
          ? 2
          : 1;
        const p2HitCount = (!p2WasStunned
          && surgeForPlayback.player2Modifiers.doubleHit
          && surgeForPlayback.player2Modifiers.doubleHitMoves.includes(aiMove))
          ? 2
          : 1;

        const PUNCH_KICK_HIT_MS = 1200;
        const HIT_IMPACT_MS = 300;

        // Phase 2: Player 1 Attack (Sequential)
        const runP1Attack = () => {
          return new Promise<void>((resolve) => {
            if (p1WasStunned) {
              resolve(); // Skip if stunned
              return;
            }

            // Show narrative for P1
            this.turnIndicatorText.setText(playerMove.toUpperCase());
            this.turnIndicatorText.setColor("#22c55e"); // Player color

            const animKey = `${p1Char}_${playerMove}`;
            const shouldRepeat = (playerMove === "punch" || playerMove === "kick") && p1HitCount > 1;
            const hitCount = shouldRepeat ? p1HitCount : 1;
            const damageParts = splitDamageIntoHits(p2ActualDamage, hitCount);

            for (let i = 0; i < hitCount; i++) {
              const startOffset = i * PUNCH_KICK_HIT_MS;

              this.time.delayedCall(startOffset, () => {
                if (this.anims.exists(animKey)) {
                  const scale = getAnimationScale(p1Char, playerMove);
                  this.player1Sprite.setScale(scale);
                  this.player1Sprite.play(animKey);

                  const sfxKey = getSFXKey(p1Char, playerMove);
                  const delay = getSoundDelay(p1Char, playerMove);
                  if (delay > 0) {
                    this.time.delayedCall(delay, () => this.playSFX(sfxKey));
                  } else {
                    this.playSFX(sfxKey);
                  }
                }
              });

              this.time.delayedCall(startOffset + HIT_IMPACT_MS, () => {
                const part = damageParts[i] ?? 0;
                if (part > 0) {
                  this.showFloatingText(`-${part}`, p2OriginalX - 50, CHARACTER_POSITIONS.PLAYER2.Y - 130, "#ff4444");
                  this.tweens.add({
                    targets: this.player2Sprite,
                    alpha: 0.5,
                    yoyo: true,
                    duration: 50,
                    repeat: 3
                  });
                } else if (i === 0 && turnResult.player2.outcome === "missed") {
                  this.showFloatingText("DODGE!", p2OriginalX - 50, CHARACTER_POSITIONS.PLAYER2.Y - 130, "#8800ff");
                }
              });
            }

            const afterLastHitOffset = (hitCount - 1) * PUNCH_KICK_HIT_MS;

            if (turnResult.player2.energyDrained && turnResult.player2.energyDrained > 0) {
              this.time.delayedCall(afterLastHitOffset + 500, () => {
                this.showFloatingText(
                  `-${Math.round(turnResult.player2.energyDrained!)} EN`,
                  p2OriginalX - 50,
                  CHARACTER_POSITIONS.PLAYER2.Y - 100,
                  "#3b82f6"
                );
              });
            }

            const p1TotalHeal = (turnResult.player1.hpRegen || 0) + (turnResult.player1.lifesteal || 0);
            if (p1TotalHeal > 0) {
              this.time.delayedCall(afterLastHitOffset + 700, () => {
                this.showFloatingText(
                  `+${Math.round(p1TotalHeal)} HP`,
                  p1OriginalX + 50,
                  CHARACTER_POSITIONS.PLAYER1.Y - 100,
                  "#00ff88"
                );
              });
            }

            this.time.delayedCall(hitCount * PUNCH_KICK_HIT_MS, () => resolve());
          });
        };

        // Phase 3: Player 2 Attack (Sequential)
        const runP2Attack = () => {
          return new Promise<void>((resolve) => {
            if (p2WasStunned) {
              resolve();
              return;
            }

            // Narrative
            this.turnIndicatorText.setText(aiMove.toUpperCase());
            this.turnIndicatorText.setColor("#ef4444"); // AI color

            const animKey = `${p2Char}_${aiMove}`;
            const shouldRepeat = (aiMove === "punch" || aiMove === "kick") && p2HitCount > 1;
            const hitCount = shouldRepeat ? p2HitCount : 1;
            const damageParts = splitDamageIntoHits(p1ActualDamage, hitCount);

            for (let i = 0; i < hitCount; i++) {
              const startOffset = i * PUNCH_KICK_HIT_MS;

              this.time.delayedCall(startOffset, () => {
                if (this.anims.exists(animKey)) {
                  const scale = getAnimationScale(p2Char, aiMove);
                  this.player2Sprite.setScale(scale);
                  this.player2Sprite.play(animKey);

                  const sfxKey = getSFXKey(p2Char, aiMove);
                  const p2Delay = getSoundDelay(p2Char, aiMove);
                  if (p2Delay > 0) {
                    this.time.delayedCall(p2Delay, () => this.playSFX(sfxKey));
                  } else {
                    this.playSFX(sfxKey);
                  }
                }
              });

              this.time.delayedCall(startOffset + HIT_IMPACT_MS, () => {
                const part = damageParts[i] ?? 0;
                if (part > 0) {
                  this.showFloatingText(`-${part}`, p1OriginalX + 50, CHARACTER_POSITIONS.PLAYER1.Y - 130, "#ff4444");
                  this.tweens.add({
                    targets: this.player1Sprite,
                    alpha: 0.5,
                    yoyo: true,
                    duration: 50,
                    repeat: 3
                  });
                } else if (i === 0 && turnResult.player1.outcome === "missed") {
                  this.showFloatingText("DODGE!", p1OriginalX + 50, CHARACTER_POSITIONS.PLAYER1.Y - 130, "#8800ff");
                }
              });
            }

            const afterLastHitOffset = (hitCount - 1) * PUNCH_KICK_HIT_MS;

            if (turnResult.player1.energyDrained && turnResult.player1.energyDrained > 0) {
              this.time.delayedCall(afterLastHitOffset + 500, () => {
                this.showFloatingText(
                  `-${Math.round(turnResult.player1.energyDrained!)} EN`,
                  p1OriginalX + 50,
                  CHARACTER_POSITIONS.PLAYER1.Y - 100,
                  "#3b82f6"
                );
              });
            }

            const p2TotalHeal = (turnResult.player2.hpRegen || 0) + (turnResult.player2.lifesteal || 0);
            if (p2TotalHeal > 0) {
              this.time.delayedCall(afterLastHitOffset + 700, () => {
                this.showFloatingText(
                  `+${Math.round(p2TotalHeal)} HP`,
                  p2OriginalX - 50,
                  CHARACTER_POSITIONS.PLAYER2.Y - 100,
                  "#00ff88"
                );
              });
            }

            this.time.delayedCall(hitCount * PUNCH_KICK_HIT_MS, () => resolve());
          });
        };

        // Execute Sequence
        (async () => {
          // Check for block interaction
          const isConcurrent = playerMove === "block" || aiMove === "block";

          if (isConcurrent) {
            await Promise.all([runP1Attack(), runP2Attack()]);
          } else {
            // P1 goes first
            await runP1Attack();
            // Then P2
            await runP2Attack();
          }

          // Show overall narrative
          let narrative = "";
          if (p1WasStunned && p2WasStunned) {
            narrative = "Both players are stunned!";
          } else if (p1WasStunned) {
            narrative = `You are STUNNED! AI uses ${aiMove}!`;
          } else if (p2WasStunned) {
            narrative = `AI is STUNNED! You use ${playerMove}!`;
          } else if (p1ActualDamage > 0 && p2ActualDamage > 0) {
            // Both players took damage - show who did more
            if (p2ActualDamage > p1ActualDamage) {
              narrative = `Brutal exchange! You ${playerMove} for ${p2ActualDamage} dmg, but take ${p1ActualDamage}!`;
            } else if (p1ActualDamage > p2ActualDamage) {
              narrative = `Fierce clash! AI ${aiMove} for ${p1ActualDamage} dmg, but takes ${p2ActualDamage}!`;
            } else {
              narrative = `Devastating trade! Both deal ${p1ActualDamage} damage!`;
            }
          } else if (p2ActualDamage > 0) {
            narrative = `You hit for ${p2ActualDamage} damage!`;
          } else if (p1ActualDamage > 0) {
            narrative = `AI hits for ${p1ActualDamage} damage!`;
          } else {
            narrative = "Both attacks were blocked or missed!";
          }
          this.narrativeText.setText(narrative);
          this.narrativeText.setAlpha(1);

          // Clear existing timer if any
          if (this.narrativeTimer) {
            this.narrativeTimer.destroy();
          }

          // Fade out narrative after 3 seconds
          this.narrativeTimer = this.time.delayedCall(3000, () => {
            this.tweens.add({
              targets: this.narrativeText,
              alpha: 0,
              duration: 500,
              onComplete: () => {
                this.narrativeTimer = undefined;
              }
            });
          });

          // Phase 4: Sync UI & Return
          this.syncUIWithCombatState();

          // Run back animations
          if (this.anims.exists(`${p1Char}_run`)) {
            const p1RunScale = getAnimationScale(p1Char, 'run');
            this.player1Sprite.setScale(p1RunScale);
            this.player1Sprite.play(`${p1Char}_run`);
          }
          if (this.anims.exists(`${p2Char}_run`)) {
            const p2RunScale = getAnimationScale(p2Char, 'run');
            this.player2Sprite.setScale(p2RunScale);
            this.player2Sprite.play(`${p2Char}_run`);
            this.player2Sprite.setFlipX(true); // Ensure facing correct way
          }

          // Tween back
          this.tweens.add({
            targets: this.player1Sprite,
            x: p1OriginalX,
            duration: 600,
            ease: 'Power2',
          });

          this.tweens.add({
            targets: this.player2Sprite,
            x: p2OriginalX,
            duration: 600,
            ease: 'Power2',
            onComplete: () => {
              // Phase 5: Return to idle
              if (this.anims.exists(`${p1Char}_idle`)) {
                const p1IdleScale = getAnimationScale(p1Char, 'idle');
                this.player1Sprite.setScale(p1IdleScale);
                this.player1Sprite.play(`${p1Char}_idle`);
              }
              if (this.anims.exists(`${p2Char}_idle`)) {
                const p2IdleScale = getAnimationScale(p2Char, 'idle');
                this.player2Sprite.setScale(p2IdleScale);
                this.player2Sprite.play(`${p2Char}_idle`);
              }

              // Check result
              if (state.isMatchOver) {
                this.showMatchEnd();
              } else if (state.isRoundOver) {
                this.showRoundEnd();
              } else if (this.privateRoundPlannedMoves.length > 0 && this.aiPlannedMoves.length > 0) {
                this.time.delayedCall(450, () => {
                  const nextPlayerMove = this.privateRoundPlannedMoves.shift();
                  const nextAiMove = this.aiPlannedMoves.shift();
                  if (!nextPlayerMove || !nextAiMove) {
                    this.startSelectionPhase();
                    return;
                  }
                  this.resolveRound(nextPlayerMove, nextAiMove);
                });
              } else {
                this.startSelectionPhase();
              }
            }
          });
        })();
      }
    });
  }

  private showDamageNumbers(turnResult: { player1: { damageTaken: number }, player2: { damageTaken: number } }, centerX: number): void {
    // Show damage taken by player (if any)
    if (turnResult.player1.damageTaken > 0) {
      this.showFloatingText(
        `-${turnResult.player1.damageTaken}`,
        centerX - 50,
        CHARACTER_POSITIONS.PLAYER1.Y - 130,
        "#ff4444"
      );
    }

    // Show damage taken by AI (if any)
    if (turnResult.player2.damageTaken > 0) {
      this.showFloatingText(
        `-${turnResult.player2.damageTaken}`,
        centerX + 50,
        CHARACTER_POSITIONS.PLAYER2.Y - 130,
        "#ff4444"
      );
    }
  }

  private showFloatingText(text: string, x: number, y: number, color: string): void {
    const floatText = this.add.text(x, y, text, {
      fontFamily: "monospace",
      fontSize: "28px",
      color: color,
      fontStyle: "bold",
      stroke: "#000000",
      strokeThickness: 4,
    }).setOrigin(0.5);

    this.tweens.add({
      targets: floatText,
      y: y - 60,
      alpha: 0,
      duration: 1000,
      ease: "Power2",
      onComplete: () => floatText.destroy(),
    });
  }

  private showRoundEnd(): void {
    this.phase = "round_end";
    const state = this.combatEngine.getState();
    const roundsToWin = this.config.matchFormat === "best_of_5" ? 3 : 2;

    // Check for draw (both KO'd)
    const isDraw = state.roundWinner === null;

    if (isDraw) {
      // Both players dead - play death animation on both
      const p1DeadScale = getAnimationScale(this.playerCharacter.id, "dead");
      const p2DeadScale = getAnimationScale(this.aiCharacter.id, "dead");

      if (this.anims.exists(`${this.playerCharacter.id}_dead`)) {
        this.player1Sprite.setScale(p1DeadScale);
        this.player1Sprite.play(`${this.playerCharacter.id}_dead`);
      }
      if (this.anims.exists(`${this.aiCharacter.id}_dead`)) {
        this.player2Sprite.setScale(p2DeadScale);
        this.player2Sprite.play(`${this.aiCharacter.id}_dead`);
      }

      // Play neutral sound for draw
      this.playSFX("sfx_click");

      // Show draw text
      this.countdownText.setText("DRAW - BOTH KO!");
      this.countdownText.setColor("#fbbf24");
      this.countdownText.setAlpha(1);
    } else {
      // Normal round end - one player won
      const loser = state.roundWinner === "player1" ? "player2" : "player1";
      const loserChar = loser === "player1" ? this.playerCharacter.id : this.aiCharacter.id;
      const loserSprite = loser === "player1" ? this.player1Sprite : this.player2Sprite;

      // Use centralized scale from sprite-config.ts
      const deadScale = getAnimationScale(loserChar, "dead");

      // Play dead animation
      if (this.anims.exists(`${loserChar}_dead`)) {
        loserSprite.setScale(deadScale);
        loserSprite.play(`${loserChar}_dead`);
      }

      // Play Round End SFX
      const isWin = state.roundWinner === "player1";
      this.playSFX(isWin ? "sfx_victory" : "sfx_defeat");

      // Show result text
      const winnerText = state.roundWinner === "player1" ? "YOU WIN ROUND!" : "AI WINS ROUND!";
      const winnerColor = state.roundWinner === "player1" ? "#22c55e" : "#ff4444";

      this.countdownText.setText(winnerText);
      this.countdownText.setColor(winnerColor);
      this.countdownText.setAlpha(1);
    }

    // Update round score
    this.roundScoreText.setText(
      `Round ${state.currentRound}  •  ${state.player1.roundsWon} - ${state.player2.roundsWon}  (First to ${roundsToWin})`
    );

    // Start new round after delay
    this.time.delayedCall(3000, () => {
      this.countdownText.setAlpha(0);
      this.countdownText.setColor("#40e0d0");

      // Reset loser sprite to idle/scale before next round
      // (Will be handled by createCharacterSprites or reset in startNewRound, 
      // but we need to reset scale/anim here or rely on startRound setting it)
      // Actually startRound doesn't reset sprites, only state.
      // We should probably reset sprites in startRound or here.

      // Clear active surges from previous round
      this.clearSurgeEffects();

      // Reset for new round
      this.combatEngine.startNewRound();
      this.syncUIWithCombatState();

      // Reset sprites to idle scales
      this.resetCharacterSprites();

      this.startRound();
    });
  }

  /**
   * Clear surge effects at end of round.
   */
  private clearSurgeEffects(): void {
    this.activeSurges = { player1: null, player2: null };
    this.surgeCardsShownThisRound = false;

    // Stop all stun tweens
    this.stunTweens.forEach((tween, player) => {
      tween.stop();
    });
    this.stunTweens.clear();

    // Clear any visual tints
    this.player1Sprite.clearTint();
    this.player2Sprite.clearTint();
  }

  private resetCharacterSprites(): void {
    const p1Char = this.playerCharacter.id;
    const p2Char = this.aiCharacter.id;

    // Use centralized scaling from sprite-config.ts
    const p1Scale = getAnimationScale(p1Char, "idle");
    const p2Scale = getAnimationScale(p2Char, "idle");

    // Reset position to original
    this.player1Sprite.setX(CHARACTER_POSITIONS.PLAYER1.X);
    this.player2Sprite.setX(CHARACTER_POSITIONS.PLAYER2.X);

    // Apply correct scales
    this.player1Sprite.setScale(p1Scale);
    if (this.anims.exists(`${p1Char}_idle`)) this.player1Sprite.play(`${p1Char}_idle`);

    this.player2Sprite.setScale(p2Scale);
    if (this.anims.exists(`${p2Char}_idle`)) this.player2Sprite.play(`${p2Char}_idle`);
  }

  private showMatchEnd(): void {
    this.phase = "match_end";

    const state = this.combatEngine.getState();
    const playerWon = state.matchWinner === "player1";

    // Play SFX
    const isWin = playerWon;
    this.playSFX(isWin ? "sfx_victory" : "sfx_defeat");

    // Play dead animation on loser
    const loser = state.matchWinner === "player1" ? "player2" : "player1";
    const loserChar = loser === "player1" ? this.playerCharacter.id : this.aiCharacter.id;
    const loserSprite = loser === "player1" ? this.player1Sprite : this.player2Sprite;
    const deadScale = getAnimationScale(loserChar, "dead");

    if (this.anims.exists(`${loserChar}_dead`)) {
      loserSprite.setScale(deadScale);
      loserSprite.play(`${loserChar}_dead`);
    }

    // Victory celebration jump animation for the winner
    const winnerSprite = playerWon ? this.player1Sprite : this.player2Sprite;
    this.tweens.add({
      targets: winnerSprite,
      y: winnerSprite.y - 30,
      duration: 500,
      yoyo: true,
      repeat: 2,
      ease: "Sine.easeOut",
    });

    // Wait for animations to complete before emitting event and showing overlay
    this.time.delayedCall(5000, () => {
      // Emit match ended event after animations complete
      EventBus.emit("practice_match_ended", {
        playerWon,
        playerRoundsWon: state.player1.roundsWon,
        aiRoundsWon: state.player2.roundsWon,
        difficulty: this.config.aiDifficulty,
      });

      this.createMatchResultOverlay(playerWon);
    });
  }

  private createMatchResultOverlay(playerWon: boolean): void {
    this.matchResultOverlay = this.add.container(GAME_DIMENSIONS.CENTER_X, GAME_DIMENSIONS.CENTER_Y);

    // Background
    const bg = this.add.graphics();
    bg.fillStyle(0x000000, 0.8);
    bg.fillRect(-GAME_DIMENSIONS.WIDTH / 2, -GAME_DIMENSIONS.HEIGHT / 2, GAME_DIMENSIONS.WIDTH, GAME_DIMENSIONS.HEIGHT);
    this.matchResultOverlay.add(bg);

    // Result title
    const title = this.add.text(0, -100, playerWon ? "VICTORY!" : "DEFEAT", {
      fontFamily: "monospace",
      fontSize: "64px",
      color: playerWon ? "#22c55e" : "#ef4444",
      fontStyle: "bold",
    }).setOrigin(0.5);
    this.matchResultOverlay.add(title);

    // Score
    const state = this.combatEngine.getState();
    const score = this.add.text(0, -20, `${state.player1.roundsWon} - ${state.player2.roundsWon}`, {
      fontFamily: "monospace",
      fontSize: "36px",
      color: "#ffffff",
    }).setOrigin(0.5);
    this.matchResultOverlay.add(score);

    // Buttons
    const retryBtn = this.createResultButton(0, 80, "PLAY AGAIN", () => this.restartMatch());
    const exitBtn = this.createResultButton(0, 150, "EXIT", () => this.exitPractice());
    this.matchResultOverlay.add([retryBtn, exitBtn]);

    this.matchResultOverlay.setDepth(100);
  }

  private createResultButton(x: number, y: number, label: string, onClick: () => void): Phaser.GameObjects.Container {
    const container = this.add.container(x, y);
    const width = 200;
    const height = 50;

    const bg = this.add.graphics();
    bg.fillStyle(0x40e0d0, 1);
    bg.fillRoundedRect(-width / 2, -height / 2, width, height, 8);

    const text = this.add.text(0, 0, label, {
      fontFamily: "monospace",
      fontSize: "18px",
      color: "#000000",
      fontStyle: "bold",
    }).setOrigin(0.5);

    container.add([bg, text]);
    container.setSize(width, height);
    container.setInteractive({ useHandCursor: true });

    container.on("pointerover", () => container.setScale(1.05));
    container.on("pointerout", () => container.setScale(1));
    container.on("pointerdown", onClick);

    return container;
  }

  // ===========================================================================
  // UI SYNC
  // ===========================================================================

  private syncUIWithCombatState(): void {
    const state = this.combatEngine.getState();
    const barWidth = UI_POSITIONS.HEALTH_BAR.PLAYER1.WIDTH;
    const barHeight = 25;
    const energyHeight = 12;
    const yOffset = 30;

    // DEBUG: Log UI sync
    console.log("[PracticeScene] syncUIWithCombatState:", {
      p1HP: state.player1.hp,
      p2HP: state.player2.hp,
      p1MaxHP: state.player1.maxHp,
      p2MaxHP: state.player2.maxHp,
      p1HealthPercent: state.player1.hp / state.player1.maxHp,
      p2HealthPercent: state.player2.hp / state.player2.maxHp,
    });

    // Player 1 health bar (fills left to right)
    this.player1HealthBar.clear();
    const p1HealthPercent = Math.min(1, Math.max(0, state.player1.hp) / (state.player1.maxHp || 1));
    const p1HealthWidth = (barWidth - 4) * p1HealthPercent;
    this.player1HealthBar.fillStyle(this.getHealthColor(p1HealthPercent), 1);
    this.player1HealthBar.fillRoundedRect(
      UI_POSITIONS.HEALTH_BAR.PLAYER1.X + 2,
      UI_POSITIONS.HEALTH_BAR.PLAYER1.Y + 2,
      p1HealthWidth,
      barHeight - 4,
      3
    );

    // Player 2 health bar (fills right to left - mirroring FightScene)
    this.player2HealthBar.clear();
    const p2HealthPercent = Math.min(1, Math.max(0, state.player2.hp) / (state.player2.maxHp || 1));
    const p2HealthWidth = (barWidth - 4) * p2HealthPercent;
    this.player2HealthBar.fillStyle(this.getHealthColor(p2HealthPercent), 1);
    this.player2HealthBar.fillRoundedRect(
      UI_POSITIONS.HEALTH_BAR.PLAYER2.X + 2 + (barWidth - 4 - p2HealthWidth),
      UI_POSITIONS.HEALTH_BAR.PLAYER2.Y + 2,
      p2HealthWidth,
      barHeight - 4,
      3
    );

    // Player 1 energy bar (fills left to right)
    this.player1EnergyBar.clear();
    const p1EnergyPercent = Math.min(1, Math.max(0, state.player1.energy) / (state.player1.maxEnergy || 1));
    const p1EnergyWidth = (barWidth - 2) * p1EnergyPercent;
    this.player1EnergyBar.fillStyle(0x3b82f6, 1);
    this.player1EnergyBar.fillRoundedRect(
      UI_POSITIONS.HEALTH_BAR.PLAYER1.X + 1,
      UI_POSITIONS.HEALTH_BAR.PLAYER1.Y + yOffset,
      p1EnergyWidth,
      energyHeight - 2,
      2
    );

    // Player 2 energy bar (fills right to left - mirroring FightScene)
    this.player2EnergyBar.clear();
    const p2EnergyPercent = Math.min(1, Math.max(0, state.player2.energy) / (state.player2.maxEnergy || 1));
    const p2EnergyWidth = (barWidth - 2) * p2EnergyPercent;
    this.player2EnergyBar.fillStyle(0x3b82f6, 1);
    this.player2EnergyBar.fillRoundedRect(
      UI_POSITIONS.HEALTH_BAR.PLAYER2.X + 1 + (barWidth - 2 - p2EnergyWidth),
      UI_POSITIONS.HEALTH_BAR.PLAYER2.Y + yOffset,
      p2EnergyWidth,
      energyHeight - 2,
      2
    );

    // Guard meters
    this.updateGuardMeterDisplay("player1", state.player1.guardMeter);
    this.updateGuardMeterDisplay("player2", state.player2.guardMeter);

    // Round score
    const roundsToWin = this.config.matchFormat === "best_of_5" ? 3 : 2;
    this.roundScoreText.setText(
      `Round ${state.currentRound}  •  ${state.player1.roundsWon} - ${state.player2.roundsWon}  (First to ${roundsToWin})`
    );
  }

  private updateGuardMeterDisplay(player: "player1" | "player2", guardMeter: number): void {
    const barWidth = UI_POSITIONS.HEALTH_BAR.PLAYER1.WIDTH;
    const barHeight = 6;
    const yOffset = 45;
    // Clamp percentage to [0, 1] to prevent bar overflow
    const guardPercent = Math.min(1, Math.max(0, guardMeter) / 100);
    const innerWidth = barWidth * guardPercent;

    const graphics = player === "player1" ? this.player1GuardMeter : this.player2GuardMeter;
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

  private getHealthColor(percent: number): number {
    if (percent > 0.5) return 0x22c55e; // Green
    if (percent > 0.25) return 0xf59e0b; // Yellow
    return 0xef4444; // Red
  }

  // ===========================================================================
  // EVENT LISTENERS
  // ===========================================================================

  private setupEventListeners(): void {
    EventBus.on("practice_restart", () => this.restartMatch());
    EventBus.on("practice_exit", () => this.exitPractice());
  }

  // ===========================================================================
  // MATCH MANAGEMENT
  // ===========================================================================

  private restartMatch(): void {
    this.scene.restart(this.config);
  }

  private exitPractice(): void {
    EventBus.off("practice_restart");
    EventBus.off("practice_exit");
    EventBus.emit("practice_exit_complete");
  }

  // ===========================================================================
  // SETTINGS MENU
  // ===========================================================================

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
    const hitArea = new Phaser.Geom.Circle(25, 25, radius);
    container.setInteractive(hitArea, Phaser.Geom.Circle.Contains);
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
    const height = 180;

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
    const title = this.add.text(0, -70, "AUDIO SETTINGS", {
      fontFamily: "monospace",
      fontSize: "16px",
      color: "#9ca3af",
      fontStyle: "bold"
    }).setOrigin(0.5);
    this.settingsContainer.add(title);

    // BGM Volume Slider
    this.bgmSlider = this.createVolumeSlider(0, -30, "Music", this.bgmVolume, (value) => {
      this.bgmVolume = value;
      this.applyBgmVolume();
      this.saveAudioSettings();
    });
    this.settingsContainer.add(this.bgmSlider);

    // SFX Volume Slider
    this.sfxSlider = this.createVolumeSlider(0, 15, "SFX", this.sfxVolume, (value) => {
      this.sfxVolume = value;
      this.saveAudioSettings();
      // Play a test sound when adjusting
      this.playSFX("sfx_click");
    });
    this.settingsContainer.add(this.sfxSlider);

    // Close button
    const closeBtn = this.add.text(0, 60, "CLOSE", {
      fontFamily: "monospace",
      fontSize: "14px",
      color: "#6b7280"
    }).setOrigin(0.5);
    closeBtn.setInteractive({ useHandCursor: true });
    closeBtn.on("pointerover", () => closeBtn.setColor("#ffffff"));
    closeBtn.on("pointerout", () => closeBtn.setColor("#6b7280"));
    closeBtn.on("pointerdown", () => this.toggleSettingsMenu());
    this.settingsContainer.add(closeBtn);
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

    // Label
    const labelText = this.add.text(-120, 0, label, {
      fontFamily: "monospace",
      fontSize: "12px",
      color: "#9ca3af"
    }).setOrigin(0, 0.5);
    container.add(labelText);

    // Track start X
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
    const hitArea = this.add.rectangle(0, 0, 240, 30, 0x000000, 0);
    hitArea.setInteractive({ useHandCursor: true });
    container.add(hitArea);

    // Drag handling
    let isDragging = false;

    const calculateValue = (pointerX: number): number => {
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

  /**
   * Get active surge effects for combat resolution.
   */
  public getActiveSurgeEffects(): {
    player1: PowerSurgeCardId | null;
    player2: PowerSurgeCardId | null;
  } {
    return { ...this.activeSurges };
  }
}
