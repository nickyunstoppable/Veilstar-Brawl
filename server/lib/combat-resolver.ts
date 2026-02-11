/**
 * Combat Resolver — orchestrates round resolution with database persistence
 * Called when both players have submitted moves for a turn.
 * Replays previous rounds to rebuild engine state, resolves current turn,
 * writes results, and broadcasts via Supabase Realtime.
 *
 * Adapted from KaspaClash lib/game/combat-resolver.ts
 */

import { getSupabase } from "./supabase";
import { broadcastGameEvent } from "./matchmaker";
import {
    type MoveType,
    type RoundResolutionInput,
    GAME_CONSTANTS,
    calculateEloChange,
} from "./game-types";
import {
    resolveRound,
    isMatchOver,
    getMatchWinner,
    isValidMove,
} from "./round-resolver";
import { reportMatchResultOnChain, isStellarConfigured, matchIdToSessionId } from "./stellar-contract";

// =============================================================================
// TYPES
// =============================================================================

export interface CombatResolutionResult {
    success: boolean;
    turnNumber: number;
    roundNumber: number;
    player1Move: MoveType;
    player2Move: MoveType;
    player1DamageDealt: number;
    player2DamageDealt: number;
    player1HealthAfter: number;
    player2HealthAfter: number;
    player1EnergyAfter: number;
    player2EnergyAfter: number;
    player1GuardAfter: number;
    player2GuardAfter: number;
    isRoundOver: boolean;
    roundWinner: "player1" | "player2" | "draw" | null;
    isMatchOver: boolean;
    matchWinner: "player1" | "player2" | null;
    narrative: string;
    error?: string;
}

// =============================================================================
// MAIN RESOLUTION
// =============================================================================

/**
 * Resolve a turn — called when both players have submitted moves.
 * Replays all previous turns to get current state, then resolves.
 */
