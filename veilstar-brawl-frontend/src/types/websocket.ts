/**
 * WebSocket / Realtime event payload types
 * Used by useGameChannel for Supabase Realtime broadcasts
 */

import type { MoveType } from "./game";

export type PlayerRole = "player1" | "player2";

// =============================================================================
// GAME EVENT PAYLOADS
// =============================================================================

export interface RoundStartingPayload {
    matchId: string;
    roundNumber: number;
    turnNumber: number;
    player1Health: number;
    player2Health: number;
    player1Energy: number;
    player2Energy: number;
    player1GuardMeter: number;
    player2GuardMeter: number;
    player1IsStunned: boolean;
    player2IsStunned: boolean;
    moveDeadlineAt: number; // Unix timestamp
    countdownEndsAt: number; // Unix timestamp
    // Power surge data
    hasPowerSurge?: boolean;
    powerSurgeCards?: any[];
}

export interface MoveSubmittedPayload {
    matchId: string;
    player: PlayerRole;
    roundNumber: number;
    turnNumber: number;
    submittedAt: number;
}

export interface MoveConfirmedPayload {
    matchId: string;
    player: PlayerRole;
    roundNumber: number;
    turnNumber: number;
    txId: string | null;
    confirmedAt: number;
}

export interface RoundResolvedPayload {
    matchId: string;
    roundNumber: number;
    turnNumber: number;
    player1: {
        move: MoveType;
        damageDealt: number;
        healthAfter: number;
        energyAfter: number;
        guardMeterAfter: number;
        isStunned: boolean;
    };
    player2: {
        move: MoveType;
        damageDealt: number;
        healthAfter: number;
        energyAfter: number;
        guardMeterAfter: number;
        isStunned: boolean;
    };
    narrative: string;
    roundWinner: "player1" | "player2" | "draw";
    isRoundOver: boolean;
    isMatchOver: boolean;
    // Next round data
    nextRoundDeadlineAt?: number;
    nextRoundCountdownAt?: number;
    // Power surge
    hasPowerSurge?: boolean;
    powerSurgeCards?: any[];
}

export interface MatchEndedPayload {
    matchId: string;
    winner: PlayerRole | null;
    reason: "knockout" | "rounds_won" | "forfeit" | "timeout";
    finalScore: {
        player1RoundsWon: number;
        player2RoundsWon: number;
    };
    ratingChanges?: {
        winner: { before: number; after: number; change: number };
        loser: { before: number; after: number; change: number };
    };
    onChainSessionId?: number;
    onChainTxHash?: string;
    contractId?: string;
}

export interface MatchStartingPayload {
    matchId: string;
    startsAt: number; // Unix timestamp
    player1: {
        address: string;
        characterId: string;
    };
    player2: {
        address: string;
        characterId: string;
    };
    onChainSessionId?: number;
    contractId?: string;
}

export interface CharacterSelectedPayload {
    player: PlayerRole;
    characterId: string | null;
    locked: boolean;
}

export interface ChatMessagePayload {
    sender: PlayerRole;
    senderAddress: string;
    message: string;
    timestamp: number;
}

export interface StickerPayload {
    sender: PlayerRole;
    senderAddress: string;
    stickerId: string;
    timestamp: number;
}

// =============================================================================
// PRESENCE
// =============================================================================

export interface GamePlayerPresence {
    address: string;
    role: PlayerRole;
    isReady: boolean;
}
