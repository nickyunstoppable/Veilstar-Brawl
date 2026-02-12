/**
 * Character Selection Route
 * POST /api/matches/:matchId/select
 */

import { getSupabase } from "../../lib/supabase";
import { broadcastGameEvent } from "../../lib/matchmaker";
import { GAME_CONSTANTS } from "../../lib/game-types";
import { isOnChainRegistrationConfigured, matchIdToSessionId } from "../../lib/stellar-contract";

interface SelectCharacterBody {
    address: string;
    characterId: string;
}

export async function handleCharacterSelect(
    matchId: string,
    req: Request
): Promise<Response> {
    try {
        const body = await req.json() as SelectCharacterBody;

        if (!body.address || !body.characterId) {
            return Response.json(
                { error: "Missing 'address' or 'characterId'" },
                { status: 400 }
            );
        }

        const supabase = getSupabase();

        // Fetch the match
        const { data: match, error } = await supabase
            .from("matches")
            .select("*")
            .eq("id", matchId)
            .single();

        if (error || !match) {
            return Response.json({ error: "Match not found" }, { status: 404 });
        }

        // Must be in character_select phase
        if (match.status !== "character_select") {
            return Response.json(
                { error: `Match is not in character select phase (status: ${match.status})` },
                { status: 400 }
            );
        }

        // Verify player is in match
        const isPlayer1 = match.player1_address === body.address;
        const isPlayer2 = match.player2_address === body.address;

        if (!isPlayer1 && !isPlayer2) {
            return Response.json(
                { error: "You are not a participant in this match" },
                { status: 403 }
            );
        }

        // Set character
        const updateField = isPlayer1 ? "player1_character_id" : "player2_character_id";
        const { error: updateError } = await supabase
            .from("matches")
            .update({ [updateField]: body.characterId })
            .eq("id", matchId);

        if (updateError) {
            return Response.json(
                { error: "Failed to select character" },
                { status: 500 }
            );
        }

        // Broadcast selection
        await broadcastGameEvent(matchId, "character_selected", {
            player: isPlayer1 ? "player1" : "player2",
            characterId: body.characterId,
            locked: true,
        });

        // Re-fetch to check if both selected
        const { data: updated } = await supabase
            .from("matches")
            .select("player1_character_id, player2_character_id")
            .eq("id", matchId)
            .single();

        if (updated?.player1_character_id && updated?.player2_character_id) {
            // Both selected — start the match
            const moveDeadline = new Date(
                Date.now() + GAME_CONSTANTS.COUNTDOWN_SECONDS * 1000 + GAME_CONSTANTS.MOVE_TIMER_SECONDS * 1000
            ).toISOString();

            await supabase
                .from("matches")
                .update({
                    status: "in_progress",
                    started_at: new Date().toISOString(),
                    fight_phase: "countdown",
                    fight_phase_started_at: new Date().toISOString(),
                })
                .eq("id", matchId);

            // Create first round
            await supabase
                .from("rounds")
                .insert({
                    match_id: matchId,
                    round_number: 1,
                    turn_number: 1,
                    move_deadline_at: moveDeadline,
                    countdown_seconds: GAME_CONSTANTS.COUNTDOWN_SECONDS,
                    countdown_started_at: new Date().toISOString(),
                });

            // Update fight state
            await supabase
                .from("fight_state_snapshots")
                .update({
                    phase: "countdown",
                    countdown_ends_at: new Date(
                        Date.now() + GAME_CONSTANTS.COUNTDOWN_SECONDS * 1000
                    ).toISOString(),
                    move_deadline_at: moveDeadline,
                    updated_at: new Date().toISOString(),
                })
                .eq("match_id", matchId);

            // On-chain registration: the frontend handles signing via Freighter.
            const requiresOnChainRegistration = isOnChainRegistrationConfigured();

            // Broadcast match start
            await broadcastGameEvent(matchId, "match_starting", {
                matchId,
                player1Address: match.player1_address,
                player2Address: match.player2_address,
                player1CharacterId: updated.player1_character_id,
                player2CharacterId: updated.player2_character_id,
                countdownSeconds: GAME_CONSTANTS.COUNTDOWN_SECONDS,
                moveDeadlineAt: moveDeadline,
                onChainSessionId: matchIdToSessionId(matchId),
                contractId: process.env.VITE_VEILSTAR_BRAWL_CONTRACT_ID || '',
                requiresOnChainRegistration,
            });

            // Broadcast first round starting
            const countdownEndsAt = Date.now() + GAME_CONSTANTS.COUNTDOWN_SECONDS * 1000;
            await broadcastGameEvent(matchId, "round_starting", {
                roundNumber: 1,
                turnNumber: 1,
                player1Health: GAME_CONSTANTS.MAX_HEALTH,
                player2Health: GAME_CONSTANTS.MAX_HEALTH,
                moveDeadlineAt: new Date(moveDeadline).getTime(),
                countdownEndsAt,
            });

            return Response.json({
                success: true,
                matchStarted: true,
                player1CharacterId: updated.player1_character_id,
                player2CharacterId: updated.player2_character_id,
                onChainSessionId: matchIdToSessionId(matchId),
            });
        }

        return Response.json({
            success: true,
            matchStarted: false,
            message: "Character selected, waiting for opponent",
        });
    } catch (err) {
        console.error("[Select POST] Error:", err);
        return Response.json(
            { error: "Failed to select character" },
            { status: 500 }
        );
    }
}