export async function resolveTurn(
    matchId: string,
    roundId: string
): Promise<CombatResolutionResult> {
    const supabase = getSupabase();

    try {
        // Fetch the current round
        const { data: currentRound, error: roundError } = await supabase
            .from("rounds")
            .select("*")
            .eq("id", roundId)
            .single();

        if (roundError || !currentRound) {
            return createErrorResult("Round not found");
        }

        // Verify both moves submitted
        if (!currentRound.player1_move || !currentRound.player2_move) {
            return createErrorResult("Both players must submit moves first");
        }

        if (!isValidMove(currentRound.player1_move) || !isValidMove(currentRound.player2_move)) {
            return createErrorResult("Invalid move type");
        }

        // Fetch the match
        const { data: match, error: matchError } = await supabase
            .from("matches")
            .select("*")
            .eq("id", matchId)
            .single();

        if (matchError || !match) {
            return createErrorResult("Match not found");
        }

        // Replay previous turns to get current state
        const state = await replayToCurrentState(matchId, roundId);

        const p1Move = currentRound.player1_move as MoveType;
        const p2Move = currentRound.player2_move as MoveType;

        // Resolve the turn
        const input: RoundResolutionInput = {
            player1Move: p1Move,
            player2Move: p2Move,
            player1Health: state.player1Health,
            player2Health: state.player2Health,
            player1Energy: state.player1Energy,
            player2Energy: state.player2Energy,
            player1Guard: state.player1Guard,
            player2Guard: state.player2Guard,
        };

        const resolution = resolveRound(input);

        // Determine round winner
        let p1RoundsWon = match.player1_rounds_won || 0;
        let p2RoundsWon = match.player2_rounds_won || 0;
        let roundOver = false;
        let roundWinner = resolution.winner;

        if (resolution.isKnockout) {
            roundOver = true;
            if (roundWinner === "player1") p1RoundsWon++;
            else if (roundWinner === "player2") p2RoundsWon++;
        }

        const roundsToWin = match.format === "best_of_5"
            ? GAME_CONSTANTS.ROUNDS_TO_WIN_BEST_OF_5
            : GAME_CONSTANTS.ROUNDS_TO_WIN_BEST_OF_3;

        const matchOver = isMatchOver(p1RoundsWon, p2RoundsWon, roundsToWin);
        const matchWinner = getMatchWinner(p1RoundsWon, p2RoundsWon, roundsToWin);

        // Persist round results
        await supabase
            .from("rounds")
            .update({
                player1_damage_dealt: resolution.player1.damageDealt,
                player2_damage_dealt: resolution.player2.damageDealt,
                player1_health_after: resolution.player1HealthAfter,
                player2_health_after: resolution.player2HealthAfter,
                player1_energy: resolution.player1EnergyAfter,
                player2_energy: resolution.player2EnergyAfter,
                player1_guard_meter: resolution.player1GuardAfter,
                player2_guard_meter: resolution.player2GuardAfter,
                winner_address: roundWinner === "player1" ? match.player1_address
                    : roundWinner === "player2" ? match.player2_address
                        : null,
            })
            .eq("id", roundId);

        // Update match state
        let eloChanges: EloChanges | null = null;
        if (matchOver && matchWinner) {
            const winnerAddress = matchWinner === "player1"
                ? match.player1_address
                : match.player2_address;

            await supabase
                .from("matches")
                .update({
                    status: "completed",
                    winner_address: winnerAddress,
                    player1_rounds_won: p1RoundsWon,
                    player2_rounds_won: p2RoundsWon,
                    completed_at: new Date().toISOString(),
                    fight_phase: "match_end",
                })
                .eq("id", matchId);

            // Update Elo ratings
            eloChanges = await updateElo(match, winnerAddress);
        } else {
            await supabase
                .from("matches")
                .update({
                    player1_rounds_won: p1RoundsWon,
                    player2_rounds_won: p2RoundsWon,
                    fight_phase: roundOver ? "round_end" : "selecting",
                })
                .eq("id", matchId);
        }

        // Update fight state snapshot
        await supabase
            .from("fight_state_snapshots")
            .update({
                current_round: currentRound.round_number,
                current_turn: currentRound.turn_number || 1,
                phase: matchOver ? "match_end" : roundOver ? "round_end" : "selecting",
                player1_health: resolution.player1HealthAfter,
                player1_energy: resolution.player1EnergyAfter,
                player1_guard_meter: resolution.player1GuardAfter,
                player1_rounds_won: p1RoundsWon,
                player1_has_submitted_move: false,
                player2_health: resolution.player2HealthAfter,
                player2_energy: resolution.player2EnergyAfter,
                player2_guard_meter: resolution.player2GuardAfter,
                player2_rounds_won: p2RoundsWon,
                player2_has_submitted_move: false,
                last_resolved_player1_move: p1Move,
                last_resolved_player2_move: p2Move,
                last_narrative: resolution.narrative,
                updated_at: new Date().toISOString(),
            })
            .eq("match_id", matchId);

        // Build result
        const result: CombatResolutionResult = {
            success: true,
            turnNumber: currentRound.turn_number || 1,
            roundNumber: currentRound.round_number,
            player1Move: p1Move,
            player2Move: p2Move,
            player1DamageDealt: resolution.player1.damageDealt,
            player2DamageDealt: resolution.player2.damageDealt,
            player1HealthAfter: resolution.player1HealthAfter,
            player2HealthAfter: resolution.player2HealthAfter,
            player1EnergyAfter: resolution.player1EnergyAfter,
            player2EnergyAfter: resolution.player2EnergyAfter,
            player1GuardAfter: resolution.player1GuardAfter,
            player2GuardAfter: resolution.player2GuardAfter,
            isRoundOver: roundOver,
            roundWinner: roundWinner,
            isMatchOver: matchOver,
            matchWinner: matchWinner,
            narrative: resolution.narrative,
        };

        // Broadcast round resolved
        await broadcastGameEvent(matchId, "round_resolved", {
            ...result,
            player1Address: match.player1_address,
            player2Address: match.player2_address,
            player1: {
                move: p1Move,
                damageDealt: resolution.player1.damageDealt,
                healthAfter: resolution.player1HealthAfter,
                energyAfter: resolution.player1EnergyAfter,
            },
            player2: {
                move: p2Move,
                damageDealt: resolution.player2.damageDealt,
                healthAfter: resolution.player2HealthAfter,
                energyAfter: resolution.player2EnergyAfter,
            },
        });

        // If match is over, report result on-chain and broadcast match ended
        if (matchOver && matchWinner) {
            const winnerAddr = matchWinner === "player1"
                ? match.player1_address
                : match.player2_address;

            // Report result on-chain (non-blocking)
            let onChainTxHash: string | undefined;
            if (isStellarConfigured()) {
                try {
                    const onChainResult = await reportMatchResultOnChain(
                        matchId,
                        match.player1_address,
                        match.player2_address,
                        winnerAddr,
                    );
                    onChainTxHash = onChainResult.txHash;
                    console.log(`[CombatResolver] On-chain result reported: ${onChainResult.success ? 'OK' : 'FAILED'}`, onChainResult.txHash || onChainResult.error || '');

                    // Store tx hash
                    if (onChainResult.txHash) {
                        await supabase.from('matches').update({
                            onchain_result_tx_hash: onChainResult.txHash,
                        }).eq('id', matchId);
                    }
                } catch (err) {
                    console.error('[CombatResolver] On-chain report error:', err);
                }
            }

            await broadcastGameEvent(matchId, "match_ended", {
                matchId,
                winner: matchWinner,
                winnerAddress: winnerAddr,
                player1RoundsWon: p1RoundsWon,
                player2RoundsWon: p2RoundsWon,
                reason: "knockout",
                ratingChanges: eloChanges ?? undefined,
                onChainSessionId: matchIdToSessionId(matchId),
                onChainTxHash,
                contractId: process.env.VITE_VEILSTAR_BRAWL_CONTRACT_ID || '',
            });
        } else if (roundOver) {
            // Broadcast round end, then next round start after delay
            await broadcastGameEvent(matchId, "round_ended", {
                roundNumber: currentRound.round_number,
                roundWinner,
                player1RoundsWon: p1RoundsWon,
                player2RoundsWon: p2RoundsWon,
            });

            // Broadcast next round starting after a short delay
            const nextRoundNumber = currentRound.round_number + 1;
            const countdownEndsAt = Date.now() + GAME_CONSTANTS.COUNTDOWN_SECONDS * 1000 + 3000; // 3s UI delay + countdown
            const moveDeadline = countdownEndsAt + GAME_CONSTANTS.MOVE_TIMER_SECONDS * 1000;

            setTimeout(async () => {
                try {
                    await broadcastGameEvent(matchId, "round_starting", {
                        roundNumber: nextRoundNumber,
                        turnNumber: 1,
                        player1Health: GAME_CONSTANTS.MAX_HEALTH,
                        player2Health: GAME_CONSTANTS.MAX_HEALTH,
                        moveDeadlineAt: moveDeadline,
                        countdownEndsAt,
                    });
                } catch (err) {
                    console.error("[CombatResolver] Failed to broadcast round_starting:", err);
                }
            }, 3000);
        } else if (!matchOver) {
            // Same round, next turn — broadcast round_starting after animation delay
            const nextTurn = (currentRound.turn_number || 1) + 1;
            const animDelay = 2500; // Allow resolution animation to play
            const countdownEndsAt = Date.now() + animDelay + GAME_CONSTANTS.COUNTDOWN_SECONDS * 1000;
            const moveDeadlineNext = countdownEndsAt + GAME_CONSTANTS.MOVE_TIMER_SECONDS * 1000;

            setTimeout(async () => {
                try {
                    await broadcastGameEvent(matchId, "round_starting", {
                        roundNumber: currentRound.round_number,
                        turnNumber: nextTurn,
                        player1Health: resolution.player1HealthAfter,
                        player2Health: resolution.player2HealthAfter,
                        moveDeadlineAt: moveDeadlineNext,
                        countdownEndsAt: Date.now() + GAME_CONSTANTS.COUNTDOWN_SECONDS * 1000,
                    });
                } catch (err) {
                    console.error("[CombatResolver] Failed to broadcast next turn:", err);
                }
            }, animDelay);
        }

        return result;
    } catch (err) {
        console.error("[CombatResolver] Error resolving turn:", err);
        return createErrorResult(
            err instanceof Error ? err.message : "Unknown resolution error"
        );
    }
}

