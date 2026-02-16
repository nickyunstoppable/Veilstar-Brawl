import { ensureEnvLoaded } from "../server/lib/env";
import { handleCommitPrivateRoundPlan, handlePreparePrivateRoundCommit, handleResolvePrivateRound } from "../server/routes/matches/zk-round-commit";
import { handleProvePrivateRoundPlan } from "../server/routes/matches/zk-round-prove";
import { handleFinalizeWithZkProof } from "../server/routes/matches/zk-finalize";
import { handleProveAndFinalize } from "../server/routes/matches/zk-prove-finalize";

ensureEnvLoaded();

const PORT = parseInt(process.env.PORT || process.env.ZK_SERVER_PORT || "3011", 10);

function getCorsHeaders(req?: Request): Record<string, string> {
    const requestOrigin = req?.headers.get("origin") || "";
    const configuredOrigin = process.env.CORS_ORIGIN || "";
    const allowOrigin = configuredOrigin || requestOrigin || "*";

    return {
        "Access-Control-Allow-Origin": allowOrigin,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Max-Age": "86400",
        Vary: "Origin",
    };
}

function withCors(response: Response, req?: Request): Response {
    const headers = new Headers(response.headers);
    const cors = getCorsHeaders(req);
    Object.entries(cors).forEach(([key, value]) => headers.set(key, value));

    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}

function corsOptions(req?: Request): Response {
    return new Response(null, { status: 204, headers: getCorsHeaders(req) });
}

function extractMatchId(pathname: string): string | null {
    const match = pathname.match(/^\/api\/matches\/([a-f0-9-]+)/i);
    return match ? match[1] : null;
}

async function handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;
    const method = req.method;

    if (method === "OPTIONS") {
        return corsOptions(req);
    }

    if (pathname === "/api/health" && method === "GET") {
        return withCors(Response.json({
            status: "ok",
            server: "veilstar-zk-service",
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
        }), req);
    }

    const matchId = extractMatchId(pathname);
    if (matchId) {
        if (pathname === `/api/matches/${matchId}/zk/round/commit/prepare` && method === "POST") {
            return withCors(await handlePreparePrivateRoundCommit(matchId, req), req);
        }

        if (pathname === `/api/matches/${matchId}/zk/round/commit` && method === "POST") {
            return withCors(await handleCommitPrivateRoundPlan(matchId, req), req);
        }

        if (pathname === `/api/matches/${matchId}/zk/round/prove` && method === "POST") {
            return withCors(await handleProvePrivateRoundPlan(matchId, req), req);
        }

        if (pathname === `/api/matches/${matchId}/zk/round/resolve` && method === "POST") {
            return withCors(await handleResolvePrivateRound(matchId, req), req);
        }

        if (pathname === `/api/matches/${matchId}/zk/finalize` && method === "POST") {
            return withCors(await handleFinalizeWithZkProof(matchId, req), req);
        }

        if (pathname === `/api/matches/${matchId}/zk/prove-finalize` && method === "POST") {
            return withCors(await handleProveAndFinalize(matchId, req), req);
        }
    }

    return withCors(Response.json({ error: "Not found" }, { status: 404 }), req);
}

Bun.serve({
    port: PORT,
    fetch: handleRequest,
});

console.log(`[ZK Service] listening on http://localhost:${PORT}`);
