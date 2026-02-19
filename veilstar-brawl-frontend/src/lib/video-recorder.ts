/**
 * MP4 Video Exporter
 * Renders ReplayScene in a hidden Phaser game and records frames/audio using WebCodecs.
 */

import { Muxer, ArrayBufferTarget } from "mp4-muxer";
import type { PowerSurgeCardId } from "@/types/power-surge";

export interface ReplayRoundData {
    roundNumber: number;
    player1Move: string;
    player2Move: string;
    player1DamageDealt: number;
    player2DamageDealt: number;
    player1HealthAfter: number;
    player2HealthAfter: number;
    winnerAddress: string | null;
    surgeCardIds?: PowerSurgeCardId[];
    player1SurgeSelection?: PowerSurgeCardId;
    player2SurgeSelection?: PowerSurgeCardId;
}

export interface ReplayData {
    matchId: string;
    player1Address: string;
    player2Address: string;
    player1Character: string;
    player2Character: string;
    winnerAddress: string | null;
    player1RoundsWon: number;
    player2RoundsWon: number;
    rounds: ReplayRoundData[];
}

export interface MP4ExportOptions {
    width?: number;
    height?: number;
    frameRate?: number;
    videoBitrate?: number;
    audioBitrate?: number;
    onProgress?: (progress: number, status: string) => void;
    onComplete?: (blob: Blob) => void;
    onError?: (error: Error) => void;
}

export function isMP4ExportSupported(): boolean {
    if (typeof window === "undefined") return false;
    return (
        typeof (window as any).VideoEncoder !== "undefined" &&
        typeof (window as any).AudioEncoder !== "undefined" &&
        typeof (window as any).OffscreenCanvas !== "undefined"
    );
}

export async function fetchReplayData(matchId: string): Promise<ReplayData> {
    const apiBase = import.meta.env.VITE_API_BASE_URL || window.location.origin;
    const response = await fetch(`${apiBase}/api/replay-data?matchId=${encodeURIComponent(matchId)}`);
    if (!response.ok) {
        throw new Error(await response.text());
    }
    return (await response.json()) as ReplayData;
}

export function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2500);
}

