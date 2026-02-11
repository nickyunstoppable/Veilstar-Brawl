/**
 * Match Routes
 * GET  /api/matches/:matchId — get match state
 */

import { getSupabase } from "../../lib/supabase";

export async function handleGetMatch(matchId: string): Promise<Response> {
    try {
        const supabase = getSupabase();

        const { data: match, error } = await supabase
            .from("matches")
            .select("*")
            .eq("id", matchId)
            .single();

        if (error || !match) {
            return Response.json(
                { error: "Match not found" },
                { status: 404 }
            );
        }

        // Also fetch fight state snapshot
        const { data: fightState } = await supabase
            .from("fight_state_snapshots")
            .select("*")
            .eq("match_id", matchId)
            .maybeSingle();

        // Fetch rounds
        const { data: rounds } = await supabase
            .from("rounds")
            .select("*")
            .eq("match_id", matchId)
            .order("round_number", { ascending: true })
            .order("turn_number", { ascending: true });

        return Response.json({
            match,
            fightState: fightState ?? null,
            rounds: rounds ?? [],
        });
    } catch (err) {
        console.error("[Match GET] Error:", err);
        return Response.json(
            { error: "Failed to get match" },
            { status: 500 }
        );
    }
}
