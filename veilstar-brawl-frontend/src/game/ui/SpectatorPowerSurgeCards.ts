/**
 * SpectatorPowerSurgeCards - Power Surge display for spectator/replay modes
 * 
 * Used in BotBattleScene and ReplayScene where the match is pre-computed.
 * Shows the 3 cards dealt, then reveals both players' selections above their heads.
 * Auto-advances after display (no interaction needed).
 * 
 * Flow:
 * 1. Show "POWER SURGE" title with 3 cards fanning out
 * 2. Highlight both players' selections with glow effect
 * 3. Show mini cards above each character's head
 * 4. Fade out and continue to combat
 */

import Phaser from "phaser";
import { GAME_DIMENSIONS, CHARACTER_POSITIONS } from "../config";
import type {
  PowerSurgeCard,
  PowerSurgeCardId,
} from "@/types/power-surge";
import {
  getPowerSurgeCard,
} from "@/types/power-surge";
import { PowerSurgeCardView } from "./PowerSurgeCardView";

// =============================================================================
// CONSTANTS
// =============================================================================

const CARD_WIDTH = 180;
const CARD_HEIGHT = 270;
const CARD_SPACING = 30;
const MINI_CARD_WIDTH = 140;
const MINI_CARD_HEIGHT = 200;

// Timing constants (in ms)
const CARD_ENTRY_DURATION = 400;
const CARD_ENTRY_STAGGER = 100;
const SELECTION_REVEAL_DELAY = 1200;
const SELECTION_HIGHLIGHT_DURATION = 600;
const MINI_CARD_MOVE_DURATION = 800;
const DISPLAY_HOLD_DURATION = 5000; // Mini cards visible for 5 seconds
const FADE_OUT_DURATION = 400;

// =============================================================================
// TYPES
// =============================================================================

export interface SpectatorPowerSurgeConfig {
  scene: Phaser.Scene;
  roundNumber: number;
  cardIds: PowerSurgeCardId[];
  player1Selection: PowerSurgeCardId;
  player2Selection: PowerSurgeCardId;
  player1SpriteY: number; // Y position of player 1 sprite (for mini card placement)
  player2SpriteY: number; // Y position of player 2 sprite
  player1Sprite?: Phaser.GameObjects.Sprite; // Sprite reference for visual effects
  player2Sprite?: Phaser.GameObjects.Sprite; // Sprite reference for visual effects
  onComplete: () => void;
  player1Label?: string; // Custom label for player 1 (default: "BOT 1")
  player2Label?: string; // Custom label for player 2 (default: "BOT 2")
}

interface CardDisplay {
  container: Phaser.GameObjects.Container;
  card: PowerSurgeCard;
  index: number;
  isPlayer1Selection: boolean;
  isPlayer2Selection: boolean;
}

// =============================================================================
// SPECTATOR POWER SURGE CARDS UI
// =============================================================================

export class SpectatorPowerSurgeCards {
  private scene: Phaser.Scene;
  private config: SpectatorPowerSurgeConfig;
  private mainContainer: Phaser.GameObjects.Container;
  private backgroundBlocker: Phaser.GameObjects.Rectangle;
  private cardDisplays: CardDisplay[] = [];
  private titleText: Phaser.GameObjects.Text;
  private roundText: Phaser.GameObjects.Text;
  private isDestroyed: boolean = false;
  private player1Label: string;
  private player2Label: string;

  // Mini cards that float above characters
  private player1MiniCard: Phaser.GameObjects.Container | null = null;
  private player2MiniCard: Phaser.GameObjects.Container | null = null;

  constructor(config: SpectatorPowerSurgeConfig) {
    this.scene = config.scene;
    this.config = config;
    this.player1Label = config.player1Label || "BOT 1";
    this.player2Label = config.player2Label || "BOT 2";

    // Create semi-transparent background blocker
    this.backgroundBlocker = this.scene.add.rectangle(
      GAME_DIMENSIONS.CENTER_X,
      GAME_DIMENSIONS.CENTER_Y,
      GAME_DIMENSIONS.WIDTH,
      GAME_DIMENSIONS.HEIGHT,
      0x000000,
      0.85
    );
    this.backgroundBlocker.setDepth(4000);

    // Main container for all UI elements
    this.mainContainer = this.scene.add.container(
      GAME_DIMENSIONS.CENTER_X,
      GAME_DIMENSIONS.CENTER_Y
    );
    this.mainContainer.setDepth(4001);

    // Create UI elements
    this.titleText = this.createTitle();
    this.roundText = this.createRoundText();

    // Create cards
    this.createCards();

    // Start the reveal sequence
    this.startRevealSequence();

    // Play sound
    this.playSFX("sfx_click");
  }

