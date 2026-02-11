/**
 * Match Store - Zustand state management for match data
 * Manages current match state, rounds, and moves
 */

import { create } from "zustand";
import type {
    Match,
    Round,
    MoveType,
    MatchStatus,
    MatchResult,
} from "../types/game";

// =============================================================================
// TYPES
// =============================================================================

export type PlayerRole = "player1" | "player2";

export type GameStateType =
    | "idle"
    | "character_select"
    | "countdown"
    | "selecting"
    | "resolving"
    | "round_end"
    | "match_end";

/**
 * Current round state for local tracking.
 */
interface RoundState {
    roundNumber: number;
    player1Move: MoveType | null;
    player2Move: MoveType | null;
    player1MoveConfirmed: boolean;
    player2MoveConfirmed: boolean;
    player1Health: number;
    player2Health: number;
    timeRemaining: number;
    isResolved: boolean;
}

/**
 * Move submission state.
 */
interface MoveSubmission {
    move: MoveType;
    txId: string | null;
    status: "pending" | "submitted" | "confirmed" | "failed";
    error?: string;
}

/**
 * Match store state.
 */
interface MatchState {
    match: Match | null;
    matchId: string | null;
    playerRole: PlayerRole | null;
    gameState: GameStateType;
    currentRound: RoundState;
    roundHistory: Round[];
    currentMove: MoveSubmission | null;
    isLoading: boolean;
    error: string | null;

    actions: {
        // Match lifecycle
        initMatch: (match: Match, playerRole: PlayerRole) => void;
        updateMatch: (matchUpdate: Partial<Match>) => void;
        setMatchStatus: (status: MatchStatus) => void;
        resetMatch: () => void;

        // Game state transitions
        transitionTo: (newState: GameStateType) => void;

        // Round management
        startRound: (roundNumber: number) => void;
        updateTimeRemaining: (seconds: number) => void;

        // Move management
        selectMove: (move: MoveType) => void;
        submitMove: (move: MoveType, txId: string | null) => void;
        confirmMove: (playerRole: PlayerRole) => void;
        failMoveSubmission: (error: string) => void;

        // Round resolution
        resolveRound: (
            player1Move: MoveType,
            player2Move: MoveType,
            player1Damage: number,
            player2Damage: number
        ) => void;
        setRoundWinner: (winner: "player1" | "player2" | "draw") => void;

        // Match completion
        endMatch: (result: MatchResult) => void;

        // Health management
        setPlayerHealth: (player: PlayerRole, health: number) => void;
        applyDamage: (player: PlayerRole, damage: number) => void;

        // Error handling
        setError: (error: string | null) => void;
        setLoading: (loading: boolean) => void;
    };
}

// =============================================================================
// INITIAL STATE
// =============================================================================

const initialRoundState: RoundState = {
    roundNumber: 1,
    player1Move: null,
    player2Move: null,
    player1MoveConfirmed: false,
    player2MoveConfirmed: false,
    player1Health: 100,
    player2Health: 100,
    timeRemaining: 15,
    isResolved: false,
};

