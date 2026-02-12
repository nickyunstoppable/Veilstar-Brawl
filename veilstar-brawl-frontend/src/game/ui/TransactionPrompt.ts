/**
 * TransactionPrompt - Modal overlay to instruct users to sign transactions
 * Explains that this is a self-transaction for verification purposes
 */

import Phaser from "phaser";
import { GAME_DIMENSIONS } from "../config";
import { TextFactory } from "./TextFactory";

export class TransactionPrompt extends Phaser.GameObjects.Container {
    private background!: Phaser.GameObjects.Graphics;
    private overlay!: Phaser.GameObjects.Graphics;
    private titleText!: Phaser.GameObjects.Text;
    private messageText!: Phaser.GameObjects.Text;
    private subText!: Phaser.GameObjects.Text;
    private spinner!: Phaser.GameObjects.Graphics;
    private spinnerTween?: Phaser.Tweens.Tween;

    private readonly MODAL_WIDTH = 500;
    private readonly MODAL_HEIGHT = 280;
    private readonly PADDING = 24;

    constructor(scene: Phaser.Scene) {
        super(scene, GAME_DIMENSIONS.WIDTH / 2, GAME_DIMENSIONS.HEIGHT / 2);

        this.createOverlay();
        this.createModal();
        this.createContent();
        this.createSpinner();

        // Start hidden
        this.setAlpha(0);
        this.setVisible(false);
        this.setDepth(5000); // Above PowerSurgeCards (4001) and Toast

        scene.add.existing(this);
    }

    private createOverlay(): void {
        // Full screen dimmer
        this.overlay = this.scene.add.graphics();
        this.overlay.fillStyle(0x000000, 0.7);
        this.overlay.fillRect(
            -GAME_DIMENSIONS.WIDTH / 2,
            -GAME_DIMENSIONS.HEIGHT / 2,
            GAME_DIMENSIONS.WIDTH,
            GAME_DIMENSIONS.HEIGHT
        );
        this.add(this.overlay);

        // Block interaction below
        this.overlay.setInteractive(
            new Phaser.Geom.Rectangle(
                -GAME_DIMENSIONS.WIDTH / 2,
                -GAME_DIMENSIONS.HEIGHT / 2,
                GAME_DIMENSIONS.WIDTH,
                GAME_DIMENSIONS.HEIGHT
            ),
            Phaser.Geom.Rectangle.Contains
        );
    }

    private createModal(): void {
        this.background = this.scene.add.graphics();

        // Main modal bg
        this.background.fillStyle(0x18181b, 0.95);
        this.background.fillRoundedRect(
            -this.MODAL_WIDTH / 2,
            -this.MODAL_HEIGHT / 2,
            this.MODAL_WIDTH,
            this.MODAL_HEIGHT,
            16
        );

        // Border
        this.background.lineStyle(2, 0xf97316, 1); // Orange border
        this.background.strokeRoundedRect(
            -this.MODAL_WIDTH / 2,
            -this.MODAL_HEIGHT / 2,
            this.MODAL_WIDTH,
            this.MODAL_HEIGHT,
            16
        );

        this.add(this.background);
    }

    private createContent(): void {
        // Title
        this.titleText = TextFactory.createTitle(
            this.scene,
            0,
            -this.MODAL_HEIGHT / 2 + 40,
            "ACTION REQUIRED"
        );
        this.titleText.setOrigin(0.5);
        this.titleText.setFontSize(28);
        this.titleText.setColor("#f97316"); // Orange
        this.add(this.titleText);

        // Message
        this.messageText = this.scene.add.text(
            0,
            -20,
            "Every move is a blockchain transaction.\nSign to continue.",
            {
                fontFamily: "Orbitron, Arial",
                fontSize: "18px",
                color: "#ffffff",
                align: "center",
                wordWrap: { width: this.MODAL_WIDTH - this.PADDING * 2 }
            }
        );
        this.messageText.setOrigin(0.5);
        this.add(this.messageText);

        // Explainer subtext
        this.subText = this.scene.add.text(
            0,
            60,
            "NOTE: You are sending 1 KAS to yourself.\nYou ONLY pay for gas fees (negligible).",
            {
                fontFamily: "Arial",
                fontSize: "14px",
                color: "#40e0d0", // Cyan/Teal
                align: "center",
                fontStyle: "italic",
                wordWrap: { width: this.MODAL_WIDTH - this.PADDING * 2 }
            }
        );
        this.subText.setOrigin(0.5);
        this.add(this.subText);
    }

    private createSpinner(): void {
        // Use Graphics for a clean open arc (no closure lines)
        this.spinner = this.scene.add.graphics();

        const radius = 15;
        const color = 0xf97316;
        const thickness = 4;
        const startAngle = Phaser.Math.DegToRad(0);
        const endAngle = Phaser.Math.DegToRad(300);

        this.spinner.lineStyle(thickness, color);
        this.spinner.beginPath();
        this.spinner.arc(0, 0, radius, startAngle, endAngle, false);
        this.spinner.strokePath();

        // Position manually since graphics origin is 0,0
        this.spinner.setPosition(0, 100);

        this.add(this.spinner);

        this.spinnerTween = this.scene.tweens.add({
            targets: this.spinner,
            angle: 360,
            duration: 1000,
            repeat: -1
        });
    }

    public show(message?: string): void {
        if (message) {
            this.messageText.setText(message);
        } else {
            this.messageText.setText("Every move is a blockchain transaction.\nSign to continue.");
        }

        this.setVisible(true);

        // Pop in animation
        this.setScale(0.9);
        this.setAlpha(0);

        this.scene.tweens.add({
            targets: this,
            scale: 1,
            alpha: 1,
            duration: 200,
            ease: "Back.easeOut"
        });
    }

    public hide(): void {
        this.scene.tweens.add({
            targets: this,
            scale: 0.9,
            alpha: 0,
            duration: 200,
            ease: "Power2",
            onComplete: () => {
                this.setVisible(false);
            }
        });
    }
}
