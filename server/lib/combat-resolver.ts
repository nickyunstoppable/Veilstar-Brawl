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
import { proveAndFinalizeMatch, triggerAutoProveFinalize, getAutoProveFinalizeStatus } from "./zk-finalizer-client";
import { SURGE_SELECTION_SECONDS, normalizeStoredDeck, isPowerSurgeCardId, type PowerSurgeCardId } from "./power-surge";

const PRIVATE_ROUNDS_ENABLED = (process.env.ZK_PRIVATE_ROUNDS ?? "true") !== "false";
const ZK_STRICT_FINALIZE = (process.env.ZK_STRICT_FINALIZE ?? "true") !== "false";
const DEBUG_MATCH_END_FLOW = (process.env.DEBUG_MATCH_END_FLOW ?? "false") === "true";

function debugMatchEndLog(message: string, extra?: unknown): void {
    if (!DEBUG_MATCH_END_FLOW) return;
    if (extra === undefined) {
        console.log(`[TERMDBG][CombatResolver] ${message}`);
        return;
    }
    console.log(`[TERMDBG][CombatResolver] ${message}`, extra);
}

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
    player1IsStunnedNext?: boolean;
    player2IsStunnedNext?: boolean;
    isRoundOver: boolean;
    roundWinner: "player1" | "player2" | "draw" | null;
    isMatchOver: boolean;
    matchWinner: "player1" | "player2" | null;
    narrative: string;
    error?: string;
}

interface PrivateRoundPlanPayload {
    move?: MoveType;
    surgeCardId?: PowerSurgeCardId | null;
}

function parsePrivateRoundPlan(raw: unknown): PrivateRoundPlanPayload {
    if (!raw || typeof raw !== "string") return {};

    const normalize = (parsed: PrivateRoundPlanPayload): PrivateRoundPlanPayload => ({
        move: parsed.move && isValidMove(parsed.move) ? parsed.move : undefined,
        surgeCardId: parsed.surgeCardId && isPowerSurgeCardId(parsed.surgeCardId)
            ? parsed.surgeCardId
            : null,
    });

    try {
        return normalize(JSON.parse(raw) as PrivateRoundPlanPayload);
    } catch {
        try {
            const decoded = Buffer.from(raw, "base64").toString("utf8");
            return normalize(JSON.parse(decoded) as PrivateRoundPlanPayload);
        } catch {
            return {};
        }
    }
}

async function getPrivateSurgesForRound(params: {
    matchId: string;
    roundNumber: number;
    player1Address: string;
    player2Address: string;
}): Promise<{ player1Surge: PowerSurgeCardId | null; player2Surge: PowerSurgeCardId | null }> {
    const supabase = getSupabase();
    const { data: commitRows } = await supabase
        .from("round_private_commits")
        .select("player_address, encrypted_plan")
        .eq("match_id", params.matchId)
        .eq("round_number", params.roundNumber);

    const byAddress = new Map<string, PrivateRoundPlanPayload>();
    for (const row of commitRows || []) {
        byAddress.set(row.player_address, parsePrivateRoundPlan((row as any).encrypted_plan));
    }

    const p1Plan = byAddress.get(params.player1Address) || {};
    const p2Plan = byAddress.get(params.player2Address) || {};

    return {
        player1Surge: p1Plan.surgeCardId ?? null,
        player2Surge: p2Plan.surgeCardId ?? null,
    };
}

function getPlannedMoveForTurn(plan: PrivateRoundPlanPayload, turnNumber: number): MoveType | null {
    if (!Number.isInteger(turnNumber) || turnNumber < 1) return null;

    if (plan.move && isValidMove(plan.move)) return plan.move;
    return null;
}

