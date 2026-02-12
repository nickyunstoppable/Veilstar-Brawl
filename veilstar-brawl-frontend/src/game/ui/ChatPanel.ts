/**
 * ChatPanel - In-game chat UI component for FightScene
 * Displays quick-chat messages between players during a match
 */

import Phaser from "phaser";
import { GAME_DIMENSIONS } from "../config";

/**
 * Chat message structure for display
 */
interface ChatMessage {
    sender: "player1" | "player2" | "system";
    message: string;
    timestamp: number;
    textObject?: Phaser.GameObjects.Text;
}

/**
 * Quick chat preset options
 */
export const QUICK_CHAT_PRESETS = [
    { id: "gg", label: "GG", message: "GG" },
    { id: "nice", label: "Nice!", message: "Nice!" },
    { id: "glhf", label: "GL HF", message: "GL HF" },
    { id: "ouch", label: "Ouch!", message: "Ouch!" },
    { id: "block", label: "Block!", message: "Block!" },
    { id: "cool", label: "😎", message: "😎" },
] as const;

/**
 * ChatPanel configuration
 */
interface ChatPanelConfig {
    x: number;
    y: number;
    width: number;
    height: number;
    playerRole: "player1" | "player2";
    onSendMessage: (message: string) => void;
}

/**
 * ChatPanel class - Phaser container for in-game chat
 */
export class ChatPanel extends Phaser.GameObjects.Container {
    private config: ChatPanelConfig;
    private messages: ChatMessage[] = [];
    private messageContainer!: Phaser.GameObjects.Container;
    private quickChatContainer!: Phaser.GameObjects.Container;
    private inputContainer!: Phaser.GameObjects.Container;
    private background!: Phaser.GameObjects.Graphics;
    private panelTitle!: Phaser.GameObjects.Text;
    private toggleButton!: Phaser.GameObjects.Container;
    private collapsedIcon!: Phaser.GameObjects.Container;
    private isExpanded: boolean = true;
    private customInputText: string = "";
    private inputDisplay!: Phaser.GameObjects.Text;
    private inputBackground!: Phaser.GameObjects.Graphics;
    private readonly MAX_MESSAGES = 5;
    private readonly MESSAGE_FADE_TIME = 10000; // 10 seconds
    private readonly PANEL_WIDTH = 220;
    private readonly PANEL_HEIGHT = 320;
    private readonly MAX_INPUT_LENGTH = 50;

    constructor(scene: Phaser.Scene, config: ChatPanelConfig) {
        super(scene, config.x, config.y);
        this.config = config;

        this.createBackground();
        this.createMessageArea();
        this.createCustomInput();
        this.createQuickChatButtons();
        this.createToggleButton();
        this.createCollapsedIcon();

        scene.add.existing(this);
        this.setDepth(100);
    }

    /**
     * Create semi-transparent background
     */
    private createBackground(): void {
        this.background = this.scene.add.graphics();
        this.background.fillStyle(0x1a1a2e, 0.9);
        this.background.fillRoundedRect(0, 0, this.PANEL_WIDTH, this.PANEL_HEIGHT, 12);
        this.background.lineStyle(2, 0x40e0d0, 0.5);
        this.background.strokeRoundedRect(0, 0, this.PANEL_WIDTH, this.PANEL_HEIGHT, 12);
        this.add(this.background);

        // Panel title
        // Panel title
        this.panelTitle = this.scene.add.text(10, 8, "💬 Chat", {
            fontFamily: "Orbitron, sans-serif",
            fontSize: "14px",
            color: "#40e0d0",
            fontStyle: "bold",
        });
        this.add(this.panelTitle);
    }

    /**
     * Create message display area
     */
    private createMessageArea(): void {
        this.messageContainer = this.scene.add.container(10, 32);
        this.add(this.messageContainer);
    }

