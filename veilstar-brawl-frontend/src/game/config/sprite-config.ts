/**
 * Sprite Configuration for all characters
 * Frame dimensions calculated from 6x6 grid (36 frames total per animation)
 */

export const CHAR_SPRITE_CONFIG: Record<string, Record<string, { frameWidth: number; frameHeight: number }>> = {
  "aeon-guard": {
    "idle": { frameWidth: 274, frameHeight: 259 },
    "run": { frameWidth: 286, frameHeight: 273 },
    "punch": { frameWidth: 381, frameHeight: 275 },
    "kick": { frameWidth: 428, frameHeight: 289 },
    "block": { frameWidth: 402, frameHeight: 402 },
    "special": { frameWidth: 453, frameHeight: 293 },
    "dead": { frameWidth: 381, frameHeight: 299 },
  },
  "bastion-hulk": {
    "idle": { frameWidth: 231, frameHeight: 268 },
    "run": { frameWidth: 313, frameHeight: 274 },
    "punch": { frameWidth: 349, frameHeight: 270 },
    "kick": { frameWidth: 455, frameHeight: 337 },
    "block": { frameWidth: 223, frameHeight: 267 },
    "special": { frameWidth: 400, frameHeight: 263 },
    "dead": { frameWidth: 434, frameHeight: 304 },
  },
  "block-bruiser": {
    "idle": { frameWidth: 305, frameHeight: 260 },
    "run": { frameWidth: 291, frameHeight: 298 },
    "punch": { frameWidth: 318, frameHeight: 263 },
    "kick": { frameWidth: 477, frameHeight: 329 },
    "block": { frameWidth: 243, frameHeight: 366 },
    "special": { frameWidth: 583, frameHeight: 379 },
    "dead": { frameWidth: 551, frameHeight: 380 },
  },
  "chrono-drifter": {
    "idle": { frameWidth: 153, frameHeight: 260 },
    "run": { frameWidth: 246, frameHeight: 268 },
    "punch": { frameWidth: 305, frameHeight: 260 },
    "kick": { frameWidth: 379, frameHeight: 261 },
    "block": { frameWidth: 338, frameHeight: 359 },
    "special": { frameWidth: 440, frameHeight: 270 },
    "dead": { frameWidth: 386, frameHeight: 280 },
  },
  "cyber-ninja": {
    "idle": { frameWidth: 232, frameHeight: 450 },
    "run": { frameWidth: 213, frameHeight: 287 },
    "punch": { frameWidth: 269, frameHeight: 260 },
    "kick": { frameWidth: 345, frameHeight: 305 },
    "block": { frameWidth: 391, frameHeight: 350 },
    "special": { frameWidth: 525, frameHeight: 426 },
    "dead": { frameWidth: 408, frameHeight: 305 },
  },
  "cyber-paladin": {
    "idle": { frameWidth: 294, frameHeight: 250 },
    "run": { frameWidth: 366, frameHeight: 301 },
    "punch": { frameWidth: 430, frameHeight: 329 },
    "kick": { frameWidth: 349, frameHeight: 380 },
    "block": { frameWidth: 263, frameHeight: 358 },
    "special": { frameWidth: 396, frameHeight: 441 },
    "dead": { frameWidth: 389, frameHeight: 332 },
  },
  "dag-warrior": {
    "idle": { frameWidth: 301, frameHeight: 253 },
    "run": { frameWidth: 285, frameHeight: 211 },
    "punch": { frameWidth: 406, frameHeight: 232 },
    "kick": { frameWidth: 495, frameHeight: 344 },
    "block": { frameWidth: 389, frameHeight: 277 },
    "special": { frameWidth: 584, frameHeight: 228 },
    "dead": { frameWidth: 539, frameHeight: 325 },
  },
  "gene-smasher": {
    "idle": { frameWidth: 229, frameHeight: 279 },
    "run": { frameWidth: 232, frameHeight: 281 },
    "punch": { frameWidth: 322, frameHeight: 279 },
    "kick": { frameWidth: 323, frameHeight: 318 },
    "block": { frameWidth: 227, frameHeight: 262 },
    "special": { frameWidth: 429, frameHeight: 276 },
    "dead": { frameWidth: 439, frameHeight: 361 },
  },
  "hash-hunter": {
    "idle": { frameWidth: 310, frameHeight: 234 },
    "run": { frameWidth: 275, frameHeight: 214 },
    "punch": { frameWidth: 416, frameHeight: 233 },
    "kick": { frameWidth: 425, frameHeight: 295 },
    "block": { frameWidth: 360, frameHeight: 259 },
    "special": { frameWidth: 621, frameHeight: 302 },
    "dead": { frameWidth: 513, frameHeight: 248 },
  },
  "heavy-loader": {
    "idle": { frameWidth: 246, frameHeight: 265 },
    "run": { frameWidth: 284, frameHeight: 278 },
    "punch": { frameWidth: 249, frameHeight: 268 },
    "kick": { frameWidth: 313, frameHeight: 302 },
    "block": { frameWidth: 273, frameHeight: 264 },
    "special": { frameWidth: 432, frameHeight: 349 },
    "dead": { frameWidth: 448, frameHeight: 291 },
  },
  "kitsune-09": {
    "idle": { frameWidth: 228, frameHeight: 272 },
    "run": { frameWidth: 317, frameHeight: 309 },
    "punch": { frameWidth: 578, frameHeight: 309 },
    "kick": { frameWidth: 460, frameHeight: 309 },
    "block": { frameWidth: 357, frameHeight: 353 },
    "special": { frameWidth: 576, frameHeight: 269 },
    "dead": { frameWidth: 482, frameHeight: 326 },
  },
  "nano-brawler": {
    "idle": { frameWidth: 154, frameHeight: 259 },
    "run": { frameWidth: 224, frameHeight: 258 },
    "punch": { frameWidth: 253, frameHeight: 259 },
    "kick": { frameWidth: 397, frameHeight: 267 },
    "block": { frameWidth: 211, frameHeight: 265 },
    "special": { frameWidth: 336, frameHeight: 264 },
    "dead": { frameWidth: 300, frameHeight: 304 },
  },
  "neon-wraith": {
    "idle": { frameWidth: 236, frameHeight: 448 },
    "run": { frameWidth: 176, frameHeight: 271 },
    "punch": { frameWidth: 234, frameHeight: 259 },
    "kick": { frameWidth: 346, frameHeight: 288 },
    "block": { frameWidth: 223, frameHeight: 258 },
    "special": { frameWidth: 535, frameHeight: 374 },
    "dead": { frameWidth: 504, frameHeight: 278 },
  },
  "prism-duelist": {
    "idle": { frameWidth: 216, frameHeight: 261 },
    "run": { frameWidth: 289, frameHeight: 266 },
    "punch": { frameWidth: 312, frameHeight: 283 },
    "kick": { frameWidth: 417, frameHeight: 285 },
    "block": { frameWidth: 292, frameHeight: 272 },
    "special": { frameWidth: 395, frameHeight: 292 },
    "dead": { frameWidth: 320, frameHeight: 292 },
  },
  "razor-bot-7": {
    "idle": { frameWidth: 242, frameHeight: 262 },
    "run": { frameWidth: 246, frameHeight: 290 },
    "punch": { frameWidth: 400, frameHeight: 292 },
    "kick": { frameWidth: 395, frameHeight: 313 },
    "block": { frameWidth: 322, frameHeight: 319 },
    "special": { frameWidth: 472, frameHeight: 307 },
    "dead": { frameWidth: 338, frameHeight: 305 },
  },
  "scrap-goliath": {
    "idle": { frameWidth: 196, frameHeight: 267 },
    "run": { frameWidth: 290, frameHeight: 285 },
    "punch": { frameWidth: 336, frameHeight: 260 },
    "kick": { frameWidth: 378, frameHeight: 268 },
    "block": { frameWidth: 200, frameHeight: 269 },
    "special": { frameWidth: 395, frameHeight: 292 },
    "dead": { frameWidth: 399, frameHeight: 285 },
  },
  "sonic-striker": {
    "idle": { frameWidth: 130, frameHeight: 259 },
    "run": { frameWidth: 187, frameHeight: 273 },
    "punch": { frameWidth: 255, frameHeight: 270 },
    "kick": { frameWidth: 303, frameHeight: 268 },
    "block": { frameWidth: 275, frameHeight: 352 },
    "special": { frameWidth: 412, frameHeight: 395 },
    "dead": { frameWidth: 392, frameHeight: 332 },
  },
  "technomancer": {
    "idle": { frameWidth: 235, frameHeight: 259 },
    "run": { frameWidth: 253, frameHeight: 281 },
    "punch": { frameWidth: 404, frameHeight: 347 },
    "kick": { frameWidth: 429, frameHeight: 311 },
    "block": { frameWidth: 233, frameHeight: 380 },
    "special": { frameWidth: 428, frameHeight: 337 },
    "dead": { frameWidth: 428, frameHeight: 287 },
  },
  "viperblade": {
    "idle": { frameWidth: 273, frameHeight: 269 },
    "run": { frameWidth: 369, frameHeight: 313 },
    "punch": { frameWidth: 427, frameHeight: 430 },
    "kick": { frameWidth: 478, frameHeight: 416 },
    "block": { frameWidth: 373, frameHeight: 303 },
    "special": { frameWidth: 504, frameHeight: 468 },
    "dead": { frameWidth: 439, frameHeight: 347 },
  },
  "void-reaper": {
    "idle": { frameWidth: 245, frameHeight: 267 },
    "run": { frameWidth: 378, frameHeight: 322 },
    "punch": { frameWidth: 426, frameHeight: 287 },
    "kick": { frameWidth: 324, frameHeight: 306 },
    "block": { frameWidth: 378, frameHeight: 344 },
    "special": { frameWidth: 426, frameHeight: 319 },
    "dead": { frameWidth: 426, frameHeight: 323 },
  },
};

