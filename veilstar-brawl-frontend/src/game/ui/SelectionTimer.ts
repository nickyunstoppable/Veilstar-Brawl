/**
 * SelectionTimer - Countdown timer for character lock-in
 * Uses real-world time (Date.now()) so the timer continues when the tab is hidden.
 */

import Phaser from "phaser";
import { GAME_DIMENSIONS } from "../config";

export interface SelectionTimerConfig {
  x?: number;
  y?: number;
  duration?: number;
  deadlineTimestamp?: number;
  warningThreshold?: number;
  criticalThreshold?: number;
  onTimeUp?: () => void;
}

type TimerState = "normal" | "warning" | "critical" | "stopped";

export class SelectionTimer extends Phaser.GameObjects.Container {
  private duration: number;
  private warningThreshold: number;
  private criticalThreshold: number;
  private onTimeUp?: () => void;

  private deadlineTimestamp: number = 0;
  private timeRemaining: number;
  private timerState: TimerState = "normal";
  private isRunning: boolean = false;
  private hasTimedOut: boolean = false;

  private timerEvent?: Phaser.Time.TimerEvent;

  private background!: Phaser.GameObjects.Graphics;
  private timerText!: Phaser.GameObjects.Text;
  private labelText!: Phaser.GameObjects.Text;
  private progressBar!: Phaser.GameObjects.Graphics;
  private progressFill!: Phaser.GameObjects.Graphics;

  private readonly BAR_WIDTH = 300;
  private readonly BAR_HEIGHT = 8;

  constructor(scene: Phaser.Scene, config: SelectionTimerConfig = {}) {
    const x = config.x ?? GAME_DIMENSIONS.CENTER_X;
    const y = config.y ?? 80;
    super(scene, x, y);

    this.duration = config.duration ?? 30;
    this.warningThreshold = config.warningThreshold ?? 10;
    this.criticalThreshold = config.criticalThreshold ?? 5;
    this.onTimeUp = config.onTimeUp;
    this.timeRemaining = this.duration;

    if (config.deadlineTimestamp && config.deadlineTimestamp > 0) {
      this.deadlineTimestamp = config.deadlineTimestamp;
      this.timeRemaining = this.calculateTimeRemaining();
    }

    this.createElements();
    this.updateVisuals();

    scene.add.existing(this as unknown as Phaser.GameObjects.GameObject);
  }

  private calculateTimeRemaining(): number {
    if (this.deadlineTimestamp === 0) return this.timeRemaining;
    return Math.max(0, Math.ceil((this.deadlineTimestamp - Date.now()) / 1000));
  }

  private createElements(): void {
    this.background = this.scene.add.graphics();
    this.background.fillStyle(0x000000, 0.6);
    this.background.fillRoundedRect(
      -this.BAR_WIDTH / 2 - 20, -30,
      this.BAR_WIDTH + 40, 80, 10
    );
    this.add(this.background);

    this.labelText = this.scene.add.text(0, -20, "SELECT YOUR FIGHTER", {
      fontFamily: "Orbitron, sans-serif",
      fontSize: "14px",
      color: "#888888",
    }).setOrigin(0.5);
    this.add(this.labelText);

    this.timerText = this.scene.add.text(0, 5, this.formatTime(this.duration), {
      fontFamily: "Orbitron, sans-serif",
      fontSize: "28px",
      color: "#ffffff",
      fontStyle: "bold",
    }).setOrigin(0.5);
    this.add(this.timerText);

    this.progressBar = this.scene.add.graphics();
    this.progressBar.fillStyle(0x333333, 1);
    this.progressBar.fillRoundedRect(-this.BAR_WIDTH / 2, 30, this.BAR_WIDTH, this.BAR_HEIGHT, 4);
    this.add(this.progressBar);

    this.progressFill = this.scene.add.graphics();
    this.add(this.progressFill);
  }