  // ===========================================================================
  // HELPER
  // ===========================================================================

  private playSFX(key: string): void {
    if (this.scene.game.sound.locked) return;
    try {
      if (this.scene.cache.audio.exists(key)) {
        this.scene.sound.play(key, { volume: 0.5 });
      }
    } catch (e) {
      console.warn(`Failed to play SFX: ${key}`, e);
    }
  }

  // ===========================================================================
  // UI CREATION
  // ===========================================================================

  private createTitle(): Phaser.GameObjects.Text {
    const text = this.scene.add.text(0, -220, "⚡ POWER SURGE ⚡", {
      fontFamily: "monospace",
      fontSize: "40px",
      color: "#40e0d0",
      fontStyle: "bold",
      stroke: "#000000",
      strokeThickness: 4,
    });
    text.setOrigin(0.5);
    text.setAlpha(0);
    this.mainContainer.add(text);

    return text;
  }

  private createRoundText(): Phaser.GameObjects.Text {
    const text = this.scene.add.text(0, -175, `Round ${this.config.roundNumber}`, {
      fontFamily: "monospace",
      fontSize: "18px",
      color: "#9ca3af",
    });
    text.setOrigin(0.5);
    text.setAlpha(0);
    this.mainContainer.add(text);

    return text;
  }

  private createCards(): void {
    const cards = this.config.cardIds.map((id) => getPowerSurgeCard(id)!).filter(Boolean);
    const totalWidth = cards.length * CARD_WIDTH + (cards.length - 1) * CARD_SPACING;
    const startX = -totalWidth / 2 + CARD_WIDTH / 2;

    cards.forEach((card, index) => {
      const x = startX + index * (CARD_WIDTH + CARD_SPACING);
      const y = 20;

      const container = this.createSingleCard(card, x, y, index);

      const isP1Selection = card.id === this.config.player1Selection;
      const isP2Selection = card.id === this.config.player2Selection;

      this.cardDisplays.push({
        container,
        card,
        index,
        isPlayer1Selection: isP1Selection,
        isPlayer2Selection: isP2Selection,
      });
    });
  }

  private createSingleCard(
    card: PowerSurgeCard,
    x: number,
    y: number,
    index: number
  ): Phaser.GameObjects.Container {
    const container = this.scene.add.container(x, y);
    container.setScale(0); // Start hidden for animation
    container.setAlpha(0);
    container.setData("cardId", card.id);
    container.setData("index", index);

    // Card background (image from public/cards)
    if (this.scene.textures.exists(card.iconKey)) {
      const cardImage = this.scene.add.image(0, 0, card.iconKey);
      cardImage.setDisplaySize(CARD_WIDTH, CARD_HEIGHT);
      cardImage.setOrigin(0.5, 0.5);
      container.add(cardImage);

      // Dark overlay for bottom half to make text readable
      const textOverlay = this.scene.add.graphics();
      textOverlay.fillGradientStyle(0x000000, 0x000000, 0x000000, 0x000000, 0, 0, 0.9, 0.9);
      textOverlay.fillRect(-CARD_WIDTH / 2, 0, CARD_WIDTH, CARD_HEIGHT / 2);
      container.add(textOverlay);
    } else {
      // Fallback to glassmorphic background
      const bg = this.scene.add.graphics();
      this.drawCardBackground(bg, card);
      container.add(bg);
    }

    // Border
    const border = this.scene.add.graphics();
    border.lineStyle(3, card.glowColor, 0.8);
    border.strokeRoundedRect(-CARD_WIDTH / 2, -CARD_HEIGHT / 2, CARD_WIDTH, CARD_HEIGHT, 12);
    container.add(border);

    // Card title
    const title = this.scene.add.text(0, 10, card.name, {
      fontFamily: "monospace",
      fontSize: "18px",
      color: "#ffffff",
      fontStyle: "bold",
      align: "center",
      stroke: "#000000",
      strokeThickness: 3,
      wordWrap: { width: CARD_WIDTH - 20 },
    });
    title.setOrigin(0.5);
    container.add(title);

    // Effect description
    const description = this.scene.add.text(0, 45, card.description, {
      fontFamily: "monospace",
      fontSize: "13px",
      color: "#e2e8f0",
      align: "center",
      stroke: "#000000",
      strokeThickness: 2,
      wordWrap: { width: CARD_WIDTH - 30 },
    });
    description.setOrigin(0.5);
    container.add(description);

    this.mainContainer.add(container);

    return container;
  }

