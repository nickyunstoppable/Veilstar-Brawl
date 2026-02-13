/**
 * Matchmaking Store
 * Zustand store for matchmaking queue state and player queue management
 */

import { create } from "zustand";

// =============================================================================
// TYPES
// =============================================================================

/**
 * Queue status states.
 */
export type QueueStatus =
    | "idle"           // Not in queue
    | "joining"        // Attempting to join queue
    | "queued"         // Actively in queue
    | "matching"       // Found potential match, confirming
    | "matched"        // Match found, transitioning to game
    | "leaving"        // Attempting to leave queue
    | "error";         // Error state

/**
 * Player in queue representation.
 */
export interface QueuedPlayer {
    address: string;
    displayName: string | null;
    rating: number;
    joinedAt: number; // Timestamp
    presenceRef?: string; // Supabase presence reference
}

/**
 * Room for private matches.
 */
export interface MatchmakingRoom {
    id: string;
    code: string;
    hostAddress: string;
    guestAddress: string | null;
    status: "waiting" | "ready" | "starting";
    createdAt: Date;
}

/**
 * Match result from matchmaking.
 */
export interface MatchmakingResult {
    matchId: string;
    player1Address: string;
    player2Address: string;
    createdAt: Date;
    selectionDeadlineAt?: string; // ISO timestamp for timer sync
}

/**
 * Matchmaking store state.
 */
interface MatchmakingStore {
    // Queue State
    queueStatus: QueueStatus;
    queuedAt: number | null;
    queuePosition: number | null;
    playersInQueue: QueuedPlayer[];
    error: string | null;

    // Room State
    currentRoom: MatchmakingRoom | null;
    roomCode: string | null;

    // Match Result
    matchResult: MatchmakingResult | null;

    // Actions - Queue
    joinQueue: () => void;
    setQueued: (queuedAt: number) => void;
    setMatching: () => void;
    setMatched: (result: MatchmakingResult) => void;
    clearMatchResult: () => void;
    leaveQueue: () => void;
    setQueueError: (error: string) => void;
    setQueuePosition: (position: number) => void;

    // Actions - Players in Queue
    setPlayersInQueue: (players: QueuedPlayer[]) => void;
    addPlayerToQueue: (player: QueuedPlayer) => void;
    removePlayerFromQueue: (address: string) => void;

    // Actions - Rooms
    setRoom: (room: MatchmakingRoom) => void;
    setRoomCode: (code: string) => void;
    updateRoomStatus: (status: MatchmakingRoom["status"]) => void;
    clearRoom: () => void;

    // Actions - General
    clearError: () => void;
    reset: () => void;
}

/**
 * Initial state.
 */
const initialState = {
    queueStatus: "idle" as QueueStatus,
    queuedAt: null,
    queuePosition: null,
    playersInQueue: [],
    error: null,
    currentRoom: null,
    roomCode: null,
    matchResult: null,
};

/**
 * Matchmaking store with Zustand.
 */
export const useMatchmakingStore = create<MatchmakingStore>()(
    (set) => ({
        // Initial state
        ...initialState,

        // Queue Actions
        joinQueue: () =>
            set({ queueStatus: "joining", error: null }),

        setQueued: (queuedAt) =>
            set({ queueStatus: "queued", queuedAt, error: null }),

        setMatching: () =>
            set({ queueStatus: "matching" }),

        setMatched: (result) =>
            set({ queueStatus: "matched", matchResult: result }),

        clearMatchResult: () =>
            set({ matchResult: null }),

        leaveQueue: () =>
            set({
                queueStatus: "idle",
                queuedAt: null,
                queuePosition: null,
                error: null,
                matchResult: null,
            }),

        setQueueError: (error) =>
            set({ queueStatus: "error", error }),

        setQueuePosition: (position) =>
            set({ queuePosition: position }),

        // Players in Queue Actions
        setPlayersInQueue: (players) =>
            set({ playersInQueue: players }),

        addPlayerToQueue: (player) =>
            set((state) => ({
                playersInQueue: [...state.playersInQueue, player],
            })),

        removePlayerFromQueue: (address) =>
            set((state) => ({
                playersInQueue: state.playersInQueue.filter(
                    (p) => p.address !== address
                ),
            })),

        // Room Actions
        setRoom: (room) =>
            set({ currentRoom: room, roomCode: room.code }),

        setRoomCode: (code) =>
            set({ roomCode: code }),

        updateRoomStatus: (status) =>
            set((state) => ({
                currentRoom: state.currentRoom
                    ? { ...state.currentRoom, status }
                    : null,
            })),

        clearRoom: () =>
            set({ currentRoom: null, roomCode: null }),

        // General Actions
        clearError: () =>
            set({ error: null, queueStatus: "idle" }),

        reset: () =>
            set(initialState),
    })
);

// =============================================================================
// SELECTORS
// =============================================================================

/**
 * Check if player is actively in queue.
 */
export const selectIsInQueue = (state: MatchmakingStore): boolean =>
    state.queueStatus === "queued" || state.queueStatus === "matching";

/**
 * Check if matchmaking is in progress (joining or queued).
 */
export const selectIsMatchmaking = (state: MatchmakingStore): boolean =>
    state.queueStatus === "joining" ||
    state.queueStatus === "queued" ||
    state.queueStatus === "matching";

/**
 * Get queue wait time in seconds.
 */
export const selectQueueWaitTime = (state: MatchmakingStore): number => {
    if (!state.queuedAt) return 0;
    return Math.floor((Date.now() - state.queuedAt) / 1000);
};

/**
 * Get count of players in queue.
 */
export const selectPlayerCount = (state: MatchmakingStore): number =>
    state.playersInQueue.length;

/**
 * Check if in a room.
 */
export const selectIsInRoom = (state: MatchmakingStore): boolean =>
    state.currentRoom !== null;

/**
 * Check if room is ready to start.
 */
export const selectIsRoomReady = (state: MatchmakingStore): boolean =>
    state.currentRoom?.status === "ready";

/**
 * Check if current player is room host.
 */
export const selectIsRoomHost = (
    state: MatchmakingStore,
    playerAddress: string | null
): boolean =>
    state.currentRoom?.hostAddress === playerAddress;

export default useMatchmakingStore;
