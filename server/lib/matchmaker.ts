/**
 * Matchmaker Service
 * Handles player pairing by rating and match creation.
 * Ported from KaspaClash matchmaking mechanism.
 */

import { getSupabase } from "./supabase";
import { GAME_CONSTANTS } from "./game-types";

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

const MATCHMAKING_CONFIG = {
    INITIAL_RATING_RANGE: 100,
    RATING_EXPANSION_RATE: 5,
    MAX_RATING_RANGE: 500,
    MIN_WAIT_BEFORE_EXPANSION: 10,
};

export async function addToQueue(address: string, rating: number): Promise<void> {
    const supabase = getSupabase();

    const { error } = await supabase
        .from("matchmaking_queue")
        .upsert({
            address,
            rating,
            joined_at: new Date().toISOString(),
            status: "searching",
            matched_with: null,
        }, {
            onConflict: "address",
        });

    if (error) {
        console.error("Failed to add player to queue:", error);
        throw new Error("Failed to join queue");
    }

    console.log(`Player ${address} added to queue (rating: ${rating})`);
}

export async function removeFromQueue(address: string): Promise<void> {
    const supabase = getSupabase();

    const { error } = await supabase
        .from("matchmaking_queue")
        .delete()
        .eq("address", address);

    if (error) {
        console.error("Failed to remove player from queue:", error);
    }

    console.log(`Player ${address} removed from queue`);
}

export async function isInQueue(address: string): Promise<boolean> {
    const supabase = getSupabase();

    const { data, error } = await supabase
        .from("matchmaking_queue")
        .select("address")
        .eq("address", address)
        .eq("status", "searching")
        .maybeSingle();

    if (error) {
        console.error("Failed to check queue status:", error);
    }

    return !!data;
}

export async function getQueueSize(): Promise<number> {
    const supabase = getSupabase();

    const { count, error } = await supabase
        .from("matchmaking_queue")
        .select("*", { count: "exact", head: true })
        .eq("status", "searching");

    if (error) {
        console.error("Failed to get queue size:", error);
        return 0;
    }

    return count ?? 0;
}

export async function getQueuedPlayers(): Promise<QueuedPlayer[]> {
    const supabase = getSupabase();

    const { data, error } = await supabase
        .from("matchmaking_queue")
        .select("address, rating, joined_at")
        .eq("status", "searching")
        .order("joined_at", { ascending: true });

    if (error) {
        console.error("Failed to get queued players:", error);
        return [];
    }

    return (data || []).map((row) => ({
        address: row.address,
        rating: row.rating,
        joinedAt: new Date(row.joined_at),
    }));
}

function calculateRatingRange(joinedAt: Date): number {
    const waitTimeSeconds = (Date.now() - joinedAt.getTime()) / 1000;

    if (waitTimeSeconds < MATCHMAKING_CONFIG.MIN_WAIT_BEFORE_EXPANSION) {
        return MATCHMAKING_CONFIG.INITIAL_RATING_RANGE;
    }

    const expansion =
        (waitTimeSeconds - MATCHMAKING_CONFIG.MIN_WAIT_BEFORE_EXPANSION) *
        MATCHMAKING_CONFIG.RATING_EXPANSION_RATE;

    return Math.min(
        MATCHMAKING_CONFIG.INITIAL_RATING_RANGE + expansion,
        MATCHMAKING_CONFIG.MAX_RATING_RANGE
    );
}