  private drawCardBackground(graphics: Phaser.GameObjects.Graphics, card: PowerSurgeCard): void {
    // Glassmorphic background
    graphics.fillStyle(0x1a1a2e, 0.95);
    graphics.fillRoundedRect(-CARD_WIDTH / 2, -CARD_HEIGHT / 2, CARD_WIDTH, CARD_HEIGHT, 12);

    // Subtle gradient overlay
    graphics.fillStyle(card.glowColor, 0.15);
    graphics.fillRoundedRect(-CARD_WIDTH / 2, -CARD_HEIGHT / 2, CARD_WIDTH, CARD_HEIGHT / 3, { tl: 12, tr: 12, bl: 0, br: 0 });
  }

  // ===========================================================================
  // REVEAL SEQUENCE
  // ===========================================================================

  private startRevealSequence(): void {
    // Step 1: Fade in title
    this.scene.tweens.add({
      targets: [this.titleText, this.roundText],
      alpha: 1,
      duration: 300,
      ease: "Power2",
    });

    // Pulsing title effect
    this.scene.tweens.add({
      targets: this.titleText,
      alpha: { from: 1, to: 0.7 },
      duration: 500,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });

    // Step 2: Fan in cards with stagger
    this.cardDisplays.forEach((display, index) => {
      this.scene.tweens.add({
        targets: display.container,
        scale: 1,
        alpha: 1,
        duration: CARD_ENTRY_DURATION,
        delay: 200 + index * CARD_ENTRY_STAGGER,
        ease: "Back.easeOut",
      });
    });

    // Step 3: After cards are shown, highlight selections
    const totalCardEntryTime = 200 + (this.cardDisplays.length - 1) * CARD_ENTRY_STAGGER + CARD_ENTRY_DURATION;

    this.scene.time.delayedCall(totalCardEntryTime + SELECTION_REVEAL_DELAY, () => {
      if (this.isDestroyed) return;
      this.revealSelections();
    });
  }

  private revealSelections(): void {
    // Play reveal sound
    this.playSFX("sfx_click");

    // Show selection labels
    this.showSelectionLabels();

    // Add glow effect to selected cards
    this.cardDisplays.forEach((display) => {
      if (display.isPlayer1Selection || display.isPlayer2Selection) {
        this.addSelectionGlow(display);
      } else {
        // Dim non-selected cards
        this.scene.tweens.add({
          targets: display.container,
          alpha: 0.4,
          duration: SELECTION_HIGHLIGHT_DURATION,
          ease: "Power2",
        });
      }
    });

    // Step 4: After highlight, spawn mini cards and move them to character heads
    this.scene.time.delayedCall(SELECTION_HIGHLIGHT_DURATION + 400, () => {
      if (this.isDestroyed) return;
      this.spawnMiniCardsAndMove();
    });
  }

  private showSelectionLabels(): void {
    this.cardDisplays.forEach((display) => {
      if (display.isPlayer1Selection && display.isPlayer2Selection) {
        // Both players selected the same card
        const label = this.scene.add.text(0, CARD_HEIGHT / 2 + 20, "BOTH SELECTED", {
          fontFamily: "monospace",
          fontSize: "14px",
          color: "#ffd700",
          fontStyle: "bold",
          stroke: "#000000",
          strokeThickness: 2,
        });
        label.setOrigin(0.5);
        display.container.add(label);

        // Animate label in
        label.setAlpha(0);
        label.setScale(0.5);
        this.scene.tweens.add({
          targets: label,
          alpha: 1,
          scale: 1,
          duration: 300,
          ease: "Back.easeOut",
        });
      } else if (display.isPlayer1Selection) {
        const label = this.scene.add.text(0, CARD_HEIGHT / 2 + 20, this.player1Label, {
          fontFamily: "monospace",
          fontSize: "14px",
          color: "#ff6b35",
          fontStyle: "bold",
          stroke: "#000000",
          strokeThickness: 2,
        });
        label.setOrigin(0.5);
        display.container.add(label);

        label.setAlpha(0);
        label.setScale(0.5);
        this.scene.tweens.add({
          targets: label,
          alpha: 1,
          scale: 1,
          duration: 300,
          ease: "Back.easeOut",
        });
      } else if (display.isPlayer2Selection) {
        const label = this.scene.add.text(0, CARD_HEIGHT / 2 + 20, this.player2Label, {
          fontFamily: "monospace",
          fontSize: "14px",
          color: "#40e0d0",
          fontStyle: "bold",
          stroke: "#000000",
          strokeThickness: 2,
        });
        label.setOrigin(0.5);
        display.container.add(label);

        label.setAlpha(0);
        label.setScale(0.5);
        this.scene.tweens.add({
          targets: label,
          alpha: 1,
          scale: 1,
          duration: 300,
          ease: "Back.easeOut",
        });
      }
    });
  }