/** Tank characters that get 20% larger display size */
export const TANK_CHARACTERS = ["block-bruiser", "heavy-loader", "gene-smasher", "bastion-hulk", "scrap-goliath"];

/**
 * Manual scale overrides for specific characters and animations.
 * These override the dynamic calculation.
 */
export const MANUAL_SCALE_OVERRIDES: Record<string, Record<string, number>> = {
  "block-bruiser": {
    "run": 1.328,
    "punch": 1.328,
    "kick": 1.321,
    "block": 1.318,
    "special": 1.337,
    "dead": 1.334,
  },
  "chrono-drifter": {
    "block": 1.080,
    "special": 1.080,
    "dead": 1.080,
    "run": 1.080,
    "punch": 1.080,
    "kick": 1.080,
  },
  "cyber-ninja": {
    "idle": 0.572,
    "block": 0.980,
    "special": 0.980,
    "dead": 0.980,
    "run": 0.980,
    "punch": 0.980,
    "kick": 0.980,
  },
  "cyber-paladin": {
    "run": 1.130,
    "punch": 1.151,
    "kick": 1.137,
    "block": 1.132,
    "special": 1.135,
    "dead": 1.143,
  },
  "dag-warrior": {
    "idle": 1.207,
    "run": 1.207,
    "kick": 1.207,
    "block": 1.207,
    "special": 1.207,
    "dead": 1.207,
    "punch": 1.207,
  },
  "gene-smasher": {
    "idle": 1.204,
    "run": 1.204,
    "kick": 1.204,
    "block": 1.204,
    "special": 1.204,
    "dead": 1.204,
    "punch": 1.204,
  },
  "hash-hunter": {
    "idle": 1.197,
    "run": 1.197,
    "kick": 1.197,
    "block": 1.197,
    "special": 1.197,
    "dead": 1.197,
    "punch": 1.197,
  },
  "heavy-loader": {
    "idle": 1.268,
    "run": 1.268,
    "kick": 1.268,
    "block": 1.268,
    "special": 1.268,
    "dead": 1.268,
    "punch": 1.268,
  },
  "kitsune-09": {
    "idle": 1.109,
    "run": 1.109,
    "kick": 1.109,
    "block": 1.109,
    "special": 1.109,
    "dead": 1.109,
    "punch": 1.109,
  },
  "nano-brawler": {
    "idle": 1.081,
    "run": 1.081,
    "kick": 1.081,
    "block": 1.081,
    "special": 1.081,
    "dead": 1.081,
    "punch": 1.081,
  },
  "neon-wraith": {
    "kick": 1.033,
    "block": 1.033,
    "special": 1.033,
    "dead": 1.033,
    "punch": 1.033,
  },
  "prism-duelist": {
    "idle": 1.073,
    "run": 1.073,
    "kick": 1.073,
    "block": 1.073,
    "special": 1.073,
    "dead": 1.073,
    "punch": 1.073,
  },
  "razor-bot-7": {
    "idle": 1.073,
    "run": 1.073,
    "kick": 1.073,
    "block": 1.073,
    "special": 1.073,
    "dead": 1.073,
    "punch": 1.073,
  },
  "scrap-goliath": {
    "idle": 1.258,
    "run": 1.258,
    "kick": 1.258,
    "block": 1.258,
    "special": 1.258,
    "dead": 1.258,
    "punch": 1.258,
  },
  "sonic-striker": {
    "idle": 1.081,
    "run": 1.081,
    "kick": 1.081,
    "block": 1.081,
    "special": 1.081,
    "dead": 1.081,
    "punch": 1.081,
  },
  "technomancer": {
    "idle": 1.081,
    "run": 1.081,
    "kick": 1.081,
    "block": 1.081,
    "special": 1.081,
    "dead": 1.081,
    "punch": 1.081,
  },
  "viperblade": {
    "idle": 1.081,
    "run": 1.081,
    "kick": 1.081,
    "block": 1.081,
    "special": 1.081,
    "dead": 1.081,
    "punch": 1.081,
  },
  "void-reaper": {
    "idle": 1.149,
    "run": 1.149,
    "kick": 1.149,
    "block": 1.149,
    "special": 1.149,
    "dead": 1.149,
    "punch": 1.149,
  },
  "aeon-guard": {
    "idle": 1.081,
    "run": 1.081,
    "kick": 1.081,
    "block": 1.081,
    "special": 1.081,
    "dead": 1.081,
    "punch": 1.081,
  },
  "bastion-hulk": {
    "idle": 1.254,
    "run": 1.254,
    "kick": 1.254,
    "block": 1.254,
    "special": 1.254,
    "dead": 1.254,
    "punch": 1.254,
  },
};

