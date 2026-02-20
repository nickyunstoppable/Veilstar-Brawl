/**
 * Veilstar Brawl — Game Server
 * Bun.serve entry point with manual route matching
 *
 * Start: bun run server/index.ts
 */

import { handleJoinQueue, handleQueueStatus, handleLeaveQueue } from "./routes/matchmaking/queue";
import { handleCreateRoom, handleJoinRoom } from "./routes/matchmaking/rooms";
import { handleGetMatch } from "./routes/matches/match";
import { handlePrepareMoveOnChain, handleSubmitMove } from "./routes/matches/move";
import { handleExpireStakeDepositWindow, handlePrepareStakeDeposit, handleSubmitStakeDeposit } from "./routes/matches/stake";
import { handleCharacterSelect } from "./routes/matches/select";
import { handleSubmitBan } from "./routes/matches/ban";
import { handleForfeit } from "./routes/matches/forfeit";
import { handlePrepareRegistration, handleSubmitAuth, handleCancelRegistration } from "./routes/matches/register";
import {
    handleGetPowerSurgeCards,
    handlePreparePowerSurge,
    handleSelectPowerSurge,
} from "./routes/matches/power-surge";
import { handleRejectMove } from "./routes/matches/reject";
import { handleMoveTimeoutRoute } from "./routes/matches/move-timeout";
import { handleTimeoutVictory } from "./routes/matches/timeout";
import { handleDisconnect } from "./routes/matches/disconnect";
import { handleFinalizeWithZkProof } from "./routes/matches/zk-finalize";
import { handleProveAndFinalize } from "./routes/matches/zk-prove-finalize";
import { handleCommitPrivateRoundPlan, handlePreparePrivateRoundCommit, handleResolvePrivateRound } from "./routes/matches/zk-round-commit";
import { handleProvePrivateRoundPlan } from "./routes/matches/zk-round-prove";
import { handleGetLeaderboard } from "./routes/leaderboard";
import { handleGetPlayer, handleGetPlayerMatches } from "./routes/players";
import { handleGetReplayData } from "./routes/replay-data";
import { handleSweepFeesCron } from "./routes/cron/sweep-fees";
import { startAbandonmentMonitor } from "./lib/abandonment-monitor";
import { ensureEnvLoaded } from "./lib/env";
import { handleGetMatchPublic } from "./routes/matches/public";
import { handleGetLiveMatches } from "./routes/matches/live";
import { handleGetBotGames, handleBotGamesSync } from "./routes/bot-games";
import { handleGetBettingPool, handlePlaceBet, handleGetBotBettingPool, handlePlaceBotBet, handleGetUnresolvedBotBets, handleGetBotBetHistory } from "./routes/betting";

ensureEnvLoaded();

const PORT = parseInt(process.env.PORT || process.env.SERVER_PORT || "3001", 10);

// =============================================================================
// CORS
// =============================================================================

function getCorsHeaders(req?: Request): Record<string, string> {
    const requestOrigin = req?.headers.get("origin") || "";
    const configuredOrigin = process.env.CORS_ORIGIN || "";
    const allowOrigin = configuredOrigin || requestOrigin || "*";

    return {
        "Access-Control-Allow-Origin": allowOrigin,
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Max-Age": "86400",
        "Vary": "Origin",
    };
}

function corsResponse(response: Response, req?: Request): Response {
    const corsHeaders = getCorsHeaders(req);
    const headers = new Headers(response.headers);
    Object.entries(corsHeaders).forEach(([k, v]) => headers.set(k, v));
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}

function corsOptions(req?: Request): Response {
    return new Response(null, { status: 204, headers: getCorsHeaders(req) });
}

// =============================================================================
// ROUTE MATCHING
// =============================================================================

/** Extract matchId from /api/matches/:matchId/... patterns */
function extractMatchId(pathname: string): string | null {
    const match = pathname.match(/^\/api\/matches\/([a-f0-9-]+)/i);
    return match ? match[1] : null;
}

