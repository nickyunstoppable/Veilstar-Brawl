/**
 * CharacterSelectScene - Pre-match character selection screen
 * Players select their fighter before entering the battle arena
 *
 * Phases: BANNING → TRANSITION → PICKING → REVEAL → FightScene
 * Uses dedicated UI components (CharacterCard, SelectionTimer, etc.)
 * Deadline-based timers via Date.now() so they work when the tab is backgrounded.
 */

import Phaser from "phaser";
import { EventBus } from "@/game/EventBus";
import { GAME_DIMENSIONS } from "@/game/config";
import { CharacterCard, SelectionTimer, OpponentStatus, StatsOverlay } from "@/game/ui";
import { CHARACTER_ROSTER, getCharacter, getRandomCharacter } from "@/data/characters";
import { getCharacterCombatStats } from "@/game/combat/CharacterStats";
import { TextFactory } from "@/game/ui/TextFactory";
import type { Character } from "@/types/game";

// =============================================================================
// TYPES
// =============================================================================

export interface CharacterSelectSceneConfig {
  matchId: string;
  playerAddress: string;
  opponentAddress: string;
  isHost: boolean;
  selectionTimeLimit?: number;
  selectionDeadlineAt?: string;
  existingPlayerCharacter?: string | null;
  existingOpponentCharacter?: string | null;
  existingPlayerBan?: string | null;
  existingOpponentBan?: string | null;
  ownedCharacterIds?: string[];
}

export interface CharacterSelectEvents {
  character_selected: { characterId: string };
  selection_confirmed: { characterId: string };
  opponent_selected: { characterId: string };
  both_ready: { player: string; opponent: string };
}

export type SelectionPhase = "BANNING" | "TRANSITION" | "PICKING" | "REVEAL";

// =============================================================================
// SCENE
// =============================================================================

export class CharacterSelectScene extends Phaser.Scene {
  // Configuration
  private config!: CharacterSelectSceneConfig;

  // UI Components
  private characterCards: CharacterCard[] = [];
  private selectionTimer!: SelectionTimer;
  private opponentStatus!: OpponentStatus;
  private titleText!: Phaser.GameObjects.Text;
  private instructionText!: Phaser.GameObjects.Text;
  private confirmButton!: Phaser.GameObjects.Container;
  private statsPanel!: Phaser.GameObjects.Container;
  private statsText!: Phaser.GameObjects.Text;
  private selectedNameText!: Phaser.GameObjects.Text;
  private selectedThemeText!: Phaser.GameObjects.Text;
  private statsOverlay!: StatsOverlay;

  // State
  private phase: SelectionPhase = "BANNING";
  private selectedCharacter: Character | null = null;
  private confirmedCharacter: Character | null = null;
  private opponentCharacter: Character | null = null;
  private isConfirmed: boolean = false;

  // Ban State
  private myBan: Character | null = null;
  private opponentBan: Character | null = null;

  private bannedCharacters: Set<string> = new Set();
  private hasLockedBan: boolean = false;
  private hasOpponentLockedBan: boolean = false;

  // Deadline-based timers (Date.now ms)
  private channelReadyFallbackAt: number = 0;
  private channelReadyHandler?: () => void;
  private banToPickTransitionAt: number = 0;
  private revealBothReadyAt: number = 0;
  private matchStartTransitionAt: number = 0;

  // Visibility change handler reference for cleanup
  private visibilityHandler?: () => void;

  // Layout constants
  private readonly CARD_WIDTH = 110;
  private readonly CARD_HEIGHT = 140;
  private readonly CARD_SPACING = 10;
  private readonly GRID_COLS = 10;
  private readonly GRID_START_Y = 360;

  constructor() {
    super({ key: "CharacterSelectScene" });
  }

  // =========================================================================
  // LIFECYCLE
  // =========================================================================

  init(data: CharacterSelectSceneConfig): void {
    this.config = {
      matchId: data?.matchId || "unknown",
      playerAddress: data?.playerAddress || "",
      opponentAddress: data?.opponentAddress || "",
      isHost: data?.isHost ?? true,
      selectionTimeLimit: data?.selectionTimeLimit ?? 30,
      selectionDeadlineAt: data?.selectionDeadlineAt,
      existingPlayerCharacter: data?.existingPlayerCharacter,
      existingOpponentCharacter: data?.existingOpponentCharacter,
      existingPlayerBan: data?.existingPlayerBan,
      existingOpponentBan: data?.existingOpponentBan,
      ownedCharacterIds: data?.ownedCharacterIds || [
        "cyber-ninja", "block-bruiser", "dag-warrior", "hash-hunter",
      ],
    };
    this.resetState();
  }