    /**
     * Create custom message input area
     */
    private createCustomInput(): void {
        this.inputContainer = this.scene.add.container(10, this.PANEL_HEIGHT - 140);
        this.add(this.inputContainer);

        // Input background
        this.inputBackground = this.scene.add.graphics();
        this.inputBackground.fillStyle(0x2d3748, 0.9);
        this.inputBackground.fillRoundedRect(0, 0, this.PANEL_WIDTH - 20, 32, 6);
        this.inputBackground.lineStyle(1, 0x4a5568, 0.8);
        this.inputBackground.strokeRoundedRect(0, 0, this.PANEL_WIDTH - 20, 32, 6);
        this.inputContainer.add(this.inputBackground);

        // Input text display
        this.inputDisplay = this.scene.add.text(8, 8, "Type message...", {
            fontFamily: "monospace",
            fontSize: "11px",
            color: "#718096",
        });
        this.inputContainer.add(this.inputDisplay);

        // Make input area interactive for focus
        const inputHitArea = this.scene.add.rectangle(
            (this.PANEL_WIDTH - 20) / 2,
            16,
            this.PANEL_WIDTH - 20,
            32,
            0x000000,
            0
        );
        inputHitArea.setInteractive({ useHandCursor: true });
        this.inputContainer.add(inputHitArea);

        inputHitArea.on("pointerdown", () => {
            this.openTextInput();
        });

        // Send button - positioned inside the panel
        const sendBtn = this.createSendButton(this.PANEL_WIDTH - 65, 2);
        this.inputContainer.add(sendBtn);
    }