/**
 * Manual Y offset overrides for specific characters and animations.
 * These adjust the vertical position of the sprite.
 */
export const MANUAL_Y_OFFSET_OVERRIDES: Record<string, Record<string, number>> = {
  "cyber-ninja": {
    "idle": 20,
    "run": 20,
    "punch": 20,
    "kick": 20,
    "block": 20,
    "special": 20,
    "dead": 20,
  },
  "hash-hunter": {
    "idle": 20,
    "run": 20,
    "punch": 20,
    "kick": 20,
    "block": 20,
    "special": 20,
    "dead": 20,
  },
  "technomancer": {
    "idle": -1,
    "run": -1,
    "punch": -1,
    "kick": -1,
    "block": -1,
    "special": -1,
    "dead": -1,
  },
  "block-bruiser": {
    "idle": -15,
    "run": -15,
    "punch": -15,
    "kick": -15,
    "block": -15,
    "special": -15,
    "dead": -15,
  },
  "gene-smasher": {
    "idle": -10,
    "run": -10,
    "punch": -10,
    "kick": -10,
    "block": -10,
    "special": -10,
    "dead": -10,
  },
  "heavy-loader": {
    "idle": -18,
    "run": -18,
    "punch": -18,
    "kick": -18,
    "block": -18,
    "special": -18,
    "dead": -18,
  },
  "kitsune-09": {
    "idle": 2,
    "run": 2,
    "punch": 2,
    "kick": 2,
    "block": 2,
    "special": 2,
    "dead": 2,
  },
  "scrap-goliath": {
    "idle": -8,
    "run": -8,
    "punch": -8,
    "kick": -8,
    "block": -8,
    "special": -8,
    "dead": -8,
  },
  "viperblade": {
    "idle": 9,
    "run": 9,
    "punch": 9,
    "kick": 9,
    "block": 9,
    "special": 9,
    "dead": 9,
  },
  "bastion-hulk": {
    "idle": -11,
    "run": -11,
    "punch": -11,
    "kick": -11,
    "block": -11,
    "special": -11,
    "dead": -11,
  },
  "chrono-drifter": {
    "idle": -1,
    "run": -1,
    "punch": -1,
    "kick": -1,
    "block": -1,
    "special": -1,
    "dead": -1,
  },
};

