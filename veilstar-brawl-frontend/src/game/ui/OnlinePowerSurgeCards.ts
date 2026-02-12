/**
 * OnlinePowerSurgeCards - Power Surge UI for online matches
 *
 * Shows 3 cards for the local player, allows selecting one before a deadline,
 * then displays waiting state until opponent selection is received.
 */

import Phaser from "phaser";
import { GAME_DIMENSIONS } from "@/game/config";
import type { PowerSurgeCard, PowerSurgeCardId } from "@/types/power-surge";
import { getPowerSurgeCard } from "@/types/power-surge";
import { PowerSurgeCardView } from "@/game/ui/PowerSurgeCardView";

const CARD_SPACING = 40;
const CENTER_CARD_SCALE = 1.08;
const WARNING_TIME_MS = 3000;

export interface OnlinePowerSurgeCardsConfig {
  scene: Phaser.Scene;
  roundNumber: number;
  cardIds: PowerSurgeCardId[];
  deadlineAt: number; // unix ms
  onCardSelected: (cardId: PowerSurgeCardId) => void;
  onTimeout: () => void;
  onClose: (playerSelection: PowerSurgeCardId | null) => void;
}

interface CardContainer {
  container: Phaser.GameObjects.Container;
  card: PowerSurgeCard;
  originalX: number;
  originalY: number;
}

export class OnlinePowerSurgeCards {
  private scene: Phaser.Scene;
  private config: OnlinePowerSurgeCardsConfig;

  private totalDurationMs: number;

  private blocker: Phaser.GameObjects.Rectangle;
  private main: Phaser.GameObjects.Container;

  private titleText: Phaser.GameObjects.Text;
  private subtitleText: Phaser.GameObjects.Text;
  private timerText: Phaser.GameObjects.Text;
  private timerBar: Phaser.GameObjects.Graphics;

  private cardContainers: CardContainer[] = [];

  private timerEvent?: Phaser.Time.TimerEvent;
  private isDestroyed = false;

  private playerSelection: PowerSurgeCardId | null = null;
  private opponentSelection: PowerSurgeCardId | null = null;

  constructor(config: OnlinePowerSurgeCardsConfig) {
    this.scene = config.scene;
    this.config = config;

    this.totalDurationMs = Math.max(1, this.config.deadlineAt - Date.now());

    this.blocker = this.scene.add.rectangle(
      GAME_DIMENSIONS.CENTER_X,
      GAME_DIMENSIONS.CENTER_Y,
      GAME_DIMENSIONS.WIDTH,
      GAME_DIMENSIONS.HEIGHT,
      0x000000,
      0.85
    );
    this.blocker.setInteractive();
    this.blocker.setDepth(4000);

    this.main = this.scene.add.container(GAME_DIMENSIONS.CENTER_X, GAME_DIMENSIONS.CENTER_Y);
    this.main.setDepth(4001);

    this.titleText = this.scene.add.text(0, -280, "⚡ POWER SURGE ⚡", {
      fontFamily: "monospace",
      fontSize: "36px",
      color: "#40e0d0",
      fontStyle: "bold",
      stroke: "#000000",
      strokeThickness: 4,
    }).setOrigin(0.5);
    this.main.add(this.titleText);

    this.subtitleText = this.scene.add.text(0, -240, "Choose a boost for this round!", {
      fontFamily: "monospace",
      fontSize: "16px",
      color: "#9ca3af",
    }).setOrigin(0.5);
    this.main.add(this.subtitleText);

    const remainingSeconds = Math.max(0, Math.ceil((this.config.deadlineAt - Date.now()) / 1000));
    this.timerText = this.scene.add.text(0, 260, `${remainingSeconds}s`, {
      fontFamily: "monospace",
      fontSize: "32px",
      color: "#40e0d0",
      fontStyle: "bold",
    }).setOrigin(0.5);
    this.main.add(this.timerText);

    this.timerBar = this.scene.add.graphics();
    this.main.add(this.timerBar);
    this.updateTimerBar(1);

    this.createCards();
    this.animateEntry();
    this.startTimer();
  }

  public destroy(): void {
    if (this.isDestroyed) return;
    this.isDestroyed = true;
    this.timerEvent?.destroy();
    this.blocker.destroy();
    this.main.destroy(true);
  }

  public getPlayerSelection(): PowerSurgeCardId | null {
    return this.playerSelection;
  }

  public setOpponentSelection(cardId: PowerSurgeCardId): void {
    this.opponentSelection = cardId;
    if (this.playerSelection) {
      this.closeSoon();
    } else {
      this.subtitleText.setText("Opponent selected — your turn!");
      this.subtitleText.setColor("#22c55e");
    }
  }

