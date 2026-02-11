/**
 * Leaderboard API route handler
 * GET /api/leaderboard?limit=50&offset=0&sortBy=rating
 */

import { getSupabase } from "../lib/supabase";

export async function handleGetLeaderboard(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "50", 10), 1), 100);
    const offset = Math.max(parseInt(url.searchParams.get("offset") || "0", 10), 0);

    const supabase = getSupabase();

    // Get total count
    const { count, error: countError } = await supabase
        .from("players")
        .select("*", { count: "exact", head: true });

    if (countError) {
        console.error("[Leaderboard] Count error:", countError);
        return Response.json({ error: "Failed to fetch leaderboard" }, { status: 500 });
    }

    // Get paginated players sorted by rating
    const { data, error } = await supabase
        .from("players")
        .select("address, display_name, wins, losses, rating")
        .order("rating", { ascending: false })
        .order("wins", { ascending: false })
        .range(offset, offset + limit - 1);

    if (error) {
        console.error("[Leaderboard] Query error:", error);
        return Response.json({ error: "Failed to fetch leaderboard" }, { status: 500 });
    }

    const entries = (data || []).map((player, index) => ({
        rank: offset + index + 1,
        address: player.address,
        displayName: player.display_name,
        wins: player.wins || 0,
        losses: player.losses || 0,
        rating: player.rating || 1000,
    }));

    return Response.json({
        entries,
        total: count || 0,
    });
}