  private addSelectionGlow(display: CardDisplay): void {
    // Create pulsing glow border
    const glowColor = display.card.glowColor;

    // Scale up slightly
    this.scene.tweens.add({
      targets: display.container,
      scale: 1.1,
      duration: SELECTION_HIGHLIGHT_DURATION,
      ease: "Power2",
    });

    // Add outer glow effect
    const glow = this.scene.add.graphics();
    glow.lineStyle(6, glowColor, 0.8);
    glow.strokeRoundedRect(-CARD_WIDTH / 2 - 4, -CARD_HEIGHT / 2 - 4, CARD_WIDTH + 8, CARD_HEIGHT + 8, 14);
    display.container.addAt(glow, 0); // Add behind other elements

    // Pulsing animation
    this.scene.tweens.add({
      targets: glow,
      alpha: { from: 0.8, to: 0.4 },
      duration: 400,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });
  }

  private spawnMiniCardsAndMove(): void {
    // Create mini cards for each player's selection
    const p1Card = getPowerSurgeCard(this.config.player1Selection);
    const p2Card = getPowerSurgeCard(this.config.player2Selection);

    if (p1Card) {
      this.player1MiniCard = this.createMiniCard(p1Card, this.player1Label);
      // Start from center, move to player 1 position
      this.player1MiniCard.setPosition(GAME_DIMENSIONS.CENTER_X, GAME_DIMENSIONS.CENTER_Y - 50);
      this.player1MiniCard.setScale(0);
      this.player1MiniCard.setDepth(4002);

      this.scene.tweens.add({
        targets: this.player1MiniCard,
        x: CHARACTER_POSITIONS.PLAYER1.X,
        y: this.config.player1SpriteY - 180,
        scale: 1,
        duration: MINI_CARD_MOVE_DURATION,
        ease: "Power2.easeOut",
        onComplete: () => {
          // Apply visual effect to sprite when mini card arrives
          if (this.config.player1Sprite && p1Card) {
            this.applySurgeVisualEffect(this.config.player1Sprite, p1Card.glowColor);
          }
        },
      });
    }

    if (p2Card) {
      this.player2MiniCard = this.createMiniCard(p2Card, this.player2Label);
      // Start from center, move to player 2 position
      this.player2MiniCard.setPosition(GAME_DIMENSIONS.CENTER_X, GAME_DIMENSIONS.CENTER_Y - 50);
      this.player2MiniCard.setScale(0);
      this.player2MiniCard.setDepth(4002);

      this.scene.tweens.add({
        targets: this.player2MiniCard,
        x: CHARACTER_POSITIONS.PLAYER2.X,
        y: this.config.player2SpriteY - 180,
        scale: 1,
        duration: MINI_CARD_MOVE_DURATION,
        ease: "Power2.easeOut",
        onComplete: () => {
          // Apply visual effect to sprite when mini card arrives
          if (this.config.player2Sprite && p2Card) {
            this.applySurgeVisualEffect(this.config.player2Sprite, p2Card.glowColor);
          }
        },
      });
    }

    // Fade out the main card display
    this.scene.time.delayedCall(MINI_CARD_MOVE_DURATION / 2, () => {
      if (this.isDestroyed) return;

      this.scene.tweens.add({
        targets: [this.backgroundBlocker, this.mainContainer],
        alpha: 0,
        duration: FADE_OUT_DURATION,
        ease: "Power2",
      });
    });

    // Step 5: Hold display, then complete
    this.scene.time.delayedCall(
      MINI_CARD_MOVE_DURATION + DISPLAY_HOLD_DURATION,
      () => {
        if (this.isDestroyed) return;
        this.complete();
      }
    );
  }

