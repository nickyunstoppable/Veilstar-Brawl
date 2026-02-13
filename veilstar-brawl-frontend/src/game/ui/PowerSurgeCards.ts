/**
 * PowerSurgeCards - Phaser UI Component
 * Displays 3 holographic neon cards for player to choose at round start.
 * 
 * Visual Design:
 * - Glassmorphic background with blur effect
 * - Pulsing neon borders based on rarity
 * - Central icon, title, effect text
 * - Tiny DAG graph decoration at bottom
 * - Center card slightly larger
 * - Staggered entry animation
 * 
 * Interaction:
 * - Cards fan out from center
 * - Hover: card lifts and glows brighter
 * - Click: triggers wallet transaction
 * - Timer: 7 seconds with red pulse warning
 */

import Phaser from "phaser";
import { EventBus } from "../EventBus";
import { GAME_DIMENSIONS } from "../config";
import type {
  PowerSurgeCard,
  PowerSurgeCardId,
} from "@/types/power-surge";
import {
  POWER_SURGE_CARDS,
  getPowerSurgeCard,
} from "@/types/power-surge";

// =============================================================================
// CONSTANTS
// =============================================================================

const CARD_WIDTH = 200;
const CARD_HEIGHT = 300;
const CARD_SPACING = 40;
const CENTER_CARD_SCALE = 1.1;
const SELECTION_TIMEOUT_MS = 15000;
const WARNING_TIME_MS = 2000; // Start warning at 2 seconds remaining

// =============================================================================
// TYPES
// =============================================================================

export interface PowerSurgeCardsConfig {
  scene: Phaser.Scene;
  matchId: string;
  roundNumber: number;
  cardIds: PowerSurgeCardId[];
  playerAddress: string;
  deadline: number;
  waitForOpponent?: boolean;
  onCardSelected: (cardId: PowerSurgeCardId) => Promise<void>;
  onTimeout: () => void;
  onClose: () => void;
}

interface CardContainer {
  container: Phaser.GameObjects.Container;
  card: PowerSurgeCard;
  isHovered: boolean;
  originalX: number;
  originalY: number;
}

// =============================================================================
// POWER SURGE CARDS UI
// =============================================================================

export class PowerSurgeCards {
  private scene: Phaser.Scene;
  private config: PowerSurgeCardsConfig;
  private mainContainer: Phaser.GameObjects.Container;
  private backgroundBlocker: Phaser.GameObjects.Rectangle;
  private cardContainers: CardContainer[] = [];
  private timerText: Phaser.GameObjects.Text;
  private timerBar: Phaser.GameObjects.Graphics;
  private titleText: Phaser.GameObjects.Text;
  private instructionText: Phaser.GameObjects.Text;
  private timerEvent?: Phaser.Time.TimerEvent;
  private isSelecting: boolean = false;
  private selectedCardId: PowerSurgeCardId | null = null;
  private isDestroyed: boolean = false;
  private opponentReadyIndicator: Phaser.GameObjects.Container | null = null;

  constructor(config: PowerSurgeCardsConfig) {
    this.scene = config.scene;
    this.config = config;

    // Create semi-transparent background blocker
    this.backgroundBlocker = this.scene.add.rectangle(
      GAME_DIMENSIONS.CENTER_X,
      GAME_DIMENSIONS.CENTER_Y,
      GAME_DIMENSIONS.WIDTH,
      GAME_DIMENSIONS.HEIGHT,
      0x000000,
      0.85
    );
    this.backgroundBlocker.setInteractive(); // Block clicks through
    this.backgroundBlocker.setDepth(4000);

    // Main container for all UI elements
    this.mainContainer = this.scene.add.container(
      GAME_DIMENSIONS.CENTER_X,
      GAME_DIMENSIONS.CENTER_Y
    );
    this.mainContainer.setDepth(4001);

    // Create UI elements
    this.titleText = this.createTitle();
    this.instructionText = this.createInstruction();
    this.timerText = this.createTimerText();
    this.timerBar = this.createTimerBar();

    // Create cards
    this.createCards();

    // Start animations
    this.animateEntry();

    // Start countdown timer
    this.startTimer();

    // Play sound
    this.playSFX("sfx_whoosh");
  }

