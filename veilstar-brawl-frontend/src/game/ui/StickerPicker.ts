/**
 * StickerPicker - In-game sticker selection UI component
 * Allows players to display stickers above their character during matches
 */

import Phaser from "phaser";
import { GAME_DIMENSIONS } from "../config";

/**
 * Available sticker definitions
 */
export const STICKER_LIST = [
    { id: "angry", filename: "angry.webp" },
    { id: "crying", filename: "crying.webp" },
    { id: "ez_peazy", filename: "ez_peazy.webp" },
    { id: "gg_glitch", filename: "gg_glitch.webp" },
    { id: "like", filename: "like.webp" },
    { id: "love", filename: "love.webp" },
    { id: "mad", filename: "mad.webp" },
    { id: "question", filename: "question.webp" },
    { id: "question-2", filename: "question-2.webp" },
    { id: "sad", filename: "sad.webp" },
    { id: "scared", filename: "scared.webp" },
    { id: "you-suck", filename: "you-suck.webp" },
] as const;

export type StickerId = typeof STICKER_LIST[number]["id"];

/**
 * StickerPicker configuration
 */
export interface StickerPickerConfig {
    x: number;
    y: number;
    playerSprite: Phaser.GameObjects.Sprite;
    ownedStickers?: StickerId[]; // Stickers the player owns (must be purchased from shop)
    onStickerSelected?: (stickerId: StickerId) => void;
}

/**
 * StickerPicker class - Phaser container for sticker selection
 */
export class StickerPicker extends Phaser.GameObjects.Container {
    private config: StickerPickerConfig;
    private isOpen: boolean = false;
    private isOnCooldown: boolean = false;
    private cooldownDuration: number = 5000; // 5 seconds
    private stickerDisplayDuration: number = 3000; // 3 seconds

    // UI Elements
    private toggleButton!: Phaser.GameObjects.Container;
    private pickerPanel!: Phaser.GameObjects.Container;
    private cooldownOverlay!: Phaser.GameObjects.Graphics;
    private cooldownText!: Phaser.GameObjects.Text;
    private activeStickerDisplay?: Phaser.GameObjects.Container;

    // Owned stickers (from player inventory)
    private ownedStickerIds: Set<StickerId>;

    // Button dimensions - increased for better 12-sticker layout (4x3 grid)
    private readonly BUTTON_SIZE = 48;
    private readonly PANEL_WIDTH = 340;
    private readonly PANEL_HEIGHT = 280;
    private readonly STICKER_SIZE = 64;
    private readonly GRID_COLS = 4;

    constructor(scene: Phaser.Scene, config: StickerPickerConfig) {
        super(scene, config.x, config.y);
        this.config = config;

        // Initialize owned stickers set from config (empty if not provided)
        this.ownedStickerIds = new Set(config.ownedStickers || []);

        this.createToggleButton();
        this.createPickerPanel();

        // Add to scene
        scene.add.existing(this);
        this.setDepth(1500); // Above most UI
    }

    /**
     * Preload sticker assets - call this from scene preload
     */
    static preloadStickers(scene: Phaser.Scene): void {
        STICKER_LIST.forEach(sticker => {
            scene.load.image(`sticker_${sticker.id}`, `/stickers/${sticker.filename}`);
        });
    }

