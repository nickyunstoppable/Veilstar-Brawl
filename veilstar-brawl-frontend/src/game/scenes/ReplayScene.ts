/**
 * ReplayScene - Replays a completed match from stored round data
 * Non-interactive playback of a full match for sharing / MP4 export
 */

import Phaser from "phaser";
import { EventBus } from "../EventBus";
import { GAME_DIMENSIONS, CHARACTER_POSITIONS, UI_POSITIONS } from "../config";
import { getCharacterScale, getCharacterYOffset, getSoundDelay, getSFXKey } from "../config/sprite-config";
import { CombatEngine } from "../combat";
import type { MoveType } from "@/types/game";
import type { PowerSurgeCardId } from "@/types/power-surge";
import { TextFactory } from "../ui/TextFactory";
import { preloadReplaySceneAssets, createCharacterAnimations } from "../utils/asset-loader";

export interface ReplayRoundData {
    roundNumber: number;
    player1Move: MoveType;
    player2Move: MoveType;
    player1DamageDealt: number;
    player2DamageDealt: number;
    player1HealthAfter: number;
    player2HealthAfter: number;
    winnerAddress: string | null;
    surgeCardIds?: PowerSurgeCardId[];
    player1SurgeSelection?: PowerSurgeCardId;
    player2SurgeSelection?: PowerSurgeCardId;
}

export interface ReplaySceneConfig {
    matchId: string;
    player1Address: string;
    player2Address: string;
    player1Character: string;
    player2Character: string;
    winnerAddress: string | null;
    player1RoundsWon: number;
    player2RoundsWon: number;
    rounds: ReplayRoundData[];
    muteAudio?: boolean;
}

export class ReplayScene extends Phaser.Scene {
    private config!: ReplaySceneConfig;

    private player1HealthBar!: Phaser.GameObjects.Graphics;
    private player2HealthBar!: Phaser.GameObjects.Graphics;
    private player1EnergyBar!: Phaser.GameObjects.Graphics;
    private player2EnergyBar!: Phaser.GameObjects.Graphics;
    private player1GuardMeter!: Phaser.GameObjects.Graphics;
    private player2GuardMeter!: Phaser.GameObjects.Graphics;
    private roundScoreText!: Phaser.GameObjects.Text;
    private narrativeText!: Phaser.GameObjects.Text;
    private replayBadge!: Phaser.GameObjects.Container;

    private player1Sprite!: Phaser.GameObjects.Sprite;
    private player2Sprite!: Phaser.GameObjects.Sprite;

    private currentRoundIndex: number = 0;
    private isPlaying: boolean = false;

    private player1Health: number = 100;
    private player2Health: number = 100;
    private player1MaxHealth: number = 100;
    private player2MaxHealth: number = 100;
    private player1Energy: number = 100;
    private player2Energy: number = 100;
    private player1MaxEnergy: number = 100;
    private player2MaxEnergy: number = 100;
    private player1GuardMeterValue: number = 0;
    private player2GuardMeterValue: number = 0;
    private player1RoundsWon: number = 0;
    private player2RoundsWon: number = 0;
    private currentGameRound: number = 1;

    private combatEngine!: CombatEngine;

    private bgmVolume: number = 0.3;
    private sfxVolume: number = 0.5;
    private isSettingsOpen: boolean = false;
    private settingsContainer!: Phaser.GameObjects.Container;

    private muteAudio: boolean = false;
    constructor() {
        super({ key: "ReplayScene" });
    }

    init(data: ReplaySceneConfig): void {
        this.config = {
            matchId: data?.matchId || "",
            player1Address: data?.player1Address || "",
            player2Address: data?.player2Address || "",
            player1Character: data?.player1Character || "dag-warrior",
            player2Character: data?.player2Character || "dag-warrior",
            winnerAddress: data?.winnerAddress || null,
            player1RoundsWon: data?.player1RoundsWon || 0,
            player2RoundsWon: data?.player2RoundsWon || 0,
            rounds: data?.rounds || [],
            muteAudio: data?.muteAudio,
        };

        this.currentRoundIndex = 0;
        this.isPlaying = false;
        this.player1RoundsWon = 0;
        this.player2RoundsWon = 0;
        this.currentGameRound = 1;

        this.muteAudio = this.config.muteAudio ?? false;

        this.combatEngine = new CombatEngine(
            this.config.player1Character || "dag-warrior",
            this.config.player2Character || "dag-warrior",
            "best_of_3",
        );

        const state = this.combatEngine.getState();
        this.player1Health = state.player1.hp;
        this.player2Health = state.player2.hp;
        this.player1MaxHealth = state.player1.maxHp;
        this.player2MaxHealth = state.player2.maxHp;
        this.player1Energy = state.player1.energy;
        this.player2Energy = state.player2.energy;
        this.player1MaxEnergy = state.player1.maxEnergy;
        this.player2MaxEnergy = state.player2.maxEnergy;
        this.player1GuardMeterValue = 0;
        this.player2GuardMeterValue = 0;
    }