// =============================================================================
// STATE REPLAY
// =============================================================================

interface ReplayedState {
    player1Health: number;
    player2Health: number;
    player1Energy: number;
    player2Energy: number;
    player1Guard: number;
    player2Guard: number;
}

/**
 * Replay all previous rounds/turns to reconstruct current state.
 * This ensures server state is always consistent.
 */
async function replayToCurrentState(
    matchId: string,
    currentRoundId: string
): Promise<ReplayedState> {
    const supabase = getSupabase();

    // Fetch all resolved rounds before this one
    const { data: previousRounds } = await supabase
        .from("rounds")
        .select("*")
        .eq("match_id", matchId)
        .neq("id", currentRoundId)
        .not("player1_move", "is", null)
        .not("player2_move", "is", null)
        .order("round_number", { ascending: true })
        .order("turn_number", { ascending: true });

    let state: ReplayedState = {
        player1Health: GAME_CONSTANTS.MAX_HEALTH,
        player2Health: GAME_CONSTANTS.MAX_HEALTH,
        player1Energy: GAME_CONSTANTS.MAX_ENERGY,
        player2Energy: GAME_CONSTANTS.MAX_ENERGY,
        player1Guard: 0,
        player2Guard: 0,
    };

    if (!previousRounds || previousRounds.length === 0) {
        return state;
    }

    // Replay each resolved turn
    for (const round of previousRounds) {
        if (!round.player1_move || !round.player2_move) continue;

        const input: RoundResolutionInput = {
            player1Move: round.player1_move as MoveType,
            player2Move: round.player2_move as MoveType,
            player1Health: state.player1Health,
            player2Health: state.player2Health,
            player1Energy: state.player1Energy,
            player2Energy: state.player2Energy,
            player1Guard: state.player1Guard,
            player2Guard: state.player2Guard,
        };

        const result = resolveRound(input);
        state.player1Health = result.player1HealthAfter;
        state.player2Health = result.player2HealthAfter;
        state.player1Energy = result.player1EnergyAfter;
        state.player2Energy = result.player2EnergyAfter;
        state.player1Guard = result.player1GuardAfter;
        state.player2Guard = result.player2GuardAfter;

        // If knockout, reset health for next round
        if (result.isKnockout) {
            state.player1Health = GAME_CONSTANTS.MAX_HEALTH;
            state.player2Health = GAME_CONSTANTS.MAX_HEALTH;
            state.player1Energy = GAME_CONSTANTS.MAX_ENERGY;
            state.player2Energy = GAME_CONSTANTS.MAX_ENERGY;
            state.player1Guard = 0;
            state.player2Guard = 0;
        }
    }

    return state;
}

