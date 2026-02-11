/**
 * Veilstar Brawl — Game Server
 * Bun.serve entry point with manual route matching
 *
 * Start: bun run server/index.ts
 */

import { handleJoinQueue, handleQueueStatus, handleLeaveQueue } from "./routes/matchmaking/queue";
import { handleCreateBotMatch } from "./routes/matchmaking/bot-match";
import { handleGetMatch } from "./routes/matches/match";
import { handleSubmitMove } from "./routes/matches/move";
import { handleCharacterSelect } from "./routes/matches/select";
import { handleForfeit } from "./routes/matches/forfeit";

const PORT = parseInt(process.env.SERVER_PORT || "3001", 10);

// =============================================================================
// CORS
// =============================================================================

const CORS_HEADERS: Record<string, string> = {
    "Access-Control-Allow-Origin": process.env.CORS_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
};

function corsResponse(response: Response): Response {
    const headers = new Headers(response.headers);
    Object.entries(CORS_HEADERS).forEach(([k, v]) => headers.set(k, v));
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}

function corsOptions(): Response {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
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
    if (method === "OPTIONS") return corsOptions();

    // -----------------------------------------------
    // Health check
    // -----------------------------------------------
    if (pathname === "/api/health") {
        return corsResponse(Response.json({
            status: "ok",
            server: "veilstar-brawl",
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
        }));
    }

    // -----------------------------------------------
    // Matchmaking Queue
    // -----------------------------------------------
    if (pathname === "/api/matchmaking/queue") {
        if (method === "POST") return corsResponse(await handleJoinQueue(req));
        if (method === "GET") return corsResponse(await handleQueueStatus(req));
        if (method === "DELETE") return corsResponse(await handleLeaveQueue(req));
    }

    // Bot match creation
    if (pathname === "/api/matchmaking/create-bot-match" && method === "POST") {
        return corsResponse(await handleCreateBotMatch(req));
    }

    // -----------------------------------------------
    // Match Routes — /api/matches/:matchId[/action]
    // -----------------------------------------------
    const matchId = extractMatchId(pathname);
    if (matchId) {
        // GET /api/matches/:matchId
        if (pathname === `/api/matches/${matchId}` && method === "GET") {
            return corsResponse(await handleGetMatch(matchId));
        }

        // GET /api/matches/:matchId/verify
        if (pathname === `/api/matches/${matchId}/verify` && method === "GET") {
            return corsResponse(await handleGetMatch(matchId));
        }

        // POST /api/matches/:matchId/move
        if (pathname === `/api/matches/${matchId}/move` && method === "POST") {
            return corsResponse(await handleSubmitMove(matchId, req));
        }

        // POST /api/matches/:matchId/select
        if (pathname === `/api/matches/${matchId}/select` && method === "POST") {
            return corsResponse(await handleCharacterSelect(matchId, req));
        }

        // POST /api/matches/:matchId/forfeit
        if (pathname === `/api/matches/${matchId}/forfeit` && method === "POST") {
            return corsResponse(await handleForfeit(matchId, req));
        }
    }

    // -----------------------------------------------
    // 404
    // -----------------------------------------------
    return corsResponse(Response.json(
        { error: "Not found", path: pathname },
        { status: 404 }
    ));
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
    error(error) {
        console.error("[Server] Unhandled error:", error);
        return corsResponse(Response.json(
            { error: "Internal server error" },
            { status: 500 }
        ));
    },
});

console.log(`Server running on http://localhost:${server.port}`);
