/**
 * CharacterSelectScene — Phaser-based Ban → Pick → Reveal character selection
 * Adapted from KaspaClash's CharacterSelectScene for Veilstar Brawl
 *
 * Phases: BANNING → TRANSITION → PICKING → REVEAL → FightScene
 * All UI is drawn with Phaser primitives (no external UI component deps).
 * Deadline-based timers via Date.now() so they work when the tab is backgrounded.
 */

import Phaser from "phaser";
import { EventBus } from "@/game/EventBus";
import { GAME_DIMENSIONS } from "@/game/config";
import { CHARACTER_ROSTER, getCharacter, getRandomCharacter } from "@/data/characters";
import type { Character } from "@/types/game";

// =============================================================================
// TYPES
// =============================================================================

export interface CharacterSelectSceneConfig {
    matchId: string;
    playerAddress: string;
    opponentAddress: string;
    isHost: boolean;
    selectionTimeLimit?: number;
    selectionDeadlineAt?: string;
    existingPlayerCharacter?: string | null;
    existingOpponentCharacter?: string | null;
    existingPlayerBan?: string | null;
    existingOpponentBan?: string | null;
    isBot?: boolean;
    botBanId?: string | null;
}

export type SelectionPhase = "BANNING" | "TRANSITION" | "PICKING" | "REVEAL";

// =============================================================================
// SCENE
// =============================================================================

export class CharacterSelectScene extends Phaser.Scene {
    // Config
    private config!: CharacterSelectSceneConfig;

    // Phase state
    private phase: SelectionPhase = "BANNING";
    private selectedCharacter: Character | null = null;
    private confirmedCharacter: Character | null = null;
    private opponentCharacter: Character | null = null;
    private isConfirmed = false;

    // Ban state
    private myBan: Character | null = null;
    private opponentBan: Character | null = null;
    private bannedCharacters = new Set<string>();
    private hasLockedBan = false;
    private hasOpponentLockedBan = false;

    // Deadline-based timers (Date.now ms)
    private botBanRevealAt = 0;
    private banToPickTransitionAt = 0;
    private botPickAt = 0;
    private revealBothReadyAt = 0;
    private matchStartTransitionAt = 0;
    private timerDeadlineAt = 0;

    // Bot
    private botBanTarget?: string;
    private botPickTarget?: string;

    // UI elements
    private titleText!: Phaser.GameObjects.Text;
    private instructionText!: Phaser.GameObjects.Text;
    private timerText!: Phaser.GameObjects.Text;
    private opponentStatusText!: Phaser.GameObjects.Text;
    private nameText!: Phaser.GameObjects.Text;
    private themeText!: Phaser.GameObjects.Text;
    private confirmBtn!: Phaser.GameObjects.Container;
    private confirmBtnBg!: Phaser.GameObjects.Graphics;
    private confirmBtnText!: Phaser.GameObjects.Text;
    private cardContainers: Phaser.GameObjects.Container[] = [];
    private cardCharacterMap: Map<Phaser.GameObjects.Container, Character> = new Map();
    private statBars!: Phaser.GameObjects.Container;

    // Layout
    private readonly CARD_W = 108;
    private readonly CARD_H = 130;
    private readonly CARD_GAP = 8;
    private readonly GRID_COLS = 10;
    private readonly GRID_Y = 370;

    // Visibility handler
    private visibilityHandler?: () => void;

    constructor() {
        super({ key: "CharacterSelectScene" });
    }

    // =========================================================================
    // LIFECYCLE
    // =========================================================================

    init(data: CharacterSelectSceneConfig): void {
        this.config = {
            matchId: data?.matchId || "unknown",
            playerAddress: data?.playerAddress || "",
            opponentAddress: data?.opponentAddress || "",
            isHost: data?.isHost ?? true,
            selectionTimeLimit: data?.selectionTimeLimit ?? 20,
            selectionDeadlineAt: data?.selectionDeadlineAt,
            existingPlayerCharacter: data?.existingPlayerCharacter,
            existingOpponentCharacter: data?.existingOpponentCharacter,
            existingPlayerBan: data?.existingPlayerBan,
            existingOpponentBan: data?.existingOpponentBan,
            isBot: data?.isBot,
            botBanId: data?.botBanId,
        };
        this.resetState();
    }

