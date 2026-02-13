/**
 * Matchmaking Store
 * Zustand store for matchmaking queue state and player queue management
 */

import { create } from "zustand";
import { devtools } from "zustand/middleware";

export type QueueStatus =
    | "idle"
    | "joining"
    | "queued"
    | "matching"
    | "matched"
    | "leaving"
    | "error";

export interface QueuedPlayer {
    address: string;
    displayName: string | null;
    rating: number;
    joinedAt: number;
    presenceRef?: string;
}

export interface MatchmakingRoom {
    id: string;
    code: string;
    hostAddress: string;
    guestAddress: string | null;
    status: "waiting" | "ready" | "starting";
    createdAt: Date;
}

export interface MatchmakingResult {
    matchId: string;
    player1Address: string;
    player2Address: string;
    createdAt: Date;
    selectionDeadlineAt?: string;
}

interface MatchmakingStore {
    queueStatus: QueueStatus;
    queuedAt: number | null;
    queuePosition: number | null;
    playersInQueue: QueuedPlayer[];
    error: string | null;

    currentRoom: MatchmakingRoom | null;
    roomCode: string | null;

    matchResult: MatchmakingResult | null;

    joinQueue: () => void;
    setQueued: (queuedAt: number) => void;
    setMatching: () => void;
    setMatched: (result: MatchmakingResult) => void;
    leaveQueue: () => void;
    setQueueError: (error: string) => void;
    setQueuePosition: (position: number) => void;

    setPlayersInQueue: (players: QueuedPlayer[]) => void;
    addPlayerToQueue: (player: QueuedPlayer) => void;
    removePlayerFromQueue: (address: string) => void;

    setRoom: (room: MatchmakingRoom) => void;
    setRoomCode: (code: string) => void;
    updateRoomStatus: (status: MatchmakingRoom["status"]) => void;
    clearRoom: () => void;

    clearError: () => void;
    reset: () => void;
}

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

export const useMatchmakingStore = create<MatchmakingStore>()(
    devtools(
        (set) => ({
            ...initialState,

            joinQueue: () =>
                set(
                    { queueStatus: "joining", error: null },
                    false,
                    "matchmaking/joinQueue"
                ),

            setQueued: (queuedAt) =>
                set(
                    { queueStatus: "queued", queuedAt, error: null },
                    false,
                    "matchmaking/setQueued"
                ),

            setMatching: () =>
                set(
                    { queueStatus: "matching" },
                    false,
                    "matchmaking/setMatching"
                ),

            setMatched: (result) =>
                set(
                    { queueStatus: "matched", matchResult: result },
                    false,
                    "matchmaking/setMatched"
                ),

            leaveQueue: () =>
                set(
                    {
                        queueStatus: "idle",
                        queuedAt: null,
                        queuePosition: null,
                        error: null,
                    },
                    false,
                    "matchmaking/leaveQueue"
                ),

            setQueueError: (error) =>
                set(
                    { queueStatus: "error", error },
                    false,
                    "matchmaking/setQueueError"
                ),

            setQueuePosition: (position) =>
                set(
                    { queuePosition: position },
                    false,
                    "matchmaking/setQueuePosition"
                ),

            setPlayersInQueue: (players) =>
                set(
                    { playersInQueue: players },
                    false,
                    "matchmaking/setPlayersInQueue"
                ),

            addPlayerToQueue: (player) =>
                set(
                    (state) => ({
                        playersInQueue: [...state.playersInQueue, player],
                    }),
                    false,
                    "matchmaking/addPlayerToQueue"
                ),

            removePlayerFromQueue: (address) =>
                set(
                    (state) => ({
                        playersInQueue: state.playersInQueue.filter(
                            (p) => p.address !== address
                        ),
                    }),
                    false,
                    "matchmaking/removePlayerFromQueue"
                ),

            setRoom: (room) =>
                set(
                    { currentRoom: room, roomCode: room.code },
                    false,
                    "matchmaking/setRoom"
                ),

            setRoomCode: (code) =>
                set(
                    { roomCode: code },
                    false,
                    "matchmaking/setRoomCode"
                ),

            updateRoomStatus: (status) =>
                set(
                    (state) => ({
                        currentRoom: state.currentRoom
                            ? { ...state.currentRoom, status }
                            : null,
                    }),
                    false,
                    "matchmaking/updateRoomStatus"
                ),

            clearRoom: () =>
                set(
                    { currentRoom: null, roomCode: null },
                    false,
                    "matchmaking/clearRoom"
                ),

            clearError: () =>
                set(
                    { error: null, queueStatus: "idle" },
                    false,
                    "matchmaking/clearError"
                ),

            reset: () =>
                set(initialState, false, "matchmaking/reset"),
        }),
        { name: "KaspaClash Matchmaking" }
    )
);

export const selectIsInQueue = (state: MatchmakingStore): boolean =>
    state.queueStatus === "queued" || state.queueStatus === "matching";

export const selectIsMatchmaking = (state: MatchmakingStore): boolean =>
    state.queueStatus === "joining" ||
    state.queueStatus === "queued" ||
    state.queueStatus === "matching";

export const selectQueueWaitTime = (state: MatchmakingStore): number => {
    if (!state.queuedAt) return 0;
    return Math.floor((Date.now() - state.queuedAt) / 1000);
};

export const selectPlayerCount = (state: MatchmakingStore): number =>
    state.playersInQueue.length;

export const selectIsInRoom = (state: MatchmakingStore): boolean =>
    state.currentRoom !== null;

export const selectIsRoomReady = (state: MatchmakingStore): boolean =>
    state.currentRoom?.status === "ready";

export const selectIsRoomHost = (
    state: MatchmakingStore,
    playerAddress: string | null
): boolean =>
    state.currentRoom?.hostAddress === playerAddress;

export default useMatchmakingStore;