async function handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;
    const method = req.method;

    // CORS preflight
    if (method === "OPTIONS") return corsOptions(req);

    // -----------------------------------------------
    // Health check
    // -----------------------------------------------
    if (pathname === "/api/health") {
        return corsResponse(Response.json({
            status: "ok",
            server: "veilstar-brawl",
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
        }), req);
    }

    // -----------------------------------------------
    // Replay Data (for public replay + MP4 export)
    // -----------------------------------------------
    if (pathname === "/api/replay-data" && method === "GET") {
        return corsResponse(await handleGetReplayData(req), req);
    }

    // -----------------------------------------------
    // Matchmaking Queue
    // -----------------------------------------------
    if (pathname === "/api/matchmaking/queue") {
        if (method === "POST") return corsResponse(await handleJoinQueue(req), req);
        if (method === "GET") return corsResponse(await handleQueueStatus(req), req);
        if (method === "DELETE") return corsResponse(await handleLeaveQueue(req), req);
    }

    if (pathname === "/api/matchmaking/rooms" && method === "POST") {
        return corsResponse(await handleCreateRoom(req), req);
    }

    if (pathname === "/api/matchmaking/rooms/join" && method === "POST") {
        return corsResponse(await handleJoinRoom(req), req);
    }

    if (pathname === "/api/cron/sweep-fees" && method === "POST") {
        return corsResponse(await handleSweepFeesCron(req), req);
    }

    // -----------------------------------------------
    // Leaderboard
    // -----------------------------------------------
    if (pathname === "/api/leaderboard" && method === "GET") {
        return corsResponse(await handleGetLeaderboard(req), req);
    }

    // -----------------------------------------------
    // Spectate — Live Matches
    // -----------------------------------------------
    if (pathname === "/api/matches/live" && method === "GET") {
        return corsResponse(await handleGetLiveMatches(), req);
    }

    // -----------------------------------------------
    // Bot Games
    // -----------------------------------------------
    if (pathname === "/api/bot-games" && method === "GET") {
        return corsResponse(await handleGetBotGames(req), req);
    }
    if (pathname === "/api/bot-games/sync" && method === "GET") {
        return corsResponse(await handleBotGamesSync(req), req);
    }

    // -----------------------------------------------
    // Betting — PvP
    // -----------------------------------------------
    const bettingPoolMatch = pathname.match(/^\/api\/betting\/pool\/([a-f0-9-]+)$/i);
    if (bettingPoolMatch && method === "GET") {
        return corsResponse(await handleGetBettingPool(bettingPoolMatch[1], req), req);
    }
    if (pathname === "/api/betting/place" && method === "POST") {
        return corsResponse(await handlePlaceBet(req), req);
    }

    // -----------------------------------------------
    // Betting — Bot
    // -----------------------------------------------
    const botBettingPoolMatch = pathname.match(/^\/api\/bot-betting\/pool\/([a-f0-9-]+)$/i);
    if (botBettingPoolMatch && method === "GET") {
        return corsResponse(await handleGetBotBettingPool(botBettingPoolMatch[1], req), req);
    }
    if (pathname === "/api/bot-betting/place" && method === "POST") {
        return corsResponse(await handlePlaceBotBet(req), req);
    }
    if (pathname === "/api/bot-betting/unresolved" && method === "GET") {
        return corsResponse(await handleGetUnresolvedBotBets(req), req);
    }
    if (pathname === "/api/bot-betting/history" && method === "GET") {
        return corsResponse(await handleGetBotBetHistory(req), req);
    }
    // -----------------------------------------------
    // Player Profile & Match History
    // -----------------------------------------------
    const playerMatch = pathname.match(/^\/api\/players\/([A-Z0-9]+)(\/matches)?$/);
    if (playerMatch) {
        const playerAddress = playerMatch[1];
        const isMatches = !!playerMatch[2];

        if (isMatches && method === "GET") {
            return corsResponse(await handleGetPlayerMatches(playerAddress, req), req);
        }
        if (!isMatches && method === "GET") {
            return corsResponse(await handleGetPlayer(playerAddress), req);
        }
    }

    // -----------------------------------------------
    // Match Routes — /api/matches/:matchId[/action]
    // -----------------------------------------------
    const matchId = extractMatchId(pathname);
    if (matchId) {
        // GET /api/matches/:matchId/public
        if (pathname === `/api/matches/${matchId}/public` && method === "GET") {
            return corsResponse(await handleGetMatchPublic(matchId), req);
        }

        // GET /api/matches/:matchId
        if (pathname === `/api/matches/${matchId}` && method === "GET") {
            return corsResponse(await handleGetMatch(matchId, req), req);
        }

        // GET /api/matches/:matchId/verify
        if (pathname === `/api/matches/${matchId}/verify` && method === "GET") {
            return corsResponse(await handleGetMatch(matchId, req), req);
        }

        // POST /api/matches/:matchId/move
        if (pathname === `/api/matches/${matchId}/move` && method === "POST") {
            return corsResponse(await handleSubmitMove(matchId, req), req);
        }

        // POST /api/matches/:matchId/stake/prepare
        if (pathname === `/api/matches/${matchId}/stake/prepare` && method === "POST") {
            return corsResponse(await handlePrepareStakeDeposit(matchId, req), req);
        }

        // POST /api/matches/:matchId/stake/submit
        if (pathname === `/api/matches/${matchId}/stake/submit` && method === "POST") {
            return corsResponse(await handleSubmitStakeDeposit(matchId, req), req);
        }

        // POST /api/matches/:matchId/stake/expire
        if (pathname === `/api/matches/${matchId}/stake/expire` && method === "POST") {
            return corsResponse(await handleExpireStakeDepositWindow(matchId, req), req);
        }

        // POST /api/matches/:matchId/move/prepare
        if (pathname === `/api/matches/${matchId}/move/prepare` && method === "POST") {
            return corsResponse(await handlePrepareMoveOnChain(matchId, req), req);
        }

        // POST /api/matches/:matchId/select
        if (pathname === `/api/matches/${matchId}/select` && method === "POST") {
            return corsResponse(await handleCharacterSelect(matchId, req), req);
        }

        // POST /api/matches/:matchId/ban
        if (pathname === `/api/matches/${matchId}/ban` && method === "POST") {
            return corsResponse(await handleSubmitBan(matchId, req), req);
        }

        // POST /api/matches/:matchId/register/prepare
        if (pathname === `/api/matches/${matchId}/register/prepare` && method === "POST") {
            return corsResponse(await handlePrepareRegistration(matchId, req), req);
        }

        // POST /api/matches/:matchId/register/auth
        if (pathname === `/api/matches/${matchId}/register/auth` && method === "POST") {
            return corsResponse(await handleSubmitAuth(matchId, req), req);
        }

        // POST /api/matches/:matchId/register/cancel
        if (pathname === `/api/matches/${matchId}/register/cancel` && method === "POST") {
            return corsResponse(await handleCancelRegistration(matchId, req), req);
        }

        // POST /api/matches/:matchId/forfeit
        if (pathname === `/api/matches/${matchId}/forfeit` && method === "POST") {
            return corsResponse(await handleForfeit(matchId, req), req);
        }

        // POST /api/matches/:matchId/reject
        if (pathname === `/api/matches/${matchId}/reject` && method === "POST") {
            return corsResponse(await handleRejectMove(matchId, req), req);
        }

        // POST /api/matches/:matchId/move-timeout
        if (pathname === `/api/matches/${matchId}/move-timeout` && method === "POST") {
            return corsResponse(await handleMoveTimeoutRoute(matchId, req), req);
        }

        // POST /api/matches/:matchId/timeout
        if (pathname === `/api/matches/${matchId}/timeout` && method === "POST") {
            return corsResponse(await handleTimeoutVictory(matchId, req), req);
        }

        // POST /api/matches/:matchId/disconnect
        if (pathname === `/api/matches/${matchId}/disconnect` && method === "POST") {
            return corsResponse(await handleDisconnect(matchId, req), req);
        }

        // GET /api/matches/:matchId/power-surge (legacy)
        if (pathname === `/api/matches/${matchId}/power-surge` && method === "GET") {
            return corsResponse(await handleGetPowerSurgeCards(matchId, req), req);
        }

        // GET /api/matches/:matchId/power-surge/cards
        if (pathname === `/api/matches/${matchId}/power-surge/cards` && method === "GET") {
            return corsResponse(await handleGetPowerSurgeCards(matchId, req), req);
        }

        // POST /api/matches/:matchId/power-surge/select
        if (pathname === `/api/matches/${matchId}/power-surge/select` && method === "POST") {
            return corsResponse(await handleSelectPowerSurge(matchId, req), req);
        }

        // POST /api/matches/:matchId/power-surge/prepare
        if (pathname === `/api/matches/${matchId}/power-surge/prepare` && method === "POST") {
            return corsResponse(await handlePreparePowerSurge(matchId, req), req);
        }

        // POST /api/matches/:matchId/zk/finalize
        if (pathname === `/api/matches/${matchId}/zk/finalize` && method === "POST") {
            return corsResponse(await handleFinalizeWithZkProof(matchId, req), req);
        }

        // POST /api/matches/:matchId/zk/prove-finalize
        if (pathname === `/api/matches/${matchId}/zk/prove-finalize` && method === "POST") {
            return corsResponse(await handleProveAndFinalize(matchId, req), req);
        }

        // POST /api/matches/:matchId/zk/round/commit/prepare
        if (pathname === `/api/matches/${matchId}/zk/round/commit/prepare` && method === "POST") {
            return corsResponse(await handlePreparePrivateRoundCommit(matchId, req), req);
        }

        // POST /api/matches/:matchId/zk/round/commit
        if (pathname === `/api/matches/${matchId}/zk/round/commit` && method === "POST") {
            return corsResponse(await handleCommitPrivateRoundPlan(matchId, req), req);
        }

        // POST /api/matches/:matchId/zk/round/prove
        if (pathname === `/api/matches/${matchId}/zk/round/prove` && method === "POST") {
            return corsResponse(await handleProvePrivateRoundPlan(matchId, req), req);
        }

        // POST /api/matches/:matchId/zk/round/resolve
        if (pathname === `/api/matches/${matchId}/zk/round/resolve` && method === "POST") {
            return corsResponse(await handleResolvePrivateRound(matchId, req), req);
        }
    }

    // -----------------------------------------------
    // 404
    // -----------------------------------------------
    return corsResponse(Response.json(
        { error: "Not found", path: pathname },
        { status: 404 }
    ), req);
}

// =============================================================================
// START SERVER
// =============================================================================

console.log(`
╔══════════════════════════════════════════════╗
║     ⚔️  VEILSTAR BRAWL — GAME SERVER  ⚔️     ║
╠══════════════════════════════════════════════╣
║  Port:     ${String(PORT).padEnd(33)}║
║  Health:   http://localhost:${PORT}/api/health   ║
╚══════════════════════════════════════════════╝
`);

const server = Bun.serve({
    port: PORT,
    fetch: handleRequest,
    idleTimeout: 60,
    error(error) {
        console.error("[Server] Unhandled error:", error);
        return corsResponse(Response.json(
            { error: "Internal server error" },
            { status: 500 }
        ));
    },
});

console.log(`Server running on http://localhost:${server.port}`);

startAbandonmentMonitor();