    private playSFX(key: string): void {
        if (this.muteAudio) return;
        if (this.game.sound.locked) return;

        try {
            this.sound.play(key, { volume: this.sfxVolume });
            this.time.delayedCall(5000, () => {
                const sound = this.sound.get(key);
                if (sound && sound.isPlaying) sound.stop();
            });
        } catch {
            // ignore
        }
    }

    private loadAudioSettings(): void {
        try {
            const savedBgm = localStorage.getItem("veilstar_brawl_bgm_volume");
            const savedSfx = localStorage.getItem("veilstar_brawl_sfx_volume");
            if (savedBgm !== null) this.bgmVolume = parseFloat(savedBgm);
            if (savedSfx !== null) this.sfxVolume = parseFloat(savedSfx);
        } catch {
            // ignore
        }
    }

    private saveAudioSettings(): void {
        try {
            localStorage.setItem("veilstar_brawl_bgm_volume", this.bgmVolume.toString());
            localStorage.setItem("veilstar_brawl_sfx_volume", this.sfxVolume.toString());
        } catch {
            // ignore
        }
    }

    private applyBgmVolume(): void {
        const bgm = this.sound.get("bgm_fight");
        if (bgm && "setVolume" in bgm) {
            (bgm as Phaser.Sound.WebAudioSound).setVolume(this.bgmVolume);
        }
    }

    preload(): void {
        const player1Char = this.config?.player1Character || "dag-warrior";
        const player2Char = this.config?.player2Character || "dag-warrior";
        preloadReplaySceneAssets(this, player1Char, player2Char);
    }

    create(): void {
        this.loadAudioSettings();

        this.sound.pauseOnBlur = false;
        if (!this.muteAudio) {
            if (this.sound.get("bgm_fight")) {
                if (!this.sound.get("bgm_fight").isPlaying) {
                    this.sound.play("bgm_fight", { loop: true, volume: this.bgmVolume });
                }
            } else {
                this.sound.play("bgm_fight", { loop: true, volume: this.bgmVolume });
            }
        }

        this.createBackground();

        const player1Char = this.config?.player1Character || "dag-warrior";
        const player2Char = this.config?.player2Character || "dag-warrior";
        createCharacterAnimations(this, [player1Char, player2Char]);

        this.createCharacters();
        this.createUI();
        this.createReplayBadge();
        this.createSettingsMenu();

        EventBus.emit("scene:ready", this);

        // Start playback after a short delay so assets/UI are ready
        this.time.delayedCall(600, () => {
            this.startReplay();
        });
    }

    private createBackground(): void {
        // Simple cyber arena background
        this.add.rectangle(
            GAME_DIMENSIONS.CENTER_X,
            GAME_DIMENSIONS.CENTER_Y,
            GAME_DIMENSIONS.WIDTH,
            GAME_DIMENSIONS.HEIGHT,
            0x050505,
            1,
        );

        // Gradient overlay
        const grad = this.add.graphics();
        grad.fillGradientStyle(0x0b0b0b, 0x0b0b0b, 0x000000, 0x000000, 0.9);
        grad.fillRect(0, 0, GAME_DIMENSIONS.WIDTH, GAME_DIMENSIONS.HEIGHT);

        // Floor line
        const floorY = CHARACTER_POSITIONS.PLAYER1.Y;
        const floor = this.add.graphics();
        floor.lineStyle(2, 0xf0b71f, 0.25);
        floor.beginPath();
        floor.moveTo(0, floorY + 56);
        floor.lineTo(GAME_DIMENSIONS.WIDTH, floorY + 56);
        floor.strokePath();
    }

