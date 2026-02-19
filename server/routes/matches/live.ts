/**
 * GET /api/matches/live
 * Fetch all in-progress PvP matches for spectate listing
 */

import { getSupabase } from "../../lib/supabase";

export async function handleGetLiveMatches(): Promise<Response> {
    try {
        const supabase = getSupabase();

        // Only return matches started within the last 2 hours to exclude zombie in_progress matches
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

        const { data: matches, error } = await supabase
            .from("matches")
            .select(`
                id,
                room_code,
                player1_address,
                player2_address,
                player1_character_id,
                player2_character_id,
                format,
                status,
                player1_rounds_won,
                player2_rounds_won,
                created_at,
                started_at
            `)
            .eq("status", "in_progress")
            .gte("started_at", twoHoursAgo)
            .order("created_at", { ascending: false });

        if (error) {
            console.error("[LiveMatches] Error fetching matches:", error);
            return Response.json({ error: "Failed to fetch matches" }, { status: 500 });
        }

        // Fetch player info for each match
        const allAddresses = new Set<string>();
        for (const match of matches || []) {
            allAddresses.add(match.player1_address);
            if (match.player2_address) allAddresses.add(match.player2_address);
        }

        let playerMap = new Map<string, { address: string; displayName: string | null; rating: number; avatarUrl: string | null }>();

        if (allAddresses.size > 0) {
            const { data: players } = await supabase
                .from("players")
                .select("address, display_name, rating, avatar_url")
                .in("address", Array.from(allAddresses));

            if (players) {
                for (const p of players) {
                    playerMap.set(p.address, {
                        address: p.address,
                        displayName: p.display_name,
                        rating: p.rating || 1000,
                        avatarUrl: p.avatar_url,
                    });
                }
            }
        }

        // Transform to camelCase for frontend
        const transformed = (matches || []).map(m => ({
            id: m.id,
            roomCode: m.room_code,
            player1Address: m.player1_address,
            player2Address: m.player2_address,
            player1CharacterId: m.player1_character_id,
            player2CharacterId: m.player2_character_id,
            format: m.format,
            status: m.status,
            player1RoundsWon: m.player1_rounds_won || 0,
            player2RoundsWon: m.player2_rounds_won || 0,
            createdAt: m.created_at,
            startedAt: m.started_at,
            player1: playerMap.get(m.player1_address) || null,
            player2: m.player2_address ? playerMap.get(m.player2_address) || null : null,
        }));

        return Response.json({ matches: transformed });
    } catch (error) {
        console.error("[LiveMatches] Unexpected error:", error);
        return Response.json({ error: "Internal server error" }, { status: 500 });
    }
}
