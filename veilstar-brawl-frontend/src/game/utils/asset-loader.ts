/**
 * Shared Asset Loading Utility
 * Optimizes Phaser asset loading by:
 * 1. Loading only the characters needed for the current match
 * 2. Caching loaded assets across scenes to prevent reloading
 * 3. Providing a centralized loading progress tracker
 */

import Phaser from "phaser";
import { CHAR_SPRITE_CONFIG, getSFXKey } from "../config/sprite-config";

// Track which assets have been loaded globally
const loadedAssets = {
  characters: new Set<string>(),
  audio: new Set<string>(),
  ui: false,
  backgrounds: new Set<string>(),
};

// Common UI assets loaded once
const UI_ASSETS = {
  moveIcons: [
    { key: "move_punch", path: "/assets/icons/punch.webp" },
    { key: "move_kick", path: "/assets/icons/kick.webp" },
    { key: "move_block", path: "/assets/icons/block.webp" },
    { key: "move_special", path: "/assets/icons/special.webp" },
  ],
  powerSurgeCards: [
    { key: "surge_10bps-barrage", path: "/cards/10bps-barrage.webp" },
    { key: "surge_block-fortress", path: "/cards/block-fortress.webp" },
    { key: "surge_blue-set-heal", path: "/cards/blueset-heal.webp" },
    { key: "surge_bps-blitz", path: "/cards/bps-blitz.webp" },
    { key: "surge_chainbreaker", path: "/cards/chain-breaker.webp" },
    { key: "surge_dag-overclock", path: "/cards/dag-overclock.webp" },
    { key: "surge_finality-fist", path: "/cards/finality-fist.webp" },
    { key: "surge_ghost-dag", path: "/cards/ghostdag.webp" },
    { key: "surge_hash-hurricane", path: "/cards/hash-hurricane.webp" },
    { key: "surge_mempool-burn", path: "/cards/mempool-burn.webp" },
    { key: "surge_orphan-smasher", path: "/cards/orphan-smasher.webp" },
    { key: "surge_pruned-rage", path: "/cards/pruned-rage.webp" },
    { key: "surge_sompi-shield", path: "/cards/sompi-shield.webp" },
    { key: "surge_tx-storm", path: "/cards/tx-storm.webp" },
    { key: "surge_vaultbreaker", path: "/cards/vault-breaker.webp" },
  ],
};

// Audio assets
const AUDIO_ASSETS = {
  bgm: [
    { key: "bgm_fight", path: "/assets/audio/fight.mp3" },
    { key: "bgm_select", path: "/assets/audio/character-selection.mp3" },
    { key: "bgm_survival", path: "/assets/audio/dojo.mp3" },
  ],
  sfx: [
    { key: "sfx_victory", path: "/assets/audio/victory.mp3" },
    { key: "sfx_defeat", path: "/assets/audio/defeat.mp3" },
    { key: "sfx_hover", path: "/assets/audio/hover.mp3" },
    { key: "sfx_click", path: "/assets/audio/click.mp3" },
    { key: "sfx_cd_fight", path: "/assets/audio/3-2-1-fight.mp3" },
  ],
  // Character-specific SFX - base characters have full sets
  baseCharSfx: ["cyber-ninja", "ledger-titan", "soroban-sage", "hash-hunter"],
  // Additional character-specific SFX
  additionalSfx: [
    { key: "sfx_nano-brawler_punch", path: "/assets/audio/nano-brawler-punch.mp3" },
    { key: "sfx_neon-wraith_special", path: "/assets/audio/neon-wraith-special.mp3" },
    { key: "sfx_prism-duelist_special", path: "/assets/audio/prism-duelist-special.mp3" },
    { key: "sfx_razor-bot-7_punch", path: "/assets/audio/razor-bot-7-punch.mp3" },
    { key: "sfx_razor-bot-7_special", path: "/assets/audio/razor-bot-7-special.mp3" },
    { key: "sfx_scrap-goliath_special", path: "/assets/audio/scrap-goliath-special.mp3" },
    { key: "sfx_sonic-striker_punch", path: "/assets/audio/sonic-striker-punch.mp3" },
    { key: "sfx_sonic-striker_special", path: "/assets/audio/sonic-striker-special.mp3" },
    { key: "sfx_void-reaper_special", path: "/assets/audio/void-reaper-special.mp3" },
    { key: "sfx_aeon-guard_special", path: "/assets/audio/aeon-guard-special.mp3" },
    { key: "sfx_bastion-hulk_special", path: "/assets/audio/bastion-hulk-special.mp3" },
    { key: "sfx_bastion-hulk_punch", path: "/assets/audio/bastion-hulk-punch.MP3" },
  ],
};