async function getPrivateAutoMovesForTurn(params: {
    matchId: string;
    roundNumber: number;
    turnNumber: number;
    player1Address: string;
    player2Address: string;
}): Promise<{ player1Move: MoveType | null; player2Move: MoveType | null }> {
    const supabase = getSupabase();
    const { data: commitRows } = await supabase
        .from("round_private_commits")
        .select("player_address, encrypted_plan")
        .eq("match_id", params.matchId)
        .eq("round_number", params.roundNumber);

    const byAddress = new Map<string, PrivateRoundPlanPayload>();
    for (const row of commitRows || []) {
        byAddress.set(row.player_address, parsePrivateRoundPlan((row as any).encrypted_plan));
    }

    const p1Plan = byAddress.get(params.player1Address) || {};
    const p2Plan = byAddress.get(params.player2Address) || {};

    return {
        player1Move: getPlannedMoveForTurn(p1Plan, params.turnNumber),
        player2Move: getPlannedMoveForTurn(p2Plan, params.turnNumber),
    };
}

async function getOrCreateRoundTurn(params: {
    matchId: string;
    roundNumber: number;
    turnNumber: number;
}): Promise<{ id: string }> {
    const supabase = getSupabase();

    const { data: existing } = await supabase
        .from("rounds")
        .select("id")
        .eq("match_id", params.matchId)
        .eq("round_number", params.roundNumber)
        .eq("turn_number", params.turnNumber)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

    if (existing?.id) {
        return { id: existing.id };
    }

    const { data: created, error } = await supabase
        .from("rounds")
        .insert({
            match_id: params.matchId,
            round_number: params.roundNumber,
            turn_number: params.turnNumber,
            countdown_seconds: 0,
            move_deadline_at: new Date(Date.now() + GAME_CONSTANTS.MOVE_TIMER_SECONDS * 1000).toISOString(),
        })
        .select("id")
        .single();

    if (error || !created?.id) {
        throw new Error(`Failed to create private auto-turn row: ${error?.message || "unknown error"}`);
    }

    return { id: created.id };
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
    roundId: string,
    options?: {
        suppressPostTurnBroadcasts?: boolean;
        suppressNextTurnBroadcastOnly?: boolean;
    },
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

        // Replay previous turns to get current state (includes surge effects)
        const state = await replayToCurrentState(match, roundId);

        // Fetch stun flags from fight_state_snapshots (set by Power Surge selections)
        const { data: snap } = await supabase
            .from("fight_state_snapshots")
            .select("player1_is_stunned, player2_is_stunned")
            .eq("match_id", matchId)
            .maybeSingle();

        let p1Move = currentRound.player1_move as MoveType;
        let p2Move = currentRound.player2_move as MoveType;

        // If stunned, force move to 'stunned' (server-authoritative)
        if (snap?.player1_is_stunned) p1Move = "stunned";
        if (snap?.player2_is_stunned) p2Move = "stunned";

        // Pull current round surge selections from the match deck
        const deck = normalizeStoredDeck(match.power_surge_deck);
        const roundKey = String(currentRound.round_number);
        const roundDeck = deck.rounds[roundKey];
        let p1Surge = (roundDeck?.player1Selection ?? null) as PowerSurgeCardId | null;
        let p2Surge = (roundDeck?.player2Selection ?? null) as PowerSurgeCardId | null;

        // PRIVATE MODE fallback: selections are persisted in power_surges during
        // zk round resolve and may not be mirrored into matches.power_surge_deck.
        if (PRIVATE_ROUNDS_ENABLED && (!p1Surge || !p2Surge)) {
            const { data: surgeRow } = await supabase
                .from("power_surges")
                .select("player1_card_id, player2_card_id")
                .eq("match_id", matchId)
                .eq("round_number", currentRound.round_number)
                .maybeSingle();

            const p1FromRow = surgeRow?.player1_card_id;
            const p2FromRow = surgeRow?.player2_card_id;

            if (!p1Surge && isPowerSurgeCardId(p1FromRow)) {
                p1Surge = p1FromRow;
            }
            if (!p2Surge && isPowerSurgeCardId(p2FromRow)) {
                p2Surge = p2FromRow;
            }

            if (!p1Surge || !p2Surge) {
                const fromCommits = await getPrivateSurgesForRound({
                    matchId,
                    roundNumber: currentRound.round_number,
                    player1Address: match.player1_address,
                    player2Address: match.player2_address,
                });
                if (!p1Surge && fromCommits.player1Surge) p1Surge = fromCommits.player1Surge;
                if (!p2Surge && fromCommits.player2Surge) p2Surge = fromCommits.player2Surge;
            }
        }

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

        const resolution = resolveRound(input, {
            matchId,
            roundNumber: currentRound.round_number,
            turnNumber: currentRound.turn_number || 1,
            player1Surge: p1Surge,
            player2Surge: p2Surge,
        });

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

        debugMatchEndLog(`resolveTurn decision match=${matchId} round=${currentRound.round_number} turn=${currentRound.turn_number || 1}`, {
            roundOver,
            roundWinner,
            p1RoundsWon,
            p2RoundsWon,
            roundsToWin,
            matchOver,
            matchWinner,
            moves: { p1Move, p2Move },
        });

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

        const autoFinalize = getAutoProveFinalizeStatus();
        const stellarReady = isStellarConfigured();
        const proofFirstFinalizeRequired = matchOver
            && !!matchWinner
            && PRIVATE_ROUNDS_ENABLED
            && ZK_STRICT_FINALIZE;

        if (proofFirstFinalizeRequired && !autoFinalize.enabled) {
            return createErrorResult(`ZK finalize required but unavailable: ${autoFinalize.reason}`);
        }

        // Update match state
        let eloChanges: EloChanges | null = null;
        if (matchOver && matchWinner && !proofFirstFinalizeRequired) {
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
                    fight_phase: matchOver ? "match_end" : (roundOver ? "round_end" : "selecting"),
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
                // Carry stun from outcome into next turn (cleared after consuming on next resolve)
                player1_is_stunned: resolution.player1IsStunnedNext,
                player2_is_stunned: resolution.player2IsStunnedNext,
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
            player1IsStunnedNext: resolution.player1IsStunnedNext,
            player2IsStunnedNext: resolution.player2IsStunnedNext,
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
                damageTaken: resolution.player1.damageTaken,
                healthAfter: resolution.player1HealthAfter,
                energyAfter: resolution.player1EnergyAfter,
                guardMeterAfter: resolution.player1GuardAfter,
                outcome: resolution.player1.outcome,
                isStunned: resolution.player1IsStunnedNext,
                hpRegen: resolution.player1.hpRegen ?? 0,
                lifesteal: resolution.player1.lifesteal ?? 0,
                energyDrained: resolution.player1.energyDrained ?? 0,
            },
            player2: {
                move: p2Move,
                damageDealt: resolution.player2.damageDealt,
                damageTaken: resolution.player2.damageTaken,
                healthAfter: resolution.player2HealthAfter,
                energyAfter: resolution.player2EnergyAfter,
                guardMeterAfter: resolution.player2GuardAfter,
                outcome: resolution.player2.outcome,
                isStunned: resolution.player2IsStunnedNext,
                hpRegen: resolution.player2.hpRegen ?? 0,
                lifesteal: resolution.player2.lifesteal ?? 0,
                energyDrained: resolution.player2.energyDrained ?? 0,
            },
        });

        // If match is over, report result on-chain and broadcast match ended
        if (!options?.suppressPostTurnBroadcasts && matchOver && matchWinner) {
            debugMatchEndLog(`broadcast branch=match_ended match=${matchId} round=${currentRound.round_number} turn=${currentRound.turn_number || 1}`, {
                suppressPostTurnBroadcasts: !!options?.suppressPostTurnBroadcasts,
                suppressNextTurnBroadcastOnly: !!options?.suppressNextTurnBroadcastOnly,
                p1RoundsWon,
                p2RoundsWon,
                matchWinner,
            });
            const winnerAddr = matchWinner === "player1"
                ? match.player1_address
                : match.player2_address;

            // Report result on-chain (non-blocking)
            let onChainTxHash: string | undefined;
            let onChainSkippedReason: string | undefined;
            let zkFinalizeFailedReason: string | undefined;
            let onChainOutcomeTxHash: string | undefined;
            let onChainResultPending: boolean | undefined;
            let onChainResultError: string | undefined;

            if (proofFirstFinalizeRequired) {
                try {
                    const proofFinalize = await proveAndFinalizeMatch({
                        matchId,
                        winnerAddress: winnerAddr,
                        allowRemoteDelegation: true,
                    });

                    const finalizeResponse = proofFinalize.finalizeResponse as any;
                    onChainTxHash = finalizeResponse?.onChainTxHash || finalizeResponse?.onChainOutcomeTxHash || onChainTxHash;
                    onChainOutcomeTxHash = finalizeResponse?.onChainOutcomeTxHash || onChainOutcomeTxHash;
                    onChainResultPending = Boolean(finalizeResponse?.onChainResultPending ?? onChainResultPending);
                    onChainResultError = finalizeResponse?.onChainResultError || onChainResultError;

                    eloChanges = await updateElo(match, winnerAddr);
                } catch (err) {
                    zkFinalizeFailedReason = err instanceof Error ? err.message : String(err);
                    console.error("[CombatResolver] Proof-first finalize failed:", zkFinalizeFailedReason);
                    return createErrorResult(`ZK proof finalize failed: ${zkFinalizeFailedReason}`);
                }
            }

            if (!proofFirstFinalizeRequired && !autoFinalize.enabled && stellarReady) {
                try {
                    const onChainResult = await reportMatchResultOnChain(
                        matchId,
                        match.player1_address,
                        match.player2_address,
                        winnerAddr,
                        {
                            sessionId: match.onchain_session_id ?? undefined,
                            contractId: match.onchain_contract_id || undefined,
                        },
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

            if (!proofFirstFinalizeRequired && autoFinalize.enabled) {
                triggerAutoProveFinalize(matchId, winnerAddr, "combat-resolver");
            } else if (!stellarReady) {
                onChainSkippedReason = `${autoFinalize.reason}; Stellar not configured`;
                console.warn(`[CombatResolver] On-chain finalize skipped for ${matchId}: ${onChainSkippedReason}`);
            }

            await broadcastGameEvent(matchId, "match_ended", {
                matchId,
                winner: matchWinner,
                winnerAddress: winnerAddr,
                finalScore: {
                    player1RoundsWon: p1RoundsWon,
                    player2RoundsWon: p2RoundsWon,
                },
                player1RoundsWon: p1RoundsWon,
                player2RoundsWon: p2RoundsWon,
                reason: "knockout",
                ratingChanges: eloChanges ?? undefined,
                isPrivateRoom: !!match.room_code,
                onChainSessionId: match.onchain_session_id ?? matchIdToSessionId(matchId),
                onChainTxHash,
                onChainOutcomeTxHash,
                onChainResultPending,
                onChainResultError,
                onChainSkippedReason,
                zkFinalizeFailedReason,
                contractId: match.onchain_contract_id || process.env.VITE_VEILSTAR_BRAWL_CONTRACT_ID || '',
            });
        } else if (!options?.suppressPostTurnBroadcasts && roundOver) {
            debugMatchEndLog(`broadcast branch=round_ended_then_round_starting match=${matchId} round=${currentRound.round_number} turn=${currentRound.turn_number || 1}`, {
                suppressPostTurnBroadcasts: !!options?.suppressPostTurnBroadcasts,
                suppressNextTurnBroadcastOnly: !!options?.suppressNextTurnBroadcastOnly,
                p1RoundsWon,
                p2RoundsWon,
            });
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
            const moveDeadline = countdownEndsAt + SURGE_SELECTION_SECONDS * 1000 + GAME_CONSTANTS.MOVE_TIMER_SECONDS * 1000;

            setTimeout(async () => {
                try {
                    await broadcastGameEvent(matchId, "round_starting", {
                        roundNumber: nextRoundNumber,
                        turnNumber: 1,
                        player1Health: GAME_CONSTANTS.MAX_HEALTH,
                        player2Health: GAME_CONSTANTS.MAX_HEALTH,
                        player1Energy: GAME_CONSTANTS.MAX_ENERGY,
                        player2Energy: GAME_CONSTANTS.MAX_ENERGY,
                        player1GuardMeter: 0,
                        player2GuardMeter: 0,
                        player1IsStunned: false,
                        player2IsStunned: false,
                        moveDeadlineAt: moveDeadline,
                        countdownEndsAt,
                    });
                } catch (err) {
                    console.error("[CombatResolver] Failed to broadcast round_starting:", err);
                }
            }, 3000);
        } else if (!options?.suppressPostTurnBroadcasts && !options?.suppressNextTurnBroadcastOnly && !matchOver) {
            debugMatchEndLog(`broadcast branch=next_turn_round_starting match=${matchId} round=${currentRound.round_number} turn=${currentRound.turn_number || 1}`, {
                suppressPostTurnBroadcasts: !!options?.suppressPostTurnBroadcasts,
                suppressNextTurnBroadcastOnly: !!options?.suppressNextTurnBroadcastOnly,
                nextTurn: (currentRound.turn_number || 1) + 1,
            });
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
                        player1Energy: resolution.player1EnergyAfter,
                        player2Energy: resolution.player2EnergyAfter,
                        player1GuardMeter: resolution.player1GuardAfter,
                        player2GuardMeter: resolution.player2GuardAfter,
                        player1IsStunned: resolution.player1IsStunnedNext,
                        player2IsStunned: resolution.player2IsStunnedNext,
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
    match: any,
    currentRoundId: string
): Promise<ReplayedState> {
    const supabase = getSupabase();

    const matchId = match.id as string;
    const deck = normalizeStoredDeck(match.power_surge_deck);

    const privateSurgesByRound = new Map<number, { player1: PowerSurgeCardId | null; player2: PowerSurgeCardId | null }>();
    if (PRIVATE_ROUNDS_ENABLED) {
        const { data: surgeRows } = await supabase
            .from("power_surges")
            .select("round_number, player1_card_id, player2_card_id")
            .eq("match_id", matchId);

        for (const row of surgeRows || []) {
            const roundNumber = Number((row as any).round_number);
            if (!Number.isInteger(roundNumber) || roundNumber < 1) continue;

            const p1Raw = (row as any).player1_card_id;
            const p2Raw = (row as any).player2_card_id;

            privateSurgesByRound.set(roundNumber, {
                player1: isPowerSurgeCardId(p1Raw) ? p1Raw : null,
                player2: isPowerSurgeCardId(p2Raw) ? p2Raw : null,
            });
        }
    }

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

        const roundKey = String(round.round_number);
        const roundDeck = deck.rounds[roundKey];
        let p1Surge = (roundDeck?.player1Selection ?? null) as PowerSurgeCardId | null;
        let p2Surge = (roundDeck?.player2Selection ?? null) as PowerSurgeCardId | null;

        if (PRIVATE_ROUNDS_ENABLED && (!p1Surge || !p2Surge)) {
            const privateRoundSurges = privateSurgesByRound.get(round.round_number);
            if (!p1Surge) p1Surge = privateRoundSurges?.player1 ?? null;
            if (!p2Surge) p2Surge = privateRoundSurges?.player2 ?? null;

            if (!p1Surge || !p2Surge) {
                const fromCommits = await getPrivateSurgesForRound({
                    matchId,
                    roundNumber: round.round_number,
                    player1Address: match.player1_address,
                    player2Address: match.player2_address,
                });
                if (!p1Surge && fromCommits.player1Surge) p1Surge = fromCommits.player1Surge;
                if (!p2Surge && fromCommits.player2Surge) p2Surge = fromCommits.player2Surge;
            }
        }

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

        const result = resolveRound(input, {
            matchId,
            roundNumber: round.round_number,
            turnNumber: round.turn_number || 1,
            player1Surge: p1Surge,
            player2Surge: p2Surge,
        });
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
    if (match?.room_code) {
        console.log("[CombatResolver] Skipping Elo update for private room match");
        return null;
    }

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
