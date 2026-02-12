/**
 * Matchmaking Queue Routes
 * POST   /api/matchmaking/queue — join queue
 * GET    /api/matchmaking/queue — poll queue status
 * DELETE /api/matchmaking/queue — leave queue
 */

import {
    addToQueue,
    removeFromQueue,
    isInQueue,
    getQueueSize,
    attemptMatch,
    getActiveMatchForPlayer,
} from "../../lib/matchmaker";
import { getSupabase } from "../../lib/supabase";

// =============================================================================
// POST — Join Queue
// =============================================================================

export async function handleJoinQueue(req: Request): Promise<Response> {
    try {
        const body = await req.json() as { address?: string; rating?: number };

        if (!body.address) {
            return Response.json(
                { error: "Missing 'address' in request body" },
                { status: 400 }
            );
        }

        const address = body.address.trim();
        const rating = body.rating ?? 1000;

        // Check if already in queue
        const alreadyQueued = await isInQueue(address);
        if (alreadyQueued) {
            // Try to find a match
            const match = await attemptMatch(address);
            const queueSize = await getQueueSize();

            if (match) {
                return Response.json({
                    success: true,
                    queueSize,
                    matchId: match.matchId,
                    matchFound: match,
                });
            }

            return Response.json({
                success: true,
                queueSize,
                message: "Already in queue, waiting for opponent",
            });
        }

        // Join the queue
        await addToQueue(address, rating);

        // Immediately try to find a match
        let match = await attemptMatch(address);

        // If we didn't find a match (e.g., we're the "waiter" due to tie-breaker),
        // trigger match attempts for OTHER players in the queue so the "initiator" can claim us
        if (!match) {
            const supabase = getSupabase();
            const { data: otherPlayers } = await supabase
                .from("matchmaking_queue")
                .select("address")
                .eq("status", "searching")
                .neq("address", address)
                .limit(5);

            if (otherPlayers && otherPlayers.length > 0) {
                for (const otherPlayer of otherPlayers) {
                    const otherResult = await attemptMatch(otherPlayer.address);
                    if (otherResult) {
                        if (otherResult.player1Address === address || otherResult.player2Address === address) {
                            match = otherResult;
                        }
                        break;
                    }
                }
            }
        }

        const queueSize = await getQueueSize();

        return Response.json({
            success: true,
            queueSize,
            matchId: match?.matchId,
            matchFound: match ?? undefined,
        });
    } catch (err) {
        console.error("[Queue POST] Error:", err);
        return Response.json(
            { error: err instanceof Error ? err.message : "Failed to join queue" },
            { status: 500 }
        );
    }
}

// =============================================================================
// GET — Poll Queue Status
// =============================================================================

