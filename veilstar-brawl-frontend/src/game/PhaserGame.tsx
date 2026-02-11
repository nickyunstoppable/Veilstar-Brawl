/**
 * PhaserGame Component
 * React wrapper for the Phaser game instance
 * Handles lifecycle and React-Phaser communication
 * Simplified for practice-only mode (no SSR concerns in Vite)
 */

import React, {
  useRef,
  useEffect,
  useImperativeHandle,
  forwardRef,
  useState,
} from "react";
import Phaser from "phaser";
import { EventBus } from "./EventBus";
import type { GameEvents } from "./EventBus";
import { BASE_GAME_CONFIG } from "./config";
import { PracticeScene } from "./scenes/PracticeScene";

/**
 * Props for the PhaserGame component.
 */
export interface PhaserGameProps {
  /** Current scene key to start with */
  currentScene?: string;
  /** Scene configuration */
  sceneConfig?: Record<string, unknown>;
  /** Callback when scene is ready */
  onSceneReady?: (scene: Phaser.Scene) => void;
  /** Callback when current scene changes */
  onSceneChange?: (scene: Phaser.Scene) => void;
  /** Additional CSS class for the container */
  className?: string;
  /** Custom width override */
  width?: number | string;
  /** Custom height override */
  height?: number | string;
}

/**
 * Ref interface for external control of the game.
 */
export interface PhaserGameRef {
  game: Phaser.Game | null;
  scene: Phaser.Scene | null;
  emit: <K extends keyof GameEvents>(event: K, data?: GameEvents[K]) => void;
}

/**
 * PhaserGame component that wraps the Phaser game instance.
 */
export const PhaserGame = forwardRef<PhaserGameRef, PhaserGameProps>(
  function PhaserGame(
    { currentScene, sceneConfig, onSceneReady, onSceneChange, className, width, height },
    ref
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const gameRef = useRef<Phaser.Game | null>(null);
    // Use refs to store latest props to avoid stale closures in async callbacks
    const sceneConfigRef = useRef(sceneConfig);
    const currentSceneRef = useRef(currentScene);
    const [currentActiveScene, setCurrentActiveScene] =
      useState<Phaser.Scene | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Keep refs updated with latest prop values
    useEffect(() => {
      sceneConfigRef.current = sceneConfig;
      currentSceneRef.current = currentScene;
    }, [sceneConfig, currentScene]);

    // Expose game instance and methods to parent
    useImperativeHandle(
      ref,
      () => ({
        game: gameRef.current,
        scene: currentActiveScene,
        emit: <K extends keyof GameEvents>(event: K, data?: GameEvents[K]) => {
          EventBus.emitEvent(event, data);
        },
      }),
      [currentActiveScene]
    );

    // Initialize Phaser game
    useEffect(() => {
      let isMounted = true;

      const initGame = () => {
        if (!containerRef.current || gameRef.current) return;

        try {
          setIsLoading(true);

          // Create game config WITHOUT scenes to prevent auto-start
          const config: Phaser.Types.Core.GameConfig = {
            ...BASE_GAME_CONFIG,
            scene: [], // Empty - we'll add scenes manually
            parent: containerRef.current,
          };

          // Create the game instance
          gameRef.current = new Phaser.Game(config);

          // Add scenes manually (they won't auto-start)
          gameRef.current.scene.add("PracticeScene", PracticeScene, false);

          // Start the initial scene with data when game is ready
          gameRef.current.events.once("ready", () => {
            const latestScene = currentSceneRef.current;
            const latestConfig = sceneConfigRef.current;

            console.log("[PhaserGame] Ready event fired, starting scene:", latestScene);
            console.log("[PhaserGame] Scene config:", latestConfig);

            if (latestScene && latestConfig) {
              gameRef.current?.scene.start(latestScene, latestConfig);
            } else if (latestScene) {
              gameRef.current?.scene.start(latestScene);
            } else if (latestConfig) {
              gameRef.current?.scene.start("PracticeScene", latestConfig);
            }
          });

          // Listen for scene ready events
          EventBus.onEvent("scene:ready", (data) => {
            if (!isMounted) return;
            const scene = data as Phaser.Scene;
            setCurrentActiveScene(scene);
            onSceneReady?.(scene);
          });

          // Listen for scene change events
          EventBus.onEvent("scene:change", (data) => {
            if (!isMounted) return;
            const scene = data as Phaser.Scene;
            setCurrentActiveScene(scene);
            onSceneChange?.(scene);
          });

          // Listen for navigation requests from within Phaser
          EventBus.onEvent("navigate", (data) => {
            if (!isMounted) return;
            console.log("[PhaserGame] Received navigation request to:", data.path);
            window.location.href = data.path;
          });

          if (isMounted) {
            setIsLoading(false);
          }
        } catch (err) {
          console.error("Failed to initialize Phaser:", err);
          if (isMounted) {
            setError(err instanceof Error ? err.message : "Failed to load game");
            setIsLoading(false);
          }
        }
      };

      initGame();

      // Cleanup on unmount
      return () => {
        isMounted = false;
        if (gameRef.current) {
          gameRef.current.destroy(true);
          gameRef.current = null;
        }
        // Only remove the specific listeners we registered
        EventBus.off("scene:ready");
        EventBus.off("scene:change");
        EventBus.off("navigate");
      };
    }, [onSceneReady, onSceneChange]);

    // Handle scene changes
    useEffect(() => {
      if (!gameRef.current || !currentScene) return;

      const game = gameRef.current;
      if (game.scene.isActive(currentScene)) return;

      if (game.scene.getScene(currentScene)) {
        game.scene.start(currentScene);
      }
    }, [currentScene]);

    // Container styles
    const containerStyle: React.CSSProperties = {
      width: width ?? "100%",
      height: height ?? "100%",
      position: "relative",
      overflow: "hidden",
    };

    if (error) {
      return (
        <div
          className={className}
          style={{
            ...containerStyle,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "#1a1a1a",
            color: "#ef4444",
          }}
        >
          <div style={{ textAlign: "center" }}>
            <p style={{ marginBottom: 8 }}>Failed to load game</p>
            <p style={{ fontSize: 14, opacity: 0.7 }}>{error}</p>
          </div>
        </div>
      );
    }

    return (
      <div
        ref={containerRef}
        className={className}
        style={containerStyle}
        onTouchStart={(e) => {
          if ((e.target as HTMLElement).tagName === "CANVAS") {
            e.preventDefault();
          }
        }}
        onTouchMove={(e) => {
          if ((e.target as HTMLElement).tagName === "CANVAS") {
            e.preventDefault();
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
        }}
      >
        {isLoading && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: "#0a0a0a",
            }}
          >
            <div style={{ textAlign: "center", color: "#F0B71F" }}>
              <div
                style={{
                  width: 48,
                  height: 48,
                  border: "4px solid #F0B71F",
                  borderTopColor: "transparent",
                  borderRadius: "50%",
                  margin: "0 auto 16px",
                  animation: "spin 1s linear infinite",
                }}
              />
              <p className="font-orbitron tracking-widest text-cyber-gold uppercase text-sm">Loading game engine...</p>
              <style>
                {`@keyframes spin { to { transform: rotate(360deg); } }`}
              </style>
            </div>
          </div>
        )}
      </div>
    );
  }
);

export default PhaserGame;
