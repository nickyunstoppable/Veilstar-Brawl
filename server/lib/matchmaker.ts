/**
 * Matchmaker Service
 * Handles queue management, opponent finding, match creation, and Realtime broadcasting
 * Adapted from KaspaClash lib/matchmaking/matchmaker.ts
 */

import { getSupabase } from "./supabase";
import { GAME_CONSTANTS } from "./game-types";

// =============================================================================
// TYPES
// =============================================================================

export interface QueuedPlayer {
    address: string;
    rating: number;
    joinedAt: Date;
}

export interface MatchFoundResult {
    matchId: string;
    player1Address: string;
    player2Address: string;
    selectionDeadlineAt: string;
}

// =============================================================================
// CONFIG
// =============================================================================

const MATCHMAKING_CONFIG = {
    /** Initial rating range for matching */
    INITIAL_RATING_RANGE: 100,
    /** Rating range expansion per second of waiting */
    RATING_EXPANSION_RATE: 5,
    /** Maximum rating range */
    MAX_RATING_RANGE: 500,
    /** Minimum wait time before expanding (seconds) */
    MIN_WAIT_BEFORE_EXPANSION: 10,
};

// =============================================================================
// QUEUE OPERATIONS
// =============================================================================

/** Add a player to the matchmaking queue (upserts) */
export async function addToQueue(address: string, rating: number): Promise<void> {
    const supabase = getSupabase();

    // Ensure player exists
    const { error: playerError } = await supabase
        .from("players")
        .upsert(
            { address, rating },
            { onConflict: "address", ignoreDuplicates: true }
        );

    if (playerError) {
        console.error("[Matchmaker] Failed to upsert player:", playerError);
        throw new Error("Failed to register player");
    }

    // Upsert into queue (handles re-joining atomically)
    const { error } = await supabase
        .from("matchmaking_queue")
        .upsert(
            {
                address,
                rating,
                status: "searching",
                joined_at: new Date().toISOString(),
                matched_with: null,
            },
            { onConflict: "address" }
        );

    if (error) {
        console.error("[Matchmaker] Failed to join queue:", error);
        throw new Error("Failed to join queue");
    }

    console.log(`[Matchmaker] ${address.slice(0, 8)}... joined queue (rating: ${rating})`);
}

/** Remove a player from the queue */
export async function removeFromQueue(address: string): Promise<void> {
    const supabase = getSupabase();

    const { error } = await supabase
        .from("matchmaking_queue")
        .delete()
        .eq("address", address);

    if (error) {
        console.error("[Matchmaker] Failed to leave queue:", error);
    }

    console.log(`[Matchmaker] ${address.slice(0, 8)}... left queue`);
}

/** Check if a player is in the queue */
export async function isInQueue(address: string): Promise<boolean> {
    const supabase = getSupabase();

    const { data, error } = await supabase
        .from("matchmaking_queue")
        .select("address")
        .eq("address", address)
        .maybeSingle();

    if (error) return false;
    return !!data;
}

/** Get queue size */
export async function getQueueSize(): Promise<number> {
    const supabase = getSupabase();

    const { count, error } = await supabase
        .from("matchmaking_queue")
        .select("*", { count: "exact", head: true })
        .eq("status", "searching");

    if (error) return 0;
    return count ?? 0;
}

// =============================================================================
// MATCHMAKING
// =============================================================================

/** Calculate allowed rating range based on wait time */
function calculateRatingRange(joinedAt: Date): number {
    const waitSeconds = (Date.now() - joinedAt.getTime()) / 1000;

    if (waitSeconds < MATCHMAKING_CONFIG.MIN_WAIT_BEFORE_EXPANSION) {
        return MATCHMAKING_CONFIG.INITIAL_RATING_RANGE;
    }

    const expansion =
        (waitSeconds - MATCHMAKING_CONFIG.MIN_WAIT_BEFORE_EXPANSION) *
        MATCHMAKING_CONFIG.RATING_EXPANSION_RATE;

    return Math.min(
        MATCHMAKING_CONFIG.INITIAL_RATING_RANGE + expansion,
        MATCHMAKING_CONFIG.MAX_RATING_RANGE
    );
}

/** Find a suitable opponent for a player */
async function findOpponent(
    playerAddress: string,
    playerRating: number,
    playerJoinedAt: Date
): Promise<QueuedPlayer | null> {
    const supabase = getSupabase();
    const ratingRange = calculateRatingRange(playerJoinedAt);

    const { data, error } = await supabase
        .from("matchmaking_queue")
        .select("address, rating, joined_at")
        .eq("status", "searching")
        .neq("address", playerAddress)
        .gte("rating", playerRating - ratingRange)
        .lte("rating", playerRating + ratingRange)
        .order("joined_at", { ascending: true })
        .limit(1);

    if (error || !data || data.length === 0) return null;

    const opponent = data[0];
    return {
        address: opponent.address,
        rating: opponent.rating,
        joinedAt: new Date(opponent.joined_at),
    };
}

