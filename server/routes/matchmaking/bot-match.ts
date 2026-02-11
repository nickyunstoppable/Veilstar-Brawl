/**
 * Bot Match Route
 * POST /api/matchmaking/create-bot-match
 * Creates a match against a bot when no opponent is found within the timeout
 */

import { getSupabase } from "../../lib/supabase";
import { GAME_CONSTANTS } from "../../lib/game-types";

interface CreateBotMatchBody {
    player1Address: string;
    player2Address: string;
    player2Name?: string;
}

export async function handleCreateBotMatch(req: Request): Promise<Response> {
    try {
        const body = (await req.json()) as CreateBotMatchBody;

        if (!body.player1Address || !body.player2Address) {
            return Response.json(
                { error: "Missing 'player1Address' or 'player2Address'" },
                { status: 400 }
            );
        }

        const supabase = getSupabase();

        const selectionDeadline = new Date(
            Date.now() + GAME_CONSTANTS.CHARACTER_SELECT_SECONDS * 1000
        ).toISOString();

        // Create match with bot opponent
        const { data, error } = await supabase
            .from("matches")
            .insert({
                player1_address: body.player1Address,
                player2_address: body.player2Address,
                status: "character_select",
                format: "best_of_3",
                selection_deadline_at: selectionDeadline,
                fight_phase: "waiting",
                is_bot_match: true,
            })
            .select("id")
            .single();

        if (error || !data) {
            console.error("[BotMatch] Failed to create bot match:", error);
            return Response.json(
                { error: "Failed to create bot match" },
                { status: 500 }
            );
        }

        // Create initial fight state snapshot
        await supabase.from("fight_state_snapshots").insert({
            match_id: data.id,
            phase: "waiting",
        });

        // Remove player from queue
        await supabase
            .from("matchmaking_queue")
            .delete()
            .eq("address", body.player1Address);

        console.log(
            `[BotMatch] Created bot match: ${data.id} for ${body.player1Address.slice(0, 8)}...`
        );

        return Response.json({ matchId: data.id });
    } catch (err) {
        console.error("[BotMatch] Error:", err);
        return Response.json(
            { error: "Failed to create bot match" },
            { status: 500 }
        );
    }
}