    private resetState(): void {
        this.phase = "BANNING";
        this.selectedCharacter = null;
        this.confirmedCharacter = null;
        this.opponentCharacter = null;
        this.isConfirmed = false;
        this.myBan = null;
        this.opponentBan = null;
        this.bannedCharacters.clear();
        this.hasLockedBan = false;
        this.hasOpponentLockedBan = false;
        this.botBanRevealAt = 0;
        this.banToPickTransitionAt = 0;
        this.botPickAt = 0;
        this.revealBothReadyAt = 0;
        this.matchStartTransitionAt = 0;
        this.timerDeadlineAt = 0;
        this.cardContainers = [];
        this.cardCharacterMap = new Map();
    }

    preload(): void {
        for (const c of CHARACTER_ROSTER) {
            this.load.image(`portrait-${c.id}`, `/characters/${c.id}/portrait.webp`);
            this.load.image(`portrait-${c.id}-png`, `/characters/${c.id}/portrait.png`);
            this.load.image(`portrait-${c.id}-idle`, `/characters/${c.id}/idle.png`);
        }
    }

    create(): void {
        this.createBackground();
        this.createTitle();
        this.createTimer();
        this.createOpponentStatus();
        this.createNameDisplay();
        this.createStatBars();
        this.createCharacterGrid();
        this.createConfirmButton();
        this.createInstructions();
        this.setupEventListeners();
        this.setupVisibilityHandler();

        // Bot init
        if (this.config.isBot || !this.config.opponentAddress) {
            this.config.isBot = true;
            if (this.config.botBanId) {
                this.botBanTarget = this.config.botBanId;
            } else {
                const ids = CHARACTER_ROSTER.map((c) => c.id);
                this.botBanTarget = ids[Math.floor(Math.random() * ids.length)];
            }
            if (this.config.existingOpponentCharacter) {
                this.botPickTarget = this.config.existingOpponentCharacter;
            } else {
                const available = CHARACTER_ROSTER.filter((c) => c.id !== this.botBanTarget).map((c) => c.id);
                this.botPickTarget = available[Math.floor(Math.random() * available.length)];
            }
            if (!this.config.existingOpponentBan) {
                this.botBanRevealAt = Date.now() + 3000 + Math.random() * 3000;
            }
        }

        // Restore existing selections (reconnection)
        this.restoreExistingSelections();

        // Start timer
        this.startTimer(this.config.selectionTimeLimit ?? 20);

        EventBus.emit("character_select_ready", { matchId: this.config.matchId });
    }

    // =========================================================================
    // BACKGROUND
    // =========================================================================

    private createBackground(): void {
        const g = this.add.graphics();
        // Dark gradient
        g.fillGradientStyle(0x050505, 0x050505, 0x0a0a0a, 0x0a0a0a, 1);
        g.fillRect(0, 0, GAME_DIMENSIONS.WIDTH, GAME_DIMENSIONS.HEIGHT);
        // Subtle gold radial
        const r = this.add.graphics();
        r.fillStyle(0xf0b71f, 0.03);
        r.fillCircle(GAME_DIMENSIONS.CENTER_X, GAME_DIMENSIONS.CENTER_Y, 500);
        // Overlay
        const ov = this.add.graphics();
        ov.fillStyle(0x000000, 0.15);
        ov.fillRect(0, 0, GAME_DIMENSIONS.WIDTH, GAME_DIMENSIONS.HEIGHT);
    }

    // =========================================================================
    // TITLE
    // =========================================================================

    private createTitle(): void {
        this.titleText = this.add.text(GAME_DIMENSIONS.CENTER_X, 40, "BAN PHASE", {
            fontFamily: "Orbitron, sans-serif",
            fontSize: "32px",
            color: "#ef4444",
            fontStyle: "bold",
        }).setOrigin(0.5);

        // Match id label
        this.add.text(GAME_DIMENSIONS.CENTER_X, 75, `Match: ${this.config.matchId.slice(0, 8)}`, {
            fontFamily: "Orbitron, sans-serif",
            fontSize: "12px",
            color: "#555555",
        }).setOrigin(0.5);
    }

    // =========================================================================
    // TIMER
    // =========================================================================