  private resetState(): void {
    this.phase = "BANNING";
    this.selectedCharacter = null;
    this.confirmedCharacter = null;
    this.opponentCharacter = null;
    this.isConfirmed = false;
    this.characterCards = [];

    this.myBan = null;
    this.opponentBan = null;
    this.bannedCharacters.clear();
    this.hasLockedBan = false;
    this.hasOpponentLockedBan = false;

    this.channelReadyFallbackAt = 0;
    this.channelReadyHandler = undefined;
    this.banToPickTransitionAt = 0;
    this.revealBothReadyAt = 0;
    this.matchStartTransitionAt = 0;
  }

  preload(): void {
    for (const character of CHARACTER_ROSTER) {
      this.load.image(`portrait-${character.id}`, `/characters/${character.id}/portrait.webp`);
      this.load.image(`portrait-${character.id}-fallback`, `/characters/${character.id}/idle.webp`);
    }

    this.load.image("select-bg", "/assets/background_1.png");
    this.load.image("lock-icon", "/assets/lock.png");

    this.load.audio("bgm_select", "/assets/audio/character-selection.mp3");
    this.load.audio("sfx_hover", "/assets/audio/hover.mp3");
    this.load.audio("sfx_click", "/assets/audio/click.mp3");
  }

  create(): void {
    this.createBackground();
    this.createTitle();
    this.createCharacterGrid();
    this.createSelectionTimer();
    this.createOpponentStatus();
    this.createConfirmButton();
    this.createSelectedNameDisplay();
    this.createStatsDisplay();
    this.createInstructions();

    // Stats Overlay (Detailed)
    this.statsOverlay = new StatsOverlay(this);

    this.setupEventListeners();
    this.setupVisibilityChangeHandler();

    // Restore existing selections (reconnection)
    this.restoreExistingSelectionsUI();

    // Listen for channel ready to trigger API calls
    this.setupChannelReadyHandler();

    // Timer starts only when BOTH clients have loaded the scene
    // (CharacterSelectClient emits `selection_timer:start` after a Realtime handshake).
    this.selectionTimer.setLabel("WAITING FOR OPPONENT...");

    // Background music
    this.sound.pauseOnBlur = false;
    if (this.sound.get("bgm_select")) {
      if (!this.sound.get("bgm_select").isPlaying) {
        this.sound.play("bgm_select", { loop: true, volume: 0.3 });
      }
    } else {
      this.sound.play("bgm_select", { loop: true, volume: 0.3 });
    }

    EventBus.emit("character_select_ready", { matchId: this.config.matchId });
  }

  // =========================================================================
  // CHANNEL READY HANDLER
  // =========================================================================

  private setupChannelReadyHandler(): void {
    const needsMatchStart = this.confirmedCharacter && this.opponentCharacter;
    const needsConfirmation = this.confirmedCharacter && !this.opponentCharacter;

    if (needsMatchStart || needsConfirmation) {
      const handleChannelReady = () => {
        EventBus.off("channel_ready", handleChannelReady);
        if (this.confirmedCharacter) {
          EventBus.emit("selection_confirmed", {
            characterId: this.confirmedCharacter.id,
          });
        }
      };

      EventBus.on("channel_ready", handleChannelReady);
      this.channelReadyHandler = handleChannelReady;

      this.channelReadyFallbackAt = Date.now() + 500;
    }
  }

  // =========================================================================
  // RESTORE (RECONNECTION)
  // =========================================================================

