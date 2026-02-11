import Phaser from "phaser";

/**
 * TextFactory - centralized text creation for consistent UI styling.
 */
export class TextFactory {
    static createNarrative(
        scene: Phaser.Scene,
        x: number,
        y: number,
        text: string
    ): Phaser.GameObjects.Text {
        return scene.add.text(x, y, text, {
            fontFamily: '"Segoe UI Black", "Arial Black", "Gadget", sans-serif',
            fontSize: "28px",
            color: "#ffffff",
            stroke: "#000000",
            strokeThickness: 6,
            align: "center",
            shadow: {
                offsetX: 2,
                offsetY: 2,
                color: "#000000",
                blur: 4,
                stroke: true,
                fill: true,
            },
            wordWrap: { width: 800 },
        });
    }

    static createTitle(
        scene: Phaser.Scene,
        x: number,
        y: number,
        text: string
    ): Phaser.GameObjects.Text {
        return scene.add.text(x, y, text, {
            fontFamily: '"Segoe UI Black", "Arial Black", "Impact", sans-serif',
            fontSize: "84px",
            color: "#ffffff",
            stroke: "#000000",
            strokeThickness: 8,
            align: "center",
            shadow: {
                offsetX: 4,
                offsetY: 4,
                color: "#000000",
                blur: 0,
                stroke: true,
                fill: true,
            },
            fontStyle: "bold",
        });
    }

    static createSubtitle(
        scene: Phaser.Scene,
        x: number,
        y: number,
        text: string
    ): Phaser.GameObjects.Text {
        return scene.add.text(x, y, text, {
            fontFamily: '"Segoe UI", "Tahoma", "Geneva", "Verdana", sans-serif',
            fontSize: "18px",
            color: "#e0e0e0",
            stroke: "#000000",
            strokeThickness: 3,
            align: "center",
            shadow: {
                offsetX: 1,
                offsetY: 1,
                color: "#000000",
                blur: 2,
                stroke: true,
                fill: true,
            },
            fontStyle: "bold",
        });
    }

    static createTimer(
        scene: Phaser.Scene,
        x: number,
        y: number,
        text: string
    ): Phaser.GameObjects.Text {
        return scene.add.text(x, y, text, {
            fontFamily: '"Consolas", "Courier New", monospace',
            fontSize: "32px",
            color: "#40e0d0",
            stroke: "#000000",
            strokeThickness: 4,
            shadow: {
                offsetX: 2,
                offsetY: 2,
                color: "#000000",
                blur: 2,
                stroke: true,
                fill: true,
            },
            fontStyle: "bold",
        });
    }

    static createScore(
        scene: Phaser.Scene,
        x: number,
        y: number,
        text: string
    ): Phaser.GameObjects.Text {
        return scene.add.text(x, y, text, {
            fontFamily: '"Segoe UI", "Verdana", sans-serif',
            fontSize: "18px",
            color: "#ffffff",
            stroke: "#000000",
            strokeThickness: 3,
            shadow: {
                offsetX: 1,
                offsetY: 1,
                color: "#000000",
                blur: 2,
                stroke: true,
                fill: true,
            },
            fontStyle: "bold",
        });
    }

    static createLabel(
        scene: Phaser.Scene,
        x: number,
        y: number,
        text: string,
        options?: Phaser.Types.GameObjects.Text.TextStyle
    ): Phaser.GameObjects.Text {
        return scene.add.text(x, y, text, {
            fontFamily: '"Segoe UI", "Verdana", sans-serif',
            fontSize: "16px",
            color: "#ffffff",
            stroke: "#000000",
            strokeThickness: 2,
            shadow: {
                offsetX: 1,
                offsetY: 1,
                color: "#000000",
                blur: 1,
                stroke: true,
                fill: true,
            },
            ...options,
        });
    }
}