// Animation types for characters
const ANIMATION_TYPES = ["idle", "run", "punch", "kick", "block", "special", "dead"];

/**
 * Check if a texture is already loaded in the scene
 */
function isTextureLoaded(scene: Phaser.Scene, key: string): boolean {
  return scene.textures.exists(key);
}

/**
 * Check if audio is already loaded in the scene
 */
function isAudioLoaded(scene: Phaser.Scene, key: string): boolean {
  try {
    return scene.cache.audio.exists(key);
  } catch {
    return false;
  }
}

/**
 * Load UI assets (move icons, etc.) - only loads if not already loaded
 */
export function loadUIAssets(scene: Phaser.Scene): void {
  if (loadedAssets.ui && UI_ASSETS.moveIcons.every(a => isTextureLoaded(scene, a.key))) {
    return; // Already loaded
  }

  UI_ASSETS.moveIcons.forEach(({ key, path }) => {
    if (!isTextureLoaded(scene, key)) {
      scene.load.image(key, path);
    }
  });

  // Load Power Surge Cards
  UI_ASSETS.powerSurgeCards.forEach(({ key, path }) => {
    if (!isTextureLoaded(scene, key)) {
      scene.load.image(key, path);
    }
  });

  loadedAssets.ui = true;
}

/**
 * Load a background image - only if not already loaded
 */
export function loadBackground(scene: Phaser.Scene, key: string, path: string): void {
  if (loadedAssets.backgrounds.has(key) && isTextureLoaded(scene, key)) {
    return;
  }

  if (!isTextureLoaded(scene, key)) {
    scene.load.image(key, path);
    loadedAssets.backgrounds.add(key);
  }
}

/**
 * Load character spritesheets - OPTIMIZED to only load specified characters
 * This is the main optimization - only load the 2 characters in the match, not all 20!
 */
export function loadCharacterSprites(scene: Phaser.Scene, characterIds: string[]): void {
  const uniqueCharacters = [...new Set(characterIds)]; // Remove duplicates

  uniqueCharacters.forEach((charId) => {
    // Skip if already loaded
    if (loadedAssets.characters.has(charId)) {
      // Verify textures still exist (in case of scene restart)
      const allLoaded = ANIMATION_TYPES.every(anim =>
        isTextureLoaded(scene, `char_${charId}_${anim}`)
      );
      if (allLoaded) return;
    }

    const charConfig = CHAR_SPRITE_CONFIG[charId];
    if (!charConfig) {
      console.warn(`[AssetLoader] Character config not found: ${charId}`);
      return;
    }

    ANIMATION_TYPES.forEach((anim) => {
      const animConfig = charConfig[anim];
      if (!animConfig) return;

      const textureKey = `char_${charId}_${anim}`;
      if (!isTextureLoaded(scene, textureKey)) {
        scene.load.spritesheet(
          textureKey,
          `/characters/${charId}/${anim}.webp`,
          { frameWidth: animConfig.frameWidth, frameHeight: animConfig.frameHeight }
        );
      }
    });

    loadedAssets.characters.add(charId);
  });
}

/**
 * Load ALL character spritesheets - use only when needed (e.g., CharacterSelectScene)
 * This is expensive and should be avoided when possible!
 */
export function loadAllCharacterSprites(scene: Phaser.Scene): void {
  const allCharacters = Object.keys(CHAR_SPRITE_CONFIG);
  loadCharacterSprites(scene, allCharacters);
}

/**
 * Load common audio assets (BGM and SFX)
 */