// =============================================================================
// MOVE TIMEOUT
// =============================================================================

/**
 * Handle when a player's move timer expires.
 * Awards the turn to the player who submitted, or random moves if neither submitted.
 */
export async function handleMoveTimeout(
    matchId: string,
    roundId: string
): Promise<CombatResolutionResult> {
    const supabase = getSupabase();

    const { data: round } = await supabase
        .from("rounds")
        .select("*")
        .eq("id", roundId)
        .single();

    if (!round) return createErrorResult("Round not found");

    // If neither submitted, assign random moves
    if (!round.player1_move && !round.player2_move) {
        const randomMoves: MoveType[] = ["punch", "kick", "block"];
        const p1Move = randomMoves[Math.floor(Math.random() * randomMoves.length)];
        const p2Move = randomMoves[Math.floor(Math.random() * randomMoves.length)];

        await supabase
            .from("rounds")
            .update({ player1_move: p1Move, player2_move: p2Move })
            .eq("id", roundId);

        return resolveTurn(matchId, roundId);
    }

    // If only one submitted, the non-submitter gets "block" (defensive default)
    if (!round.player1_move) {
        await supabase
            .from("rounds")
            .update({ player1_move: "block" })
            .eq("id", roundId);
    }
    if (!round.player2_move) {
        await supabase
            .from("rounds")
            .update({ player2_move: "block" })
            .eq("id", roundId);
    }

    return resolveTurn(matchId, roundId);
}