export const useMatchStore = create<MatchState>()((set) => ({
    match: null,
    matchId: null,
    playerRole: null,
    gameState: "idle",
    currentRound: { ...initialRoundState },
    roundHistory: [],
    currentMove: null,
    isLoading: false,
    error: null,

    actions: {
        initMatch: (match, playerRole) =>
            set({
                match,
                matchId: match.id,
                playerRole,
                gameState: "character_select",
                currentRound: { ...initialRoundState },
                roundHistory: [],
                currentMove: null,
                error: null,
            }),

        updateMatch: (matchUpdate) =>
            set((state) => ({
                match: state.match ? { ...state.match, ...matchUpdate } : null,
            })),

        setMatchStatus: (status) =>
            set((state) => ({
                match: state.match ? { ...state.match, status } : null,
            })),

        resetMatch: () =>
            set({
                match: null,
                matchId: null,
                playerRole: null,
                gameState: "idle",
                currentRound: { ...initialRoundState },
                roundHistory: [],
                currentMove: null,
                error: null,
            }),

        transitionTo: (newState) =>
            set((state) => {
                console.log(
                    `[MatchStore] State transition: ${state.gameState} → ${newState}`
                );
                return { gameState: newState };
            }),

        startRound: (roundNumber) =>
            set({
                currentRound: {
                    ...initialRoundState,
                    roundNumber,
                },
                currentMove: null,
                gameState: "countdown",
            }),

        updateTimeRemaining: (seconds) =>
            set((state) => ({
                currentRound: { ...state.currentRound, timeRemaining: seconds },
            })),

        selectMove: (move) =>
            set({
                currentMove: { move, txId: null, status: "pending" },
            }),

        submitMove: (move, txId) =>
            set({
                currentMove: { move, txId, status: "submitted" },
            }),

        confirmMove: (playerRole) =>
            set((state) => {
                const round = { ...state.currentRound };
                if (playerRole === "player1") {
                    round.player1MoveConfirmed = true;
                } else {
                    round.player2MoveConfirmed = true;
                }

                // If current player's move was just confirmed, update submission status
                const currentMove = state.currentMove;
                const updatedMove =
                    playerRole === state.playerRole && currentMove
                        ? { ...currentMove, status: "confirmed" as const }
                        : currentMove;

                return { currentRound: round, currentMove: updatedMove };
            }),

        failMoveSubmission: (error) =>
            set((state) => ({
                currentMove: state.currentMove
                    ? { ...state.currentMove, status: "failed", error }
                    : null,
            })),

        resolveRound: (player1Move, player2Move, player1Damage, player2Damage) =>
            set((state) => {
                const round = { ...state.currentRound };
                round.player1Move = player1Move;
                round.player2Move = player2Move;
                round.player1Health = Math.max(
                    0,
                    round.player1Health - player1Damage
                );
                round.player2Health = Math.max(
                    0,
                    round.player2Health - player2Damage
                );
                round.isResolved = true;

                return {
                    currentRound: round,
                    gameState: "resolving",
                };
            }),

        setRoundWinner: (winner) =>
            set((state) => {
                const completedRound: Round = {
                    number: state.currentRound.roundNumber,
                    moves: {
                        player1: [],
                        player2: [],
                    },
                    winner,
                    player1Health: state.currentRound.player1Health,
                    player2Health: state.currentRound.player2Health,
                };

                return {
                    roundHistory: [...state.roundHistory, completedRound],
                    gameState: "round_end",
                };
            }),

        endMatch: (result) =>
            set((state) => ({
                match: state.match
                    ? { ...state.match, result, status: "match_end" as MatchStatus }
                    : null,
                gameState: "match_end",
            })),

        setPlayerHealth: (player, health) =>
            set((state) => ({
                currentRound: {
                    ...state.currentRound,
                    [player === "player1" ? "player1Health" : "player2Health"]: health,
                },
            })),

        applyDamage: (player, damage) =>
            set((state) => {
                const key =
                    player === "player1" ? "player1Health" : "player2Health";
                return {
                    currentRound: {
                        ...state.currentRound,
                        [key]: Math.max(0, state.currentRound[key] - damage),
                    },
                };
            }),

        setError: (error) => set({ error }),
        setLoading: (loading) => set({ isLoading: loading }),
    },
}));

// =============================================================================
// SELECTORS
// =============================================================================

export const selectMatch = (state: MatchState) => state.match;
export const selectPlayerRole = (state: MatchState) => state.playerRole;
export const selectGameState = (state: MatchState) => state.gameState;
export const selectCurrentRound = (state: MatchState) => state.currentRound;
export const selectRoundHistory = (state: MatchState) => state.roundHistory;
export const selectCurrentMove = (state: MatchState) => state.currentMove;

export default useMatchStore;