  private restoreExistingSelectionsUI(): void {
    // STEP 1: Restore Bans
    if (this.config.existingPlayerBan) {
      const bannedChar = getCharacter(this.config.existingPlayerBan);
      if (bannedChar) {
        this.myBan = bannedChar;
        this.hasLockedBan = true;
        this.bannedCharacters.add(bannedChar.id);
        this.markCardAsBanned(bannedChar.id);
      }
    }

    const opponentBanId = this.config.existingOpponentBan;

    if (opponentBanId) {
      const bannedChar = getCharacter(opponentBanId);
      if (bannedChar) {
        this.opponentBan = bannedChar;
        this.hasOpponentLockedBan = true;
        this.bannedCharacters.add(bannedChar.id);
        this.markCardAsBanned(bannedChar.id);
      }
    }

    // STEP 2: Determine current phase
    const bothBansComplete = this.hasLockedBan && this.hasOpponentLockedBan;

    if (bothBansComplete && !this.config.existingPlayerCharacter) {
      this.phase = "PICKING";
      this.isConfirmed = false;
      this.titleText?.setText("CHOOSE YOUR FIGHTER");
      this.titleText?.setColor("#ffffff");
      this.instructionText?.setText("Bans Locked! Choose your fighter (Blind Pick)");
      this.updateCardsForPickPhase();
    } else if (this.hasLockedBan && !this.hasOpponentLockedBan) {
      this.instructionText?.setText("Waiting for opponent to ban...");
    }

    // STEP 3: Restore Character Picks
    if (this.config.existingPlayerCharacter) {
      const character = getCharacter(this.config.existingPlayerCharacter);
      if (character) {
        this.phase = "PICKING";
        this.selectedCharacter = character;
        this.confirmedCharacter = character;
        this.isConfirmed = true;

        const card = this.characterCards.find(
          (c) => c.getCharacter()?.id === character.id
        );
        if (card) {
          card.select();
          card.lock();
        }

        this.characterCards.forEach((c) => {
          if (c.getCharacter()?.id !== character.id) c.disable();
        });

        this.hideConfirmButton();
        this.selectionTimer?.showLockedIn();
        this.instructionText?.setText("Waiting for opponent...");
      }
    }

    if (this.config.existingOpponentCharacter) {
      const opponent = getCharacter(this.config.existingOpponentCharacter);
      if (opponent) {
        this.opponentCharacter = opponent;
        this.opponentStatus?.showCharacterPreview(opponent.name, opponent.theme);
      }
    }

    // STEP 4: Update UI for final state
    if (this.confirmedCharacter && this.opponentCharacter) {
      this.instructionText?.setText("Both players ready! Connecting...");
      this.instructionText?.setColor("#22c55e");
    }
  }

  private markCardAsBanned(characterId: string): void {
    const card = this.characterCards.find((c) => c.getCharacter()?.id === characterId);
    if (!card) return;

    card.disable();

    const bannedText = this.add
      .text(this.CARD_WIDTH / 2, this.CARD_HEIGHT / 2, "BANNED", {
        fontFamily: "Orbitron, sans-serif",
        fontSize: "24px",
        color: "#ff0000",
        backgroundColor: "#000000cc",
        padding: { x: 8, y: 4 },
        fontStyle: "bold",
      })
      .setOrigin(0.5);
    bannedText.setRotation(-0.2);
    card.add(bannedText);
    card.setAlpha(0.5);
  }

  private updateCardsForPickPhase(): void {
    const STARTERS = ["cyber-ninja", "block-bruiser", "dag-warrior", "hash-hunter"];

    this.characterCards.forEach((card) => {
      const charId = card.getCharacter()?.id;
      const isStarter = STARTERS.includes(charId || "");
      const isOwned = this.config.ownedCharacterIds?.includes(charId || "");
      const isUnlocked = isStarter || isOwned;

      if (charId && (this.bannedCharacters.has(charId) || !isUnlocked)) {
        card.disable();
        card.setAlpha(0.3);
      } else {
        card.enable();
        if ((card as any)["deselect"]) card.deselect();
      }
    });

    const buttonText = this.confirmButton?.getAt(1) as Phaser.GameObjects.Text;
    if (buttonText) buttonText.setText("LOCK IN");
  }

  // =========================================================================
  // BACKGROUND
  // =========================================================================

  private createBackground(): void {
    const graphics = this.add.graphics();
    graphics.fillGradientStyle(0x1a1a2e, 0x1a1a2e, 0x16213e, 0x16213e, 1);
    graphics.fillRect(0, 0, GAME_DIMENSIONS.WIDTH, GAME_DIMENSIONS.HEIGHT);

    if (this.textures.exists("select-bg")) {
      const bg = this.add.image(
        GAME_DIMENSIONS.CENTER_X,
        GAME_DIMENSIONS.CENTER_Y,
        "select-bg"
      );
      bg.setDisplaySize(GAME_DIMENSIONS.WIDTH, GAME_DIMENSIONS.HEIGHT);
    }

    const overlay = this.add.graphics();
    overlay.fillStyle(0x000000, 0.3);
    overlay.fillRect(0, 0, GAME_DIMENSIONS.WIDTH, GAME_DIMENSIONS.HEIGHT);
  }

