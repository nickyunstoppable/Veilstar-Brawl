/**
 * Move Transaction Builder (Stellar)
 * Builds and verifies move messages signed by Stellar keypairs.
 * For ranked quick-match, we use signature verification only (no on-chain tx).
 */

import type { MoveType } from "../../types/game";

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Move type to opcode mapping (for compact encoding).
 */
export const MOVE_OPCODES: Record<MoveType, string> = {
    punch: "01",
    kick: "02",
    block: "03",
    special: "04",
    stunned: "00",
};

/**
 * Veilstar Brawl protocol identifier.
 */
export const PROTOCOL_PREFIX = "VEILSTAR";

// =============================================================================
// TYPES
// =============================================================================

/**
 * Move transaction request.
 */
export interface MoveTransactionRequest {
    matchId: string;
    roundNumber: number;
    moveType: MoveType;
    playerAddress: string; // Stellar public key
}

/**
 * Built move message ready for signing.
 */
export interface BuiltMoveMessage {
    message: string;
    matchId: string;
    roundNumber: number;
    moveType: MoveType;
}

/**
 * Move message build result.
 */
export interface MoveMessageResult {
    success: boolean;
    builtMessage?: BuiltMoveMessage;
    error?: string;
}

/**
 * Signed move ready for submission to server.
 */
export interface SignedMove {
    message: string;
    signature: string;
    publicKey: string;
    matchId: string;
    roundNumber: number;
    moveType: MoveType;
}

// =============================================================================
// MESSAGE BUILDING
// =============================================================================

/**
 * Build a move message for signing.
 * This is used for signature verification without a full on-chain transaction.
 */
export function buildMoveMessage(
    matchId: string,
    roundNumber: number,
    moveType: MoveType,
    timestamp: number = Date.now()
): string {
    return JSON.stringify({
        protocol: PROTOCOL_PREFIX,
        version: 1,
        matchId,
        round: roundNumber,
        move: moveType,
        timestamp,
    });
}

/**
 * Build a move message result from a request.
 */
export function buildMoveRequest(
    request: MoveTransactionRequest
): MoveMessageResult {
    try {
        const message = buildMoveMessage(
            request.matchId,
            request.roundNumber,
            request.moveType
        );

        return {
            success: true,
            builtMessage: {
                message,
                matchId: request.matchId,
                roundNumber: request.roundNumber,
                moveType: request.moveType,
            },
        };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : "Unknown error building message",
        };
    }
}

/**
 * Verify a move message structure (no signature check — server does that).
 */
export function verifyMoveMessage(
    message: string,
    expectedMatchId: string,
    expectedRound: number
): { valid: boolean; moveType?: MoveType; error?: string } {
    try {
        const parsed = JSON.parse(message);

        if (parsed.protocol !== PROTOCOL_PREFIX) {
            return { valid: false, error: "Invalid protocol" };
        }

        if (parsed.matchId !== expectedMatchId) {
            return { valid: false, error: "Match ID mismatch" };
        }

        if (parsed.round !== expectedRound) {
            return { valid: false, error: "Round number mismatch" };
        }

        const validMoves: MoveType[] = ["punch", "kick", "block", "special", "stunned"];
        if (!validMoves.includes(parsed.move)) {
            return { valid: false, error: "Invalid move type" };
        }

        return { valid: true, moveType: parsed.move };
    } catch {
        return { valid: false, error: "Invalid message format" };
    }
}

/**
 * Estimate a nominal fee (for UI display).
 * Since we use signature-only for ranked, this returns 0.
 */
export function estimateFee(): number {
    return 0;
}