    private createTimer(): void {
        this.timerText = this.add.text(GAME_DIMENSIONS.WIDTH - 80, 40, "20", {
            fontFamily: "Orbitron, sans-serif",
            fontSize: "36px",
            color: "#ffffff",
            fontStyle: "bold",
        }).setOrigin(0.5);
    }

    private startTimer(seconds: number): void {
        if (this.config.selectionDeadlineAt) {
            this.timerDeadlineAt = new Date(this.config.selectionDeadlineAt).getTime();
        } else {
            this.timerDeadlineAt = Date.now() + seconds * 1000;
        }
    }

    // =========================================================================
    // OPPONENT STATUS
    // =========================================================================

    private createOpponentStatus(): void {
        this.opponentStatusText = this.add.text(GAME_DIMENSIONS.WIDTH - 80, 80, "SELECTING...", {
            fontFamily: "Orbitron, sans-serif",
            fontSize: "10px",
            color: "#F0B71F",
        }).setOrigin(0.5);

        // Pulsing dot
        const dot = this.add.circle(GAME_DIMENSIONS.WIDTH - 130, 80, 4, 0xf0b71f);
        this.tweens.add({ targets: dot, alpha: { from: 1, to: 0.3 }, duration: 800, yoyo: true, repeat: -1 });
    }

    // =========================================================================
    // NAME DISPLAY (CENTER)
    // =========================================================================

    private createNameDisplay(): void {
        this.nameText = this.add.text(GAME_DIMENSIONS.CENTER_X, 220, "", {
            fontFamily: "Orbitron, sans-serif",
            fontSize: "40px",
            color: "#ffffff",
            fontStyle: "bold",
        }).setOrigin(0.5).setAlpha(0);

        this.themeText = this.add.text(GAME_DIMENSIONS.CENTER_X, 265, "", {
            fontFamily: "Arial, sans-serif",
            fontSize: "16px",
            color: "#aaaaaa",
            fontStyle: "italic",
        }).setOrigin(0.5).setAlpha(0);
    }

    private showCharacterInfo(char: Character): void {
        this.nameText.setText(char.name.toUpperCase()).setAlpha(1);
        this.themeText.setText(char.theme).setAlpha(1);
        this.tweens.add({
            targets: this.nameText,
            scale: { from: 1.1, to: 1 },
            duration: 200,
            ease: "Back.out",
        });
        this.updateStatBars(char);
    }

    // =========================================================================
    // STAT BARS
    // =========================================================================

    private createStatBars(): void {
        this.statBars = this.add.container(GAME_DIMENSIONS.CENTER_X, 310).setAlpha(0);
    }

    private updateStatBars(char: Character): void {
        this.statBars.removeAll(true);
        const stats = [
            { label: "SPD", val: char.archetype === "speed" ? 5 : char.archetype === "precision" ? 3 : char.archetype === "tech" ? 3 : 1 },
            { label: "PWR", val: char.archetype === "tank" ? 5 : char.archetype === "tech" ? 4 : char.archetype === "precision" ? 3 : 2 },
            { label: "DEF", val: char.archetype === "tank" ? 5 : char.archetype === "tech" ? 3 : 2 },
            { label: "TEC", val: char.archetype === "precision" ? 5 : char.archetype === "tech" ? 4 : char.archetype === "speed" ? 3 : 2 },
        ];
        const totalW = 300;
        const barH = 6;
        const gap = 18;
        stats.forEach((s, i) => {
            const y = i * gap;
            const label = this.add.text(-totalW / 2, y - 4, s.label, {
                fontFamily: "Orbitron, sans-serif", fontSize: "10px", color: "#888",
            });
            const bgBar = this.add.graphics().fillStyle(0x222222).fillRoundedRect(-totalW / 2 + 40, y, totalW - 40, barH, 3);
            const fillW = ((totalW - 40) * s.val) / 5;
            const fillBar = this.add.graphics().fillStyle(0xf0b71f).fillRoundedRect(-totalW / 2 + 40, y, fillW, barH, 3);
            this.statBars.add([label, bgBar, fillBar]);
        });
        this.statBars.setAlpha(1);
    }

    // =========================================================================
    // CHARACTER GRID
    // =========================================================================