  // =========================================================================
  // TITLE
  // =========================================================================

  private createTitle(): void {
    this.titleText = this.add.text(
      GAME_DIMENSIONS.CENTER_X,
      50,
      "BAN PHASE - BAN 1 CHARACTER",
      {
        fontFamily: "Orbitron, sans-serif",
        fontSize: "36px",
        color: "#ef4444",
        fontStyle: "bold",
      }
    );
    this.titleText.setOrigin(0.5);

    TextFactory.createLabel(
      this,
      GAME_DIMENSIONS.CENTER_X,
      90,
      `Match: ${this.config.matchId.slice(0, 8)}`,
      { fontSize: "14px", color: "#888888" }
    ).setOrigin(0.5);
  }

  // =========================================================================
  // CHARACTER GRID
  // =========================================================================

  private createCharacterGrid(): void {
    const totalWidth =
      this.CARD_WIDTH * this.GRID_COLS +
      this.CARD_SPACING * (this.GRID_COLS - 1);
    const startX = (GAME_DIMENSIONS.WIDTH - totalWidth) / 2;

    const STARTERS = ["cyber-ninja", "block-bruiser", "dag-warrior", "hash-hunter"];

    CHARACTER_ROSTER.forEach((character, index) => {
      const col = index % this.GRID_COLS;
      const row = Math.floor(index / this.GRID_COLS);

      const x = startX + col * (this.CARD_WIDTH + this.CARD_SPACING);
      const y = this.GRID_START_Y + row * (this.CARD_HEIGHT + 20);

      const isStarter = STARTERS.includes(character.id);
      const isOwned = this.config.ownedCharacterIds?.includes(character.id);
      const isUnlocked = isStarter || isOwned;

      const card = new CharacterCard(this, {
        x,
        y,
        character,
        width: this.CARD_WIDTH,
        height: this.CARD_HEIGHT,
        onSelect: (char) => {
          if (isUnlocked || this.phase === "BANNING") {
            this.onCharacterSelect(char);
          } else {
            this.sound.play("sfx_click", { volume: 0.2, detune: -500 });
          }
        },
        onHover: (char) => {
          this.updateSelectedNameDisplay(char);
        },
        onInfo: (char) => this.statsOverlay.show(char),
      });

      this.characterCards.push(card);
    });
  }

  // =========================================================================
  // SELECTION TIMER
  // =========================================================================

  private createSelectionTimer(): void {
    let deadlineTimestamp: number | undefined = undefined;
    if (this.config.selectionDeadlineAt) {
      const parsed = new Date(this.config.selectionDeadlineAt).getTime();
      if (!Number.isNaN(parsed) && parsed > Date.now()) {
        deadlineTimestamp = parsed;
      }
    }

    this.selectionTimer = new SelectionTimer(this, {
      x: GAME_DIMENSIONS.CENTER_X,
      y: 150,
      duration: this.config.selectionTimeLimit ?? 30,
      deadlineTimestamp,
      warningThreshold: 10,
      criticalThreshold: 5,
      onTimeUp: () => this.onTimeUp(),
    });
  }

  // =========================================================================
  // OPPONENT STATUS
  // =========================================================================

  private createOpponentStatus(): void {
    this.opponentStatus = new OpponentStatus(this, {
      x: GAME_DIMENSIONS.WIDTH - 120,
      y: 150,
      opponentAddress: this.config.opponentAddress,
    });
    this.opponentStatus.setWaiting();
  }

  // =========================================================================
  // NAME DISPLAY (CENTER)
  // =========================================================================

  private createSelectedNameDisplay(): void {
    const centerX = GAME_DIMENSIONS.CENTER_X;
    const centerY = 280;

    this.selectedNameText = this.add
      .text(centerX, centerY, "", {
        fontFamily: "Orbitron, sans-serif",
        fontSize: "48px",
        color: "#ffffff",
        fontStyle: "bold",
      })
      .setOrigin(0.5)
      .setAlpha(0);

    this.selectedThemeText = this.add
      .text(centerX, centerY + 50, "", {
        fontFamily: "Arial, sans-serif",
        fontSize: "20px",
        color: "#aaa",
        fontStyle: "italic",
      })
      .setOrigin(0.5)
      .setAlpha(0);
  }

