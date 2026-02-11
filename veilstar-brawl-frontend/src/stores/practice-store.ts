/**
 * Practice Mode Store
 * Zustand store for managing practice mode state
 */

import { create } from "zustand";
import type { MoveType } from "@/types/game";

// =============================================================================
// TYPES
// =============================================================================

export type AIDifficulty = "easy" | "medium" | "hard";

export interface PracticeMatchState {
  isPlaying: boolean;
  characterId: string | null;
  difficulty: AIDifficulty;
  matchFormat: "best_of_3" | "best_of_5";

  // Match progress
  currentRound: number;
  playerRoundsWon: number;
  aiRoundsWon: number;
  playerHealth: number;
  aiHealth: number;
  playerMaxHealth: number;
  aiMaxHealth: number;

  // Move history
  playerMoves: MoveType[];
  aiMoves: MoveType[];

  // Results
  matchResult: "win" | "loss" | null;
  matchEndedAt: number | null;
}

export interface PracticeStats {
  totalMatches: number;
  wins: number;
  losses: number;
  winStreak: number;
  bestWinStreak: number;
  favoriteCharacter: string | null;
  favoriteMove: MoveType | null;
  characterUsage: Record<string, number>;
  moveUsage: Record<MoveType, number>;
}

export interface PracticeStore extends PracticeMatchState {
  stats: PracticeStats;

  // Actions
  startMatch: (characterId: string, difficulty: AIDifficulty, format?: "best_of_3" | "best_of_5") => void;
  endMatch: (playerWon: boolean) => void;
  updateHealth: (playerHealth: number, aiHealth: number) => void;
  recordRoundWin: (winner: "player" | "ai") => void;
  recordMove: (player: "player" | "ai", move: MoveType) => void;
  resetMatch: () => void;
  resetSession: () => void;
}

// =============================================================================
// INITIAL STATE
// =============================================================================

const INITIAL_MATCH_STATE: PracticeMatchState = {
  isPlaying: false,
  characterId: null,
  difficulty: "medium",
  matchFormat: "best_of_3",
  currentRound: 1,
  playerRoundsWon: 0,
  aiRoundsWon: 0,
  playerHealth: 100,
  aiHealth: 100,
  playerMaxHealth: 100,
  aiMaxHealth: 100,
  playerMoves: [],
  aiMoves: [],
  matchResult: null,
  matchEndedAt: null,
};

const INITIAL_STATS: PracticeStats = {
  totalMatches: 0,
  wins: 0,
  losses: 0,
  winStreak: 0,
  bestWinStreak: 0,
  favoriteCharacter: null,
  favoriteMove: null,
  characterUsage: {},
  moveUsage: {} as Record<MoveType, number>,
};

// =============================================================================
// STORE
// =============================================================================

export const usePracticeStore = create<PracticeStore>((set, get) => ({
  ...INITIAL_MATCH_STATE,
  stats: { ...INITIAL_STATS },

  startMatch: (characterId, difficulty, format = "best_of_3") => {
    set({
      isPlaying: true,
      characterId,
      difficulty,
      matchFormat: format,
      currentRound: 1,
      playerRoundsWon: 0,
      aiRoundsWon: 0,
      playerHealth: 100,
      aiHealth: 100,
      playerMoves: [],
      aiMoves: [],
      matchResult: null,
      matchEndedAt: null,
    });
  },

  endMatch: (playerWon) => {
    const state = get();
    const stats = { ...state.stats };

    stats.totalMatches++;
    if (playerWon) {
      stats.wins++;
      stats.winStreak++;
      if (stats.winStreak > stats.bestWinStreak) {
        stats.bestWinStreak = stats.winStreak;
      }
    } else {
      stats.losses++;
      stats.winStreak = 0;
    }

    // Track character usage
    if (state.characterId) {
      stats.characterUsage[state.characterId] = (stats.characterUsage[state.characterId] || 0) + 1;

      // Update favorite character
      let maxUsage = 0;
      let favorite: string | null = null;
      for (const [charId, usage] of Object.entries(stats.characterUsage)) {
        if (usage > maxUsage) {
          maxUsage = usage;
          favorite = charId;
        }
      }
      stats.favoriteCharacter = favorite;
    }

    // Find most used move
    let maxMoveUsage = 0;
    let favoriteMove: MoveType | null = null;
    for (const [move, usage] of Object.entries(stats.moveUsage)) {
      if (usage > maxMoveUsage) {
        maxMoveUsage = usage;
        favoriteMove = move as MoveType;
      }
    }
    stats.favoriteMove = favoriteMove;

    set({
      isPlaying: false,
      matchResult: playerWon ? "win" : "loss",
      matchEndedAt: Date.now(),
      stats,
    });
  },

  updateHealth: (playerHealth, aiHealth) => {
    set({ playerHealth, aiHealth });
  },

  recordRoundWin: (winner) => {
    const state = get();
    if (winner === "player") {
      set({
        playerRoundsWon: state.playerRoundsWon + 1,
        currentRound: state.currentRound + 1,
      });
    } else {
      set({
        aiRoundsWon: state.aiRoundsWon + 1,
        currentRound: state.currentRound + 1,
      });
    }
  },

  recordMove: (player, move) => {
    const state = get();
    if (player === "player") {
      set({ playerMoves: [...state.playerMoves, move] });
    } else {
      set({ aiMoves: [...state.aiMoves, move] });
    }

    // Track move usage for stats
    const stats = { ...state.stats };
    if (player === "player") {
      stats.moveUsage[move] = (stats.moveUsage[move] || 0) + 1;
    }
    set({ stats });
  },

  resetMatch: () => {
    set({ ...INITIAL_MATCH_STATE });
  },

  resetSession: () => {
    set({
      ...INITIAL_MATCH_STATE,
      stats: { ...INITIAL_STATS },
    });
  },
}));

// Selector hooks
export const usePracticeStats = () => usePracticeStore((s) => s.stats);
export const useIsPracticePlaying = () => usePracticeStore((s) => s.isPlaying);
export const usePracticeDifficulty = () => usePracticeStore((s) => s.difficulty);