    private createCharacters(): void {
        const p1Char = this.config.player1Character;
        const p2Char = this.config.player2Character;

        const p1TextureKey = `char_${p1Char}_idle`;
        const p2TextureKey = `char_${p2Char}_idle`;

        const p1BaseYOffset = 50;
        const p2BaseYOffset = 50;
        const p1ConfigOffset = getCharacterYOffset(p1Char, "idle");
        const p2ConfigOffset = getCharacterYOffset(p2Char, "idle");

        this.player1Sprite = this.add.sprite(
            CHARACTER_POSITIONS.PLAYER1.X,
            CHARACTER_POSITIONS.PLAYER1.Y - p1BaseYOffset + p1ConfigOffset,
            p1TextureKey,
        );
        this.player1Sprite.setScale(getCharacterScale(p1Char));
        this.player1Sprite.setOrigin(0.5, 0.5);
        if (this.anims.exists(`${p1Char}_idle`)) this.player1Sprite.play(`${p1Char}_idle`);

        this.player2Sprite = this.add.sprite(
            CHARACTER_POSITIONS.PLAYER2.X,
            CHARACTER_POSITIONS.PLAYER2.Y - p2BaseYOffset + p2ConfigOffset,
            p2TextureKey,
        );
        this.player2Sprite.setScale(getCharacterScale(p2Char));
        this.player2Sprite.setOrigin(0.5, 0.5);
        this.player2Sprite.setFlipX(true);
        if (this.anims.exists(`${p2Char}_idle`)) this.player2Sprite.play(`${p2Char}_idle`);
    }

    private createUI(): void {
        // Health/energy bars
        this.player1HealthBar = this.add.graphics();
        this.player2HealthBar = this.add.graphics();
        this.player1EnergyBar = this.add.graphics();
        this.player2EnergyBar = this.add.graphics();
        this.player1GuardMeter = this.add.graphics();
        this.player2GuardMeter = this.add.graphics();

        this.roundScoreText = TextFactory.createScore(
            this,
            UI_POSITIONS.ROUND_INDICATOR.X,
            UI_POSITIONS.ROUND_INDICATOR.Y,
            "0 - 0",
        ).setOrigin(0.5);

        this.narrativeText = TextFactory.createNarrative(
            this,
            GAME_DIMENSIONS.CENTER_X,
            UI_POSITIONS.ROUND_INDICATOR.Y + 60,
            "REPLAY",
        ).setOrigin(0.5);

        this.drawBars();
    }

    private drawBars(): void {
        const barWidth = UI_POSITIONS.HEALTH_BAR.PLAYER1.WIDTH;
        const barHeight = 18;
        const energyHeight = 10;
        const guardHeight = 6;

        const p1X = UI_POSITIONS.HEALTH_BAR.PLAYER1.X;
        const p2X = UI_POSITIONS.HEALTH_BAR.PLAYER2.X;
        const y = UI_POSITIONS.HEALTH_BAR.PLAYER1.Y;

        const p1HealthPct = Phaser.Math.Clamp(this.player1Health / this.player1MaxHealth, 0, 1);
        const p2HealthPct = Phaser.Math.Clamp(this.player2Health / this.player2MaxHealth, 0, 1);
        const p1EnergyPct = Phaser.Math.Clamp(this.player1Energy / this.player1MaxEnergy, 0, 1);
        const p2EnergyPct = Phaser.Math.Clamp(this.player2Energy / this.player2MaxEnergy, 0, 1);

        this.player1HealthBar.clear();
        this.player2HealthBar.clear();
        this.player1EnergyBar.clear();
        this.player2EnergyBar.clear();
        this.player1GuardMeter.clear();
        this.player2GuardMeter.clear();

        // Background
        this.player1HealthBar.fillStyle(0x000000, 0.6).fillRect(p1X, y, barWidth, barHeight);
        this.player2HealthBar.fillStyle(0x000000, 0.6).fillRect(p2X, y, barWidth, barHeight);

        // Health
        this.player1HealthBar.fillStyle(0x22c55e, 0.9).fillRect(p1X, y, barWidth * p1HealthPct, barHeight);
        this.player2HealthBar.fillStyle(0x22c55e, 0.9).fillRect(p2X + (barWidth - barWidth * p2HealthPct), y, barWidth * p2HealthPct, barHeight);

        // Energy
        this.player1EnergyBar.fillStyle(0x000000, 0.5).fillRect(p1X, y + 24, barWidth, energyHeight);
        this.player2EnergyBar.fillStyle(0x000000, 0.5).fillRect(p2X, y + 24, barWidth, energyHeight);
        this.player1EnergyBar.fillStyle(0x60a5fa, 0.9).fillRect(p1X, y + 24, barWidth * p1EnergyPct, energyHeight);
        this.player2EnergyBar.fillStyle(0x60a5fa, 0.9).fillRect(p2X + (barWidth - barWidth * p2EnergyPct), y + 24, barWidth * p2EnergyPct, energyHeight);

        // Guard meter
        const p1GuardPct = Phaser.Math.Clamp(this.player1GuardMeterValue / 100, 0, 1);
        const p2GuardPct = Phaser.Math.Clamp(this.player2GuardMeterValue / 100, 0, 1);
        this.player1GuardMeter.fillStyle(0x000000, 0.5).fillRect(p1X, y + 40, barWidth, guardHeight);
        this.player2GuardMeter.fillStyle(0x000000, 0.5).fillRect(p2X, y + 40, barWidth, guardHeight);
        this.player1GuardMeter.fillStyle(0xf0b71f, 0.9).fillRect(p1X, y + 40, barWidth * p1GuardPct, guardHeight);
        this.player2GuardMeter.fillStyle(0xf0b71f, 0.9).fillRect(p2X + (barWidth - barWidth * p2GuardPct), y + 40, barWidth * p2GuardPct, guardHeight);
    }