export async function findOpponent(
    playerAddress: string,
    playerRating: number,
    playerJoinedAt: Date
): Promise<QueuedPlayer | null> {
    const supabase = getSupabase();

    const ratingRange = calculateRatingRange(playerJoinedAt);
    const minRating = Math.floor(playerRating - ratingRange);
    const maxRating = Math.ceil(playerRating + ratingRange);

    const { data, error } = await supabase
        .from("matchmaking_queue")
        .select("address, rating, joined_at")
        .eq("status", "searching")
        .neq("address", playerAddress)
        .gte("rating", minRating)
        .lte("rating", maxRating)
        .order("joined_at", { ascending: true })
        .limit(10);

    if (error) {
        console.error("Failed to find opponent:", error);
        return null;
    }

    if (!data || data.length === 0) {
        return null;
    }

    let bestMatch: QueuedPlayer | null = null;
    let smallestRatingDiff = Infinity;

    for (const candidate of data) {
        const candidateJoinedAt = new Date(candidate.joined_at);
        const candidateRange = calculateRatingRange(candidateJoinedAt);
        const ratingDiff = Math.abs(candidate.rating - playerRating);

        if (ratingDiff <= candidateRange && ratingDiff < smallestRatingDiff) {
            smallestRatingDiff = ratingDiff;
            bestMatch = {
                address: candidate.address,
                rating: candidate.rating,
                joinedAt: candidateJoinedAt,
            };
        }
    }

    return bestMatch;
}

