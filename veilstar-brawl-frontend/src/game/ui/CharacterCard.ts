/**
 * CharacterCard - Character portrait card for selection screen
 * Displays character portrait, name, theme, and selection state
 */

import Phaser from "phaser";
import type { Character } from "@/types/game";

/**
 * Character card configuration.
 */
export interface CharacterCardConfig {
  character: Character;
  x: number;
  y: number;
  width?: number;
  height?: number;
  isSelected?: boolean;
  isLocked?: boolean;
  isDisabled?: boolean;
  onSelect?: (character: Character) => void;
  onInfo?: (character: Character) => void;
  onHover?: (character: Character) => void;
}

/**
 * Card visual states.
 */
type CardState = "default" | "hover" | "selected" | "locked" | "disabled";

/**
 * Animation configuration for smooth transitions.
 */
const ANIMATION_CONFIG = {
  HOVER_SCALE: 1.03,
  SELECTED_SCALE: 1.06,
  DEFAULT_SCALE: 1,
  HOVER_DURATION: 120,
  SELECT_DURATION: 180,
  DESELECT_DURATION: 150,
  EASE_IN: "Sine.easeOut",
  EASE_OUT: "Sine.easeIn",
  EASE_BOUNCE: "Back.easeOut",
};

/** Convert hex string like "#8B5CF6" to a number 0x8B5CF6 */
function hexToNum(hex: string): number {
  return parseInt(hex.replace("#", ""), 16);
}

/**
 * CharacterCard - Selectable character portrait.
 */
export class CharacterCard extends Phaser.GameObjects.Container {
  // Configuration
  private character: Character;
  private cardWidth: number;
  private cardHeight: number;
  private onSelectCb?: (character: Character) => void;
  private onInfoCb?: (character: Character) => void;
  private onHoverCb?: (character: Character) => void;

  // State
  private cardState: CardState = "default";
  private isInteractiveFlag: boolean = true;
  private isAnimating: boolean = false;

  // Visual elements
  private background!: Phaser.GameObjects.Graphics;
  private border!: Phaser.GameObjects.Graphics;
  private portrait!: Phaser.GameObjects.Image;
  private nameText!: Phaser.GameObjects.Text;
  private themeText!: Phaser.GameObjects.Text;
  private checkmarkGraphics?: Phaser.GameObjects.Graphics;
  private glowEffect!: Phaser.GameObjects.Graphics;

  // Colors (numeric)
  private colors: { primary: number; secondary: number; glow: number };

  // Tween references for cleanup
  private currentTween?: Phaser.Tweens.Tween;

  constructor(scene: Phaser.Scene, config: CharacterCardConfig) {
    super(scene, config.x, config.y);

    this.character = config.character;
    this.cardWidth = config.width ?? 200;
    this.cardHeight = config.height ?? 280;
    this.onSelectCb = config.onSelect;
    this.onInfoCb = config.onInfo;
    this.onHoverCb = config.onHover;

    // Convert hex strings → numbers
    const c = config.character.colors;
    this.colors = {
      primary: hexToNum(c.primary),
      secondary: hexToNum(c.secondary),
      glow: hexToNum(c.accent),
    };

    // Determine initial state
    if (config.isDisabled) {
      this.cardState = "disabled";
      this.isInteractiveFlag = false;
    } else if (config.isLocked) {
      this.cardState = "locked";
      this.isInteractiveFlag = false;
    } else if (config.isSelected) {
      this.cardState = "selected";
    }

    this.createCardElements();
    this.setupInteraction();
    this.updateVisuals();

    scene.add.existing(this);
  }