/** Target display heights in pixels */
const TARGET_HEIGHT_REGULAR = 280;
const TARGET_HEIGHT_TANK = 336; // 280 * 1.2

/**
 * Get character scale based on their idle frame height to achieve uniform display size
 * All regular characters appear ~280px tall, Tanks appear ~336px tall (20% larger)
 */
export function getCharacterScale(charId: string): number {
  // Check for idle override first
  if (MANUAL_SCALE_OVERRIDES[charId]?.idle) {
    return MANUAL_SCALE_OVERRIDES[charId].idle;
  }

  const isTank = TANK_CHARACTERS.includes(charId);
  const targetHeight = isTank ? TARGET_HEIGHT_TANK : TARGET_HEIGHT_REGULAR;

  // Get idle frame height for this character
  const charConfig = CHAR_SPRITE_CONFIG[charId];
  if (!charConfig || !charConfig.idle) {
    return 1.0; // Fallback
  }

  const idleFrameHeight = charConfig.idle.frameHeight;

  // Calculate scale to achieve target display height
  return targetHeight / idleFrameHeight;
}

/**
 * Get scale for a specific animation to maintain consistent character size
 * Uses the animation's own frame height to calculate appropriate scale
 */
export function getAnimationScale(charId: string, animType: string): number {
  // Check for manual override first
  if (MANUAL_SCALE_OVERRIDES[charId]?.[animType]) {
    return MANUAL_SCALE_OVERRIDES[charId][animType];
  }

  const isTank = TANK_CHARACTERS.includes(charId);
  const targetHeight = isTank ? TARGET_HEIGHT_TANK : TARGET_HEIGHT_REGULAR;

  const charConfig = CHAR_SPRITE_CONFIG[charId];
  if (!charConfig) {
    return 1.0;
  }

  // Get this animation's frame height, fallback to idle
  const animConfig = charConfig[animType] || charConfig.idle;
  if (!animConfig) {
    return 1.0;
  }

  return targetHeight / animConfig.frameHeight;
}