    /**
     * Create the toggle button (emoji icon)
     */
    private createToggleButton(): void {
        this.toggleButton = this.scene.add.container(0, 0);

        // Circle background
        const bg = this.scene.add.graphics();
        bg.fillStyle(0x1a1a2e, 0.9);
        bg.fillCircle(0, 0, this.BUTTON_SIZE / 2);
        bg.lineStyle(2, 0x49eacb, 1);
        bg.strokeCircle(0, 0, this.BUTTON_SIZE / 2);

        // Emoji icon
        const icon = this.scene.add.text(0, 0, "😀", {
            fontSize: "22px",
        }).setOrigin(0.5).setPadding(4);

        this.toggleButton.add([bg, icon]);
        this.toggleButton.setSize(this.BUTTON_SIZE, this.BUTTON_SIZE);
        this.toggleButton.setInteractive({ useHandCursor: true });

        // Cooldown overlay (hidden by default)
        this.cooldownOverlay = this.scene.add.graphics();
        this.cooldownOverlay.setVisible(false);
        this.toggleButton.add(this.cooldownOverlay);

        // Cooldown timer text
        this.cooldownText = this.scene.add.text(0, 0, "", {
            fontFamily: "monospace",
            fontSize: "14px",
            color: "#ffffff",
            fontStyle: "bold",
        }).setOrigin(0.5);
        this.cooldownText.setVisible(false);
        this.toggleButton.add(this.cooldownText);

        // Interactions
        this.toggleButton.on("pointerover", () => {
            if (!this.isOnCooldown) {
                bg.clear();
                bg.fillStyle(0x1a1a2e, 0.9);
                bg.fillCircle(0, 0, this.BUTTON_SIZE / 2);
                bg.lineStyle(2, 0x3b82f6, 1);
                bg.strokeCircle(0, 0, this.BUTTON_SIZE / 2);
            }
        });

        this.toggleButton.on("pointerout", () => {
            bg.clear();
            bg.fillStyle(0x1a1a2e, 0.9);
            bg.fillCircle(0, 0, this.BUTTON_SIZE / 2);
            bg.lineStyle(2, 0x49eacb, 1);
            bg.strokeCircle(0, 0, this.BUTTON_SIZE / 2);
        });

        this.toggleButton.on("pointerdown", () => {
            if (!this.isOnCooldown) {
                this.togglePanel();
            }
        });

        this.add(this.toggleButton);
    }

    /**
     * Create the sticker picker panel
     */
    private createPickerPanel(): void {
        // Panel positioned above the toggle button
        this.pickerPanel = this.scene.add.container(0, -this.PANEL_HEIGHT / 2 - this.BUTTON_SIZE / 2 - 10);
        this.pickerPanel.setVisible(false);
        this.pickerPanel.setAlpha(0);

        // Background
        const bg = this.scene.add.graphics();
        bg.fillStyle(0x0f172a, 0.95);
        bg.fillRoundedRect(-this.PANEL_WIDTH / 2, -this.PANEL_HEIGHT / 2, this.PANEL_WIDTH, this.PANEL_HEIGHT, 12);
        bg.lineStyle(2, 0x49eacb, 0.5);
        bg.strokeRoundedRect(-this.PANEL_WIDTH / 2, -this.PANEL_HEIGHT / 2, this.PANEL_WIDTH, this.PANEL_HEIGHT, 12);
        this.pickerPanel.add(bg);

        // Header
        const title = this.scene.add.text(0, -this.PANEL_HEIGHT / 2 + 20, "STICKERS", {
            fontFamily: "Orbitron, sans-serif",
            fontSize: "14px",
            color: "#49eacb",
            fontStyle: "bold",
        }).setOrigin(0.5);
        this.pickerPanel.add(title);

        // Sticker grid - calculate centered positioning
        const gridRows = Math.ceil(STICKER_LIST.length / this.GRID_COLS); // 3 rows for 12 stickers
        const spacing = this.STICKER_SIZE + 12; // sticker size + gap
        const gridWidth = this.GRID_COLS * spacing - 12; // total width minus last gap
        const gridHeight = gridRows * spacing - 12;
        const startX = -gridWidth / 2 + this.STICKER_SIZE / 2; // center horizontally
        const startY = -this.PANEL_HEIGHT / 2 + 55; // below header

        STICKER_LIST.forEach((sticker, index) => {
            const col = index % this.GRID_COLS;
            const row = Math.floor(index / this.GRID_COLS);
            const x = startX + col * spacing;
            const y = startY + row * spacing;

            const stickerBtn = this.createStickerButton(x, y, sticker.id);
            this.pickerPanel.add(stickerBtn);
        });

        // Close button
        const closeBtn = this.scene.add.text(
            this.PANEL_WIDTH / 2 - 20,
            -this.PANEL_HEIGHT / 2 + 20,
            "✕",
            {
                fontSize: "16px",
                color: "#888888",
            }
        ).setOrigin(0.5);
        closeBtn.setInteractive({ useHandCursor: true });
        closeBtn.on("pointerover", () => closeBtn.setColor("#ffffff"));
        closeBtn.on("pointerout", () => closeBtn.setColor("#888888"));
        closeBtn.on("pointerdown", () => this.closePanel());
        this.pickerPanel.add(closeBtn);

        this.add(this.pickerPanel);
    }