  /**
   * Create card visual elements.
   */
  private createCardElements(): void {
    // Glow effect (behind everything)
    this.glowEffect = this.scene.add.graphics();
    this.add(this.glowEffect);

    // Background
    this.background = this.scene.add.graphics();
    this.add(this.background);

    // Border
    this.border = this.scene.add.graphics();
    this.add(this.border);

    // Portrait
    const charId = this.character.id;
    let portraitKey = `portrait-${charId}`;

    if (!this.scene.textures.exists(portraitKey)) {
      if (this.scene.textures.exists(`portrait-${charId}-png`)) {
        portraitKey = `portrait-${charId}-png`;
      } else if (this.scene.textures.exists(`portrait-${charId}-fallback`)) {
        portraitKey = `portrait-${charId}-fallback`;
      }
    }

    if (this.scene.textures.exists(portraitKey)) {
      this.portrait = this.scene.add.image(
        this.cardWidth / 2,
        this.cardHeight * 0.4,
        portraitKey
      );
      const targetSize = Math.min(this.cardWidth * 0.8, this.cardHeight * 0.6);
      const startScale =
        targetSize / Math.max(this.portrait.width, this.portrait.height);
      this.portrait.setScale(startScale);
      this.add(this.portrait);
    } else {
      // Placeholder
      const placeholder = this.scene.add.graphics();
      placeholder.fillStyle(this.colors.secondary, 1);
      placeholder.fillRoundedRect(20, 20, 160, 160, 8);
      placeholder.lineStyle(2, this.colors.primary);
      placeholder.strokeRoundedRect(20, 20, 160, 160, 8);
      this.add(placeholder);

      const initial = this.scene.add.text(
        this.cardWidth / 2,
        100,
        this.character.name.charAt(0).toUpperCase(),
        { fontFamily: "Orbitron, sans-serif", fontSize: "64px", color: "#ffffff" }
      );
      initial.setOrigin(0.5);
      this.add(initial);
    }

    // Character name
    const nameFontSize = Math.max(12, Math.floor(this.cardWidth / 12));
    this.nameText = this.scene.add.text(
      this.cardWidth / 2,
      this.cardHeight * 0.75,
      this.character.name.toUpperCase(),
      {
        fontFamily: "Orbitron, sans-serif",
        fontSize: `${nameFontSize}px`,
        color: "#ffffff",
        fontStyle: "bold",
        align: "center",
        wordWrap: { width: this.cardWidth - 10 },
      }
    );
    this.nameText.setOrigin(0.5, 0);
    this.add(this.nameText);

    // Theme description (only if card is tall enough)
    if (this.cardHeight > 180) {
      const themePreview = this.character.theme.slice(0, 50) + "...";
      this.themeText = this.scene.add.text(
        this.cardWidth / 2,
        this.cardHeight * 0.85,
        themePreview,
        {
          fontFamily: "Arial, sans-serif",
          fontSize: "10px",
          color: "#888888",
          wordWrap: { width: this.cardWidth - 20 },
          align: "center",
        }
      );
      this.themeText.setOrigin(0.5);
      this.add(this.themeText);
    } else {
      this.themeText = this.scene.add.text(0, 0, "");
      this.themeText.setVisible(false);
      this.add(this.themeText);
    }

    // Info icon
    this.createInfoIcon();
  }

  private createInfoIcon(): void {
    if (!this.onInfoCb) return;

    const iconContainer = this.scene.add.container(this.cardWidth - 20, 20);
    const circle = this.scene.add.graphics();
    circle.fillStyle(0x000000, 0.6);
    circle.fillCircle(0, 0, 12);
    circle.lineStyle(1, 0xffffff);
    circle.strokeCircle(0, 0, 12);

    const text = this.scene.add
      .text(0, 0, "i", {
        fontSize: "14px",
        fontFamily: "monospace",
        fontStyle: "bold",
        color: "#ffffff",
      })
      .setOrigin(0.5);

    iconContainer.add([circle, text]);

    const hitArea = new Phaser.Geom.Circle(0, 0, 15);
    iconContainer.setInteractive(hitArea, Phaser.Geom.Circle.Contains);

    iconContainer.on("pointerover", () => {
      circle.clear();
      circle.fillStyle(this.colors.primary, 1);
      circle.fillCircle(0, 0, 12);
      circle.lineStyle(1, 0xffffff);
      circle.strokeCircle(0, 0, 12);
      this.scene.game.canvas.style.cursor = "pointer";
    });

    iconContainer.on("pointerout", () => {
      circle.clear();
      circle.fillStyle(0x000000, 0.6);
      circle.fillCircle(0, 0, 12);
      circle.lineStyle(1, 0xffffff);
      circle.strokeCircle(0, 0, 12);
      this.scene.game.canvas.style.cursor = "default";
    });

    iconContainer.on(
      "pointerdown",
      (
        _pointer: Phaser.Input.Pointer,
        _localX: number,
        _localY: number,
        event: Phaser.Types.Input.EventData
      ) => {
        event.stopPropagation();
        this.onInfoCb?.(this.character);
      }
    );

    this.add(iconContainer);
  }