  private updateSelectedNameDisplay(character: Character): void {
    if (!character) return;

    this.selectedNameText.setText(character.name.toUpperCase());
    this.selectedNameText.setAlpha(1);

    this.selectedThemeText.setText(character.theme);
    this.selectedThemeText.setAlpha(1);

    this.tweens.add({
      targets: [this.selectedNameText],
      scale: { from: 1.1, to: 1 },
      duration: 200,
      ease: "Back.out",
    });
  }

  // =========================================================================
  // CONFIRM BUTTON
  // =========================================================================

  private createConfirmButton(): void {
    const buttonWidth = 200;
    const buttonHeight = 50;
    const x = GAME_DIMENSIONS.CENTER_X;
    const y = GAME_DIMENSIONS.HEIGHT - 80;

    this.confirmButton = this.add.container(x, y);

    const bg = this.add.graphics();
    bg.fillStyle(0x22c55e, 1);
    bg.fillRoundedRect(
      -buttonWidth / 2,
      -buttonHeight / 2,
      buttonWidth,
      buttonHeight,
      8
    );

    const text = this.add.text(0, 0, "BAN CHARACTER", {
      fontFamily: "Orbitron, sans-serif",
      fontSize: "20px",
      color: "#ffffff",
      fontStyle: "bold",
    });
    text.setOrigin(0.5);

    this.confirmButton.add([bg, text]);
    this.confirmButton.setSize(buttonWidth, buttonHeight);
    this.confirmButton.setInteractive({ useHandCursor: true });

    this.confirmButton.on("pointerover", () => {
      if (!this.isConfirmed && this.selectedCharacter) {
        this.confirmButton.setScale(1.05);
        this.sound.play("sfx_hover", { volume: 0.5 });
      }
    });

    this.confirmButton.on("pointerout", () => {
      this.confirmButton.setScale(1);
    });

    this.confirmButton.on("pointerdown", () => {
      this.sound.play("sfx_click", { volume: 0.5 });
      this.confirmSelection();
    });

    this.confirmButton.setVisible(false);
    this.confirmButton.setAlpha(0);
  }

  // =========================================================================
  // STATS DISPLAY
  // =========================================================================

  private createStatsDisplay(): void {
    this.statsPanel = this.add.container(GAME_DIMENSIONS.CENTER_X, 230);

    this.statsText = this.add.text(0, 0, "", {
      fontFamily: "Orbitron, sans-serif",
      fontSize: "16px",
      color: "#4ade80",
      align: "center",
      stroke: "#000000",
      strokeThickness: 3,
    });
    this.statsText.setOrigin(0.5);

    this.statsText.postFX.addGlow(0x4ade80, 0.5, 0, false, 0.1, 10);

    this.statsPanel.add(this.statsText);
    this.statsPanel.setVisible(false);
  }

  private updateStatsDisplay(character: Character): void {
    const stats = getCharacterCombatStats(character.id);
    let archetype = "Balanced";
    if (character.archetype === "tank") archetype = "Tank / Heavy Hitter";
    if (character.archetype === "speed") archetype = "Glass Cannon / Fast";
    if (character.archetype === "precision") archetype = "Aggressive Specialist";
    if (character.archetype === "tech") archetype = "Tech Specialist";

    const text = `${character.name.toUpperCase()}\nHP: ${stats.maxHp}  |  Energy: ${stats.maxEnergy}\n${archetype}`;
    this.statsText.setText(text);

    let color = "#4ade80";
    if (character.archetype === "tank") color = "#f97316";
    if (character.archetype === "precision") color = "#ef4444";
    if (character.archetype === "speed") color = "#a855f7";
    if (character.archetype === "tech") color = "#3b82f6";

    this.statsText.setColor(color);
    this.statsPanel.setVisible(true);
  }

  // =========================================================================
  // INSTRUCTIONS
  // =========================================================================

  private createInstructions(): void {
    this.instructionText = this.add.text(
      GAME_DIMENSIONS.CENTER_X,
      GAME_DIMENSIONS.HEIGHT - 30,
      "Click a character to preview, then Lock In your choice",
      {
        fontFamily: "Orbitron, sans-serif",
        fontSize: "14px",
        color: "#888888",
      }
    );
    this.instructionText.setOrigin(0.5);
  }