/**
 * Attempt to match a player with someone in the queue.
 * Uses deterministic tie-breaking: only the lexicographically lower address initiates.
 */
export async function attemptMatch(address: string): Promise<MatchFoundResult | null> {
    const supabase = getSupabase();

    // CRITICAL: First check if player already has an active match
    // This prevents duplicate matches from racing attemptMatch calls
    const { data: existingMatch } = await supabase
        .from("matches")
        .select("id, player1_address, player2_address, selection_deadline_at, created_at, status")
        .or(`player1_address.eq.${address},player2_address.eq.${address}`)
        .in("status", ["character_select", "in_progress"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

    if (existingMatch && existingMatch.player2_address) {
        const matchAge = Date.now() - new Date(existingMatch.created_at).getTime();

        // Don't cancel matches that were just created (within 5 seconds)
        if (matchAge < 5000) {
            return {
                matchId: existingMatch.id,
                player1Address: existingMatch.player1_address,
                player2Address: existingMatch.player2_address,
                selectionDeadlineAt: existingMatch.selection_deadline_at ?? "",
            };
        }

        // If match is older than 5 seconds and player is back in the queue,
        // they have abandoned the previous game — cancel it
        console.log(`[Matchmaker] ${address.slice(0, 8)}... abandoning stale match ${existingMatch.id.slice(0, 8)} (age: ${Math.round(matchAge / 1000)}s)`);
        await supabase
            .from("matches")
            .update({
                status: "cancelled",
                completed_at: new Date().toISOString(),
            })
            .eq("id", existingMatch.id);
    }

    // Get player's queue entry
    const { data: queueEntry, error: queueError } = await supabase
        .from("matchmaking_queue")
        .select("*")
        .eq("address", address)
        .eq("status", "searching")
        .maybeSingle();

    if (queueError || !queueEntry) return null;

    // Check if already matched
    if (queueEntry.matched_with) {
        // Find the existing match
        const { data: existingMatch } = await supabase
            .from("matches")
            .select("id, player1_address, player2_address, selection_deadline_at")
            .or(`player1_address.eq.${address},player2_address.eq.${address}`)
            .in("status", ["waiting", "character_select"])
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

        if (existingMatch) {
            return {
                matchId: existingMatch.id,
                player1Address: existingMatch.player1_address,
                player2Address: existingMatch.player2_address,
                selectionDeadlineAt: existingMatch.selection_deadline_at || "",
            };
        }
    }

    // Find an opponent
    const opponent = await findOpponent(
        address,
        queueEntry.rating,
        new Date(queueEntry.joined_at)
    );

    if (!opponent) return null;

    // Deterministic tie-breaker: lower address creates the match
    const shouldInitiate = address.toLowerCase() < opponent.address.toLowerCase();
    if (!shouldInitiate) {
        // Wait for the other player to initiate
        return null;
    }

    // Try to claim the opponent (set matched_with atomically)
    const { error: claimError } = await supabase
        .from("matchmaking_queue")
        .update({ status: "matched", matched_with: address })
        .eq("address", opponent.address)
        .eq("status", "searching");

    if (claimError) return null;

    // Mark ourselves as matched too
    await supabase
        .from("matchmaking_queue")
        .update({ status: "matched", matched_with: opponent.address })
        .eq("address", address);

    // Create the match
    const match = await createMatch(address, opponent.address);
    if (!match) {
        // Rollback queue status
        await supabase
            .from("matchmaking_queue")
            .update({ status: "searching", matched_with: null })
            .in("address", [address, opponent.address]);
        return null;
    }

    const result: MatchFoundResult = {
        matchId: match.id,
        player1Address: address,
        player2Address: opponent.address,
        selectionDeadlineAt: match.selectionDeadlineAt,
    };

    // Broadcast match found
    await broadcastMatchFound(result);

    // Clean up queue
    await supabase
        .from("matchmaking_queue")
        .delete()
        .in("address", [address, opponent.address]);

    return result;
}

/**
 * Find an active match for a player (even if they are no longer in queue).
 */
export async function getActiveMatchForPlayer(
    address: string
): Promise<MatchFoundResult | null> {
    const supabase = getSupabase();

    const { data: activeMatch } = await supabase
        .from("matches")
        .select("id, player1_address, player2_address, selection_deadline_at")
        .or(`player1_address.eq.${address},player2_address.eq.${address}`)
        .in("status", ["waiting", "character_select"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

    if (!activeMatch) return null;

    return {
        matchId: activeMatch.id,
        player1Address: activeMatch.player1_address,
        player2Address: activeMatch.player2_address,
        selectionDeadlineAt: activeMatch.selection_deadline_at || "",
    };
}

// =============================================================================
// MATCH CREATION
// =============================================================================

/** Create a new match in the database */
async function createMatch(
    player1Address: string,
    player2Address: string
): Promise<{ id: string; selectionDeadlineAt: string } | null> {
    const supabase = getSupabase();

    const selectionDeadline = new Date(
        Date.now() + GAME_CONSTANTS.CHARACTER_SELECT_SECONDS * 1000
    ).toISOString();

    // Check for existing active match between these players
    const { data: existing } = await supabase
        .from("matches")
        .select("id, selection_deadline_at, created_at, status")
        .or(`player1_address.eq.${player1Address},player1_address.eq.${player2Address}`)
        .or(`player2_address.eq.${player1Address},player2_address.eq.${player2Address}`)
        .in("status", ["waiting", "character_select", "in_progress"])
        .limit(1);

    if (existing && existing.length > 0) {
        const match = existing[0];
        const matchAge = Date.now() - new Date(match.created_at).getTime();

        // Don't cancel matches that were just created (within 5 seconds)
        if (matchAge < 5000) {
            console.log("[Matchmaker] Recent active match exists, reusing it");
            return {
                id: match.id,
                selectionDeadlineAt: match.selection_deadline_at ?? selectionDeadline,
            };
        }

        // Cancel the stale match
        console.log(`[Matchmaker] Cancelling stale match ${match.id.slice(0, 8)} (age: ${Math.round(matchAge / 1000)}s)`);
        await supabase
            .from("matches")
            .update({
                status: "cancelled",
                completed_at: new Date().toISOString(),
            })
            .eq("id", match.id);
    }

    const { data, error } = await supabase
        .from("matches")
        .insert({
            player1_address: player1Address,
            player2_address: player2Address,
            status: "character_select",
            format: "best_of_3",
            selection_deadline_at: selectionDeadline,
            fight_phase: "waiting",
        })
        .select("id, selection_deadline_at")
        .single();

    if (error || !data) {
        console.error("[Matchmaker] Failed to create match:", error);
        return null;
    }

    console.log(`[Matchmaker] Match created: ${data.id}`);

    // Create initial fight state snapshot
    await supabase
        .from("fight_state_snapshots")
        .insert({
            match_id: data.id,
            phase: "waiting",
        });

    return {
        id: data.id,
        selectionDeadlineAt: data.selection_deadline_at || selectionDeadline,
    };
}

// =============================================================================
// REALTIME BROADCASTING
// =============================================================================

/** Broadcast match found to both players via Supabase Realtime */
async function _broadcastMatchFoundImpl(
    player1Address: string,
    player2Address: string,
    matchId: string,
    selectionDeadlineAt: string
): Promise<void> {
    const supabase = getSupabase();

    try {
        const channel = supabase.channel(`matchmaking:${player1Address}`);
        await channel.send({
            type: "broadcast",
            event: "match_found",
            payload: { matchId, player1Address, player2Address, selectionDeadlineAt },
        });
        await supabase.removeChannel(channel);

        const channel2 = supabase.channel(`matchmaking:${player2Address}`);
        await channel2.send({
            type: "broadcast",
            event: "match_found",
            payload: { matchId, player1Address, player2Address, selectionDeadlineAt },
        });
        await supabase.removeChannel(channel2);

        console.log(`[Matchmaker] Broadcast match_found for ${matchId}`);
    } catch (err) {
        console.error("[Matchmaker] Failed to broadcast:", err);
    }
}

/** Broadcast match found — accepts a MatchFoundResult or individual params */
export async function broadcastMatchFound(matchOrP1: MatchFoundResult | string, p2?: string, id?: string, deadline?: string): Promise<void> {
    if (typeof matchOrP1 === "object") {
        await _broadcastMatchFoundImpl(matchOrP1.player1Address, matchOrP1.player2Address, matchOrP1.matchId, matchOrP1.selectionDeadlineAt);
    } else {
        await _broadcastMatchFoundImpl(matchOrP1, p2!, id!, deadline!);
    }
}

/** Broadcast a game event on the match channel */
export async function broadcastGameEvent(
    matchId: string,
    event: string,
    payload: Record<string, unknown>
): Promise<void> {
    const supabase = getSupabase();

    try {
        const channel = supabase.channel(`game:${matchId}`);
        await channel.send({
            type: "broadcast",
            event,
            payload,
        });
        await supabase.removeChannel(channel);
    } catch (err) {
        console.error(`[Matchmaker] Failed to broadcast ${event}:`, err);
    }
}

/** Clean up stale queue entries */
export async function cleanupStaleQueue(maxAgeMinutes: number = 30): Promise<number> {
    const supabase = getSupabase();
    const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000).toISOString();

    const { data, error } = await supabase
        .from("matchmaking_queue")
        .delete()
        .lt("joined_at", cutoff)
        .select("address");

    if (error) return 0;
    return data?.length ?? 0;
}