  /**
   * Set up interactive behavior.
   */
  private setupInteraction(): void {
    const hitArea = new Phaser.Geom.Rectangle(
      this.cardWidth * 0.5,
      this.cardHeight * 0.45,
      this.cardWidth,
      this.cardHeight
    );

    this.setSize(this.cardWidth, this.cardHeight);
    this.setInteractive(hitArea, Phaser.Geom.Rectangle.Contains);

    this.on("pointerover", this.handlePointerOver, this);
    this.on("pointerout", this.handlePointerOut, this);
    this.on("pointerdown", this.handlePointerDown, this);
  }

  private handlePointerOver(): void {
    if (!this.isInteractiveFlag || this.isAnimating) return;
    if (this.cardState === "default") {
      this.cardState = "hover";
      this.animateToState();
      this.onHoverCb?.(this.character);
    }
  }

  private handlePointerOut(): void {
    if (!this.isInteractiveFlag) return;
    if (this.cardState === "hover") {
      this.cardState = "default";
      this.animateToState();
    }
  }

  private handlePointerDown(): void {
    if (!this.isInteractiveFlag || this.isAnimating) return;
    this.onSelectCb?.(this.character);
  }

  private animateToState(): void {
    this.currentTween?.stop();

    let targetScale = ANIMATION_CONFIG.DEFAULT_SCALE;
    let duration = ANIMATION_CONFIG.DESELECT_DURATION;
    let ease = ANIMATION_CONFIG.EASE_OUT;

    switch (this.cardState) {
      case "hover":
        targetScale = ANIMATION_CONFIG.HOVER_SCALE;
        duration = ANIMATION_CONFIG.HOVER_DURATION;
        ease = ANIMATION_CONFIG.EASE_IN;
        break;
      case "selected":
      case "locked":
        targetScale = ANIMATION_CONFIG.SELECTED_SCALE;
        duration = ANIMATION_CONFIG.SELECT_DURATION;
        ease = ANIMATION_CONFIG.EASE_BOUNCE;
        break;
      default:
        targetScale = ANIMATION_CONFIG.DEFAULT_SCALE;
        duration = ANIMATION_CONFIG.DESELECT_DURATION;
        ease = ANIMATION_CONFIG.EASE_OUT;
        break;
    }

    this.currentTween = this.scene.tweens.add({
      targets: this,
      scaleX: targetScale,
      scaleY: targetScale,
      duration,
      ease,
      onStart: () => {
        this.isAnimating = true;
      },
      onComplete: () => {
        this.isAnimating = false;
      },
    });

    this.updateVisuals();
  }

  /**
   * Update visuals based on current state.
   */
  private updateVisuals(): void {
    this.background.clear();
    this.border.clear();
    this.glowEffect.clear();

    this.checkmarkGraphics?.destroy();
    this.checkmarkGraphics = undefined;

    const borderRadius = 12;

    switch (this.cardState) {
      case "default":
        this.drawDefaultState(borderRadius);
        break;
      case "hover":
        this.drawHoverState(borderRadius);
        break;
      case "selected":
        this.drawSelectedState(borderRadius);
        break;
      case "locked":
        this.drawLockedState(borderRadius);
        break;
      case "disabled":
        this.drawDisabledState(borderRadius);
        break;
    }
  }

