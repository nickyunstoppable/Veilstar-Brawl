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
    attemptMatch,
    broadcastMatchFound,
    getQueueSize,
} from "../../lib/matchmaker";
import { getSupabase } from "../../lib/supabase";

export async function handleJoinQueue(req: Request): Promise<Response> {
    try {
        const body = await req.json() as { address?: string };
        const { address } = body;

        if (!address) {
            return Response.json({ error: "Address is required" }, { status: 400 });
        }

        if (await isInQueue(address)) {
            return Response.json({
                success: true,
                queueSize: await getQueueSize(),
            });
        }

        const supabase = getSupabase();
        const { data: player } = await supabase
            .from("players")
            .select("rating")
            .eq("address", address)
            .maybeSingle();

        const rating = player?.rating ?? 1000;

        await addToQueue(address, rating);

        const matchResult = await attemptMatch(address);

        if (!matchResult) {
            console.log(`[MATCHMAKING-POST] ${address.slice(-8)}: No match found, triggering cycle for other players`);

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
                        await broadcastMatchFound(
                            otherResult.matchId,
                            otherResult.player1Address,
                            otherResult.player2Address,
                            otherResult.selectionDeadlineAt
                        );

                        if (otherResult.player1Address === address || otherResult.player2Address === address) {
                            return Response.json({
                                success: true,
                                queueSize: await getQueueSize(),
                                matchId: otherResult.matchId,
                            });
                        }
                        break;
                    }
                }
            }
        }

        if (matchResult) {
            await broadcastMatchFound(
                matchResult.matchId,
                matchResult.player1Address,
                matchResult.player2Address,
                matchResult.selectionDeadlineAt
            );

            return Response.json({
                success: true,
                queueSize: await getQueueSize(),
                matchId: matchResult.matchId,
            });
        }

        return Response.json({
            success: true,
            queueSize: await getQueueSize(),
        });
    } catch (error) {
        return Response.json(
            { error: error instanceof Error ? error.message : "Failed to join queue" },
            { status: 500 }
        );
    }
}

export async function handleLeaveQueue(req: Request): Promise<Response> {
    try {
        const body = await req.json() as { address?: string };
        const { address } = body;

        if (!address) {
            return Response.json({ error: "Address is required" }, { status: 400 });
        }

        await removeFromQueue(address);

        return Response.json({ success: true });
    } catch (error) {
        return Response.json(
            { error: error instanceof Error ? error.message : "Failed to leave queue" },
            { status: 500 }
        );
    }
}

export async function handleQueueStatus(req: Request): Promise<Response> {
    try {
        const { searchParams } = new URL(req.url);
        const address = searchParams.get("address");

        const queueSize = await getQueueSize();

        if (!address) {
            return Response.json({
                inQueue: false,
                queueSize,
            });
        }

        const supabase = getSupabase();

        const { data: pendingMatch } = await supabase
            .from("matches")
            .select("id, player1_address, player2_address, status, selection_deadline_at, created_at")
            .or(`player1_address.eq.${address},player2_address.eq.${address}`)
            .in("status", ["waiting", "character_select"])
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

        if (pendingMatch && pendingMatch.player2_address) {
            if (pendingMatch.status === "cancelled" || pendingMatch.status === "abandoned") {
            } else {
                const now = new Date();
                let isStale = false;

                if (pendingMatch.status === "character_select" && pendingMatch.selection_deadline_at) {
                    const deadline = new Date(pendingMatch.selection_deadline_at);
                    if (now.getTime() > deadline.getTime() + 30000) {
                        isStale = true;
                    }
                }

                if (!isStale && pendingMatch.created_at) {
                    const createdAt = new Date(pendingMatch.created_at);
                    const matchAgeMs = now.getTime() - createdAt.getTime();
                    const maxMatchDurationMs = 30 * 60 * 1000;
                    if (matchAgeMs > maxMatchDurationMs) {
                        isStale = true;
                    }
                }

                if (isStale) {
                    await supabase
                        .from("matches")
                        .update({
                            status: "abandoned",
                            completed_at: now.toISOString(),
                        })
                        .eq("id", pendingMatch.id);
                } else {
                    return Response.json({
                        inQueue: false,
                        queueSize: await getQueueSize(),
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

        const { data: queueEntry } = await supabase
            .from("matchmaking_queue")
            .select("status, matched_with")
            .eq("address", address)
            .maybeSingle();

        const shortAddr = address.slice(-8);
        console.log(`[MATCHMAKING-GET] ${shortAddr}: Queue entry status = ${queueEntry?.status || "not found"}, matched_with = ${queueEntry?.matched_with?.slice(-8) || "null"}`);

        if (queueEntry?.status === "matched" && queueEntry?.matched_with) {
            for (let retry = 0; retry < 3; retry++) {
                const { data: matchFromOther } = await supabase
                    .from("matches")
                    .select("id, player1_address, player2_address, selection_deadline_at, status")
                    .or(`player1_address.eq.${address},player2_address.eq.${address}`)
                    .in("status", ["character_select"])
                    .order("created_at", { ascending: false })
                    .limit(1)
                    .maybeSingle();

                if (matchFromOther && matchFromOther.player2_address) {
                    return Response.json({
                        inQueue: false,
                        queueSize: await getQueueSize(),
                        matchFound: {
                            matchId: matchFromOther.id,
                            player1Address: matchFromOther.player1_address,
                            player2Address: matchFromOther.player2_address,
                            selectionDeadlineAt: matchFromOther.selection_deadline_at ?? undefined,
                        },
                    });
                }

                if (retry < 2) {
                    await new Promise((resolve) => setTimeout(resolve, 200));
                }
            }

            const { data: queueEntryWithTime } = await supabase
                .from("matchmaking_queue")
                .select("joined_at")
                .eq("address", address)
                .maybeSingle();

            if (queueEntryWithTime) {
                const joinedAt = new Date(queueEntryWithTime.joined_at).getTime();
                const staleDuration = Date.now() - joinedAt;

                if (staleDuration > 15000) {
                    await supabase
                        .from("matchmaking_queue")
                        .update({ status: "searching", matched_with: null })
                        .eq("address", address);

                    return Response.json({
                        inQueue: true,
                        queueSize: await getQueueSize(),
                    });
                }
            }

            return Response.json({
                inQueue: true,
                queueSize: await getQueueSize(),
                matchPending: true,
            });
        }

        if (!queueEntry || queueEntry.status !== "searching") {
            return Response.json({
                inQueue: !!queueEntry,
                queueSize,
            });
        }

        const matchResult = await attemptMatch(address);

        if (matchResult) {
            await broadcastMatchFound(
                matchResult.matchId,
                matchResult.player1Address,
                matchResult.player2Address,
                matchResult.selectionDeadlineAt
            );

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

        return Response.json({
            inQueue: true,
            queueSize,
        });
    } catch (error) {
        console.error("Queue status error:", error);
        return Response.json({
            inQueue: false,
            queueSize: 0,
        });
    }
}