export async function handleQueueStatus(req: Request): Promise<Response> {
    try {
        const url = new URL(req.url);
        const address = url.searchParams.get("address");

        if (!address) {
            return Response.json(
                { error: "Missing 'address' query parameter" },
                { status: 400 }
            );
        }

        const supabase = getSupabase();
        const queueSize = await getQueueSize();

        // FIRST: Check if player has a pending/active match
        const { data: pendingMatch } = await supabase
            .from("matches")
            .select("id, player1_address, player2_address, status, selection_deadline_at, created_at")
            .or(`player1_address.eq.${address},player2_address.eq.${address}`)
            .in("status", ["waiting", "character_select"])
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

        if (pendingMatch && pendingMatch.player2_address) {
            // Skip cancelled/abandoned matches
            if (pendingMatch.status === "cancelled" || pendingMatch.status === "abandoned") {
                // Don't return — fall through to normal queue logic
            } else {
                // Check if the match is stale and should be cleaned up
                const now = Date.now();
                let isStale = false;

                // Check 1: selection deadline passed by 30+ seconds
                if (pendingMatch.status === "character_select" && pendingMatch.selection_deadline_at) {
                    const deadline = new Date(pendingMatch.selection_deadline_at).getTime();
                    if (now > deadline + 30000) {
                        isStale = true;
                    }
                }

                // Check 2: match older than 30 minutes
                if (!isStale && pendingMatch.created_at) {
                    const createdAt = new Date(pendingMatch.created_at).getTime();
                    if (now - createdAt > 30 * 60 * 1000) {
                        isStale = true;
                    }
                }

                if (isStale) {
                    console.log(`[Queue GET] Cleaning up stale match ${pendingMatch.id}`);
                    await supabase
                        .from("matches")
                        .update({
                            status: "abandoned",
                            completed_at: new Date().toISOString(),
                        })
                        .eq("id", pendingMatch.id);
                    // Don't return — fall through to normal queue logic
                } else {
                    // Valid pending match — return it
                    return Response.json({
                        inQueue: false,
                        queueSize,
                        matchFound: {
                            matchId: pendingMatch.id,
                            player1Address: pendingMatch.player1_address,
                            player2Address: pendingMatch.player2_address,
                            selectionDeadlineAt: pendingMatch.selection_deadline_at ?? undefined,
                        },
                    });
                }
            }
        }

        // SECOND: Check if we've been claimed (matched_with set)
        const { data: queueEntry } = await supabase
            .from("matchmaking_queue")
            .select("status, matched_with")
            .eq("address", address)
            .maybeSingle();

        if (queueEntry?.status === "matched" && queueEntry?.matched_with) {
            // Try to find the match created by the other player (with retries)
            for (let retry = 0; retry < 3; retry++) {
                const { data: matchFromOther } = await supabase
                    .from("matches")
                    .select("id, player1_address, player2_address, selection_deadline_at")
                    .or(`player1_address.eq.${address},player2_address.eq.${address}`)
                    .in("status", ["character_select"])
                    .order("created_at", { ascending: false })
                    .limit(1)
                    .maybeSingle();

                if (matchFromOther && matchFromOther.player2_address) {
                    return Response.json({
                        inQueue: false,
                        queueSize,
                        matchFound: {
                            matchId: matchFromOther.id,
                            player1Address: matchFromOther.player1_address,
                            player2Address: matchFromOther.player2_address,
                            selectionDeadlineAt: matchFromOther.selection_deadline_at ?? undefined,
                        },
                    });
                }

                if (retry < 2) {
                    await new Promise(resolve => setTimeout(resolve, 200));
                }
            }

            // If matched status persists for too long without a match, reset
            const { data: queueEntryWithTime } = await supabase
                .from("matchmaking_queue")
                .select("joined_at")
                .eq("address", address)
                .maybeSingle();

            if (queueEntryWithTime) {
                const staleDuration = Date.now() - new Date(queueEntryWithTime.joined_at).getTime();
                if (staleDuration > 15000) {
                    await supabase
                        .from("matchmaking_queue")
                        .update({ status: "searching", matched_with: null })
                        .eq("address", address);

                    return Response.json({ inQueue: true, queueSize });
                }
            }

            return Response.json({ inQueue: true, queueSize, matchPending: true });
        }

        // If not in queue or not searching, return status
        if (!queueEntry || queueEntry.status !== "searching") {
            return Response.json({ inQueue: !!queueEntry, queueSize });
        }

        // Try to find a match
        const matchResult = await attemptMatch(address);

        if (matchResult) {
            return Response.json({
                inQueue: false,
                queueSize: await getQueueSize(),
                matchFound: {
                    matchId: matchResult.matchId,
                    player1Address: matchResult.player1Address,
                    player2Address: matchResult.player2Address,
                    selectionDeadlineAt: matchResult.selectionDeadlineAt,
                },
            });
        }

        return Response.json({ inQueue: true, queueSize });
    } catch (err) {
        console.error("[Queue GET] Error:", err);
        return Response.json(
            { error: "Failed to get queue status" },
            { status: 500 }
        );
    }
}

// =============================================================================
// DELETE — Leave Queue
// =============================================================================

export async function handleLeaveQueue(req: Request): Promise<Response> {
    try {
        const body = await req.json() as { address?: string };

        if (!body.address) {
            return Response.json(
                { error: "Missing 'address' in request body" },
                { status: 400 }
            );
        }

        await removeFromQueue(body.address.trim());

        return Response.json({ success: true });
    } catch (err) {
        console.error("[Queue DELETE] Error:", err);
        return Response.json(
            { error: "Failed to leave queue" },
            { status: 500 }
        );
    }
}
