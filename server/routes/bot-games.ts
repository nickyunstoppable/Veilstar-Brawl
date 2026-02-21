/**
 * Bot Games API Routes
 * GET /api/bot-games — get current active bot match
 * GET /api/bot-games/sync — sync data for returning spectators
 */

import { ensureActiveBotMatch, getActiveMatch, getMatchSyncInfo, reportActiveMatchPlaybackEnded, syncActiveBotBettingLifecycle } from "../lib/bot-match-service";

export async function handleGetBotGames(req: Request): Promise<Response> {
    try {
        void syncActiveBotBettingLifecycle();

        const url = new URL(req.url);
        const requestedMatchId = url.searchParams.get("matchId");

        // If a specific match is requested, check if it's the active one
        if (requestedMatchId) {
            const active = getActiveMatch();
            if (active && active.id === requestedMatchId) {
                return Response.json({ match: active });
            }
        }

        // Get (or create) the current active match
        const match = await ensureActiveBotMatch();

        return Response.json({ match });
    } catch (error) {
        console.error("[BotGames] Error:", error);
        return Response.json({ error: "Failed to get bot match" }, { status: 500 });
    }
}

export async function handleBotGamesSync(req: Request): Promise<Response> {
    try {
        void syncActiveBotBettingLifecycle();

        const url = new URL(req.url);
        const matchId = url.searchParams.get("matchId");

        if (!matchId) {
            return Response.json({ error: "matchId required" }, { status: 400 });
        }

        const syncInfo = getMatchSyncInfo(matchId);

        if (!syncInfo) {
            // Match not found, maybe it expired — get the new active one
            const newMatch = await ensureActiveBotMatch();
            return Response.json({
                error: "match_expired",
                newMatch: { id: newMatch.id },
            });
        }

        return Response.json(syncInfo);
    } catch (error) {
        console.error("[BotGamesSync] Error:", error);
        return Response.json({ error: "Failed to sync" }, { status: 500 });
    }
}

export async function handleBotGamesPlaybackEnded(req: Request): Promise<Response> {
    try {
        const body = await req.json();
        const matchId = String(body?.matchId || "").trim();

        if (!matchId) {
            return Response.json({ error: "matchId required" }, { status: 400 });
        }

        const reported = reportActiveMatchPlaybackEnded(matchId);
        if (!reported.accepted) {
            return Response.json(
                {
                    accepted: false,
                    error: "stale_match",
                    activeMatchId: reported.activeMatchId,
                },
                { status: 409 }
            );
        }

        return Response.json({ accepted: true, matchId });
    } catch (error) {
        console.error("[BotGamesPlaybackEnded] Error:", error);
        return Response.json({ error: "Failed to record playback end" }, { status: 500 });
    }
}