  // =========================================================================
  // EVENT LISTENERS
  // =========================================================================

  private setupEventListeners(): void {
    EventBus.on("opponent_character_selected", (data: unknown) => {
      const payload = data as { characterId: string };
      this.onOpponentSelected(payload.characterId);
    });

    EventBus.on("opponent_character_confirmed", (data: unknown) => {
      const payload = data as { characterId: string };
      this.onOpponentConfirmed(payload.characterId);
    });

    EventBus.on("match_starting", (data: unknown) => {
      const payload = data as {
        countdown: number;
        player1CharacterId?: string;
        player2CharacterId?: string;
      };
      this.onMatchStarting(payload);
    });

    EventBus.on("opponent_disconnected", () => {
      this.opponentStatus.setDisconnected();
    });

    EventBus.on("game:banConfirmed", (data: unknown) => {
      const payload = data as { characterId: string; player: string };
      this.onOpponentBanConfirmed(payload.characterId, payload.player);
    });

    EventBus.on("selection_timer:start", () => {
      this.selectionTimer.setLabel("SELECT YOUR FIGHTER");
      this.selectionTimer.start();
    });
  }

  // =========================================================================
  // INPUT HANDLERS
  // =========================================================================

  private onCharacterSelect(character: Character): void {
    if (this.isConfirmed) return;
    if (this.phase === "PICKING" && this.bannedCharacters.has(character.id)) {
      this.sound.play("sfx_click", { volume: 0.2, detune: -500 });
      return;
    }

    if (this.selectedCharacter) {
      const prevCard = this.characterCards.find(
        (c) => c.getCharacter()?.id === this.selectedCharacter?.id
      );
      prevCard?.deselect();
    }

    this.sound.play("sfx_click", { volume: 0.5 });

    this.selectedCharacter = character;
    const newCard = this.characterCards.find(
      (c) => c.getCharacter()?.id === character.id
    );
    newCard?.select();

    this.showConfirmButton();
    this.updateStatsDisplay(character);

    if (this.phase === "BANNING") {
      EventBus.emit("game:sendBanSelected", { characterId: character.id });
    } else {
      EventBus.emit("character_selected", { characterId: character.id });
    }
  }

  // =========================================================================
  // CONFIRM SELECTION
  // =========================================================================

  private confirmSelection(): void {
    if (this.isConfirmed || !this.selectedCharacter) return;
    this.isConfirmed = true;

    if (this.phase === "BANNING") {
      this.myBan = this.selectedCharacter;
      this.hasLockedBan = true;
      this.bannedCharacters.add(this.selectedCharacter.id);

      const card = this.characterCards.find(
        (c) => c.getCharacter()?.id === this.selectedCharacter?.id
      );

      if (card) {
        card.disable();

        const bannedText = this.add
          .text(this.CARD_WIDTH / 2, this.CARD_HEIGHT / 2, "BANNED", {
            fontFamily: "Orbitron, sans-serif",
            fontSize: "24px",
            color: "#ff0000",
            backgroundColor: "#000000cc",
            padding: { x: 8, y: 4 },
            fontStyle: "bold",
          })
          .setOrigin(0.5);
        bannedText.setRotation(-0.2);
        card.add(bannedText);
      }

      EventBus.emit("game:sendBanConfirmed", { characterId: this.selectedCharacter.id });

      this.hideConfirmButton();
      this.instructionText.setText("Waiting for opponent to ban...");

      this.checkBanPhaseComplete();
      return;
    }

    this.confirmedCharacter = this.selectedCharacter;

    const card = this.characterCards.find(
      (c) => c.getCharacter()?.id === this.selectedCharacter?.id
    );
    card?.lock();

    this.characterCards.forEach((c) => {
      if (c.getCharacter()?.id !== this.selectedCharacter?.id) c.disable();
    });

    this.hideConfirmButton();
    this.selectionTimer.showLockedIn();
    this.instructionText.setText("Waiting for opponent...");

    EventBus.emit("selection_confirmed", {
      characterId: this.confirmedCharacter.id,
    });

    this.checkBothReady();
  }

  private onOpponentSelected(_characterId: string): void {
    this.opponentStatus.setSelecting();
  }

  // =========================================================================
  // BAN & BLIND PICK LOGIC
  // =========================================================================

