/**
 * Match Routes
 * GET  /api/matches/:matchId — get match state
 */

import { getSupabase } from "../../lib/supabase";

const NO_STORE_HEADERS: Record<string, string> = {
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
    Pragma: "no-cache",
    Expires: "0",
};

export async function handleGetMatch(matchId: string, req?: Request): Promise<Response> {
    try {
        const supabase = getSupabase();
        const lite = (() => {
            if (!req) return false;
            const url = new URL(req.url);
            return url.searchParams.get("lite") === "1";
        })();

        const { data: match, error } = await supabase
            .from("matches")
            .select(lite
                ? "id,status,player1_address,player2_address,winner_address,player1_rounds_won,player2_rounds_won,fight_phase,updated_at"
                : "*")
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

        if (lite) {
            return Response.json(
                {
                    match,
                    fightState: fightState ?? null,
                    rounds: [],
                },
                { headers: NO_STORE_HEADERS }
            );
        }

        // Fetch rounds
        const { data: rounds } = await supabase
            .from("rounds")
            .select("*")
            .eq("match_id", matchId)
            .order("round_number", { ascending: true })
            .order("turn_number", { ascending: true });

        return Response.json(
            {
                match,
                fightState: fightState ?? null,
                rounds: rounds ?? [],
            },
            { headers: NO_STORE_HEADERS }
        );
    } catch (err) {
        console.error("[Match GET] Error:", err);
        return Response.json(
            { error: "Failed to get match" },
            { status: 500 }
        );
    }
}