/**
 * Base characters that have their own unique sound effects.
 * Others will fallback to cyber-ninja.
 */
export const BASE_CHARS = ["cyber-ninja", "block-bruiser", "dag-warrior", "hash-hunter"];

/**
 * Default sound delay overrides for specific characters and animations (in ms).
 */
export const DEFAULT_SOUND_DELAYS: Record<string, Record<string, number>> = {
  "block-bruiser": {
    "special": 1150,
    "punch": 900,
    "kick": 650,
  },
  "chrono-drifter": {
    "punch": 400,
    "kick": 400,
    "special": 550,
  },
  "cyber-ninja": {
    "special": 500,
    "punch": 500,
    "kick": 500,
  },
  "hash-hunter": {
    "punch": 200,
    "special": 500,
    "kick": -150,
  },
  "cyber-paladin": {
    "punch": 500,
    "special": 800,
  },
  "gene-smasher": {
    "punch": 500,
    "kick": -300,
    "special": 400,
  },
  "heavy-loader": {
    "punch": 400,
    "special": 700,
  },
  "kitsune-09": {
    "special": 700,
  },
  "nano-brawler": {
    "special": 200,
  },
  "neon-wraith": {
    "punch": 200,
    "kick": 200,
    "special": 700,
  },
  "prism-duelist": {
    "punch": 800,
  },
  "razor-bot-7": {
    "special": 600,
  },
  "scrap-goliath": {
    "punch": 600,
  },
  "technomancer": {
    "punch": 400,
    "special": 300,
  },
  "viperblade": {
    "punch": 750,
    "special": 750,
  },
  "void-reaper": {
    "punch": 300,
    "kick": 300,
    "special": 350,
  },
  "aeon-guard": {
    "punch": 300,
    "special": 500,
  },
  "bastion-hulk": {
    "punch": 150,
    "special": 400
  },
};