  // ===========================================================================
  // UI CREATION
  // ===========================================================================

  private createTitle(): Phaser.GameObjects.Text {
    const text = this.scene.add.text(0, -280, "⚡ POWER SURGE ⚡", {
      fontFamily: "monospace",
      fontSize: "36px",
      color: "#40e0d0",
      fontStyle: "bold",
      stroke: "#000000",
      strokeThickness: 4,
    });
    text.setOrigin(0.5);
    this.mainContainer.add(text);

    // Pulsing glow effect
    this.scene.tweens.add({
      targets: text,
      alpha: { from: 1, to: 0.7 },
      duration: 500,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });

    return text;
  }

  private createInstruction(): Phaser.GameObjects.Text {
    const text = this.scene.add.text(0, -240, "Choose a boost for this round!", {
      fontFamily: "monospace",
      fontSize: "16px",
      color: "#9ca3af",
    });
    text.setOrigin(0.5);
    this.mainContainer.add(text);
    return text;
  }

  private createTimerText(): Phaser.GameObjects.Text {
    const remainingSeconds = Math.ceil((this.config.deadline - Date.now()) / 1000);
    const text = this.scene.add.text(0, 260, `${remainingSeconds}s`, {
      fontFamily: "monospace",
      fontSize: "32px",
      color: "#40e0d0",
      fontStyle: "bold",
    });
    text.setOrigin(0.5);
    this.mainContainer.add(text);
    return text;
  }

  private createTimerBar(): Phaser.GameObjects.Graphics {
    const graphics = this.scene.add.graphics();
    this.mainContainer.add(graphics);
    // Must assign to this.timerBar before calling updateTimerBar
    this.timerBar = graphics;
    this.updateTimerBar(1);
    return graphics;
  }

  private updateTimerBar(progress: number): void {
    const barWidth = 300;
    const barHeight = 8;
    const y = 290;

    this.timerBar.clear();

    // Background
    this.timerBar.fillStyle(0x333333, 1);
    this.timerBar.fillRoundedRect(-barWidth / 2, y, barWidth, barHeight, 4);

    // Progress fill
    const progressWidth = barWidth * progress;
    const color = progress > 0.3 ? 0x40e0d0 : 0xff4444;
    this.timerBar.fillStyle(color, 1);
    this.timerBar.fillRoundedRect(-barWidth / 2, y, progressWidth, barHeight, 4);
  }

  private createCards(): void {
    const cards = this.config.cardIds.map((id) => getPowerSurgeCard(id)!).filter(Boolean);
    const totalWidth = cards.length * CARD_WIDTH + (cards.length - 1) * CARD_SPACING;
    const startX = -totalWidth / 2 + CARD_WIDTH / 2;

    cards.forEach((card, index) => {
      const x = startX + index * (CARD_WIDTH + CARD_SPACING);
      const y = 40; // Center vertical position
      const isCenter = index === Math.floor(cards.length / 2);
      const scale = isCenter ? CENTER_CARD_SCALE : 1;

      const container = this.createSingleCard(card, x, y, scale, index);
      this.cardContainers.push({
        container,
        card,
        isHovered: false,
        originalX: x,
        originalY: y,
      });
    });
  }

  private createSingleCard(
    card: PowerSurgeCard,
    x: number,
    y: number,
    scale: number,
    index: number
  ): Phaser.GameObjects.Container {
    const container = this.scene.add.container(x, y);
    container.setScale(0); // Start hidden for animation
    container.setData("cardId", card.id);
    container.setData("index", index);

    // Uniform style for all cards
    const cardStyle = {
      borderColor: card.glowColor,
      backgroundColor: 0x1a1a2e,
      glowIntensity: 1.0,
    };

    // Card background (image from public/cards)
    console.log(`[PowerSurgeCards] Checking texture for card: ${card.id}, iconKey: ${card.iconKey}, exists: ${this.scene.textures.exists(card.iconKey)}`);

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
      console.warn(`[PowerSurgeCards] Texture not found for ${card.id}, using fallback background`);
      // Fallback to glassmorphic background if image doesn't exist
      const bg = this.scene.add.graphics();
      this.drawCardBackground(bg, card, cardStyle);
      container.add(bg);
    }