    private createCharacterGrid(): void {
        const totalW = this.CARD_W * this.GRID_COLS + this.CARD_GAP * (this.GRID_COLS - 1);
        const startX = (GAME_DIMENSIONS.WIDTH - totalW) / 2;

        CHARACTER_ROSTER.forEach((char, idx) => {
            const col = idx % this.GRID_COLS;
            const row = Math.floor(idx / this.GRID_COLS);
            const x = startX + col * (this.CARD_W + this.CARD_GAP);
            const y = this.GRID_Y + row * (this.CARD_H + 12);

            const container = this.add.container(x, y);

            // Card background
            const bg = this.add.graphics();
            bg.fillStyle(0x111111, 1);
            bg.fillRoundedRect(0, 0, this.CARD_W, this.CARD_H, 8);
            bg.lineStyle(1.5, 0x333333, 1);
            bg.strokeRoundedRect(0, 0, this.CARD_W, this.CARD_H, 8);
            container.add(bg);

            // Portrait image — try various formats
            const portraitKey = this.textures.exists(`portrait-${char.id}`)
                ? `portrait-${char.id}`
                : this.textures.exists(`portrait-${char.id}-png`)
                ? `portrait-${char.id}-png`
                : this.textures.exists(`portrait-${char.id}-idle`)
                ? `portrait-${char.id}-idle`
                : null;

            if (portraitKey) {
                const img = this.add.image(this.CARD_W / 2, this.CARD_H / 2 - 10, portraitKey);
                img.setDisplaySize(this.CARD_W - 16, this.CARD_H - 36);
                container.add(img);
            }

            // Archetype color bar at bottom
            const color = Phaser.Display.Color.HexStringToColor(char.colors.primary).color;
            const bar = this.add.graphics().fillStyle(color, 0.7).fillRect(4, this.CARD_H - 22, this.CARD_W - 8, 3);
            container.add(bar);

            // Name label
            const nameLabel = this.add.text(this.CARD_W / 2, this.CARD_H - 12, char.name.split(" ")[0], {
                fontFamily: "Orbitron, sans-serif",
                fontSize: "9px",
                color: "#cccccc",
            }).setOrigin(0.5);
            container.add(nameLabel);

            // Make interactive
            container.setSize(this.CARD_W, this.CARD_H);
            container.setInteractive({ useHandCursor: true });

            container.on("pointerover", () => {
                if (!this.bannedCharacters.has(char.id)) {
                    this.showCharacterInfo(char);
                    bg.clear();
                    bg.fillStyle(0x1a1a1a, 1);
                    bg.fillRoundedRect(0, 0, this.CARD_W, this.CARD_H, 8);
                    bg.lineStyle(2, 0xf0b71f, 0.6);
                    bg.strokeRoundedRect(0, 0, this.CARD_W, this.CARD_H, 8);
                }
            });

            container.on("pointerout", () => {
                if (this.selectedCharacter?.id !== char.id) {
                    bg.clear();
                    bg.fillStyle(0x111111, 1);
                    bg.fillRoundedRect(0, 0, this.CARD_W, this.CARD_H, 8);
                    bg.lineStyle(1.5, 0x333333, 1);
                    bg.strokeRoundedRect(0, 0, this.CARD_W, this.CARD_H, 8);
                }
            });

            container.on("pointerdown", () => {
                this.onCardClick(char);
            });

            this.cardContainers.push(container);
            this.cardCharacterMap.set(container, char);
        });
    }

    // =========================================================================
    // CONFIRM BUTTON
    // =========================================================================

    private createConfirmButton(): void {
        const w = 200, h = 48;
        const x = GAME_DIMENSIONS.CENTER_X;
        const y = GAME_DIMENSIONS.HEIGHT - 60;

        this.confirmBtn = this.add.container(x, y);

        this.confirmBtnBg = this.add.graphics();
        this.confirmBtnBg.fillStyle(0xf0b71f, 1);
        this.confirmBtnBg.fillRoundedRect(-w / 2, -h / 2, w, h, 8);

        this.confirmBtnText = this.add.text(0, 0, "BAN CHARACTER", {
            fontFamily: "Orbitron, sans-serif",
            fontSize: "16px",
            color: "#000000",
            fontStyle: "bold",
        }).setOrigin(0.5);

        this.confirmBtn.add([this.confirmBtnBg, this.confirmBtnText]);
        this.confirmBtn.setSize(w, h);
        this.confirmBtn.setInteractive({ useHandCursor: true });

        this.confirmBtn.on("pointerover", () => {
            if (!this.isConfirmed && this.selectedCharacter) this.confirmBtn.setScale(1.05);
        });
        this.confirmBtn.on("pointerout", () => this.confirmBtn.setScale(1));
        this.confirmBtn.on("pointerdown", () => this.confirmSelection());

        this.confirmBtn.setVisible(false).setAlpha(0);
    }

