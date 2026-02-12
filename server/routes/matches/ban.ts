/**
 * Character Ban Route
 * POST /api/matches/:matchId/ban
 */

import { getSupabase } from "../../lib/supabase";
import { broadcastGameEvent } from "../../lib/matchmaker";

interface SubmitBanBody {
    address: string;
    characterId: string;
}

export async function handleSubmitBan(matchId: string, req: Request): Promise<Response> {
    try {
        const body = await req.json() as SubmitBanBody;

        if (!body.address || !body.characterId) {
            return Response.json(
                { error: "Missing 'address' or 'characterId'" },
                { status: 400 }
            );
        }

        const address = body.address.trim();
        const characterId = body.characterId.trim();

        if (!address || !characterId) {
            return Response.json(
                { error: "Invalid 'address' or 'characterId'" },
                { status: 400 }
            );
        }

        const supabase = getSupabase();

        const { data: match, error: matchError } = await supabase
            .from("matches")
            .select("id, status, player1_address, player2_address, player1_ban_id, player2_ban_id")
            .eq("id", matchId)
            .single();

        if (matchError || !match) {
            return Response.json({ error: "Match not found" }, { status: 404 });
        }

        if (match.status !== "character_select") {
            return Response.json(
                { error: `Match is not in character select phase (status: ${match.status})` },
                { status: 400 }
            );
        }

        const isPlayer1 = match.player1_address === address;
        const isPlayer2 = match.player2_address === address;

        if (!isPlayer1 && !isPlayer2) {
            return Response.json(
                { error: "You are not a participant in this match" },
                { status: 403 }
            );
        }

        const updateField = isPlayer1 ? "player1_ban_id" : "player2_ban_id";
        const playerRole = isPlayer1 ? "player1" : "player2";

        const { error: updateError } = await supabase
            .from("matches")
            .update({ [updateField]: characterId })
            .eq("id", matchId);

        if (updateError) {
            console.error("[Ban POST] Failed to update match ban:", updateError);
            return Response.json(
                { error: "Failed to save ban" },
                { status: 500 }
            );
        }

        await broadcastGameEvent(matchId, "ban_confirmed", {
            player: playerRole,
            characterId,
        });

        const { data: updated } = await supabase
            .from("matches")
            .select("player1_ban_id, player2_ban_id")
            .eq("id", matchId)
            .single();

        const bothBansComplete = !!(updated?.player1_ban_id && updated?.player2_ban_id);

        return Response.json({
            success: true,
            characterId,
            player: playerRole,
            bothBansComplete,
        });
    } catch (err) {
        console.error("[Ban POST] Error:", err);
        return Response.json(
            { error: "Failed to submit ban" },
            { status: 500 }
        );
    }
}