  private formatTime(seconds: number): string {
    if (seconds >= 60) {
      const mins = Math.floor(seconds / 60);
      const secs = seconds % 60;
      return `${mins}:${secs.toString().padStart(2, "0")}`;
    }
    return `${seconds}`;
  }

  private getColor(): number {
    switch (this.timerState) {
      case "critical": return 0xef4444;
      case "warning": return 0xfbbf24;
      default: return 0x22c55e;
    }
  }

  private updateState(): void {
    if (!this.isRunning) {
      this.timerState = "stopped";
    } else if (this.timeRemaining <= this.criticalThreshold) {
      this.timerState = "critical";
    } else if (this.timeRemaining <= this.warningThreshold) {
      this.timerState = "warning";
    } else {
      this.timerState = "normal";
    }
  }

  private updateVisuals(): void {
    this.updateState();
    const color = this.getColor();
    const colorHex = `#${color.toString(16).padStart(6, "0")}`;

    this.timerText.setText(this.formatTime(this.timeRemaining));
    this.timerText.setColor(colorHex);

    this.progressFill.clear();
    const progress = this.timeRemaining / this.duration;
    const fillWidth = this.BAR_WIDTH * progress;

    this.progressFill.fillStyle(color, 1);
    this.progressFill.fillRoundedRect(-this.BAR_WIDTH / 2, 30, fillWidth, this.BAR_HEIGHT, 4);

    if (this.timerState === "critical" && this.timeRemaining > 0) {
      const pulse = Math.sin(Date.now() / 100) * 0.1 + 1;
      this.timerText.setScale(pulse);
    } else {
      this.timerText.setScale(1);
    }
  }

  private tick(): void {
    if (!this.isRunning || this.hasTimedOut) return;
    this.timeRemaining = this.calculateTimeRemaining();
    this.updateVisuals();

    if (this.timeRemaining <= 0 && !this.hasTimedOut) {
      this.hasTimedOut = true;
      this.stop();
      this.onTimeUp?.();
    }
  }

  // ==========================================================================
  // PUBLIC API
  // ==========================================================================

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.hasTimedOut = false;

    if (this.deadlineTimestamp === 0) {
      this.deadlineTimestamp = Date.now() + this.duration * 1000;
    }

    this.timeRemaining = this.calculateTimeRemaining();
    this.updateVisuals();

    if (this.timeRemaining <= 0) {
      this.hasTimedOut = true;
      this.stop();
      this.onTimeUp?.();
      return;
    }

    this.timerEvent = this.scene.time.addEvent({
      delay: 200,
      callback: this.tick,
      callbackScope: this,
      loop: true,
    });
  }

  stop(): void {
    this.isRunning = false;
    this.timerEvent?.destroy();
    this.timerEvent = undefined;
    this.updateVisuals();
  }

  reset(newDuration?: number): void {
    this.stop();
    if (newDuration !== undefined) this.duration = newDuration;
    this.timeRemaining = this.duration;
    this.deadlineTimestamp = 0;
    this.hasTimedOut = false;
    this.timerState = "normal";
    this.updateVisuals();
  }

  getTimeRemaining(): number {
    return this.timeRemaining;
  }

  tickFromUpdate(): void {
    this.tick();
  }

  setLabel(text: string): void {
    this.labelText.setText(text);
  }

  showLockedIn(): void {
    this.stop();
    this.labelText.setText("LOCKED IN!");
    this.labelText.setColor("#22c55e");
    this.timerText.setText("✓");
    this.timerText.setColor("#22c55e");
    this.timerText.setScale(1);

    this.progressFill.clear();
    this.progressFill.fillStyle(0x22c55e, 1);
    this.progressFill.fillRoundedRect(-this.BAR_WIDTH / 2, 30, this.BAR_WIDTH, this.BAR_HEIGHT, 4);
  }

  destroy(fromScene?: boolean): void {
    this.timerEvent?.destroy();
    super.destroy(fromScene);
  }
}