    private createReplayBadge(): void {
        const container = this.add.container(0, 0);
        const bg = this.add.rectangle(GAME_DIMENSIONS.WIDTH - 90, 40, 160, 38, 0x000000, 0.6);
        bg.setStrokeStyle(1, 0xf0b71f, 0.6);
        const text = this.add.text(GAME_DIMENSIONS.WIDTH - 90, 40, "REPLAY", {
            fontFamily: "monospace",
            fontSize: "14px",
            color: "#F0B71F",
        }).setOrigin(0.5);
        container.add([bg, text]);
        this.replayBadge = container;
    }

    private createSettingsMenu(): void {
        this.settingsContainer = this.add.container(0, 0).setDepth(1000).setVisible(false);

        const overlay = this.add.rectangle(
            GAME_DIMENSIONS.CENTER_X,
            GAME_DIMENSIONS.CENTER_Y,
            GAME_DIMENSIONS.WIDTH,
            GAME_DIMENSIONS.HEIGHT,
            0x000000,
            0.55,
        );
        overlay.setInteractive();
        overlay.on("pointerdown", () => this.toggleSettings(false));

        const panel = this.add.rectangle(GAME_DIMENSIONS.CENTER_X, GAME_DIMENSIONS.CENTER_Y, 520, 300, 0x000000, 0.8);
        panel.setStrokeStyle(1, 0xf0b71f, 0.4);

        const title = this.add.text(GAME_DIMENSIONS.CENTER_X, GAME_DIMENSIONS.CENTER_Y - 110, "SETTINGS", {
            fontFamily: '"Segoe UI Black", Arial, sans-serif',
            fontSize: "22px",
            color: "#F0B71F",
        }).setOrigin(0.5);

        const bgmLabel = this.add.text(GAME_DIMENSIONS.CENTER_X - 200, GAME_DIMENSIONS.CENTER_Y - 35, "BGM", {
            fontFamily: "monospace",
            fontSize: "14px",
            color: "#9CA3AF",
        }).setOrigin(0, 0.5);

        const sfxLabel = this.add.text(GAME_DIMENSIONS.CENTER_X - 200, GAME_DIMENSIONS.CENTER_Y + 35, "SFX", {
            fontFamily: "monospace",
            fontSize: "14px",
            color: "#9CA3AF",
        }).setOrigin(0, 0.5);

        const makeSlider = (y: number, value: number, onChange: (v: number) => void) => {
            const slider = this.add.container(GAME_DIMENSIONS.CENTER_X + 20, y);
            const track = this.add.rectangle(0, 0, 260, 8, 0x111111, 1);
            track.setStrokeStyle(1, 0xffffff, 0.1);
            const fill = this.add.rectangle(-130 + 260 * value, 0, 260 * value, 8, 0xf0b71f, 0.8);
            fill.setOrigin(0, 0.5);
            const handle = this.add.circle(-130 + 260 * value, 0, 8, 0xf0b71f, 1);

            track.setInteractive({ useHandCursor: true });
            track.on("pointerdown", (p: Phaser.Input.Pointer) => {
                const localX = Phaser.Math.Clamp(p.x - slider.x + 130, 0, 260);
                const v = localX / 260;
                fill.width = 260 * v;
                handle.x = -130 + 260 * v;
                onChange(v);
            });

            slider.add([track, fill, handle]);
            return slider;
        };

        const bgmSlider = makeSlider(GAME_DIMENSIONS.CENTER_Y - 35, this.bgmVolume, (v) => {
            this.bgmVolume = v;
            this.applyBgmVolume();
            this.saveAudioSettings();
        });

        const sfxSlider = makeSlider(GAME_DIMENSIONS.CENTER_Y + 35, this.sfxVolume, (v) => {
            this.sfxVolume = v;
            this.saveAudioSettings();
        });

        const closeBtnBg = this.add.rectangle(GAME_DIMENSIONS.CENTER_X, GAME_DIMENSIONS.CENTER_Y + 115, 180, 40, 0xf0b71f, 0.15);
        closeBtnBg.setStrokeStyle(1, 0xf0b71f, 0.6);
        closeBtnBg.setInteractive({ useHandCursor: true });
        closeBtnBg.on("pointerdown", () => this.toggleSettings(false));
        const closeBtnText = this.add.text(GAME_DIMENSIONS.CENTER_X, GAME_DIMENSIONS.CENTER_Y + 115, "CLOSE", {
            fontFamily: "monospace",
            fontSize: "14px",
            color: "#F0B71F",
        }).setOrigin(0.5);

        this.settingsContainer.add([overlay, panel, title, bgmLabel, sfxLabel, bgmSlider, sfxSlider, closeBtnBg, closeBtnText]);

        // Gear icon button
        const gear = this.add.text(GAME_DIMENSIONS.WIDTH - 36, 40, "⚙", {
            fontFamily: "monospace",
            fontSize: "18px",
            color: "#9CA3AF",
        }).setOrigin(0.5);
        gear.setInteractive({ useHandCursor: true });
        gear.on("pointerdown", () => this.toggleSettings(!this.isSettingsOpen));
    }