    private showConfirmButton(): void {
        this.confirmBtn.setVisible(true);
        this.tweens.add({ targets: this.confirmBtn, alpha: 1, duration: 200, ease: "Power2" });
    }

    private hideConfirmButton(): void {
        this.tweens.add({
            targets: this.confirmBtn,
            alpha: 0,
            duration: 200,
            ease: "Power2",
            onComplete: () => this.confirmBtn.setVisible(false),
        });
    }

    // =========================================================================
    // INSTRUCTIONS
    // =========================================================================

    private createInstructions(): void {
        this.instructionText = this.add.text(
            GAME_DIMENSIONS.CENTER_X,
            GAME_DIMENSIONS.HEIGHT - 20,
            "Select a character to ban, then confirm",
            { fontFamily: "Orbitron, sans-serif", fontSize: "12px", color: "#666666" }
        ).setOrigin(0.5);
    }

    // =========================================================================
    // INPUT HANDLERS
    // =========================================================================

    private onCardClick(char: Character): void {
        if (this.isConfirmed) return;
        if (this.bannedCharacters.has(char.id)) return;

        // Deselect previous
        if (this.selectedCharacter) {
            this.updateCardVisual(this.selectedCharacter.id, false);
        }

        this.selectedCharacter = char;
        this.updateCardVisual(char.id, true);
        this.showCharacterInfo(char);
        this.showConfirmButton();
    }

    private updateCardVisual(charId: string, selected: boolean): void {
        const container = this.cardContainers.find((c) => this.cardCharacterMap.get(c)?.id === charId);
        if (!container) return;
        const bg = container.getAt(0) as Phaser.GameObjects.Graphics;
        bg.clear();
        if (selected) {
            bg.fillStyle(0x1a1500, 1);
            bg.fillRoundedRect(0, 0, this.CARD_W, this.CARD_H, 8);
            bg.lineStyle(2, 0xf0b71f, 1);
            bg.strokeRoundedRect(0, 0, this.CARD_W, this.CARD_H, 8);
        } else {
            bg.fillStyle(0x111111, 1);
            bg.fillRoundedRect(0, 0, this.CARD_W, this.CARD_H, 8);
            bg.lineStyle(1.5, 0x333333, 1);
            bg.strokeRoundedRect(0, 0, this.CARD_W, this.CARD_H, 8);
        }
    }

    private markCardBanned(charId: string): void {
        const container = this.cardContainers.find((c) => this.cardCharacterMap.get(c)?.id === charId);
        if (!container) return;

        container.disableInteractive();
        container.setAlpha(0.35);

        const bannedLabel = this.add.text(this.CARD_W / 2, this.CARD_H / 2, "BANNED", {
            fontFamily: "Orbitron, sans-serif",
            fontSize: "14px",
            color: "#ff0000",
            backgroundColor: "#000000cc",
            padding: { x: 4, y: 2 },
            fontStyle: "bold",
        }).setOrigin(0.5).setRotation(-0.2);
        container.add(bannedLabel);
    }

    // =========================================================================
    // CONFIRM SELECTION
    // =========================================================================

