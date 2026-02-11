/**
 * Phaser Game Configuration
 * Core configuration for the Veilstar Brawl fighting game engine
 */

import Phaser from "phaser";

/**
 * Base game configuration without scene initialization.
 */
export const BASE_GAME_CONFIG: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: undefined,
  backgroundColor: "#0a0a0a",

  width: 1280,
  height: 720,

  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: 1280,
    height: 720,
    min: {
      width: 640,
      height: 360,
    },
    max: {
      width: 1920,
      height: 1080,
    },
  },

  render: {
    antialias: true,
    antialiasGL: true,
    pixelArt: false,
    roundPixels: true,
    transparent: false,
    clearBeforeRender: true,
    preserveDrawingBuffer: false,
    powerPreference: "high-performance",
    batchSize: 4096,
    maxTextures: -1,
  },

  audio: {
    disableWebAudio: false,
  },

  loader: {
    maxParallelDownloads: 32,
    crossOrigin: "anonymous",
    async: true,
    maxRetries: 2,
  },

  fps: {
    target: 60,
    forceSetTimeOut: false,
    smoothStep: true,
    deltaHistory: 10,
  },

  banner: import.meta.env.DEV,

  scene: [],
};

/**
 * Create game configuration with scenes.
 */
export function createGameConfig(
  scenes: Phaser.Types.Scenes.SceneType[]
): Phaser.Types.Core.GameConfig {
  return {
    ...BASE_GAME_CONFIG,
    scene: scenes,
  };
}

/**
 * Game dimensions constants.
 */
export const GAME_DIMENSIONS = {
  WIDTH: 1280,
  HEIGHT: 720,
  CENTER_X: 640,
  CENTER_Y: 360,
};

/**
 * Character positioning constants.
 */
export const CHARACTER_POSITIONS = {
  PLAYER1: {
    X: 320,
    Y: 500,
  },
  PLAYER2: {
    X: 960,
    Y: 500,
  },
};

/**
 * UI positioning constants.
 */
export const UI_POSITIONS = {
  HEALTH_BAR: {
    PLAYER1: { X: 50, Y: 50, WIDTH: 400 },
    PLAYER2: { X: 830, Y: 50, WIDTH: 400 },
  },
  TIMER: {
    X: 640,
    Y: 50,
  },
  ROUND_INDICATOR: {
    X: 640,
    Y: 100,
  },
};
