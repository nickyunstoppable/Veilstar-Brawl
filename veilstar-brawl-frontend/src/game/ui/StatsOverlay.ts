/**
 * StatsOverlay - Full-screen character stats detail panel
 */

import Phaser from "phaser";
import { getCharacterCombatStats } from "@/game/combat/CharacterStats";
import { getCharacterColor } from "@/data/characters";
import type { Character } from "@/types/game";
import { GAME_DIMENSIONS } from "../config";

/** Convert hex string like "#8B5CF6" to a number 0x8B5CF6 */
function hexToNum(hex: string): number {
  return parseInt(hex.replace("#", ""), 16);
}

export class StatsOverlay extends Phaser.GameObjects.Container {
  private bg: Phaser.GameObjects.Graphics;
  private panel: Phaser.GameObjects.Container;
  private isShowing = false;

  constructor(scene: Phaser.Scene) {
    super(scene, 0, 0);
    this.setDepth(1000);

    this.bg = scene.add.graphics();
    this.bg.fillStyle(0x000000, 0.8);
    this.bg.fillRect(0, 0, GAME_DIMENSIONS.WIDTH, GAME_DIMENSIONS.HEIGHT);
    this.bg.setInteractive(
      new Phaser.Geom.Rectangle(0, 0, GAME_DIMENSIONS.WIDTH, GAME_DIMENSIONS.HEIGHT),
      Phaser.Geom.Rectangle.Contains
    );
    this.bg.on("pointerdown", () => this.hide());
    this.add(this.bg);

    this.panel = scene.add.container(GAME_DIMENSIONS.CENTER_X, GAME_DIMENSIONS.CENTER_Y);
    this.add(this.panel);

    this.setVisible(false);
    this.setAlpha(0);

    scene.add.existing(this);
  }

  public show(character: Character): void {
    this.panel.removeAll(true);
    this.buildPanelContent(character);
    this.isShowing = true;
    this.setVisible(true);

    this.scene.tweens.add({ targets: this, alpha: 1, duration: 200, ease: "Power2" });
    this.panel.setScale(0.9);
    this.scene.tweens.add({ targets: this.panel, scale: 1, duration: 200, ease: "Back.easeOut" });
  }

  public hide(): void {
    if (!this.isShowing) return;
    this.isShowing = false;
    this.scene.tweens.add({
      targets: this,
      alpha: 0,
      duration: 150,
      onComplete: () => this.setVisible(false),
    });
  }

  private buildPanelContent(character: Character): void {
    const stats = getCharacterCombatStats(character.id);
    const colorsStr = getCharacterColor(character.id);
    const primaryNum = hexToNum(colorsStr.primary);
    const secondaryNum = hexToNum(colorsStr.secondary);
    const width = 500;
    const height = 400;
    const radius = 16;

    // Panel background
    const panelBg = this.scene.add.graphics();
    panelBg.fillStyle(0x111111, 0.95);
    panelBg.fillRoundedRect(-width / 2, -height / 2, width, height, radius);
    panelBg.lineStyle(2, primaryNum);
    panelBg.strokeRoundedRect(-width / 2, -height / 2, width, height, radius);
    this.panel.add(panelBg);

    // Title
    const title = this.scene.add.text(0, -height / 2 + 40, character.name.toUpperCase(), {
      fontFamily: "Orbitron, sans-serif",
      fontSize: "32px",
      color: "#ffffff",
      fontStyle: "bold",
    }).setOrigin(0.5);
    this.panel.add(title);

    // Theme
    const themeText = this.scene.add.text(0, -height / 2 + 80, `"${character.theme}"`, {
      fontFamily: "Arial, sans-serif",
      fontSize: "14px",
      color: "#aaaaaa",
      fontStyle: "italic",
      align: "center",
      wordWrap: { width: width - 60 },
    }).setOrigin(0.5, 0);
    this.panel.add(themeText);

    // Stats grid
    const gridY = -height / 2 + 150;
    const col1X = -120;
    const col2X = 120;

    this.addStatRow(col1X, gridY, "HP", stats.maxHp.toString(), colorsStr.primary);
    this.addStatRow(col2X, gridY, "Energy", stats.maxEnergy.toString(), colorsStr.secondary);
    this.addStatRow(col1X, gridY + 50, "Regen", `${stats.energyRegen}/turn`, "#ffffff");
    this.addStatRow(col2X, gridY + 50, "Guard", `${Math.round((1 - stats.blockEffectiveness) * 100)}% Block`, "#ffffff");

    // Modifiers
    const modY = gridY + 110;
    const modTitle = this.scene.add.text(0, modY, "DAMAGE MODIFIERS", {
      fontFamily: "Orbitron, sans-serif",
      fontSize: "16px",
      color: "#888888",
    }).setOrigin(0.5);
    this.panel.add(modTitle);

    const mods = stats.damageModifiers;
    const modLabels = [
      { l: "PUNCH", v: Number(mods["punch"] ?? 1) },
      { l: "KICK", v: Number(mods["kick"] ?? 1) },
      { l: "SPECIAL", v: Number(mods["special"] ?? 1) },
    ];

    modLabels.forEach((m, i) => {
      const x = (i - 1) * 140;
      const valStr = m.v === 1 ? "100%" : `${Math.round(m.v * 100)}%`;
      const color = m.v > 1 ? "#4ade80" : m.v < 1 ? "#f87171" : "#bbbbbb";
      this.addStatBox(x, modY + 40, m.l, valStr, color);
    });

    // Close button
    const closeBtn = this.scene.add.container(width / 2 - 30, -height / 2 + 30);
    const closeCircle = this.scene.add.graphics();
    closeCircle.fillStyle(0x333333, 1);
    closeCircle.fillCircle(0, 0, 15);
    const closeX = this.scene.add.text(0, 0, "×", { fontSize: "24px", color: "#ffffff" }).setOrigin(0.5, 0.55);
    closeBtn.add([closeCircle, closeX]);
    closeBtn.setSize(30, 30);
    closeBtn.setInteractive({ useHandCursor: true }).on("pointerdown", () => this.hide());
    this.panel.add(closeBtn);
  }

  private addStatRow(x: number, y: number, label: string, value: string, color: string): void {
    const l = this.scene.add.text(x, y, label, {
      fontFamily: "Orbitron, sans-serif", fontSize: "14px", color: "#888888",
    }).setOrigin(0.5, 1);
    const v = this.scene.add.text(x, y + 5, value, {
      fontFamily: "Orbitron, sans-serif", fontSize: "24px", color, fontStyle: "bold",
    }).setOrigin(0.5, 0);
    this.panel.add([l, v]);
  }

  private addStatBox(x: number, y: number, label: string, value: string, color: string): void {
    const box = this.scene.add.graphics();
    box.lineStyle(1, 0x444444);
    box.strokeRoundedRect(x - 60, y, 120, 50, 8);
    const l = this.scene.add.text(x, y + 10, label, {
      fontFamily: "Arial, sans-serif", fontSize: "10px", color: "#666666",
    }).setOrigin(0.5, 0);
    const v = this.scene.add.text(x, y + 25, value, {
      fontFamily: "Orbitron, sans-serif", fontSize: "16px", color, fontStyle: "bold",
    }).setOrigin(0.5, 0);
    this.panel.add([box, l, v]);
  }
}
