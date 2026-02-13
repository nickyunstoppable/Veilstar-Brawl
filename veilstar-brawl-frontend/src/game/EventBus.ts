/**
 * EventBus - Bridge between Phaser and React
 * Uses custom EventEmitter for SSR compatibility (no Phaser dependency)
 */

/**
 * Game event types for type safety.
 */
export interface GameEvents {
  // Scene lifecycle events
  "scene:ready": unknown;
  "scene:change": unknown;

  // Match events
  "match:start": { matchId: string };
  "match:end": { matchId: string; winnerId: string };
  "match:forfeit": { matchId: string; playerId: string };

  // Round events
  "round:start": { roundNumber: number };
  "round:end": { roundNumber: number; winner: "player1" | "player2" | "draw" };

  // Move events
  "move:selected": { moveType: "punch" | "kick" | "block" | "special" };
  "move:submitted": { moveType: string; txId?: string };
  "move:confirmed": { moveType: string; txId: string };
  "move:timeout": { playerId: string };

  // Health events
  "health:update": {
    player1Health: number;
    player2Health: number;
  };

  // Animation events
  "animation:attack": { playerId: string; moveType: string };
  "animation:hurt": { playerId: string; damage: number };
  "animation:block": { playerId: string };
  "animation:victory": { playerId: string };
  "animation:defeat": { playerId: string };
  "animation:complete": { animationType: string };

  // UI events
  "ui:showMoveSelect": void;
  "ui:hideMoveSelect": void;
  "ui:showResult": { winner: string; loser: string };
  "ui:countdown": { seconds: number };

  // Error events
  "error:game": { message: string; code?: string };

  // Game Engine events
  "game:submitMove": {
    matchId: string;
    moveType: string;
    playerRole: string;
  };
  "game:submitPrivateRoundPlan": {
    matchId: string;
    roundNumber: number;
    playerRole: "player1" | "player2";
    commitment: string;
    proof: string;
    publicInputs?: unknown;
    transcriptHash?: string;
    encryptedPlan?: string;
    onChainCommitTxHash?: string;
  };
  "game:privateRoundCommitted": {
    matchId: string;
    roundNumber: number;
    player1Committed: boolean;
    player2Committed: boolean;
    bothCommitted: boolean;
  };
  "game:moveError": { error: string };
  "game:moveInFlight": { player: string };
  "game:roundStarting": any;
  "game:moveSubmitted": any;
  "game:moveConfirmed": any;
  "game:roundResolved": any;
  "game:matchEnded": any;
  "game:matchCancelled": any;
  "game:moveRejected": any;
  "game:playerDisconnected": any;
  "game:playerReconnected": any;
  "game:timerExpired": any;
  "game:claimTimeoutVictory": any;
  "game:characterSelected": any;
  "game:matchStarting": any;
  "game:rejectionWaiting": { message: string };
  "game:opponentRejected": { rejectedAt: number };
  "fight:requestRoundState": { matchId: string };
  "channel_ready": { matchId: string };
  "navigate": { path: string };

  // Game Control Events
  "request-surrender": void;
  "request-cancel": void;

  // Chat Events
  "game:chatMessage": { sender: string; senderAddress: string; message: string; timestamp: number };
  "game:sendChat": { message: string };

  // Sticker Events
  "game:stickerMessage": { sender: string; senderAddress: string; stickerId: string; timestamp: number };
  "game:sendSticker": { stickerId: string };
}

/**
 * Event listener type for internal tracking.
 */
interface EventListener<T = unknown> {
  callback: (data: T) => void;
  context?: unknown;
  once: boolean;
}

/**
 * SSR-safe EventEmitter base class.
 */
class SSRSafeEventEmitter {
  private listeners: Map<string, EventListener[]> = new Map();

  on(event: string, callback: (data: unknown) => void, context?: unknown): this {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push({ callback, context, once: false });
    return this;
  }

  once(event: string, callback: (data: unknown) => void, context?: unknown): this {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push({ callback, context, once: true });
    return this;
  }

  off(event: string, callback?: (data: unknown) => void, context?: unknown): this {
    if (!callback) {
      this.listeners.delete(event);
      return this;
    }

    const eventListeners = this.listeners.get(event);
    if (eventListeners) {
      const filtered = eventListeners.filter(
        (listener) =>
          listener.callback !== callback ||
          (context !== undefined && listener.context !== context)
      );
      if (filtered.length === 0) {
        this.listeners.delete(event);
      } else {
        this.listeners.set(event, filtered);
      }
    }
    return this;
  }

  emit(event: string, data?: unknown): boolean {
    const eventListeners = this.listeners.get(event);

    if (!eventListeners || eventListeners.length === 0) {
      return false;
    }

    const listenersCopy = [...eventListeners];

    listenersCopy.forEach((listener) => {
      try {
        if (listener.context) {
          listener.callback.call(listener.context, data);
        } else {
          listener.callback(data);
        }
      } catch (error) {
        console.error(`[EventBus] Error in listener for '${event}':`, error);
      }

      if (listener.once) {
        this.off(event, listener.callback, listener.context);
      }
    });

    return true;
  }

  removeAllListeners(): this {
    this.listeners.clear();
    return this;
  }
}

/**
 * Event bus for Phaser-React communication.
 */
class GameEventBus extends SSRSafeEventEmitter {
  private static instance: GameEventBus | null = null;
  private readonly instanceId: string;

  private constructor() {
    super();
    this.instanceId = Math.random().toString(36).substring(7);
  }

  static getInstance(): GameEventBus {
    if (!GameEventBus.instance) {
      GameEventBus.instance = new GameEventBus();
    }
    return GameEventBus.instance;
  }

  getInstanceId(): string {
    return this.instanceId;
  }

  emitEvent<K extends keyof GameEvents>(
    event: K,
    data?: GameEvents[K]
  ): boolean {
    return this.emit(event, data);
  }

  onEvent<K extends keyof GameEvents>(
    event: K,
    callback: (data: GameEvents[K]) => void,
    context?: unknown
  ): this {
    return this.on(event, callback as (data: unknown) => void, context);
  }

  onceEvent<K extends keyof GameEvents>(
    event: K,
    callback: (data: GameEvents[K]) => void,
    context?: unknown
  ): this {
    return this.once(event, callback as (data: unknown) => void, context);
  }

  offEvent<K extends keyof GameEvents>(
    event: K,
    callback?: (data: GameEvents[K]) => void,
    context?: unknown
  ): this {
    return this.off(event, callback as (data: unknown) => void, context);
  }

  removeAllGameListeners(): this {
    return this.removeAllListeners();
  }

  static reset(): void {
    if (GameEventBus.instance) {
      GameEventBus.instance.removeAllListeners();
      GameEventBus.instance = null;
    }
  }
}

/**
 * Export singleton instance.
 * Uses window global to ensure true singleton across all module bundles.
 */
declare global {
  interface Window {
    __VEILSTAR_BRAWL_EVENT_BUS__?: GameEventBus;
  }
}

function getGlobalEventBus(): GameEventBus {
  if (typeof window !== 'undefined') {
    if (!window.__VEILSTAR_BRAWL_EVENT_BUS__) {
      window.__VEILSTAR_BRAWL_EVENT_BUS__ = GameEventBus.getInstance();
    }
    return window.__VEILSTAR_BRAWL_EVENT_BUS__;
  }
  return GameEventBus.getInstance();
}

export const EventBus = getGlobalEventBus();

export type EventCallback<K extends keyof GameEvents> = (
  data: GameEvents[K]
) => void;