    private toggleSettings(open: boolean): void {
        this.isSettingsOpen = open;
        this.settingsContainer.setVisible(open);
    }

    private startReplay(): void {
        if (!this.config.rounds || this.config.rounds.length === 0) {
            this.narrativeText.setText("NO REPLAY DATA");
            return;
        }
        if (this.isPlaying) return;
        this.isPlaying = true;
        this.playNextRound();
    }

    private playNextRound(): void {
        const r = this.config.rounds[this.currentRoundIndex];
        if (!r) {
            this.finishReplay();
            return;
        }

        // Update score text when a game round ends
        if (this.currentRoundIndex === 0) {
            this.roundScoreText.setText(`${this.player1RoundsWon} - ${this.player2RoundsWon}`);
        }

        // Narrative
        this.narrativeText.setText(`TURN ${r.roundNumber}`);

        // Play animations
        const p1Char = this.config.player1Character;
        const p2Char = this.config.player2Character;

        const resolveP1 = r.player1Move;
        const resolveP2 = r.player2Move;

        // P1
        const p1Anim = `${p1Char}_${resolveP1 === "block" ? "block" : resolveP1 === "stunned" ? "hurt" : resolveP1}`;
        const p2Anim = `${p2Char}_${resolveP2 === "block" ? "block" : resolveP2 === "stunned" ? "hurt" : resolveP2}`;

        if (this.anims.exists(p1Anim)) this.player1Sprite.play(p1Anim);
        if (this.anims.exists(p2Anim)) this.player2Sprite.play(p2Anim);

        // SFX
        const p1Sfx = getSFXKey(p1Char, resolveP1);
        const p2Sfx = getSFXKey(p2Char, resolveP2);
        if (p1Sfx) this.time.delayedCall(getSoundDelay(p1Char, resolveP1), () => this.playSFX(p1Sfx));
        if (p2Sfx) this.time.delayedCall(getSoundDelay(p2Char, resolveP2), () => this.playSFX(p2Sfx));

        // Apply state from recorded data
        this.time.delayedCall(900, () => {
            this.player1Health = r.player1HealthAfter;
            this.player2Health = r.player2HealthAfter;
            this.drawBars();

            // If this turn ended a game round, update round score
            if (r.winnerAddress) {
                if (r.winnerAddress === this.config.player1Address) this.player1RoundsWon++;
                if (r.winnerAddress === this.config.player2Address) this.player2RoundsWon++;
                this.roundScoreText.setText(`${this.player1RoundsWon} - ${this.player2RoundsWon}`);
                this.currentGameRound++;
            }

            this.currentRoundIndex++;
            this.time.delayedCall(900, () => this.playNextRound());
        });
    }

    private finishReplay(): void {
        this.isPlaying = false;
        const winner = this.config.winnerAddress;
        const text = winner
            ? winner === this.config.player1Address
                ? "PLAYER 1 WINS"
                : "PLAYER 2 WINS"
            : "MATCH COMPLETE";
        this.narrativeText.setText(text);

        // Notify any external recorder/exporter.
        // Use the non-typed emit API to avoid widening GameEvents.
        (EventBus as any).emit("replay:complete", {
            matchId: this.config.matchId,
            winnerAddress: this.config.winnerAddress,
        });
    }
}
