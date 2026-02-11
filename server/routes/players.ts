/**
 * Player API route handlers
 * GET /api/players/:address         — player profile + rank
 * GET /api/players/:address/matches — recent match history
 */

import { getSupabase } from "../lib/supabase";

/**
 * GET /api/players/:address
 * Returns player profile with computed rank
 */
export async function handleGetPlayer(address: string): Promise<Response> {
    const supabase = getSupabase();

    // Fetch player
    const { data: player, error } = await supabase
        .from("players")
        .select("address, display_name, wins, losses, rating, created_at")
        .eq("address", address)
        .single();

    if (error || !player) {
        return Response.json({ error: "Player not found" }, { status: 404 });
    }

    // Compute rank: count players with higher rating
    const { count: higherCount } = await supabase
        .from("players")
        .select("*", { count: "exact", head: true })
        .gt("rating", player.rating);

    const rank = (higherCount ?? 0) + 1;

    return Response.json({
        address: player.address,
        displayName: player.display_name,
        rating: player.rating || 1000,
        wins: player.wins || 0,
        losses: player.losses || 0,
        rank,
        createdAt: player.created_at,
    });
}

/**
 * GET /api/players/:address/matches?limit=10
 * Returns recent completed matches for a player
 */
export async function handleGetPlayerMatches(address: string, req: Request): Promise<Response> {
    const url = new URL(req.url);
    const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "10", 10), 1), 50);

    const supabase = getSupabase();

    // Get completed matches where this player participated
    const { data: matches, error, count } = await supabase
        .from("matches")
        .select("id, player1_address, player2_address, winner_address, player1_rounds_won, player2_rounds_won, completed_at, player1_character_id, player2_character_id", { count: "exact" })
        .or(`player1_address.eq.${address},player2_address.eq.${address}`)
        .eq("status", "completed")
        .not("winner_address", "is", null)
        .order("completed_at", { ascending: false })
        .limit(limit);

    if (error) {
        console.error("[Players] Match history error:", error);
        return Response.json({ error: "Failed to fetch match history" }, { status: 500 });
    }

    // Collect opponent addresses for display name lookups
    const opponentAddresses = new Set<string>();
    for (const m of matches || []) {
        const opAddr = m.player1_address === address ? m.player2_address : m.player1_address;
        opponentAddresses.add(opAddr);
    }

    // Batch fetch opponent display names
    let opponentNames: Record<string, string | null> = {};
    if (opponentAddresses.size > 0) {
        const { data: opponents } = await supabase
            .from("players")
            .select("address, display_name")
            .in("address", Array.from(opponentAddresses));

        if (opponents) {
            for (const op of opponents) {
                opponentNames[op.address] = op.display_name;
            }
        }
    }

    const result = (matches || []).map((m) => {
        const isPlayer1 = m.player1_address === address;
        const opponentAddress = isPlayer1 ? m.player2_address : m.player1_address;
        const won = m.winner_address === address;
        const p1Rounds = m.player1_rounds_won || 0;
        const p2Rounds = m.player2_rounds_won || 0;
        const score = isPlayer1 ? `${p1Rounds} - ${p2Rounds}` : `${p2Rounds} - ${p1Rounds}`;

        return {
            matchId: m.id,
            opponentAddress,
            opponentName: opponentNames[opponentAddress] || null,
            playerCharacterId: isPlayer1 ? m.player1_character_id : m.player2_character_id,
            opponentCharacterId: isPlayer1 ? m.player2_character_id : m.player1_character_id,
            result: won ? "win" : "loss",
            score,
            completedAt: m.completed_at,
        };
    });

    return Response.json({
        matches: result,
        total: count || 0,
    });
}