/**
 * SFX Key overrides for specific characters and animations.
 */
export const SFX_KEY_OVERRIDES: Record<string, Record<string, string>> = {
  "cyber-paladin": {
    "special": "sfx_cyber-ninja_punch"
  },
  "gene-smasher": {
    "special": "sfx_cyber-ninja_punch"
  },
  "heavy-loader": {
    "special": "sfx_block-bruiser_special"
  },
  "nano-brawler": {
    "punch": "sfx_nano-brawler_punch",
    "special": "sfx_hash-hunter_special"
  },
  "kitsune-09": {
    "punch": "sfx_cyber-ninja_special"
  },
  "neon-wraith": {
    "special": "sfx_neon-wraith_special"
  },
  "prism-duelist": {
    "special": "sfx_prism-duelist_special"
  },
  "razor-bot-7": {
    "punch": "sfx_razor-bot-7_punch",
    "special": "sfx_razor-bot-7_special"
  },
  "scrap-goliath": {
    "special": "sfx_scrap-goliath_special"
  },
  "sonic-striker": {
    "punch": "sfx_sonic-striker_punch",
    "special": "sfx_sonic-striker_special"
  },
  "void-reaper": {
    "special": "sfx_void-reaper_special"
  },
  "aeon-guard": {
    "special": "sfx_aeon-guard_special"
  },
  "bastion-hulk": {
    "punch": "sfx_bastion-hulk_punch",
    "special": "sfx_bastion-hulk_special"
  }
};


/**
 * Get vertical position offset for a specific character and animation
 */
export function getCharacterYOffset(charId: string, animType: string = "idle"): number {
  // Check for animation specific override
  if (MANUAL_Y_OFFSET_OVERRIDES[charId]?.[animType] !== undefined) {
    return MANUAL_Y_OFFSET_OVERRIDES[charId][animType];
  }

  // Fallback to idle override
  if (MANUAL_Y_OFFSET_OVERRIDES[charId]?.idle !== undefined) {
    return MANUAL_Y_OFFSET_OVERRIDES[charId].idle;
  }

  return 0; // Default no offset
}

/**
 * Get the default sound delay for a character's animation
 */
export function getSoundDelay(charId: string, animType: string): number {
  return DEFAULT_SOUND_DELAYS[charId]?.[animType] ?? 0;
}

/**
 * Get the SFX key for a character's animation, handling overrides and fallbacks.
 */
export function getSFXKey(charId: string, animType: string): string {
  // 1. Check for explicit overrides
  if (SFX_KEY_OVERRIDES[charId]?.[animType]) {
    return SFX_KEY_OVERRIDES[charId][animType];
  }

  // 2. Default logic with fallback to cyber-ninja
  const sfxCharId = BASE_CHARS.includes(charId) ? charId : "cyber-ninja";
  return `sfx_${sfxCharId}_${animType}`;
}