    private confirmSelection(): void {
        if (this.isConfirmed || !this.selectedCharacter) return;
        this.isConfirmed = true;

        if (this.phase === "BANNING") {
            // ---- BAN ----
            this.myBan = this.selectedCharacter;
            this.hasLockedBan = true;
            this.bannedCharacters.add(this.selectedCharacter.id);
            this.markCardBanned(this.selectedCharacter.id);

            EventBus.emit("game:sendBanConfirmed", { characterId: this.selectedCharacter.id });

            this.hideConfirmButton();
            this.instructionText.setText("Waiting for opponent to ban...");
            this.checkBanPhaseComplete();
            return;
        }

        // ---- PICK ----
        this.confirmedCharacter = this.selectedCharacter;

        // Lock card visually (green border)
        const container = this.cardContainers.find((c) => this.cardCharacterMap.get(c)?.id === this.selectedCharacter?.id);
        if (container) {
            const bg = container.getAt(0) as Phaser.GameObjects.Graphics;
            bg.clear();
            bg.fillStyle(0x0a1a0a, 1);
            bg.fillRoundedRect(0, 0, this.CARD_W, this.CARD_H, 8);
            bg.lineStyle(2.5, 0x22c55e, 1);
            bg.strokeRoundedRect(0, 0, this.CARD_W, this.CARD_H, 8);
        }

        // Disable all other cards
        this.cardContainers.forEach((c) => {
            const ch = this.cardCharacterMap.get(c);
            if (ch && ch.id !== this.selectedCharacter?.id) {
                c.disableInteractive();
                c.setAlpha(0.3);
            }
        });

        this.hideConfirmButton();
        this.timerText.setText("✓").setColor("#22c55e");
        this.instructionText.setText("Waiting for opponent...");

        EventBus.emit("selection_confirmed", { characterId: this.confirmedCharacter.id });
        this.checkBothReady();
    }

    // =========================================================================
    // BAN FLOW
    // =========================================================================

    private onOpponentBanConfirmed(characterId: string, playerRole?: string): void {
        const myRole = this.config.isHost ? "player1" : "player2";
        if (playerRole && playerRole === myRole) return;
        if (this.opponentBan?.id === characterId) return;

        const char = getCharacter(characterId);
        if (char) {
            this.opponentBan = char;
            this.bannedCharacters.add(characterId);
            this.markCardBanned(characterId);
        }
        this.hasOpponentLockedBan = true;
        this.checkBanPhaseComplete();
    }

    private checkBanPhaseComplete(): void {
        if (this.phase !== "BANNING") return;
        if (this.hasLockedBan && this.hasOpponentLockedBan) {
            this.phase = "TRANSITION";
            this.instructionText.setText("Ban Phase Complete. Prepare to Pick...");
            this.banToPickTransitionAt = Date.now() + Phaser.Math.Between(2000, 3500);
        }
    }

    private startPickPhase(): void {
        this.phase = "PICKING";
        this.isConfirmed = false;
        this.selectedCharacter = null;

        this.titleText.setText("CHOOSE YOUR FIGHTER").setColor("#F0B71F");
        this.instructionText.setText("Bans Locked! Choose your fighter (Blind Pick)").setColor("#888888");

        this.confirmBtnText.setText("LOCK IN");

        // Re-enable non-banned cards
        this.cardContainers.forEach((c) => {
            const ch = this.cardCharacterMap.get(c);
            if (ch && !this.bannedCharacters.has(ch.id)) {
                c.setInteractive({ useHandCursor: true });
                c.setAlpha(1);
            }
        });

        this.hideConfirmButton();
        this.startTimer(this.config.selectionTimeLimit ?? 20);

        if (this.config.isBot) {
            this.botPickAt = Date.now() + 3000 + Math.random() * 3000;
        }
    }

    // =========================================================================
    // PICK FLOW
    // =========================================================================

    private onOpponentConfirmed(characterId: string): void {
        const character = getCharacter(characterId);
        if (character) {
            this.opponentCharacter = character;
            this.opponentStatusText.setText("LOCKED IN").setColor("#22c55e");
        }
        this.checkBothReady();
    }

    private checkBothReady(): void {
        if (this.confirmedCharacter && this.opponentCharacter) {
            this.phase = "REVEAL";
            this.revealOpponent();
        }
    }

    private revealOpponent(): void {
        if (!this.opponentCharacter) return;
        this.opponentStatusText.setText(this.opponentCharacter.name.toUpperCase()).setColor("#E03609");
        this.instructionText.setText("Opponent Revealed!").setColor("#22c55e");
        this.revealBothReadyAt = Date.now() + 1500;
    }

    // =========================================================================
    // BOT LOGIC
    // =========================================================================

    private revealBotBan(): void {
        if (this.hasOpponentLockedBan || this.phase !== "BANNING") return;
        if (!this.botBanTarget) return;
        const botRole = this.config.isHost ? "player2" : "player1";
        this.onOpponentBanConfirmed(this.botBanTarget, botRole);
    }