  // ===========================================================================
  // SURGE VISUAL EFFECTS (matching FightScene)
  // ===========================================================================

  private applySurgeVisualEffect(sprite: Phaser.GameObjects.Sprite, tintColor: number): void {
    // Flash effect
    this.scene.tweens.add({
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
      const particle = this.scene.add.graphics();
      particle.fillStyle(color, 1);
      particle.fillCircle(0, 0, 3 + Math.random() * 3);
      particle.setPosition(x, y);
      particle.setDepth(500);

      const angle = Math.random() * Math.PI * 2;
      const speed = 50 + Math.random() * 100;
      const targetX = x + Math.cos(angle) * speed;
      const targetY = y + Math.sin(angle) * speed - 50; // Upward bias

      this.scene.tweens.add({
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

  private createMiniCard(card: PowerSurgeCard, label: string): Phaser.GameObjects.Container {
    // Use PowerSurgeCardView for unified design (matches selection phase)
    // Scale: 140 / 200 = 0.7
    const container = PowerSurgeCardView.create({
      scene: this.scene,
      card,
      x: 0,
      y: 0,
      scale: 0.7
    });

    // Add Player label above card
    // Note: PowerSurgeCardView is 200x300 at scale 1.
    // At scale 0.7, visual height is ~210.
    // View centers content at 0,0.
    const labelColor = label === this.player1Label ? "#ff6b35" : "#40e0d0";
    const labelText = this.scene.add.text(0, -PowerSurgeCardView.CARD_HEIGHT / 2 - 20, label, {
      fontFamily: "monospace",
      fontSize: "20px",
      color: labelColor,
      fontStyle: "bold",
      stroke: "#000000",
      strokeThickness: 4,
    });
    labelText.setOrigin(0.5);
    container.add(labelText);

    return container;
  }

  // ===========================================================================
  // CLEANUP
  // ===========================================================================

  private complete(): void {
    // Fade out mini cards
    if (this.player1MiniCard) {
      this.scene.tweens.add({
        targets: this.player1MiniCard,
        alpha: 0,
        y: (this.player1MiniCard.y as number) - 30,
        duration: FADE_OUT_DURATION,
        ease: "Power2",
        onComplete: () => {
          if (this.player1MiniCard) {
            this.player1MiniCard.destroy();
            this.player1MiniCard = null;
          }
        },
      });
    }

    if (this.player2MiniCard) {
      this.scene.tweens.add({
        targets: this.player2MiniCard,
        alpha: 0,
        y: (this.player2MiniCard.y as number) - 30,
        duration: FADE_OUT_DURATION,
        ease: "Power2",
        onComplete: () => {
          if (this.player2MiniCard) {
            this.player2MiniCard.destroy();
            this.player2MiniCard = null;
          }
        },
      });
    }

    // Call completion callback after fade
    this.scene.time.delayedCall(FADE_OUT_DURATION + 100, () => {
      this.destroy();
      this.config.onComplete();
    });
  }

  /**
   * Get the mini card containers (for scenes that want to keep them visible during combat)
   */
  public getMiniCards(): { player1: Phaser.GameObjects.Container | null; player2: Phaser.GameObjects.Container | null } {
    return {
      player1: this.player1MiniCard,
      player2: this.player2MiniCard,
    };
  }

  /**
   * Destroy and clean up all resources
   */
  public destroy(): void {
    if (this.isDestroyed) return;
    this.isDestroyed = true;

    // Clean up tweens
    this.scene.tweens.killTweensOf(this.titleText);
    this.scene.tweens.killTweensOf(this.roundText);
    this.cardDisplays.forEach((display) => {
      this.scene.tweens.killTweensOf(display.container);
    });

    // Destroy containers
    this.mainContainer.destroy();
    this.backgroundBlocker.destroy();

    if (this.player1MiniCard) {
      this.player1MiniCard.destroy();
      this.player1MiniCard = null;
    }
    if (this.player2MiniCard) {
      this.player2MiniCard.destroy();
      this.player2MiniCard = null;
    }
  }
}