  public setPlayerSelection(cardId: PowerSurgeCardId): void {
    this.playerSelection = cardId;
    this.subtitleText.setText("✓ Selected — waiting for opponent...");
    this.subtitleText.setColor("#22c55e");

    // Disable card interactions
    this.cardContainers.forEach(({ container }) => {
      container.disableInteractive();
      container.list.forEach((child) => {
        if (child instanceof Phaser.GameObjects.Rectangle) {
          child.disableInteractive();
        }
      });
    });

    if (this.opponentSelection) {
      this.closeSoon();
    }
  }

  private closeSoon(): void {
    this.timerEvent?.destroy();

    this.scene.time.delayedCall(700, () => {
      if (this.isDestroyed) return;
      this.animateExit(() => {
        if (this.isDestroyed) return;
        const selection = this.playerSelection;
        this.destroy();
        this.config.onClose(selection);
      });
    });
  }

  private animateEntry(): void {
    this.main.setScale(0.9);
    this.main.setAlpha(0);
    this.scene.tweens.add({
      targets: this.main,
      alpha: 1,
      scale: 1,
      duration: 250,
      ease: "Back.easeOut",
    });
  }

  private animateExit(onComplete: () => void): void {
    this.scene.tweens.add({
      targets: this.main,
      alpha: 0,
      scale: 0.95,
      duration: 200,
      ease: "Power2",
      onComplete,
    });
    this.scene.tweens.add({
      targets: this.blocker,
      alpha: 0,
      duration: 200,
      ease: "Power2",
    });
  }

  private createCards(): void {
    const cards = this.config.cardIds
      .map((id) => getPowerSurgeCard(id))
      .filter(Boolean) as PowerSurgeCard[];

    const totalWidth = cards.length * PowerSurgeCardView.CARD_WIDTH + (cards.length - 1) * CARD_SPACING;
    const startX = -totalWidth / 2 + PowerSurgeCardView.CARD_WIDTH / 2;

    cards.forEach((card, index) => {
      const x = startX + index * (PowerSurgeCardView.CARD_WIDTH + CARD_SPACING);
      const y = 40;
      const isCenter = index === Math.floor(cards.length / 2);
      const scale = isCenter ? CENTER_CARD_SCALE : 1;

      const container = PowerSurgeCardView.create({
        scene: this.scene,
        card,
        x,
        y,
        scale,
      });

      // Hit area overlay
      const hit = this.scene.add.rectangle(0, 0, PowerSurgeCardView.CARD_WIDTH, PowerSurgeCardView.CARD_HEIGHT, 0x000000, 0);
      hit.setInteractive({ useHandCursor: true });
      container.add(hit);

      hit.on("pointerover", () => {
        if (this.playerSelection) return;
        this.scene.tweens.add({
          targets: container,
          y: y - 12,
          scaleX: scale * 1.03,
          scaleY: scale * 1.03,
          duration: 140,
          ease: "Power2",
        });
      });

      hit.on("pointerout", () => {
        if (this.playerSelection) return;
        this.scene.tweens.add({
          targets: container,
          y,
          scaleX: scale,
          scaleY: scale,
          duration: 140,
          ease: "Power2",
        });
      });

      hit.on("pointerdown", () => {
        if (this.playerSelection) return;
        this.playerSelection = card.id;
        this.config.onCardSelected(card.id);
        this.setPlayerSelection(card.id);
      });

      this.main.add(container);
      this.cardContainers.push({ container, card, originalX: x, originalY: y });

      // Pop-in
      container.setScale(0);
      this.scene.tweens.add({
        targets: container,
        scale: scale,
        duration: 220,
        delay: index * 70,
        ease: "Back.easeOut",
      });
    });
  }

  private startTimer(): void {
    this.timerEvent = this.scene.time.addEvent({
      delay: 100,
      loop: true,
      callback: () => {
        if (this.isDestroyed) return;

        const now = Date.now();
        const remainingMs = this.config.deadlineAt - now;
        const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1000));

        this.timerText.setText(`${remainingSeconds}s`);

        const progress = Math.max(0, Math.min(1, remainingMs / this.totalDurationMs));
        this.updateTimerBar(progress);

        if (remainingMs <= WARNING_TIME_MS && remainingMs > 0 && !this.playerSelection) {
          this.timerText.setColor("#ff4444");
        }

        if (remainingMs <= 0) {
          this.timerEvent?.destroy();
          if (!this.playerSelection) {
            this.subtitleText.setText("Timed out — choosing random...");
            this.subtitleText.setColor("#ff4444");
            this.config.onTimeout();
          }
        }
      },
    });
  }

  private updateTimerBar(progress: number): void {
    const barWidth = 300;
    const barHeight = 8;
    const y = 290;

    this.timerBar.clear();
    this.timerBar.fillStyle(0x333333, 1);
    this.timerBar.fillRoundedRect(-barWidth / 2, y, barWidth, barHeight, 4);

    const progressWidth = barWidth * progress;
    const color = progress > 0.3 ? 0x40e0d0 : 0xff4444;
    this.timerBar.fillStyle(color, 1);
    this.timerBar.fillRoundedRect(-barWidth / 2, y, progressWidth, barHeight, 4);
  }
}