  private onOpponentBanConfirmed(characterId: string, playerRole?: string): void {
    const myRole = this.config.isHost ? "player1" : "player2";
    if (playerRole && playerRole === myRole) return;
    if (this.opponentBan?.id === characterId) return;

    const char = getCharacter(characterId);
    if (char) {
      this.opponentBan = char;
      this.bannedCharacters.add(characterId);

      const card = this.characterCards.find((c) => c.getCharacter()?.id === characterId);
      if (card) {
        const bannedText = this.add
          .text(this.CARD_WIDTH / 2, this.CARD_HEIGHT / 2, "BANNED", {
            fontFamily: "Orbitron, sans-serif",
            fontSize: "24px",
            color: "#ff0000",
            backgroundColor: "#000000cc",
            padding: { x: 8, y: 4 },
            fontStyle: "bold",
          })
          .setOrigin(0.5);
        bannedText.setRotation(-0.2);
        card.add(bannedText);
        card.setAlpha(0.5);
      }
    }
    this.hasOpponentLockedBan = true;
    this.checkBanPhaseComplete();
  }

  private checkBanPhaseComplete(): void {
    if (this.phase !== "BANNING") return;

    const oppReady = this.hasOpponentLockedBan || !!this.opponentCharacter;

    if (this.hasLockedBan && oppReady) {
      this.phase = "TRANSITION";
      this.instructionText.setText("Ban Phase Complete. Prepare to Pick...");

      const delay = Phaser.Math.Between(2000, 4000);
      this.banToPickTransitionAt = Date.now() + delay;
    }
  }

  private startPickPhase(): void {
    this.phase = "PICKING";
    this.isConfirmed = false;
    this.selectedCharacter = null;

    this.titleText.setText("CHOOSE YOUR FIGHTER");
    this.titleText.setColor("#ffffff");
    this.instructionText.setText("Bans Locked! Choose your fighter (Blind Pick)");

    this.updateCardsForPickPhase();
    this.hideConfirmButton();

    this.selectionTimer.reset(this.config.selectionTimeLimit || 30);
    this.selectionTimer.start();
  }

  private onOpponentConfirmed(characterId: string): void {
    const character = getCharacter(characterId);
    if (character) {
      this.opponentCharacter = character;
      this.opponentStatus.setLockedHidden();
    }
    this.checkBothReady();
  }

  private checkBothReady(): void {
    if (this.confirmedCharacter && this.opponentCharacter) {
      this.phase = "REVEAL";
      this.revealOpponentSelection();
    }
  }

  private revealOpponentSelection(): void {
    if (!this.opponentCharacter) return;

    this.opponentStatus.showCharacterPreview(
      this.opponentCharacter.name,
      this.opponentCharacter.theme
    );

    this.revealBothReadyAt = Date.now() + 1500;
  }

  // =========================================================================
  // TIMER EXPIRATION
  // =========================================================================

  private onTimeUp(): void {
    if (this.isConfirmed) return;

    if (!this.selectedCharacter) {
      const STARTERS = ["cyber-ninja", "block-bruiser", "dag-warrior", "hash-hunter"];
      const unlockedCharacters = CHARACTER_ROSTER.filter(
        (c) =>
          STARTERS.includes(c.id) ||
          this.config.ownedCharacterIds?.includes(c.id)
      );

      if (unlockedCharacters.length > 0) {
        const randomIndex = Math.floor(Math.random() * unlockedCharacters.length);
        this.selectedCharacter = unlockedCharacters[randomIndex];
      } else {
        this.selectedCharacter = getRandomCharacter();
      }

      const card = this.characterCards.find(
        (c) => c.getCharacter()?.id === this.selectedCharacter?.id
      );
      card?.select();
    }

    this.confirmSelection();
  }

  // =========================================================================
  // MATCH START & TRANSITION
  // =========================================================================

  private onMatchStarting(payload: {
    countdown: number;
    player1CharacterId?: string;
    player2CharacterId?: string;
  }): void {
    const { countdown, player1CharacterId, player2CharacterId } = payload;

    if (player1CharacterId && player2CharacterId) {
      const opponentCharacterId = this.config.isHost
        ? player2CharacterId
        : player1CharacterId;
      const playerCharacterId = this.config.isHost
        ? player1CharacterId
        : player2CharacterId;

      if (!this.opponentCharacter) {
        const opponent = getCharacter(opponentCharacterId);
        if (opponent) {
          this.opponentCharacter = opponent;
          this.opponentStatus.showCharacterPreview(opponent.name, opponent.theme);
        }
      }

      if (!this.confirmedCharacter) {
        const player = getCharacter(playerCharacterId);
        if (player) this.confirmedCharacter = player;
      }
    }

    this.instructionText.setText(`Match starting in ${countdown}...`);
    this.instructionText.setColor("#22c55e");

    this.matchStartTransitionAt = Date.now() + countdown * 1000;
  }

