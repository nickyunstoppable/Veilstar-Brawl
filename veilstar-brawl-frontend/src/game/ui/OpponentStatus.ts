/**
 * OpponentStatus - Displays opponent's selection state
 * Shows whether opponent has locked in their character
 */

import Phaser from "phaser";
import { GAME_DIMENSIONS } from "../config";

export interface OpponentStatusConfig {
  x?: number;
  y?: number;
  opponentAddress?: string;
  showAddress?: boolean;
}

type SelectionStatus = "waiting" | "selecting" | "locked" | "disconnected";

export class OpponentStatus extends Phaser.GameObjects.Container {
  private opponentAddress: string;
  private showAddressFlag: boolean;

  private status: SelectionStatus = "waiting";

  private background!: Phaser.GameObjects.Graphics;
  private statusIcon!: Phaser.GameObjects.Text;
  private statusText!: Phaser.GameObjects.Text;
  private addressText!: Phaser.GameObjects.Text;
  private pulseEffect!: Phaser.Tweens.Tween;

  private readonly WIDTH = 200;
  private readonly HEIGHT = 60;

  constructor(scene: Phaser.Scene, config: OpponentStatusConfig = {}) {
    const x = config.x ?? GAME_DIMENSIONS.WIDTH - 120;
    const y = config.y ?? 80;
    super(scene, x, y);

    this.opponentAddress = config.opponentAddress ?? "";
    this.showAddressFlag = config.showAddress ?? true;

    this.createElements();
    this.updateVisuals();
  }

  private createElements(): void {
    this.background = this.scene.add.graphics();
    this.add(this.background);

    this.statusIcon = this.scene.add.text(-this.WIDTH / 2 + 25, 0, "●", {
      fontFamily: "Orbitron, sans-serif",
      fontSize: "24px",
      color: "#888888",
    }).setOrigin(0.5);
    this.add(this.statusIcon);

    this.statusText = this.scene.add.text(10, -8, "OPPONENT", {
      fontFamily: "Orbitron, sans-serif",
      fontSize: "14px",
      color: "#ffffff",
    }).setOrigin(0, 0.5);
    this.add(this.statusText);

    this.addressText = this.scene.add.text(10, 10, "", {
      fontFamily: "monospace",
      fontSize: "10px",
      color: "#888888",
    }).setOrigin(0, 0.5);
    this.add(this.addressText);

    this.updateAddressDisplay();
  }

  private updateAddressDisplay(): void {
    if (this.showAddressFlag && this.opponentAddress) {
      const truncated = this.opponentAddress.length <= 16
        ? this.opponentAddress
        : `${this.opponentAddress.slice(0, 8)}...${this.opponentAddress.slice(-6)}`;
      this.addressText.setText(truncated);
      this.addressText.setVisible(true);
    } else {
      this.addressText.setVisible(false);
    }
  }

  private getStatusDisplay(): { color: number; text: string; icon: string } {
    switch (this.status) {
      case "waiting": return { color: 0x888888, text: "WAITING...", icon: "○" };
      case "selecting": return { color: 0xfbbf24, text: "SELECTING...", icon: "●" };
      case "locked": return { color: 0x22c55e, text: "LOCKED IN!", icon: "✓" };
      case "disconnected": return { color: 0xef4444, text: "DISCONNECTED", icon: "✕" };
    }
  }

  private updateVisuals(): void {
    const display = this.getStatusDisplay();
    const colorHex = `#${display.color.toString(16).padStart(6, "0")}`;

    this.background.clear();
    this.background.fillStyle(0x000000, 0.6);
    this.background.fillRoundedRect(-this.WIDTH / 2, -this.HEIGHT / 2, this.WIDTH, this.HEIGHT, 8);
    this.background.lineStyle(2, display.color, 0.5);
    this.background.strokeRoundedRect(-this.WIDTH / 2, -this.HEIGHT / 2, this.WIDTH, this.HEIGHT, 8);

    this.statusIcon.setText(display.icon);
    this.statusIcon.setColor(colorHex);

    this.statusText.setText(display.text);

    this.stopPulse();
    if (this.status === "selecting") this.startPulse();
  }

  private startPulse(): void {
    this.pulseEffect = this.scene.tweens.add({
      targets: this.statusIcon,
      alpha: { from: 1, to: 0.3 },
      duration: 500,
      yoyo: true,
      repeat: -1,
    });
  }

  private stopPulse(): void {
    this.pulseEffect?.destroy();
    this.statusIcon.setAlpha(1);
  }

  // ==========================================================================
  // PUBLIC API
  // ==========================================================================

  setWaiting(): void { this.status = "waiting"; this.updateVisuals(); }
  setSelecting(): void { this.status = "selecting"; this.updateVisuals(); }
  setLocked(): void { this.status = "locked"; this.updateVisuals(); }
  setDisconnected(): void { this.status = "disconnected"; this.updateVisuals(); }

  getStatus(): SelectionStatus { return this.status; }

  setLockedHidden(): void {
    this.status = "locked";
    this.updateVisuals();
    this.statusText.setText("LOCKED IN");
    this.addressText.setText("Waiting for reveal...");
    this.addressText.setVisible(true);
    this.addressText.setColor("#22c55e");
  }

  showCharacterPreview(characterName: string, characterTheme: string): void {
    this.status = "locked";
    this.updateVisuals();
    this.statusText.setText(characterName.toUpperCase());
    this.addressText.setText(characterTheme);
    this.addressText.setVisible(true);
    this.addressText.setColor("#888888");
  }

  destroy(fromScene?: boolean): void {
    this.stopPulse();
    super.destroy(fromScene);
  }
}