export function loadCommonAudio(scene: Phaser.Scene): void {
  // Load BGM
  AUDIO_ASSETS.bgm.forEach(({ key, path }) => {
    if (!isAudioLoaded(scene, key)) {
      scene.load.audio(key, path);
      loadedAssets.audio.add(key);
    }
  });

  // Load common SFX
  AUDIO_ASSETS.sfx.forEach(({ key, path }) => {
    if (!isAudioLoaded(scene, key)) {
      scene.load.audio(key, path);
      loadedAssets.audio.add(key);
    }
  });
}

/**
 * Load character-specific audio (punch, kick, block, special sounds)
 * OPTIMIZED to only load audio for the characters in the match
 */
export function loadCharacterAudio(scene: Phaser.Scene, characterIds: string[]): void {
  const uniqueCharacters = [...new Set(characterIds)];
  const sfxTypes = ["punch", "kick", "block", "special"];

  // 1. Identify ALL required sound keys for these characters
  // This resolves aliases (e.g. Bastion Hulk using Nano Brawler's punch)
  const requiredSoundKeys = new Set<string>();

  uniqueCharacters.forEach(charId => {
    sfxTypes.forEach(type => {
      const key = getSFXKey(charId, type);
      requiredSoundKeys.add(key);
    });
  });

  // 2. Load base character SFX if they are required
  AUDIO_ASSETS.baseCharSfx.forEach((charId) => {
    sfxTypes.forEach((sfxType) => {
      const key = `sfx_${charId}_${sfxType}`;
      // Load if explicitly required OR if this is a base char in the match (fallback logic)
      if (requiredSoundKeys.has(key) || (uniqueCharacters.includes(charId) && !isAudioLoaded(scene, key))) {
        if (!isAudioLoaded(scene, key)) {
          scene.load.audio(key, `/assets/audio/${charId}-${sfxType}.mp3`);
          loadedAssets.audio.add(key);
        }
      }
    });
  });

  // 3. Load additional character-specific SFX if they are required
  AUDIO_ASSETS.additionalSfx.forEach(({ key, path }) => {
    if (requiredSoundKeys.has(key) && !isAudioLoaded(scene, key)) {
      scene.load.audio(key, path);
      loadedAssets.audio.add(key);
    }
  });
}

/**
 * Create animations for specified characters
 * Only creates animations for loaded characters
 */
export function createCharacterAnimations(scene: Phaser.Scene, characterIds: string[]): void {
  const uniqueCharacters = [...new Set(characterIds)];

  uniqueCharacters.forEach((charId) => {
    ANIMATION_TYPES.forEach((animType) => {
      const textureKey = `char_${charId}_${animType}`;
      const animKey = `${charId}_${animType}`;

      if (scene.textures.exists(textureKey) && !scene.anims.exists(animKey)) {
        const frameCount = scene.textures.get(textureKey).frameTotal - 1;
        const endFrame = Math.max(0, frameCount - 1);

        scene.anims.create({
          key: animKey,
          frames: scene.anims.generateFrameNumbers(textureKey, { start: 0, end: endFrame }),
          frameRate: 24,
          repeat: animType === "idle" || animType === "run" ? -1 : 0,
        });
      }
    });

    // Create fallback animations (hurt, victory, defeat -> map to idle)
    const idleKey = `char_${charId}_idle`;
    ["hurt", "victory", "defeat"].forEach((key) => {
      const fallbackAnimKey = `${charId}_${key}`;
      if (!scene.anims.exists(fallbackAnimKey) && scene.textures.exists(idleKey)) {
        const frameCount = scene.textures.get(idleKey).frameTotal - 1;
        const endFrame = Math.max(0, frameCount - 1);

        scene.anims.create({
          key: fallbackAnimKey,
          frames: scene.anims.generateFrameNumbers(idleKey, { start: 0, end: endFrame }),
          frameRate: 24,
          repeat: 0,
        });
      }
    });
  });
}

/**
 * Create animations for ALL characters - use only in CharacterSelectScene
 */
export function createAllCharacterAnimations(scene: Phaser.Scene): void {
  const allCharacters = Object.keys(CHAR_SPRITE_CONFIG);
  createCharacterAnimations(scene, allCharacters);
}