  private transitionToFight(): void {
    EventBus.off("opponent_character_selected");
    EventBus.off("opponent_character_confirmed");
    EventBus.off("match_starting");
    EventBus.off("opponent_disconnected");
    EventBus.off("game:banConfirmed");

    if (this.sound.get("bgm_select")) {
      this.sound.stopByKey("bgm_select");
    }

    this.scene.start("FightScene", {
      matchId: this.config.matchId,
      player1Address: this.config.isHost
        ? this.config.playerAddress
        : this.config.opponentAddress,
      player2Address: this.config.isHost
        ? this.config.opponentAddress
        : this.config.playerAddress,
      player1Character: this.config.isHost
        ? this.confirmedCharacter?.id
        : this.opponentCharacter?.id,
      player2Character: this.config.isHost
        ? this.opponentCharacter?.id
        : this.confirmedCharacter?.id,
      playerRole: this.config.isHost ? "player1" : "player2",
    });
  }

  // =========================================================================
  // UI HELPERS
  // =========================================================================

  private showConfirmButton(): void {
    this.confirmButton.setVisible(true);
    this.tweens.add({
      targets: this.confirmButton,
      alpha: 1,
      y: GAME_DIMENSIONS.HEIGHT - 80,
      duration: 200,
      ease: "Power2",
    });
  }

  private hideConfirmButton(): void {
    this.tweens.add({
      targets: this.confirmButton,
      alpha: 0,
      duration: 200,
      ease: "Power2",
      onComplete: () => {
        this.confirmButton.setVisible(false);
      },
    });
  }

  // =========================================================================
  // UPDATE LOOP
  // =========================================================================

  update(_time: number, _delta: number): void {
    const now = Date.now();

    // SelectionTimer visual refresh
    if (this.selectionTimer) {
      this.selectionTimer.tickFromUpdate?.();
    }

    // Channel ready fallback deadline
    if (this.channelReadyFallbackAt > 0 && now >= this.channelReadyFallbackAt) {
      this.channelReadyFallbackAt = 0;
      if (this.confirmedCharacter && !this.scene.isActive("FightScene")) {
        if (this.channelReadyHandler) {
          EventBus.off("channel_ready", this.channelReadyHandler);
          this.channelReadyHandler = undefined;
        }
        EventBus.emit("selection_confirmed", {
          characterId: this.confirmedCharacter.id,
        });
      }
    }

    // Ban → Pick transition deadline
    if (this.banToPickTransitionAt > 0 && now >= this.banToPickTransitionAt) {
      this.banToPickTransitionAt = 0;
      this.startPickPhase();
    }

    // Reveal → both_ready deadline
    if (this.revealBothReadyAt > 0 && now >= this.revealBothReadyAt) {
      this.revealBothReadyAt = 0;
      EventBus.emit("both_ready", {
        player: this.confirmedCharacter!.id,
        opponent: this.opponentCharacter!.id,
      });
    }

    // Match starting → fight transition deadline
    if (this.matchStartTransitionAt > 0 && now >= this.matchStartTransitionAt) {
      this.matchStartTransitionAt = 0;
      this.transitionToFight();
    }
  }

  // =========================================================================
  // VISIBILITY HANDLER
  // =========================================================================

  private setupVisibilityChangeHandler(): void {
    this.visibilityHandler = () => {
      if (document.visibilityState === "visible") {
        this.update(0, 0);
      }
    };
    document.addEventListener("visibilitychange", this.visibilityHandler);
  }

  // =========================================================================
  // SHUTDOWN
  // =========================================================================

  shutdown(): void {
    EventBus.off("opponent_character_selected");
    EventBus.off("opponent_character_confirmed");
    EventBus.off("match_starting");
    EventBus.off("selection_timer:start");
    EventBus.off("opponent_disconnected");
    EventBus.off("channel_ready");
    EventBus.off("game:banConfirmed");

    if (this.visibilityHandler) {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
      this.visibilityHandler = undefined;
    }
  }
}