export async function exportReplayToMP4(replayData: ReplayData, options: MP4ExportOptions = {}): Promise<Blob> {
    const {
        width = 1280,
        height = 720,
        frameRate = 30,
        videoBitrate = 8_000_000,
        audioBitrate = 128_000,
        onProgress,
        onError,
    } = options;

    if (!isMP4ExportSupported()) {
        const err = new Error("WebCodecs is not supported. Use Chrome/Edge.");
        onError?.(err);
        throw err;
    }

    const [{ default: Phaser }, { ReplayScene }, { EventBus }] = await Promise.all([
        import("phaser"),
        import("@/game/scenes/ReplayScene"),
        import("@/game/EventBus"),
    ]);

    return await new Promise((resolve, reject) => {
        onProgress?.(5, "Initializing...");

        const container = document.createElement("div");
        container.style.cssText = `
            position: fixed;
            left: -9999px;
            top: -9999px;
            width: ${width}px;
            height: ${height}px;
            visibility: hidden;
            pointer-events: none;
        `;
        document.body.appendChild(container);

        const sampleRate = 48_000;
        const numberOfChannels = 2;
        let audioContext: AudioContext | null = null;
        let scriptProcessor: ScriptProcessorNode | null = null;

        let isComplete = false;
        let frameCount = 0;
        const frameDurationMicros = Math.round(1_000_000 / frameRate);

        try {
            audioContext = new AudioContext({ sampleRate });
        } catch {
            // If AudioContext fails, we still can export silent video
            audioContext = null;
        }

        const muxer = new Muxer({
            target: new ArrayBufferTarget(),
            video: {
                codec: "avc",
                width,
                height,
            },
            audio: {
                codec: "aac",
                numberOfChannels,
                sampleRate,
            },
            fastStart: "in-memory",
        });

        const videoEncoder = new (window as any).VideoEncoder({
            output: (chunk: any, meta: any) => muxer.addVideoChunk(chunk, meta ?? undefined),
            error: (e: any) => {
                onError?.(new Error(`VideoEncoder error: ${e?.message || String(e)}`));
            },
        });

        videoEncoder.configure({
            codec: "avc1.42001f",
            width,
            height,
            bitrate: videoBitrate,
            framerate: frameRate,
        });

        let audioTimestamp = 0;
        const audioEncoder = new (window as any).AudioEncoder({
            output: (chunk: any, meta: any) => muxer.addAudioChunk(chunk, meta ?? undefined),
            error: () => {
                // ignore
            },
        });
        audioEncoder.configure({
            codec: "mp4a.40.2",
            numberOfChannels,
            sampleRate,
            bitrate: audioBitrate,
        });

        const gameConfig: Phaser.Types.Core.GameConfig = {
            type: Phaser.CANVAS,
            parent: container,
            width,
            height,
            backgroundColor: "#0a0a0a",
            scene: [],
            audio: {
                noAudio: false,
                context: audioContext ?? undefined,
            },
            fps: { target: 60, forceSetTimeOut: false },
            render: { antialias: true, pixelArt: false },
        };

        const game = new Phaser.Game(gameConfig);

        const sceneConfig = {
            matchId: replayData.matchId,
            player1Address: replayData.player1Address,
            player2Address: replayData.player2Address,
            player1Character: replayData.player1Character,
            player2Character: replayData.player2Character,
            winnerAddress: replayData.winnerAddress,
            player1RoundsWon: replayData.player1RoundsWon,
            player2RoundsWon: replayData.player2RoundsWon,
            rounds: replayData.rounds,
            muteAudio: false,
        };

        const estimatedDurationMs = (1.2 + replayData.rounds.length * 1.9 + 1.5) * 1000;

        const cleanup = () => {
            try {
                (EventBus as any).off("replay:complete");
                document.removeEventListener("visibilitychange", handleVisibilityChange);
                if (scriptProcessor) scriptProcessor.disconnect();
                if (audioContext && audioContext.state !== "closed") audioContext.close();
                game.destroy(true);
                container.remove();
            } catch {
                // ignore
            }
        };

        let captureIntervalId: ReturnType<typeof setInterval> | null = null;
        let isPaused = false;

        const finalize = async () => {
            if (isComplete) return;
            isComplete = true;
            onProgress?.(92, "Finalizing...");

            try {
                if (captureIntervalId) clearInterval(captureIntervalId);
                await videoEncoder.flush();
                await audioEncoder.flush();
                videoEncoder.close();
                audioEncoder.close();
                muxer.finalize();
                const buffer = muxer.target.buffer;
                const blob = new Blob([buffer], { type: "video/mp4" });
                onProgress?.(100, "Complete");
                cleanup();
                resolve(blob);
            } catch (e) {
                cleanup();
                const err = e instanceof Error ? e : new Error(String(e));
                onError?.(err);
                reject(err);
            }
        };

        const captureFrame = () => {
            if (isComplete || isPaused) return;
            const canvas = (game as any).canvas as HTMLCanvasElement | undefined;
            if (!canvas) return;
            try {
                const timestamp = frameCount * frameDurationMicros;
                const videoFrame = new (window as any).VideoFrame(canvas, {
                    timestamp,
                    duration: frameDurationMicros,
                });
                videoEncoder.encode(videoFrame, { keyFrame: frameCount % (frameRate * 2) === 0 });
                videoFrame.close();
                frameCount++;
                const elapsedMs = frameCount * (1000 / frameRate);
                const progress = Math.min(85, 10 + Math.round((elapsedMs / estimatedDurationMs) * 75));
                onProgress?.(progress, `Recording... (${frameCount} frames)`);
            } catch {
                // ignore
            }
        };

        const handleVisibilityChange = () => {
            if (isComplete) return;
            if (document.hidden) {
                isPaused = true;
                (game as any).loop?.sleep?.();
                onProgress?.(Math.min(85, 10 + Math.round((frameCount * (1000 / frameRate) / estimatedDurationMs) * 75)), "Paused (tab hidden)...");
            } else {
                isPaused = false;
                (game as any).loop?.wake?.();
            }
        };

        document.addEventListener("visibilitychange", handleVisibilityChange);

        game.events.on("ready", () => {
            onProgress?.(10, "Starting replay...");

            // Capture Phaser mixed audio silently (optional)
            if (audioContext && (game as any).sound) {
                const soundManager = (game as any).sound;
                const masterNode = soundManager.masterVolumeNode as GainNode | undefined;

                if (masterNode) {
                    try {
                        masterNode.disconnect();
                    } catch {
                        // ignore
                    }

                    scriptProcessor = audioContext.createScriptProcessor(4096, 2, 2);
                    const silentGain = audioContext.createGain();
                    silentGain.gain.value = 0;

                    masterNode.connect(scriptProcessor);
                    scriptProcessor.connect(silentGain);
                    silentGain.connect(audioContext.destination);

                    scriptProcessor.onaudioprocess = (e) => {
                        if (isComplete || isPaused) return;
                        try {
                            const left = e.inputBuffer.getChannelData(0);
                            const right = e.inputBuffer.getChannelData(1);
                            const audioData = new (window as any).AudioData({
                                format: "f32-planar",
                                sampleRate,
                                numberOfFrames: left.length,
                                numberOfChannels,
                                timestamp: audioTimestamp,
                                data: new Float32Array([...left, ...right]),
                            });
                            audioEncoder.encode(audioData);
                            audioData.close();
                            audioTimestamp += (left.length / sampleRate) * 1_000_000;
                        } catch {
                            // ignore
                        }
                    };
                }
            }

            game.scene.add("ReplayScene", ReplayScene, true, sceneConfig);

            // Frame capture loop
            captureIntervalId = setInterval(captureFrame, 1000 / frameRate);
        });

        // Stop when the replay scene signals completion
        (EventBus as any).on("replay:complete", () => {
            finalize();
        });

        // Safety timeout
        setTimeout(() => {
            if (!isComplete) finalize();
        }, Math.max(10_000, estimatedDurationMs + 12_000));
    });
}