/**
 * Preload assets for FightScene - OPTIMIZED
 * Only loads the 2 characters needed for the match!
 */
export function preloadFightSceneAssets(
  scene: Phaser.Scene,
  player1Character: string,
  player2Character: string
): void {
  // Load background
  loadBackground(scene, "arena-bg", "/assets/background_2.webp");

  // Load UI
  loadUIAssets(scene);

  // Load only the 2 characters needed!
  loadCharacterSprites(scene, [player1Character, player2Character]);

  // Load audio
  loadCommonAudio(scene);
  loadCharacterAudio(scene, [player1Character, player2Character]);
}

/**
 * Preload assets for PracticeScene - OPTIMIZED
 * Loads player character + all AI characters lazily
 */
export function preloadPracticeSceneAssets(
  scene: Phaser.Scene,
  playerCharacter: string,
  aiCharacter: string
): void {
  // Load background
  loadBackground(scene, "arena-bg", "/assets/background_2.webp");

  // Load UI
  loadUIAssets(scene);

  // Load player and current AI character
  loadCharacterSprites(scene, [playerCharacter, aiCharacter]);

  // Load audio
  loadCommonAudio(scene);
  loadCharacterAudio(scene, [playerCharacter, aiCharacter]);
}

/**
 * Preload assets for ReplayScene - OPTIMIZED
 */
export function preloadReplaySceneAssets(
  scene: Phaser.Scene,
  player1Character: string,
  player2Character: string
): void {
  // Same as FightScene
  preloadFightSceneAssets(scene, player1Character, player2Character);
}

/**
 * Preload assets for SurvivalScene - loads player + first few opponents
 */
export function preloadSurvivalSceneAssets(
  scene: Phaser.Scene,
  playerCharacter: string,
  firstOpponents: string[]
): void {
  loadBackground(scene, "survival-bg", "/assets/survival.webp");
  loadUIAssets(scene);

  // Load player and first few opponents
  loadCharacterSprites(scene, [playerCharacter, ...firstOpponents]);

  loadCommonAudio(scene);
  loadCharacterAudio(scene, [playerCharacter, ...firstOpponents]);
}

/**
 * Yield to the main thread to keep the scene responsive
 */
function yieldToMainThread(): Promise<void> {
  return new Promise(resolve => {
    if (typeof requestAnimationFrame !== 'undefined') {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}

/**
 * Dynamically load additional characters during gameplay
 * Useful for survival mode when new opponents appear
 * Includes frame yielding to prevent blocking the main thread
 */
export async function loadAdditionalCharacter(
  scene: Phaser.Scene,
  characterId: string
): Promise<void> {
  // Yield before starting to prevent blocking
  await yieldToMainThread();

  if (loadedAssets.characters.has(characterId)) {
    // Verify all textures exist
    const allLoaded = ANIMATION_TYPES.every(anim =>
      scene.textures.exists(`char_${characterId}_${anim}`)
    );
    if (allLoaded) {
      // Just create animations if not already created
      createCharacterAnimations(scene, [characterId]);
      return;
    }
  }

  // Load the character sprites
  loadCharacterSprites(scene, [characterId]);
  loadCharacterAudio(scene, [characterId]);

  // Return a promise that resolves when loading completes
  return new Promise((resolve) => {
    scene.load.once("complete", async () => {
      // Yield before creating animations to stay responsive
      await yieldToMainThread();
      createCharacterAnimations(scene, [characterId]);
      resolve();
    });
    scene.load.start();
  });
}

/**
 * Get loading statistics for debugging
 */
export function getLoadingStats(): {
  loadedCharacters: number;
  loadedAudio: number;
  uiLoaded: boolean;
} {
  return {
    loadedCharacters: loadedAssets.characters.size,
    loadedAudio: loadedAssets.audio.size,
    uiLoaded: loadedAssets.ui,
  };
}

/**
 * Reset loading cache - use when restarting the game completely
 */
export function resetLoadingCache(): void {
  loadedAssets.characters.clear();
  loadedAssets.audio.clear();
  loadedAssets.ui = false;
  loadedAssets.backgrounds.clear();
}