    private performBotPick(): void {
        if (this.phase !== "PICKING" || this.opponentCharacter) return;
        const available = CHARACTER_ROSTER.filter((c) => !this.bannedCharacters.has(c.id)).map((c) => c.id);
        if (available.length === 0) return;
        let pickId = this.botPickTarget;
        if (!pickId || this.bannedCharacters.has(pickId)) {
            pickId = available[Math.floor(Math.random() * available.length)];
        }
        this.onOpponentConfirmed(pickId);
    }

    // =========================================================================
    // TIMER EXPIRATION
    // =========================================================================

    private onTimeUp(): void {
        if (this.isConfirmed) return;

        if (this.phase === "BANNING" && !this.myBan) {
            // Auto-ban random
            const available = CHARACTER_ROSTER.filter((c) => !this.bannedCharacters.has(c.id));
            this.selectedCharacter = available[Math.floor(Math.random() * available.length)];
        } else if (this.phase === "PICKING" && !this.confirmedCharacter) {
            // Auto-pick random
            const available = CHARACTER_ROSTER.filter((c) => !this.bannedCharacters.has(c.id));
            this.selectedCharacter = available[Math.floor(Math.random() * available.length)];
        }
        this.confirmSelection();
    }

    // =========================================================================
    // MATCH START & TRANSITION
    // =========================================================================

    private onMatchStarting(payload: { countdown: number; player1CharacterId?: string; player2CharacterId?: string }): void {
        const { countdown, player1CharacterId, player2CharacterId } = payload;

        if (player1CharacterId && player2CharacterId) {
            const oppId = this.config.isHost ? player2CharacterId : player1CharacterId;
            const myId = this.config.isHost ? player1CharacterId : player2CharacterId;

            if (!this.opponentCharacter) {
                const opp = getCharacter(oppId);
                if (opp) {
                    this.opponentCharacter = opp;
                    this.opponentStatusText.setText(opp.name.toUpperCase()).setColor("#E03609");
                }
            }
            if (!this.confirmedCharacter) {
                const me = getCharacter(myId);
                if (me) this.confirmedCharacter = me;
            }
        }

        this.instructionText.setText(`Match starting in ${countdown}...`).setColor("#22c55e");
        this.matchStartTransitionAt = Date.now() + countdown * 1000;
    }

    private transitionToFight(): void {
        this.cleanupListeners();
        this.scene.start("FightScene", {
            matchId: this.config.matchId,
            player1Address: this.config.isHost ? this.config.playerAddress : this.config.opponentAddress,
            player2Address: this.config.isHost ? this.config.opponentAddress : this.config.playerAddress,
            player1Character: this.config.isHost ? this.confirmedCharacter?.id : this.opponentCharacter?.id,
            player2Character: this.config.isHost ? this.opponentCharacter?.id : this.confirmedCharacter?.id,
            playerRole: this.config.isHost ? "player1" : "player2",
        });
    }

    // =========================================================================
    // RESTORE (RECONNECTION)
    // =========================================================================

    private restoreExistingSelections(): void {
        // Restore bans
        if (this.config.existingPlayerBan) {
            const c = getCharacter(this.config.existingPlayerBan);
            if (c) { this.myBan = c; this.hasLockedBan = true; this.bannedCharacters.add(c.id); this.markCardBanned(c.id); }
        }
        const oppBanId = this.config.existingOpponentBan || (this.config.isBot ? this.config.botBanId : null);
        if (oppBanId) {
            const c = getCharacter(oppBanId);
            if (c) { this.opponentBan = c; this.hasOpponentLockedBan = true; this.bannedCharacters.add(c.id); this.markCardBanned(c.id); }
        }

        const bothBansDone = this.hasLockedBan && this.hasOpponentLockedBan;
        if (bothBansDone && !this.config.existingPlayerCharacter) {
            this.phase = "PICKING";
            this.isConfirmed = false;
            this.titleText.setText("CHOOSE YOUR FIGHTER").setColor("#F0B71F");
            this.instructionText.setText("Bans Locked! Choose your fighter (Blind Pick)");
            this.confirmBtnText.setText("LOCK IN");
            this.cardContainers.forEach((c) => {
                const ch = this.cardCharacterMap.get(c);
                if (ch && !this.bannedCharacters.has(ch.id)) { c.setInteractive({ useHandCursor: true }); c.setAlpha(1); }
            });
        }

        // Restore picks
        if (this.config.existingPlayerCharacter) {
            const c = getCharacter(this.config.existingPlayerCharacter);
            if (c) {
                this.phase = "PICKING";
                this.selectedCharacter = c;
                this.confirmedCharacter = c;
                this.isConfirmed = true;
                this.updateCardVisual(c.id, true);
                this.cardContainers.forEach((ct) => {
                    const ch = this.cardCharacterMap.get(ct);
                    if (ch && ch.id !== c.id) { ct.disableInteractive(); ct.setAlpha(0.3); }
                });
                this.hideConfirmButton();
                this.timerText.setText("✓").setColor("#22c55e");
                this.instructionText.setText("Waiting for opponent...");
            }
        }
        if (this.config.existingOpponentCharacter && !this.config.isBot) {
            const c = getCharacter(this.config.existingOpponentCharacter);
            if (c) {
                this.opponentCharacter = c;
                this.opponentStatusText.setText("LOCKED IN").setColor("#22c55e");
            }
        }

        if (this.confirmedCharacter && this.opponentCharacter) {
            this.instructionText.setText("Both players ready!").setColor("#22c55e");
        }
    }