  private drawDefaultState(radius: number): void {
    this.background.fillStyle(0x1a1a2e, 0.9);
    this.background.fillRoundedRect(0, 0, this.cardWidth, this.cardHeight, radius);
    this.border.lineStyle(2, 0x333333);
    this.border.strokeRoundedRect(0, 0, this.cardWidth, this.cardHeight, radius);
  }

  private drawHoverState(radius: number): void {
    this.glowEffect.fillStyle(this.colors.glow, 0.25);
    this.glowEffect.fillRoundedRect(-6, -6, this.cardWidth + 12, this.cardHeight + 12, radius + 6);
    this.background.fillStyle(0x1a1a2e, 0.95);
    this.background.fillRoundedRect(0, 0, this.cardWidth, this.cardHeight, radius);
    this.border.lineStyle(3, this.colors.primary);
    this.border.strokeRoundedRect(0, 0, this.cardWidth, this.cardHeight, radius);
  }

  private drawSelectedState(radius: number): void {
    this.glowEffect.fillStyle(this.colors.glow, 0.45);
    this.glowEffect.fillRoundedRect(-10, -10, this.cardWidth + 20, this.cardHeight + 20, radius + 10);
    this.background.fillStyle(this.colors.secondary, 0.35);
    this.background.fillRoundedRect(0, 0, this.cardWidth, this.cardHeight, radius);
    this.border.lineStyle(4, this.colors.primary);
    this.border.strokeRoundedRect(0, 0, this.cardWidth, this.cardHeight, radius);
  }

  private drawLockedState(radius: number): void {
    this.drawSelectedState(radius);

    this.checkmarkGraphics = this.scene.add.graphics();
    this.add(this.checkmarkGraphics);

    const centerX = this.cardWidth / 2;
    const centerY = this.cardHeight / 2;
    const circleRadius = Math.min(this.cardWidth, this.cardHeight) * 0.15;

    this.checkmarkGraphics.fillStyle(0x22c55e, 1);
    this.checkmarkGraphics.fillCircle(centerX, centerY, circleRadius);

    this.checkmarkGraphics.lineStyle(3, 0xffffff, 1);
    this.checkmarkGraphics.beginPath();
    this.checkmarkGraphics.moveTo(centerX - 10, centerY);
    this.checkmarkGraphics.lineTo(centerX - 2, centerY + 8);
    this.checkmarkGraphics.lineTo(centerX + 12, centerY - 8);
    this.checkmarkGraphics.strokePath();
  }

  private drawDisabledState(radius: number): void {
    this.background.fillStyle(0x0a0a0a, 0.9);
    this.background.fillRoundedRect(0, 0, this.cardWidth, this.cardHeight, radius);
    this.border.lineStyle(2, 0x222222);
    this.border.strokeRoundedRect(0, 0, this.cardWidth, this.cardHeight, radius);
    this.setAlpha(0.5);
  }

  // ==========================================================================
  // PUBLIC API
  // ==========================================================================

  select(): void {
    if (this.cardState === "disabled" || this.cardState === "locked") return;
    this.cardState = "selected";
    this.animateToState();
  }

  deselect(): void {
    if (this.cardState === "locked" || this.cardState === "disabled") return;
    this.cardState = "default";
    this.animateToState();
  }

  lock(): void {
    this.cardState = "locked";
    this.isInteractiveFlag = false;
    this.animateToState();
  }

  disable(): void {
    this.cardState = "disabled";
    this.isInteractiveFlag = false;
    this.animateToState();
  }

  enable(): void {
    if (this.cardState !== "disabled") return;
    this.cardState = "default";
    this.isInteractiveFlag = true;
    this.setAlpha(1);
    this.animateToState();
  }

  getCharacter(): Character {
    return this.character;
  }

  isSelected(): boolean {
    return this.cardState === "selected";
  }

  isLocked(): boolean {
    return this.cardState === "locked";
  }
}