// =============================================================================
// ELO UPDATE
// =============================================================================

interface EloChanges {
    winner: { before: number; after: number; change: number };
    loser: { before: number; after: number; change: number };
}

async function updateElo(match: any, winnerAddress: string): Promise<EloChanges | null> {
    // Skip Elo for bot matches — bots don't have player records
    if (match.is_bot_match) {
        console.log("[CombatResolver] Skipping Elo update for bot match");
        return null;
    }

    const supabase = getSupabase();

    try {
        const { data: p1 } = await supabase
            .from("players")
            .select("rating, wins, losses")
            .eq("address", match.player1_address)
            .single();

        const { data: p2 } = await supabase
            .from("players")
            .select("rating, wins, losses")
            .eq("address", match.player2_address)
            .single();

        if (!p1 || !p2) return null;

        const isP1Winner = winnerAddress === match.player1_address;
        const winnerRating = isP1Winner ? p1.rating : p2.rating;
        const loserRating = isP1Winner ? p2.rating : p1.rating;
        const { winnerChange, loserChange } = calculateEloChange(winnerRating, loserRating);

        const winnerAfter = Math.max(100, winnerRating + winnerChange);
        const loserAfter = Math.max(100, loserRating + loserChange);

        // Update winner
        await supabase
            .from("players")
            .update({
                rating: winnerAfter,
                wins: (isP1Winner ? p1.wins : p2.wins) + 1,
                updated_at: new Date().toISOString(),
            })
            .eq("address", winnerAddress);

        // Update loser
        const loserAddress = isP1Winner ? match.player2_address : match.player1_address;
        await supabase
            .from("players")
            .update({
                rating: loserAfter,
                losses: (isP1Winner ? p2.losses : p1.losses) + 1,
                updated_at: new Date().toISOString(),
            })
            .eq("address", loserAddress);

        console.log(`[CombatResolver] Elo updated: winner ${winnerChange > 0 ? "+" : ""}${winnerChange}, loser ${loserChange}`);

        return {
            winner: { before: winnerRating, after: winnerAfter, change: winnerChange },
            loser: { before: loserRating, after: loserAfter, change: loserChange },
        };
    } catch (err) {
        console.error("[CombatResolver] Failed to update Elo:", err);
        return null;
    }
}

// =============================================================================
// HELPERS
// =============================================================================

function createErrorResult(error: string): CombatResolutionResult {
    return {
        success: false,
        turnNumber: 0,
        roundNumber: 0,
        player1Move: "punch",
        player2Move: "punch",
        player1DamageDealt: 0,
        player2DamageDealt: 0,
        player1HealthAfter: 0,
        player2HealthAfter: 0,
        player1EnergyAfter: 0,
        player2EnergyAfter: 0,
        player1GuardAfter: 0,
        player2GuardAfter: 0,
        isRoundOver: false,
        roundWinner: null,
        isMatchOver: false,
        matchWinner: null,
        narrative: "",
        error,
    };
}