    /**
     * Create a single sticker button
     */
    private createStickerButton(x: number, y: number, stickerId: string): Phaser.GameObjects.Container {
        const container = this.scene.add.container(x, y);
        const isOwned = this.ownedStickerIds.has(stickerId as StickerId);

        // Background
        const bg = this.scene.add.graphics();
        bg.fillStyle(isOwned ? 0x1e293b : 0x0f1419, 1);
        bg.fillRoundedRect(-this.STICKER_SIZE / 2, -this.STICKER_SIZE / 2, this.STICKER_SIZE, this.STICKER_SIZE, 8);
        container.add(bg);

        // Sticker image
        const textureKey = `sticker_${stickerId}`;
        let stickerImg: Phaser.GameObjects.Image | null = null;
        if (this.scene.textures.exists(textureKey)) {
            stickerImg = this.scene.add.image(0, 0, textureKey);
            // Scale to fit
            const maxSize = this.STICKER_SIZE - 8;
            const scale = Math.min(maxSize / stickerImg.width, maxSize / stickerImg.height);
            stickerImg.setScale(scale);
            container.add(stickerImg);
        } else {
            // Fallback placeholder
            const placeholder = this.scene.add.text(0, 0, "?", {
                fontSize: "24px",
                color: "#666666",
            }).setOrigin(0.5);
            container.add(placeholder);
        }

        container.setSize(this.STICKER_SIZE, this.STICKER_SIZE);

        if (isOwned) {
            // Owned sticker - fully interactive
            container.setInteractive({ useHandCursor: true });

            // Hover effects
            container.on("pointerover", () => {
                bg.clear();
                bg.fillStyle(0x3b82f6, 0.5);
                bg.fillRoundedRect(-this.STICKER_SIZE / 2, -this.STICKER_SIZE / 2, this.STICKER_SIZE, this.STICKER_SIZE, 8);
                container.setScale(1.1);
            });

            container.on("pointerout", () => {
                bg.clear();
                bg.fillStyle(0x1e293b, 1);
                bg.fillRoundedRect(-this.STICKER_SIZE / 2, -this.STICKER_SIZE / 2, this.STICKER_SIZE, this.STICKER_SIZE, 8);
                container.setScale(1);
            });

            container.on("pointerdown", () => {
                this.selectSticker(stickerId as StickerId);
            });
        } else {
            // Unowned sticker - lower opacity, not interactive, show lock
            container.setAlpha(0.35);

            // Add lock icon overlay
            const lockIcon = this.scene.add.text(0, this.STICKER_SIZE / 4, "🔒", {
                fontSize: "16px",
            }).setOrigin(0.5);
            container.add(lockIcon);

            // Add subtle border to indicate locked
            bg.lineStyle(1, 0x374151, 0.5);
            bg.strokeRoundedRect(-this.STICKER_SIZE / 2, -this.STICKER_SIZE / 2, this.STICKER_SIZE, this.STICKER_SIZE, 8);
        }

        return container;
    }

    /**
     * Toggle the panel visibility
     */
    private togglePanel(): void {
        if (this.isOpen) {
            this.closePanel();
        } else {
            this.openPanel();
        }
    }

    /**
     * Open the sticker picker panel
     */
    private openPanel(): void {
        if (this.isOpen) return;

        this.isOpen = true;
        this.pickerPanel.setVisible(true);
        this.scene.tweens.add({
            targets: this.pickerPanel,
            alpha: 1,
            scaleX: { from: 0.8, to: 1 },
            scaleY: { from: 0.8, to: 1 },
            duration: 200,
            ease: "Back.easeOut",
        });
    }