    // =========================================================================
    // EVENT LISTENERS
    // =========================================================================

    private setupEventListeners(): void {
        EventBus.on("opponent_character_confirmed", (data: unknown) => {
            const { characterId } = data as { characterId: string };
            this.onOpponentConfirmed(characterId);
        });
        EventBus.on("match_starting", (data: unknown) => {
            this.onMatchStarting(data as { countdown: number; player1CharacterId?: string; player2CharacterId?: string });
        });
        EventBus.on("game:banConfirmed", (data: unknown) => {
            const { characterId, player } = data as { characterId: string; player: string };
            this.onOpponentBanConfirmed(characterId, player);
        });
    }

    private cleanupListeners(): void {
        EventBus.off("opponent_character_confirmed");
        EventBus.off("match_starting");
        EventBus.off("game:banConfirmed");
        if (this.visibilityHandler) {
            document.removeEventListener("visibilitychange", this.visibilityHandler);
            this.visibilityHandler = undefined;
        }
    }

    // =========================================================================
    // VISIBILITY HANDLER
    // =========================================================================

    private setupVisibilityHandler(): void {
        this.visibilityHandler = () => {
            if (document.visibilityState === "visible") {
                this.update(0, 0);
            }
        };
        document.addEventListener("visibilitychange", this.visibilityHandler);
    }

    // =========================================================================
    // UPDATE LOOP
    // =========================================================================

    update(_time: number, _delta: number): void {
        const now = Date.now();

        // Timer display
        if (this.timerDeadlineAt > 0 && !this.isConfirmed) {
            const remaining = Math.max(0, Math.ceil((this.timerDeadlineAt - now) / 1000));
            this.timerText.setText(String(remaining));
            if (remaining <= 5) this.timerText.setColor("#ef4444");
            else if (remaining <= 10) this.timerText.setColor("#F0B71F");
            else this.timerText.setColor("#ffffff");
            if (remaining <= 0) { this.timerDeadlineAt = 0; this.onTimeUp(); }
        }

        // Bot ban reveal
        if (this.botBanRevealAt > 0 && now >= this.botBanRevealAt) {
            this.botBanRevealAt = 0;
            this.revealBotBan();
        }

        // Ban → Pick transition
        if (this.banToPickTransitionAt > 0 && now >= this.banToPickTransitionAt) {
            this.banToPickTransitionAt = 0;
            this.startPickPhase();
        }

        // Bot pick
        if (this.botPickAt > 0 && now >= this.botPickAt) {
            this.botPickAt = 0;
            this.performBotPick();
        }

        // Reveal → both_ready
        if (this.revealBothReadyAt > 0 && now >= this.revealBothReadyAt) {
            this.revealBothReadyAt = 0;
            EventBus.emit("both_ready", {
                player: this.confirmedCharacter!.id,
                opponent: this.opponentCharacter!.id,
            });
        }

        // Match start transition
        if (this.matchStartTransitionAt > 0 && now >= this.matchStartTransitionAt) {
            this.matchStartTransitionAt = 0;
            this.transitionToFight();
        }
    }

    // =========================================================================
    // SHUTDOWN
    // =========================================================================

    shutdown(): void {
        this.cleanupListeners();
    }
}