    // Neon border glow effect
    const glowBorder = this.scene.add.graphics();
    this.drawGlowBorder(glowBorder, card.glowColor, 1.0);
    container.add(glowBorder);

    // Remove legacy icon logic since we have full art now
    /*
    const iconBg = this.scene.add.graphics();
    iconBg.fillStyle(card.glowColor, 0.3);
    iconBg.fillRoundedRect(-40, -100, 80, 80, 12);
    container.add(iconBg);

    const iconText = this.scene.add.text(0, -60, this.getCardEmoji(card.id), {
      fontFamily: "monospace",
      fontSize: "40px",
    });
    iconText.setOrigin(0.5);
    container.add(iconText);
    */

    // Card title - make it pop more over the image
    const title = this.scene.add.text(0, 5, card.name, {
      fontFamily: "monospace",
      fontSize: "20px",
      color: "#ffffff",
      fontStyle: "bold",
      align: "center",
      stroke: "#000000",
      strokeThickness: 3,
      wordWrap: { width: CARD_WIDTH - 30 },
    });
    title.setOrigin(0.5);
    container.add(title);

    // Effect description
    const description = this.scene.add.text(0, 45, card.description, {
      fontFamily: "monospace",
      fontSize: "14px",
      color: "#e2e8f0",
      align: "center",
      stroke: "#000000",
      strokeThickness: 2,
      wordWrap: { width: CARD_WIDTH - 40 },
    });
    description.setOrigin(0.5);
    container.add(description);

    // DAG graph decoration at bottom (moved up slightly)
    this.drawDAGGraph(container, card.glowColor);

    // Interactive hit area
    const hitArea = this.scene.add.rectangle(0, 0, CARD_WIDTH, CARD_HEIGHT, 0x000000, 0);
    hitArea.setInteractive({ useHandCursor: true });
    container.add(hitArea);

    // Hover effects
    hitArea.on("pointerover", () => this.onCardHover(container, card, true));
    hitArea.on("pointerout", () => this.onCardHover(container, card, false));
    hitArea.on("pointerdown", () => this.onCardClick(card));

    this.mainContainer.add(container);

    // Pulsing border animation
    this.scene.tweens.add({
      targets: glowBorder,
      alpha: { from: 1, to: 0.5 },
      duration: 800 + index * 100,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });

    return container;
  }

  private drawCardBackground(
    graphics: Phaser.GameObjects.Graphics,
    card: PowerSurgeCard,
    style: { borderColor: number; backgroundColor: number; glowIntensity: number }
  ): void {
    // Dark glassmorphic background
    graphics.fillStyle(style.backgroundColor, 0.9);
    graphics.fillRoundedRect(
      -CARD_WIDTH / 2,
      -CARD_HEIGHT / 2,
      CARD_WIDTH,
      CARD_HEIGHT,
      16
    );

    // Inner gradient overlay
    graphics.fillGradientStyle(
      card.glowColor,
      card.glowColor,
      style.backgroundColor,
      style.backgroundColor,
      0.15,
      0.15,
      0,
      0
    );
    graphics.fillRoundedRect(
      -CARD_WIDTH / 2 + 4,
      -CARD_HEIGHT / 2 + 4,
      CARD_WIDTH - 8,
      CARD_HEIGHT - 8,
      14
    );
  }

  private drawGlowBorder(
    graphics: Phaser.GameObjects.Graphics,
    color: number,
    intensity: number
  ): void {
    // Outer blooming glow
    for (let i = 1; i <= 3; i++) {
      graphics.lineStyle(2 + i * 2, color, (0.15 / i) * intensity);
      graphics.strokeRoundedRect(
        -CARD_WIDTH / 2 - i,
        -CARD_HEIGHT / 2 - i,
        CARD_WIDTH + i * 2,
        CARD_HEIGHT + i * 2,
        16 + i
      );
    }

    // Main sharp neon border
    graphics.lineStyle(3, color, 1.0 * intensity);
    graphics.strokeRoundedRect(
      -CARD_WIDTH / 2,
      -CARD_HEIGHT / 2,
      CARD_WIDTH,
      CARD_HEIGHT,
      16
    );

    // High-tech corner accents
    const cornerSize = 25;
    graphics.lineStyle(4, 0xffffff, 0.5 * intensity);

    // Top Left
    graphics.beginPath();
    graphics.moveTo(-CARD_WIDTH / 2 + cornerSize, -CARD_HEIGHT / 2);
    graphics.lineTo(-CARD_WIDTH / 2, -CARD_HEIGHT / 2);
    graphics.lineTo(-CARD_WIDTH / 2, -CARD_HEIGHT / 2 + cornerSize);
    graphics.strokePath();

    // Bottom Right
    graphics.beginPath();
    graphics.moveTo(CARD_WIDTH / 2 - cornerSize, CARD_HEIGHT / 2);
    graphics.lineTo(CARD_WIDTH / 2, CARD_HEIGHT / 2);
    graphics.lineTo(CARD_WIDTH / 2, CARD_HEIGHT / 2 - cornerSize);
    graphics.strokePath();

    // Inner highlight
    graphics.lineStyle(1, 0xffffff, 0.2);
    graphics.strokeRoundedRect(
      -CARD_WIDTH / 2 + 2,
      -CARD_HEIGHT / 2 + 2,
      CARD_WIDTH - 4,
      CARD_HEIGHT - 4,
      14
    );
  }

  private drawDAGGraph(container: Phaser.GameObjects.Container, color: number): void {
    const graphics = this.scene.add.graphics();
    const baseY = CARD_HEIGHT / 2 - 25;

    // Circuitry-style DAG decoration
    graphics.lineStyle(1.5, color, 0.6);

    // Create a network of connected nodes
    const nodes = [
      { x: -60, y: baseY + 10 },
      { x: -30, y: baseY - 5 },
      { x: 0, y: baseY + 5 },
      { x: 30, y: baseY - 5 },
      { x: 60, y: baseY + 10 }
    ];

    // Draw lines
    graphics.beginPath();
    graphics.moveTo(nodes[0].x, nodes[0].y);
    for (let i = 1; i < nodes.length; i++) {
      graphics.lineTo(nodes[i].x, nodes[i].y);
    }
    graphics.strokePath();

    // Draw little square "blocks" at each node
    nodes.forEach(node => {
      graphics.fillStyle(color, 0.8);
      graphics.fillRect(node.x - 3, node.y - 3, 6, 6);

      // Add a small glow to each block
      graphics.lineStyle(1, 0xffffff, 0.5);
      graphics.strokeRect(node.x - 4, node.y - 4, 8, 8);
    });

    container.add(graphics);
  }

  private getCardEmoji(cardId: PowerSurgeCardId): string {
    const emojiMap: Record<string, string> = {
      "dag-overclock": "⚡",
      "block-fortress": "🏰",
      "tx-storm": "🌀",
      "mempool-congest": "🪫",
      "blue-set-heal": "💙",
      "orphan-smasher": "💥",
      "10bps-barrage": "🎯",
      "pruned-rage": "😤",
      "sompi-shield": "🛡️",
      "hash-hurricane": "🌪️",
      "ghost-dag": "👻",
      "finality-fist": "👊",
      "bps-blitz": "⚡",
      "vaultbreaker": "🔓",
      "chainbreaker": "⛓️",
    };
    return emojiMap[cardId] || "⚡";
  }

  // ===========================================================================
  // ANIMATIONS
  // ===========================================================================

  private animateEntry(): void {
    // Staggered card entry animation
    this.cardContainers.forEach((cc, index) => {
      const delay = 100 + index * 150;
      const isCenter = index === Math.floor(this.cardContainers.length / 2);
      const targetScale = isCenter ? CENTER_CARD_SCALE : 1;

      // Start from bottom and scale up
      cc.container.setY(cc.originalY + 100);

      this.scene.tweens.add({
        targets: cc.container,
        y: cc.originalY,
        scaleX: targetScale,
        scaleY: targetScale,
        duration: 500,
        delay,
        ease: "Back.easeOut",
      });
    });

    // Title slide in
    this.titleText.setY(-350);
    this.scene.tweens.add({
      targets: this.titleText,
      y: -280,
      duration: 600,
      ease: "Back.easeOut",
    });
  }

  private onCardHover(
    container: Phaser.GameObjects.Container,
    card: PowerSurgeCard,
    isHover: boolean
  ): void {
    if (this.isSelecting || this.isDestroyed) return;

    const cc = this.cardContainers.find((c) => c.container === container);
    if (!cc) return;

    cc.isHovered = isHover;

    if (isHover) {
      // Hover: lift card and glow brighter
      this.playSFX("sfx_hover");
      this.scene.tweens.add({
        targets: container,
        y: cc.originalY - 30,
        scaleX: container.scaleX * 1.08,
        scaleY: container.scaleY * 1.08,
        duration: 200,
        ease: "Back.easeOut",
      });
    } else {
      // Unhover: return to original
      const index = container.getData("index");
      const isCenter = index === Math.floor(this.cardContainers.length / 2);
      const targetScale = isCenter ? CENTER_CARD_SCALE : 1;

      this.scene.tweens.add({
        targets: container,
        y: cc.originalY,
        scaleX: targetScale,
        scaleY: targetScale,
        duration: 200,
        ease: "Quad.easeOut",
      });
    }
  }

  private async onCardClick(card: PowerSurgeCard): Promise<void> {
    if (this.isSelecting || this.isDestroyed) return;

    this.isSelecting = true;
    this.selectedCardId = card.id;

    // Play click sound
    this.playSFX("sfx_click");

    // Visual feedback - highlight selected card
    const selectedCC = this.cardContainers.find((cc) => cc.card.id === card.id);
    if (selectedCC) {
      // Pulse effect on selected card
      this.scene.tweens.add({
        targets: selectedCC.container,
        scaleX: selectedCC.container.scaleX * 1.15,
        scaleY: selectedCC.container.scaleY * 1.15,
        duration: 200,
        yoyo: true,
        repeat: 1,
      });
    }

    // Dim other cards
    this.cardContainers.forEach((cc) => {
      if (cc.card.id !== card.id) {
        this.scene.tweens.add({
          targets: cc.container,
          alpha: 0.3,
          duration: 200,
        });
      }
    });

    // Update instruction text
    this.instructionText.setText("Inscribing on blockchain...");
    this.instructionText.setColor("#f97316");

    try {
      // Call the selection handler (triggers wallet transaction)
      await this.config.onCardSelected(card.id);

      // Success! Show confirmation
      this.showConfirmation(card);
    } catch (error) {
      console.error("[PowerSurgeCards] Selection failed:", error);
      this.instructionText.setText("Selection failed. Try again!");
      this.instructionText.setColor("#ef4444");

      // Reset state to allow retry
      this.isSelecting = false;
      this.selectedCardId = null;

      // Restore card visibility
      this.cardContainers.forEach((cc) => {
        this.scene.tweens.add({
          targets: cc.container,
          alpha: 1,
          duration: 200,
        });
      });
    }
  }

  private showConfirmation(card: PowerSurgeCard): void {
    // Update text
    this.instructionText.setText("BLOCK CONFIRMED!");
    this.instructionText.setColor("#22c55e");
    this.instructionText.setFontSize(20);

    // Flash effect
    const flash = this.scene.add.rectangle(
      0,
      0,
      GAME_DIMENSIONS.WIDTH,
      GAME_DIMENSIONS.HEIGHT,
      card.glowColor,
      0.3
    );
    this.mainContainer.add(flash);

    this.scene.tweens.add({
      targets: flash,
      alpha: 0,
      duration: 500,
      onComplete: () => flash.destroy(),
    });

    // Particle explosion from selected card
    const selectedCC = this.cardContainers.find((cc) => cc.card.id === card.id);
    if (selectedCC) {
      this.createParticleExplosion(selectedCC.container.x, selectedCC.container.y, card.glowColor);
    }

    // Play confirmation sound
    this.playSFX("sfx_powerup");

    if (this.config.waitForOpponent === false) {
      this.instructionText.setText("Phase 1 complete!");
      this.instructionText.setColor("#22c55e");
      this.scene.time.delayedCall(500, () => {
        if (!this.isDestroyed) {
          this.animateExit();
        }
      });
      return;
    }

    // Wait for opponent to also complete their selection
    this.waitForBothPlayersReady();
  }

  private createParticleExplosion(x: number, y: number, color: number): void {
    // Create multiple particles
    for (let i = 0; i < 20; i++) {
      const particle = this.scene.add.graphics();
      particle.fillStyle(color, 1);
      particle.fillCircle(0, 0, 4 + Math.random() * 4);
      particle.setPosition(x, y);
      this.mainContainer.add(particle);

      // Random direction
      const angle = Math.random() * Math.PI * 2;
      const speed = 100 + Math.random() * 200;
      const targetX = x + Math.cos(angle) * speed;
      const targetY = y + Math.sin(angle) * speed;

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

  /**
   * Wait for both players to complete their selections before closing.
   * Polls the database every 500ms to check if both cards are selected.
   * Also handles the case where opponent times out (doesn't pick a card).
   */
  private async waitForBothPlayersReady(): Promise<void> {
    this.instructionText.setText("Waiting for opponent...");
    this.instructionText.setColor("#fbbf24");

    // Poll database to check if both players selected
    const checkBothReady = async (): Promise<boolean> => {
      try {
        const { getSupabaseClient } = await import("@/lib/supabase/client");
        const supabase = getSupabaseClient();

          const { data: surge, error } = await supabase
          .from("power_surges")
          .select("player1_card_id, player2_card_id")
          .eq("match_id", this.config.matchId)
          .eq("round_number", this.config.roundNumber)
          .maybeSingle();

        if (error) {
          console.error("[PowerSurgeCards] Error checking both ready:", error);
          return false;
        }

        if (!surge) {
          return false;
        }

        const surgeRow = surge as any;
        return !!(surgeRow?.player1_card_id && surgeRow?.player2_card_id);
      } catch (error) {
        console.error("[PowerSurgeCards] Exception checking both ready:", error);
        return false;
      }
    };

    // Poll every 500ms until both ready
    const pollInterval = 500;
    const maxWaitTime = 20000; // 20 seconds max
    const startTime = Date.now();
    // Grace period after deadline for opponent selection to propagate
    const deadlineGracePeriod = 2000; // 2 seconds after deadline

    const poll = async () => {
      if (this.isDestroyed) return;

      const bothReady = await checkBothReady();

      if (bothReady) {
        console.log("[PowerSurgeCards] Both players ready, closing UI");
        this.instructionText.setText("Both players ready!");
        this.instructionText.setColor("#22c55e");

        // Close after brief delay
        this.scene.time.delayedCall(800, () => {
          if (!this.isDestroyed) {
            this.animateExit();
          }
        });
        return;
      }

      // Check if deadline has passed with grace period - opponent likely timed out
      const now = Date.now();
      if (now > this.config.deadline + deadlineGracePeriod) {
        console.log("[PowerSurgeCards] Deadline passed + grace period, opponent likely timed out. Closing UI.");
        this.instructionText.setText("Opponent skipped - continuing!");
        this.instructionText.setColor("#f97316");

        // Close after brief delay
        this.scene.time.delayedCall(800, () => {
          if (!this.isDestroyed) {
            this.animateExit();
          }
        });
        return;
      }

      // Check absolute timeout (failsafe)
      if (now - startTime > maxWaitTime) {
        console.log("[PowerSurgeCards] Wait timeout, closing anyway");
        this.animateExit();
        return;
      }

      // Continue polling
      this.scene.time.delayedCall(pollInterval, poll);
    };

    poll();
  }

  // ===========================================================================
  // TIMER
  // ===========================================================================

  private startTimer(): void {
    const updateTimer = () => {
      if (this.isDestroyed) return;

      const now = Date.now();
      const remaining = Math.max(0, this.config.deadline - now);
      const progress = remaining / SELECTION_TIMEOUT_MS;
      const seconds = Math.ceil(remaining / 1000);

      // Update text
      this.timerText.setText(`${seconds}s`);

      // Update bar
      this.updateTimerBar(progress);

      // Warning state
      if (remaining <= WARNING_TIME_MS && remaining > 0) {
        this.timerText.setColor("#ff4444");
        // Pulse effect
        if (!this.timerText.getData("isPulsing")) {
          this.timerText.setData("isPulsing", true);
          this.scene.tweens.add({
            targets: this.timerText,
            scaleX: 1.2,
            scaleY: 1.2,
            duration: 200,
            yoyo: true,
            repeat: -1,
          });
        }
      }

      // Timeout
      if (remaining <= 0 && !this.isSelecting) {
        this.handleTimeout();
        return;
      }

      // Continue updating
      if (remaining > 0) {
        this.timerEvent = this.scene.time.delayedCall(100, updateTimer);
      }
    };

    updateTimer();
  }

  private handleTimeout(): void {
    if (this.isDestroyed) return;

    this.instructionText.setText("Time's up! No boost selected.");
    this.instructionText.setColor("#ef4444");

    // Flash red
    this.cardContainers.forEach((cc) => {
      this.scene.tweens.add({
        targets: cc.container,
        alpha: 0.2,
        duration: 300,
      });
    });

    this.playSFX("sfx_error");

    // Callback and close
    this.config.onTimeout();

    this.scene.time.delayedCall(1000, () => {
      if (!this.isDestroyed) {
        this.animateExit();
      }
    });
  }

  // ===========================================================================
  // EXIT
  // ===========================================================================

  private animateExit(): void {
    // Fade out cards
    this.cardContainers.forEach((cc, index) => {
      this.scene.tweens.add({
        targets: cc.container,
        y: cc.originalY + 100,
        alpha: 0,
        scaleX: 0.5,
        scaleY: 0.5,
        duration: 300,
        delay: index * 50,
        ease: "Quad.easeIn",
      });
    });

    // Fade out everything else
    this.scene.tweens.add({
      targets: [this.titleText, this.instructionText, this.timerText, this.timerBar],
      alpha: 0,
      duration: 300,
    });

    this.scene.tweens.add({
      targets: this.backgroundBlocker,
      alpha: 0,
      duration: 400,
      onComplete: () => {
        this.destroy();
      },
    });
  }

  // ===========================================================================
  // UTILITIES
  // ===========================================================================

  private playSFX(key: string): void {
    if (this.scene.game.sound.locked) return;
    try {
      const hasRequested = this.scene.cache.audio.exists(key);
      const fallbackKey = "sfx_click";
      const hasFallback = this.scene.cache.audio.exists(fallbackKey);

      if (hasRequested) {
        this.scene.sound.play(key, { volume: 0.5 });
        return;
      }

      if (key !== fallbackKey && hasFallback) {
        this.scene.sound.play(fallbackKey, { volume: 0.5 });
      }
    } catch (e) {
      console.warn(`Failed to play SFX: ${key}`, e);
    }
  }

  /**
   * Force close the UI immediately.
   */
  public forceClose(): void {
    this.destroy();
  }

  /**
   * Show/hide the "Opponent Ready" indicator.
   * Called when opponent selects their surge (identity stays hidden until reveal).
   */
  public showOpponentReady(ready: boolean): void {
    if (this.isDestroyed) return;

    if (ready && !this.opponentReadyIndicator) {
      // Create opponent ready indicator
      const container = this.scene.add.container(0, 280);

      // Glowing background
      const bg = this.scene.add.graphics();
      bg.fillStyle(0x22c55e, 0.2);
      bg.fillRoundedRect(-100, -15, 200, 30, 8);
      bg.lineStyle(2, 0x22c55e, 0.8);
      bg.strokeRoundedRect(-100, -15, 200, 30, 8);
      container.add(bg);

      // Text
      const text = this.scene.add.text(0, 0, "✓ Opponent Ready", {
        fontFamily: "monospace",
        fontSize: "14px",
        color: "#22c55e",
        fontStyle: "bold",
      });
      text.setOrigin(0.5);
      container.add(text);

      // Pulse animation
      this.scene.tweens.add({
        targets: container,
        alpha: { from: 1, to: 0.6 },
        duration: 600,
        yoyo: true,
        repeat: -1,
        ease: "Sine.easeInOut",
      });

      this.mainContainer.add(container);
      this.opponentReadyIndicator = container;

      // Play a subtle sound
      this.playSFX("sfx_click");
    } else if (!ready && this.opponentReadyIndicator) {
      this.opponentReadyIndicator.destroy();
      this.opponentReadyIndicator = null;
    }
  }

  /**
   * Refresh the displayed cards with a new set (used when opponent selects first).
   * This ensures both players are working with the same authoritative card set.
   */
  public refreshCards(newCardIds: PowerSurgeCardId[]): void {
    if (this.isDestroyed || this.isSelecting) return;

    console.log(`[PowerSurgeCards] Refreshing cards from:`, this.config.cardIds, `to:`, newCardIds);

    // Check if cards are actually different
    const currentIds = this.config.cardIds.sort().join(',');
    const newIds = newCardIds.sort().join(',');
    if (currentIds === newIds) {
      console.log(`[PowerSurgeCards] Cards unchanged, skipping refresh`);
      return;
    }

    // Update config
    this.config.cardIds = newCardIds;

    // Destroy old cards
    this.cardContainers.forEach((cc) => {
      cc.container.destroy();
    });
    this.cardContainers = [];

    // Recreate cards with new IDs
    this.createCards();

    // Reanimate entry
    this.cardContainers.forEach((cc, index) => {
      cc.container.setScale(0);
      this.scene.tweens.add({
        targets: cc.container,
        scale: index === Math.floor(this.cardContainers.length / 2) ? CENTER_CARD_SCALE : 1,
        duration: 400,
        delay: index * 100,
        ease: "Back.easeOut",
      });
    });

    // Update instruction text
    this.instructionText.setText("Cards updated! Choose your boost.");
    this.instructionText.setColor("#f97316");

    // Flash instruction text
    this.scene.tweens.add({
      targets: this.instructionText,
      alpha: { from: 0.5, to: 1 },
      duration: 200,
      yoyo: true,
      repeat: 2,
    });
  }

  /**
   * Get the selected card ID (null if none selected).
   */
  public getSelectedCard(): PowerSurgeCardId | null {
    return this.selectedCardId;
  }

  /**
   * Clean up all resources.
   */
  public destroy(): void {
    if (this.isDestroyed) return;
    this.isDestroyed = true;

    if (this.timerEvent) {
      this.timerEvent.remove();
    }

    this.cardContainers.forEach((cc) => {
      cc.container.destroy();
    });
    this.cardContainers = [];

    if (this.opponentReadyIndicator) {
      this.opponentReadyIndicator.destroy();
      this.opponentReadyIndicator = null;
    }

    this.mainContainer.destroy();
    this.backgroundBlocker.destroy();

    this.config.onClose();
  }
}
