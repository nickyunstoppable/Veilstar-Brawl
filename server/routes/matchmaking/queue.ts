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
} from "../../lib/matchmaker";

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
        const match = await attemptMatch(address);
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

        const inQueue = await isInQueue(address);
        const queueSize = await getQueueSize();

        // If in queue, try to find a match
        let matchFound = null;
        if (inQueue) {
            matchFound = await attemptMatch(address);
        }

        return Response.json({
            inQueue,
            queueSize,
            matchFound: matchFound ?? undefined,
            matchPending: !!matchFound,
        });
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
