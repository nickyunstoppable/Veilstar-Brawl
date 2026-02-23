export async function handleProveAndFinalize(matchId: string, req: Request): Promise<Response> {
    return Response.json(
        {
            error: "Backend prove-finalize is disabled. Generate proof in browser and call /api/matches/:matchId/zk/finalize.",
            code: "BACKEND_PROVE_FINALIZE_DISABLED",
            matchId,
        },
        { status: 410 },
    );
}