    /**
     * Open browser text input for mobile/complex input
     */
    private openTextInput(): void {
        const input = document.createElement("input");
        input.type = "text";
        input.maxLength = this.MAX_INPUT_LENGTH;
        input.value = this.customInputText;
        input.placeholder = "Type message...";
        input.style.position = "fixed";
        input.style.bottom = "20px";
        input.style.right = "20px";
        input.style.width = "200px";
        input.style.padding = "10px";
        input.style.fontSize = "16px";
        input.style.borderRadius = "8px";
        input.style.border = "2px solid #40e0d0";
        input.style.backgroundColor = "#1a1a2e";
        input.style.color = "#fff";
        input.style.zIndex = "10000";

        document.body.appendChild(input);
        input.focus();

        let isRemoved = false;

        const removeInput = () => {
            if (!isRemoved && input.parentNode) {
                isRemoved = true;
                input.remove();
            }
        };

        const handleSubmit = () => {
            this.customInputText = input.value.trim();
            this.updateInputDisplay();
            if (this.customInputText.length > 0) {
                this.sendCustomMessage();
            }
            removeInput();
        };

        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                handleSubmit();
            } else if (e.key === "Escape") {
                removeInput();
            }
        });

        input.addEventListener("blur", () => {
            this.customInputText = input.value.trim();
            this.updateInputDisplay();
            removeInput();
        });
    }

    /**
     * Update input display text
     */
    private updateInputDisplay(): void {
        if (this.customInputText.length === 0) {
            this.inputDisplay.setText("Type message...");
            this.inputDisplay.setColor("#718096");
        } else {
            this.inputDisplay.setText(this.customInputText);
            this.inputDisplay.setColor("#e2e8f0");
        }
    }

    /**
     * Send custom message
     */
    private sendCustomMessage(): void {
        if (this.customInputText.length > 0) {
            this.config.onSendMessage(this.customInputText);
            this.customInputText = "";
            this.updateInputDisplay();
        }
    }

    /**
     * Create send button
     */
    private createSendButton(x: number, y: number): Phaser.GameObjects.Container {
        const container = this.scene.add.container(x, y);
        const width = 45;
        const height = 28;

        const bg = this.scene.add.graphics();
        bg.fillStyle(0x40e0d0, 0.3);
        bg.fillRoundedRect(0, 0, width, height, 6);
        bg.lineStyle(1, 0x40e0d0, 0.8);
        bg.strokeRoundedRect(0, 0, width, height, 6);
        container.add(bg);

        const text = this.scene.add.text(width / 2, height / 2, "Send", {
            fontFamily: "monospace",
            fontSize: "10px",
            color: "#40e0d0",
            fontStyle: "bold",
        }).setOrigin(0.5);
        container.add(text);

        container.setSize(width, height);
        container.setInteractive({ useHandCursor: true });

        container.on("pointerover", () => {
            bg.clear();
            bg.fillStyle(0x40e0d0, 0.5);
            bg.fillRoundedRect(0, 0, width, height, 6);
            bg.lineStyle(1, 0x40e0d0, 1);
            bg.strokeRoundedRect(0, 0, width, height, 6);
        });

        container.on("pointerout", () => {
            bg.clear();
            bg.fillStyle(0x40e0d0, 0.3);
            bg.fillRoundedRect(0, 0, width, height, 6);
            bg.lineStyle(1, 0x40e0d0, 0.8);
            bg.strokeRoundedRect(0, 0, width, height, 6);
        });

        container.on("pointerdown", () => {
            this.sendCustomMessage();
        });

        return container;
    }

    /**
     * Create quick-chat preset buttons
     */
    private createQuickChatButtons(): void {
        this.quickChatContainer = this.scene.add.container(10, this.PANEL_HEIGHT - 100);
        this.add(this.quickChatContainer);

        const buttonWidth = 64;
        const buttonHeight = 28;
        const padding = 4;
        const buttonsPerRow = 3;

        QUICK_CHAT_PRESETS.forEach((preset, index) => {
            const row = Math.floor(index / buttonsPerRow);
            const col = index % buttonsPerRow;
            const x = col * (buttonWidth + padding);
            const y = row * (buttonHeight + padding);

            const button = this.createQuickChatButton(x, y, buttonWidth, buttonHeight, preset);
            this.quickChatContainer.add(button);
        });
    }

    /**
     * Create individual quick-chat button
     */
    private createQuickChatButton(
        x: number,
        y: number,
        width: number,
        height: number,
        preset: typeof QUICK_CHAT_PRESETS[number]
    ): Phaser.GameObjects.Container {
        const container = this.scene.add.container(x, y);

        // Button background
        const bg = this.scene.add.graphics();
        bg.fillStyle(0x2d3748, 0.9);
        bg.fillRoundedRect(0, 0, width, height, 6);
        bg.lineStyle(1, 0x4a5568, 0.8);
        bg.strokeRoundedRect(0, 0, width, height, 6);
        container.add(bg);

        // Button text
        const text = this.scene.add.text(width / 2, height / 2, preset.label, {
            fontFamily: "monospace",
            fontSize: "11px",
            color: "#e2e8f0",
        }).setOrigin(0.5);
        container.add(text);

        // Create explicit hitbox rectangle offset to the right for proper hit detection
        const hitbox = new Phaser.Geom.Rectangle(20, 0, width, height);
        container.setSize(width, height);
        container.setInteractive({ hitArea: hitbox, hitAreaCallback: Phaser.Geom.Rectangle.Contains, useHandCursor: true });

        // Hover effects
        container.on("pointerover", () => {
            bg.clear();
            bg.fillStyle(0x4a5568, 0.95);
            bg.fillRoundedRect(0, 0, width, height, 6);
            bg.lineStyle(1, 0x40e0d0, 0.9);
            bg.strokeRoundedRect(0, 0, width, height, 6);
            text.setColor("#40e0d0");
        });

        container.on("pointerout", () => {
            bg.clear();
            bg.fillStyle(0x2d3748, 0.9);
            bg.fillRoundedRect(0, 0, width, height, 6);
            bg.lineStyle(1, 0x4a5568, 0.8);
            bg.strokeRoundedRect(0, 0, width, height, 6);
            text.setColor("#e2e8f0");
        });

        container.on("pointerdown", () => {
            // Visual feedback
            bg.clear();
            bg.fillStyle(0x40e0d0, 0.3);
            bg.fillRoundedRect(0, 0, width, height, 6);
            bg.lineStyle(1, 0x40e0d0, 1);
            bg.strokeRoundedRect(0, 0, width, height, 6);

            // Send message
            this.config.onSendMessage(preset.message);

            // Reset after brief delay
            this.scene.time.delayedCall(150, () => {
                bg.clear();
                bg.fillStyle(0x2d3748, 0.9);
                bg.fillRoundedRect(0, 0, width, height, 6);
                bg.lineStyle(1, 0x4a5568, 0.8);
                bg.strokeRoundedRect(0, 0, width, height, 6);
                text.setColor("#e2e8f0");
            });
        });

        return container;
    }

    /**
     * Create toggle button to collapse/expand panel
     */
    private createToggleButton(): void {
        this.toggleButton = this.scene.add.container(this.PANEL_WIDTH - 30, 6);

        const bg = this.scene.add.graphics();
        bg.fillStyle(0x2d3748, 0.8);
        bg.fillCircle(10, 10, 10);
        this.toggleButton.add(bg);

        const icon = this.scene.add.text(10, 10, "−", {
            fontFamily: "monospace",
            fontSize: "16px",
            color: "#a0aec0",
            fontStyle: "bold",
        }).setOrigin(0.5);
        this.toggleButton.add(icon);

        // Explicit hitbox offset to the right for proper alignment
        const hitbox = new Phaser.Geom.Rectangle(10, 0, 20, 20);
        this.toggleButton.setSize(20, 20);
        this.toggleButton.setInteractive({ hitArea: hitbox, hitAreaCallback: Phaser.Geom.Rectangle.Contains, useHandCursor: true });

        this.toggleButton.on("pointerover", () => {
            bg.clear();
            bg.fillStyle(0x4a5568, 0.9);
            bg.fillCircle(10, 10, 10);
            icon.setColor("#40e0d0");
        });

        this.toggleButton.on("pointerout", () => {
            bg.clear();
            bg.fillStyle(0x2d3748, 0.8);
            bg.fillCircle(10, 10, 10);
            icon.setColor("#a0aec0");
        });

        this.toggleButton.on("pointerdown", () => {
            this.togglePanel();
        });

        this.add(this.toggleButton);
    }

    /**
     * Create collapsed icon button (FAB style)
     */
    private createCollapsedIcon(): void {
        // Position at bottom right of the panel area
        this.collapsedIcon = this.scene.add.container(this.PANEL_WIDTH - 25, this.PANEL_HEIGHT - 25);

        // Circular background
        const bg = this.scene.add.graphics();
        bg.fillStyle(0x2d3748, 0.9);
        bg.fillCircle(0, 0, 20);
        bg.lineStyle(2, 0x40e0d0, 0.8);
        bg.strokeCircle(0, 0, 20);
        this.collapsedIcon.add(bg);

        // Chat icon text
        const icon = this.scene.add.text(0, 0, "💬", {
            fontSize: "20px",
        }).setOrigin(0.5);
        this.collapsedIcon.add(icon);

        // Interaction
        this.collapsedIcon.setSize(40, 40);
        this.collapsedIcon.setInteractive({ useHandCursor: true });

        // Hover effects
        this.collapsedIcon.on("pointerover", () => {
            bg.clear();
            bg.fillStyle(0x4a5568, 0.95);
            bg.fillCircle(0, 0, 20);
            bg.lineStyle(2, 0x40e0d0, 1);
            bg.strokeCircle(0, 0, 20);
        });

        this.collapsedIcon.on("pointerout", () => {
            bg.clear();
            bg.fillStyle(0x2d3748, 0.9);
            bg.fillCircle(0, 0, 20);
            bg.lineStyle(2, 0x40e0d0, 0.8);
            bg.strokeCircle(0, 0, 20);
        });

        this.collapsedIcon.on("pointerdown", () => {
            this.togglePanel();
        });

        // Initially hidden
        this.collapsedIcon.setAlpha(0);
        this.collapsedIcon.setVisible(false);
        this.add(this.collapsedIcon);
    }

    /**
     * Toggle panel visibility
     */
    private togglePanel(): void {
        this.isExpanded = !this.isExpanded;

        if (this.isExpanded) {
            // Expand: Show panel contents, hide collapsed icon
            this.collapsedIcon.setVisible(false);
            this.background.setVisible(true);
            this.panelTitle.setVisible(true);
            this.toggleButton.setVisible(true);
            this.messageContainer.setVisible(true);
            this.quickChatContainer.setVisible(true);
            this.inputContainer.setVisible(true);

            this.scene.tweens.add({
                targets: [this.background, this.panelTitle, this.messageContainer, this.quickChatContainer, this.inputContainer, this.toggleButton],
                alpha: 1,
                duration: 200,
                ease: "Power2",
            });

            this.scene.tweens.add({
                targets: this.collapsedIcon,
                alpha: 0,
                duration: 200,
            });

        } else {
            // Collapse: Hide panel contents, show collapsed icon
            this.collapsedIcon.setVisible(true);

            this.scene.tweens.add({
                targets: [this.background, this.panelTitle, this.messageContainer, this.quickChatContainer, this.inputContainer, this.toggleButton],
                alpha: 0,
                duration: 200,
                ease: "Power2",
                onComplete: () => {
                    if (!this.isExpanded) {
                        this.background.setVisible(false);
                        this.panelTitle.setVisible(false);
                        this.toggleButton.setVisible(false);
                        this.messageContainer.setVisible(false);
                        this.quickChatContainer.setVisible(false);
                        this.inputContainer.setVisible(false);
                    }
                }
            });

            this.scene.tweens.add({
                targets: this.collapsedIcon,
                alpha: 1,
                duration: 200,
            });
        }
    }

    /**
     * Add a new chat message to display
     */
    public addMessage(sender: "player1" | "player2" | "system", message: string, timestamp: number): void {
        const isOwnMessage = sender === this.config.playerRole;

        // Create message text
        const senderLabel = sender === "system" ? "⚡" : (isOwnMessage ? "You" : "Opp");
        const color = sender === "system" ? "#f59e0b" : (isOwnMessage ? "#40e0d0" : "#f472b6");

        const displayMessage = message.length > 25 ? message.substring(0, 25) + "..." : message;

        const messageText = this.scene.add.text(0, 0, `${senderLabel}: ${displayMessage}`, {
            fontFamily: "monospace",
            fontSize: "11px",
            color: color,
            wordWrap: { width: this.PANEL_WIDTH - 20 },
        });

        const chatMessage: ChatMessage = {
            sender,
            message,
            timestamp,
            textObject: messageText,
        };

        this.messages.push(chatMessage);
        this.messageContainer.add(messageText);

        // Limit messages
        if (this.messages.length > this.MAX_MESSAGES) {
            const oldest = this.messages.shift();
            if (oldest?.textObject) {
                oldest.textObject.destroy();
            }
        }

        // Reposition all messages
        this.repositionMessages();

        // Schedule fade out
        this.scene.time.delayedCall(this.MESSAGE_FADE_TIME, () => {
            this.fadeOutMessage(chatMessage);
        });
    }

    /**
     * Reposition all messages in the display area
     */
    private repositionMessages(): void {
        let yOffset = 0;
        const lineHeight = 18;

        this.messages.forEach((msg) => {
            if (msg.textObject) {
                msg.textObject.setY(yOffset);
                yOffset += lineHeight;
            }
        });
    }

    /**
     * Fade out and remove a message
     */
    private fadeOutMessage(chatMessage: ChatMessage): void {
        const index = this.messages.indexOf(chatMessage);
        if (index === -1) return; // Already removed

        if (chatMessage.textObject) {
            this.scene.tweens.add({
                targets: chatMessage.textObject,
                alpha: 0,
                duration: 500,
                onComplete: () => {
                    if (chatMessage.textObject) {
                        chatMessage.textObject.destroy();
                    }
                    const idx = this.messages.indexOf(chatMessage);
                    if (idx !== -1) {
                        this.messages.splice(idx, 1);
                    }
                    this.repositionMessages();
                },
            });
        }
    }

    /**
     * Clean up resources
     */
    public destroy(): void {
        this.messages.forEach((msg) => {
            if (msg.textObject) {
                msg.textObject.destroy();
            }
        });
        this.messages = [];
        super.destroy();
    }
}