export async function attemptMatch(address: string): Promise<MatchFoundResult | null> {
    const supabase = getSupabase();
    const shortAddr = address.slice(-8);

    console.log(`[MATCHMAKING] ${shortAddr}: Starting attemptMatch`);

    const { data: existingMatch } = await supabase
        .from("matches")
        .select("id, player1_address, player2_address, selection_deadline_at, created_at, status")
        .or(`player1_address.eq.${address},player2_address.eq.${address}`)
        .in("status", ["character_select", "in_progress"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

    if (existingMatch && existingMatch.player2_address) {
        const shortId = existingMatch.id.slice(0, 8);
        const matchAge = Date.now() - new Date(existingMatch.created_at).getTime();
        const fiveSecondsMs = 5000;

        if (matchAge < fiveSecondsMs) {
            console.log(`[MATCHMAKING] ${shortAddr}: Found recent match ${shortId} (${Math.round(matchAge / 1000)}s old), using it`);
            return {
                matchId: existingMatch.id,
                player1Address: existingMatch.player1_address,
                player2Address: existingMatch.player2_address,
                selectionDeadlineAt: existingMatch.selection_deadline_at ?? new Date(Date.now() + 30000).toISOString(),
            };
        }

        console.log(`[MATCHMAKING] ${shortAddr}: Abandoning stale/stuck match ${shortId} (status: ${existingMatch.status}, age: ${Math.round(matchAge / 1000)}s)`);

        await supabase
            .from("matches")
            .update({
                status: "cancelled",
                completed_at: new Date().toISOString(),
            })
            .eq("id", existingMatch.id);
    }

    const { data: player, error: playerError } = await supabase
        .from("matchmaking_queue")
        .select("address, rating, joined_at, status, matched_with")
        .eq("address", address)
        .maybeSingle();

    if (playerError || !player) {
        console.log(`[MATCHMAKING] ${shortAddr}: Player not in queue`);
        return null;
    }

    if (player.status === "matched" && player.matched_with) {
        console.log(`[MATCHMAKING] ${shortAddr}: Already claimed by ${player.matched_with.slice(-8)}, waiting for match creation`);
        return null;
    }

    if (player.status !== "searching") {
        console.log(`[MATCHMAKING] ${shortAddr}: Player status is '${player.status}', not searching`);
        return null;
    }

    const playerJoinedAt = new Date(player.joined_at);
    const ratingRange = calculateRatingRange(playerJoinedAt);
    const minRating = Math.floor(player.rating - ratingRange);
    const maxRating = Math.ceil(player.rating + ratingRange);

    const { data: candidates, error: findError } = await supabase
        .from("matchmaking_queue")
        .select("address, rating, status")
        .eq("status", "searching")
        .neq("address", address)
        .gte("rating", minRating)
        .lte("rating", maxRating)
        .order("joined_at", { ascending: true })
        .limit(5);

    if (findError) {
        console.log(`[MATCHMAKING] ${shortAddr}: Error finding opponents - ${findError.message}`);
        return null;
    }

    if (!candidates || candidates.length === 0) {
        console.log(`[MATCHMAKING] ${shortAddr}: No opponents found in rating range`);
        return null;
    }

    let claimedOpponent: { address: string; rating: number } | null = null;

    for (const candidate of candidates) {
        const candidateShort = candidate.address.slice(-8);

        if (address > candidate.address) {
            console.log(`[MATCHMAKING] ${shortAddr}: Skipping ${candidateShort} - they should initiate (tie-breaker)`);
            continue;
        }

        const { data: claimed, error: claimError } = await supabase
            .from("matchmaking_queue")
            .update({
                status: "matched",
                matched_with: address,
            })
            .eq("address", candidate.address)
            .eq("status", "searching")
            .select("address, rating");

        if (claimError) {
            console.log(`[MATCHMAKING] ${shortAddr}: Claim error for ${candidateShort} - ${claimError.message}`);
            continue;
        }

        if (claimed && claimed.length > 0) {
            claimedOpponent = claimed[0];
            console.log(`[MATCHMAKING] ${shortAddr}: Successfully claimed ${candidateShort}`);
            break;
        }
    }

    if (!claimedOpponent) {
        console.log(`[MATCHMAKING] ${shortAddr}: Could not claim any opponent`);
        return null;
    }

    const { data: selfUpdate, error: selfUpdateError } = await supabase
        .from("matchmaking_queue")
        .update({
            status: "matched",
            matched_with: claimedOpponent.address,
        })
        .eq("address", address)
        .eq("status", "searching")
        .select("address");

    if (selfUpdateError || !selfUpdate || selfUpdate.length === 0) {
        await supabase
            .from("matchmaking_queue")
            .update({ status: "searching", matched_with: null })
            .eq("address", claimedOpponent.address);
        return null;
    }

    const match = await createMatch(address, claimedOpponent.address);
    if (!match) {
        await supabase
            .from("matchmaking_queue")
            .update({ status: "searching", matched_with: null })
            .in("address", [address, claimedOpponent.address]);
        return null;
    }

    const { error: deleteError } = await supabase
        .from("matchmaking_queue")
        .delete()
        .in("address", [address, claimedOpponent.address]);

    if (deleteError) {
        console.log(`[MATCHMAKING] ${shortAddr}: Warning - failed to remove from queue: ${deleteError.message}`);
    }

    return {
        matchId: match.id,
        player1Address: address,
        player2Address: claimedOpponent.address,
        selectionDeadlineAt: match.selectionDeadlineAt,
    };
}

export async function getActiveMatchForPlayer(address: string): Promise<MatchFoundResult | null> {
    const supabase = getSupabase();

    const { data: activeMatch } = await supabase
        .from("matches")
        .select("id, player1_address, player2_address, selection_deadline_at")
        .or(`player1_address.eq.${address},player2_address.eq.${address}`)
        .in("status", ["waiting", "character_select", "in_progress"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

    if (!activeMatch || !activeMatch.player2_address) {
        return null;
    }

    return {
        matchId: activeMatch.id,
        player1Address: activeMatch.player1_address,
        player2Address: activeMatch.player2_address,
        selectionDeadlineAt: activeMatch.selection_deadline_at ?? "",
    };
}

const CHARACTER_SELECT_TIMEOUT_SECONDS = GAME_CONSTANTS.CHARACTER_SELECT_SECONDS;

export async function createMatch(
    player1Address: string,
    player2Address: string
): Promise<{ id: string; selectionDeadlineAt: string } | null> {
    try {
        const supabase = getSupabase();

        const { data: existingMatch } = await supabase
            .from("matches")
            .select("id, player1_address, player2_address, selection_deadline_at, created_at, status")
            .or(`player1_address.eq.${player1Address},player2_address.eq.${player1Address},player1_address.eq.${player2Address},player2_address.eq.${player2Address}`)
            .in("status", ["character_select", "in_progress"])
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

        if (existingMatch) {
            const shortId = existingMatch.id.slice(0, 8);
            const matchAge = Date.now() - new Date(existingMatch.created_at).getTime();
            const fiveSecondsMs = 5000;

            if (matchAge < fiveSecondsMs) {
                console.log(`[MATCHMAKING-CREATE] Found recent match ${shortId} (${Math.round(matchAge / 1000)}s old), reusing it`);
                return {
                    id: existingMatch.id,
                    selectionDeadlineAt: existingMatch.selection_deadline_at ?? new Date(Date.now() + CHARACTER_SELECT_TIMEOUT_SECONDS * 1000).toISOString(),
                };
            }

            console.log(`[MATCHMAKING-CREATE] ${existingMatch.id}: Abandoning stale/stuck match ${shortId} (status: ${existingMatch.status}, age: ${Math.round(matchAge / 1000)}s)`);

            await supabase
                .from("matches")
                .update({
                    status: "cancelled",
                    completed_at: new Date().toISOString(),
                })
                .eq("id", existingMatch.id);
        }

        const selectionDeadlineAt = new Date(
            Date.now() + CHARACTER_SELECT_TIMEOUT_SECONDS * 1000
        ).toISOString();

        const { data, error } = await supabase
            .from("matches")
            .insert({
                player1_address: player1Address,
                player2_address: player2Address,
                status: "character_select",
                format: "best_of_3",
                selection_deadline_at: selectionDeadlineAt,
                fight_phase: "waiting",
            })
            .select("id, selection_deadline_at")
            .single();

        if (error || !data) {
            console.error("Failed to create match:", error);
            return null;
        }

        await supabase
            .from("fight_state_snapshots")
            .insert({
                match_id: data.id,
                phase: "waiting",
            });

        return { id: data.id, selectionDeadlineAt: data.selection_deadline_at ?? selectionDeadlineAt };
    } catch (error) {
        console.error("Error creating match:", error);
        return null;
    }
}

export async function runMatchmakingCycle(): Promise<MatchFoundResult[]> {
    const results: MatchFoundResult[] = [];
    const processedAddresses = new Set<string>();
    const players = await getQueuedPlayers();

    for (const player of players) {
        if (processedAddresses.has(player.address)) continue;

        const result = await attemptMatch(player.address);
        if (result) {
            results.push(result);
            processedAddresses.add(result.player1Address);
            processedAddresses.add(result.player2Address);
        }
    }

    return results;
}

async function sendBroadcast(channel: any, event: string, payload: Record<string, unknown>): Promise<void> {
    if (typeof channel.httpSend === "function") {
        await channel.httpSend(event, payload);
        return;
    }

    await channel.send({
        type: "broadcast",
        event,
        payload,
    });
}

export async function broadcastMatchFound(
    matchId: string,
    player1Address: string,
    player2Address: string,
    selectionDeadlineAt: string
): Promise<void> {
    try {
        const supabase = getSupabase();
        const channel = supabase.channel("matchmaking:queue");

        await sendBroadcast(channel as any, "match_found", {
            matchId,
            player1Address,
            player2Address,
            selectionDeadlineAt,
        });

        await supabase.removeChannel(channel);
    } catch (error) {
        console.error("Failed to broadcast match found:", error);
    }
}

export async function broadcastGameEvent(
    matchId: string,
    event: string,
    payload: Record<string, unknown>
): Promise<void> {
    const supabase = getSupabase();

    try {
        const channel = supabase.channel(`game:${matchId}`);
        await sendBroadcast(channel as any, event, payload);
        await supabase.removeChannel(channel);
    } catch (err) {
        console.error(`[Matchmaker] Failed to broadcast ${event}:`, err);
    }
}

export async function cleanupStaleQueue(maxAgeMinutes: number = 30): Promise<number> {
    const supabase = getSupabase();
    const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000).toISOString();

    const { data, error } = await supabase
        .from("matchmaking_queue")
        .delete()
        .lt("joined_at", cutoff)
        .select("address");

    if (error) {
        console.error("Failed to clean up stale queue entries:", error);
        return 0;
    }

    return data?.length ?? 0;
}

export interface PrivateRoomResult {
    id: string;
    code: string;
    stakeAmountStroops?: string;
}

export interface JoinRoomResult {
    id: string;
    hostAddress: string;
    selectionDeadlineAt?: string;
    stakeAmountStroops?: string;
    stakeDeadlineAt?: string;
}

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const STAKE_DEPOSIT_TIMEOUT_SECONDS = 60;

function generateRoomCode(): string {
    let code = "";
    for (let i = 0; i < 6; i++) {
        const index = Math.floor(Math.random() * ROOM_CODE_ALPHABET.length);
        code += ROOM_CODE_ALPHABET[index];
    }
    return code;
}

async function generateUniqueRoomCode(maxAttempts: number = 8): Promise<string> {
    const supabase = getSupabase();

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const code = generateRoomCode();
        const { data } = await supabase
            .from("matches")
            .select("id")
            .eq("room_code", code)
            .maybeSingle();

        if (!data) return code;
    }

    throw new Error("Failed to generate unique room code");
}

export async function createRoom(
    hostAddress: string,
    stakeAmountStroops?: bigint
): Promise<PrivateRoomResult | null> {
    try {
        const supabase = getSupabase();
        const roomCode = await generateUniqueRoomCode();
        const hasStake = !!stakeAmountStroops && stakeAmountStroops > 0n;

        const insertData: Record<string, unknown> = {
            player1_address: hostAddress,
            room_code: roomCode,
            status: "waiting",
            format: "best_of_3",
            fight_phase: "waiting",
            stake_fee_bps: 10,
        };

        if (hasStake) {
            insertData.stake_amount_stroops = stakeAmountStroops!.toString();
        }

        const { data, error } = await supabase
            .from("matches")
            .insert(insertData)
            .select("id, room_code, stake_amount_stroops")
            .single();

        if (error || !data) {
            console.error("Failed to create room:", error);
            return null;
        }

        return {
            id: data.id,
            code: data.room_code,
            stakeAmountStroops: data.stake_amount_stroops ?? undefined,
        };
    } catch (error) {
        console.error("Error creating room:", error);
        return null;
    }
}

export async function joinRoom(
    guestAddress: string,
    roomCode: string
): Promise<JoinRoomResult | null> {
    try {
        const supabase = getSupabase();

        const { data: room, error: findError } = await supabase
            .from("matches")
            .select("id, player1_address, player2_address, status, stake_amount_stroops")
            .eq("room_code", roomCode.toUpperCase())
            .eq("status", "waiting")
            .single();

        if (findError || !room) {
            return null;
        }

        if (room.player2_address) {
            return null;
        }

        if (room.player1_address === guestAddress) {
            return null;
        }

        const hasStake = !!room.stake_amount_stroops && BigInt(room.stake_amount_stroops) > 0n;

        const selectionDeadlineAt = hasStake
            ? null
            : new Date(Date.now() + CHARACTER_SELECT_TIMEOUT_SECONDS * 1000).toISOString();

        const stakeDeadlineAt = hasStake
            ? new Date(Date.now() + STAKE_DEPOSIT_TIMEOUT_SECONDS * 1000).toISOString()
            : undefined;

        const updateData: Record<string, unknown> = {
            player2_address: guestAddress,
            status: "character_select",
        };

        if (selectionDeadlineAt) updateData.selection_deadline_at = selectionDeadlineAt;
        if (stakeDeadlineAt) updateData.stake_deadline_at = stakeDeadlineAt;

        const { data: updated, error: updateError } = await supabase
            .from("matches")
            .update(updateData)
            .eq("id", room.id)
            .select("selection_deadline_at, stake_deadline_at")
            .single();

        if (updateError || !updated) {
            console.error("Failed to join room:", updateError);
            return null;
        }

        return {
            id: room.id,
            hostAddress: room.player1_address,
            selectionDeadlineAt: updated.selection_deadline_at ?? undefined,
            stakeAmountStroops: room.stake_amount_stroops ?? undefined,
            stakeDeadlineAt: updated.stake_deadline_at ?? undefined,
        };
    } catch (error) {
        console.error("Error joining room:", error);
        return null;
    }
}