    /**
     * Close the sticker picker panel
     */
    private closePanel(): void {
        if (!this.isOpen) return;

        this.scene.tweens.add({
            targets: this.pickerPanel,
            alpha: 0,
            scaleX: 0.8,
            scaleY: 0.8,
            duration: 150,
            ease: "Quad.easeIn",
            onComplete: () => {
                this.pickerPanel.setVisible(false);
                this.isOpen = false;
            },
        });
    }

    /**
     * Handle sticker selection
     */
    private selectSticker(stickerId: StickerId): void {
        if (this.isOnCooldown) return;

        // Close the panel
        this.closePanel();

        // NOTE: Don't display locally here - wait for broadcast to sync timing with opponent
        // The sticker will be displayed when we receive our own broadcast back

        // Start cooldown
        this.startCooldown();

        // Emit event (will broadcast to channel, we receive our own broadcast)
        if (this.config.onStickerSelected) {
            this.config.onStickerSelected(stickerId);
        }
    }

    /**
     * Display a sticker above the player's character
     */
    displaySticker(stickerId: StickerId): void {
        // Remove existing sticker if any
        if (this.activeStickerDisplay) {
            this.activeStickerDisplay.destroy();
            this.activeStickerDisplay = undefined;
        }

        const sprite = this.config.playerSprite;
        if (!sprite) return;

        const textureKey = `sticker_${stickerId}`;
        if (!this.scene.textures.exists(textureKey)) return;

        // Create container for sticker
        const container = this.scene.add.container(sprite.x, sprite.y - 150);
        container.setDepth(1000);

        // Sticker image
        const stickerImg = this.scene.add.image(0, 0, textureKey);
        const targetSize = 80;
        const scale = Math.min(targetSize / stickerImg.width, targetSize / stickerImg.height);
        stickerImg.setScale(scale);
        container.add(stickerImg);

        this.activeStickerDisplay = container;

        // Pop-in animation
        container.setScale(0);
        this.scene.tweens.add({
            targets: container,
            scaleX: 1,
            scaleY: 1,
            duration: 300,
            ease: "Back.easeOut",
        });

        // Swaying animation
        this.scene.tweens.add({
            targets: container,
            y: container.y - 8,
            angle: { from: -5, to: 5 },
            duration: 800,
            yoyo: true,
            repeat: -1,
            ease: "Sine.easeInOut",
        });

        // Fade out and destroy after display duration
        this.scene.time.delayedCall(this.stickerDisplayDuration, () => {
            if (container && container.active) {
                this.scene.tweens.add({
                    targets: container,
                    alpha: 0,
                    y: container.y - 30,
                    duration: 400,
                    ease: "Quad.easeIn",
                    onComplete: () => {
                        container.destroy();
                        if (this.activeStickerDisplay === container) {
                            this.activeStickerDisplay = undefined;
                        }
                    },
                });
            }
        });
    }

    /**
     * Start the cooldown period
     */
    private startCooldown(): void {
        this.isOnCooldown = true;

        // Show cooldown overlay
        this.cooldownOverlay.setVisible(true);
        this.cooldownText.setVisible(true);

        let remaining = this.cooldownDuration / 1000;
        this.updateCooldownDisplay(remaining);

        // Countdown timer
        const timer = this.scene.time.addEvent({
            delay: 1000,
            repeat: this.cooldownDuration / 1000 - 1,
            callback: () => {
                remaining--;
                this.updateCooldownDisplay(remaining);
            },
        });

        // End cooldown
        this.scene.time.delayedCall(this.cooldownDuration, () => {
            this.isOnCooldown = false;
            this.cooldownOverlay.setVisible(false);
            this.cooldownText.setVisible(false);
        });
    }

    /**
     * Update the cooldown display
     */
    private updateCooldownDisplay(seconds: number): void {
        this.cooldownOverlay.clear();
        this.cooldownOverlay.fillStyle(0x000000, 0.6);
        this.cooldownOverlay.fillCircle(0, 0, this.BUTTON_SIZE / 2 - 2);
        this.cooldownText.setText(`${Math.ceil(seconds)}`);
    }

    /**
     * Clean up resources
     */
    destroy(): void {
        if (this.activeStickerDisplay) {
            this.activeStickerDisplay.destroy();
        }
        super.destroy();
    }
}
