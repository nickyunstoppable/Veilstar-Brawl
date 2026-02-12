/**
 * Power Surge Routes
 *
 * GET  /api/matches/:matchId/power-surge/cards?address=...&roundNumber=...
 * POST /api/matches/:matchId/power-surge/select
 */

import { getSupabase } from "../../lib/supabase";
import { broadcastGameEvent } from "../../lib/matchmaker";
import {
  computeStunFlags,
  getOrCreateRoundDeck,
  isPowerSurgeCardId,
  type PowerSurgeCardId,
} from "../../lib/power-surge";

export async function handleGetPowerSurgeCards(matchId: string, req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const address = url.searchParams.get("address") || "";
    const roundNumber = parseInt(url.searchParams.get("roundNumber") || "1", 10);

    if (!address) {
      return Response.json({ error: "Missing address" }, { status: 400 });
    }

    const supabase = getSupabase();

    const { data: match } = await supabase
      .from("matches")
      .select("id, player1_address, player2_address, power_surge_deck")
      .eq("id", matchId)
      .single();

    if (!match) return Response.json({ error: "Match not found" }, { status: 404 });

    const isPlayer1 = match.player1_address === address;
    const isPlayer2 = match.player2_address === address;
    if (!isPlayer1 && !isPlayer2) {
      return Response.json({ error: "Not a participant" }, { status: 403 });
    }

    const { deck, round } = getOrCreateRoundDeck({
      matchId,
      player1Address: match.player1_address,
      player2Address: match.player2_address,
      roundNumber,
      existingDeck: match.power_surge_deck,
    });

    // Persist deck if created
    await supabase
      .from("matches")
      .update({ power_surge_deck: deck })
      .eq("id", matchId);

    const cardIds = (isPlayer1 ? round.player1Cards : round.player2Cards) as PowerSurgeCardId[];

    return Response.json({
      matchId,
      roundNumber,
      deadlineAt: round.deadlineAt,
      cardIds,
    });
  } catch (err) {
    console.error("[PowerSurge GET] Error:", err);
    return Response.json({ error: "Failed to get power surge cards" }, { status: 500 });
  }
}

export async function handleSelectPowerSurge(matchId: string, req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as { address?: string; roundNumber?: number; cardId?: string };
    const address = body.address || "";
    const roundNumber = body.roundNumber || 1;
    const cardId = body.cardId;

    if (!address || !cardId || typeof roundNumber !== "number") {
      return Response.json({ error: "Missing address, roundNumber, or cardId" }, { status: 400 });
    }

    if (!isPowerSurgeCardId(cardId)) {
      return Response.json({ error: `Invalid cardId: ${cardId}` }, { status: 400 });
    }

    const supabase = getSupabase();

    const { data: match } = await supabase
      .from("matches")
      .select("id, player1_address, player2_address, power_surge_deck")
      .eq("id", matchId)
      .single();

    if (!match) return Response.json({ error: "Match not found" }, { status: 404 });

    const isPlayer1 = match.player1_address === address;
    const isPlayer2 = match.player2_address === address;
    if (!isPlayer1 && !isPlayer2) {
      return Response.json({ error: "Not a participant" }, { status: 403 });
    }

    const { deck, round } = getOrCreateRoundDeck({
      matchId,
      player1Address: match.player1_address,
      player2Address: match.player2_address,
      roundNumber,
      existingDeck: match.power_surge_deck,
    });

    // Validate card belongs to this player's options
    const allowed = isPlayer1 ? round.player1Cards : round.player2Cards;
    if (!allowed.includes(cardId as any)) {
      return Response.json({ error: "Card not in your offered deck" }, { status: 400 });
    }

    // Enforce deadline (soft)
    if (Date.now() > round.deadlineAt + 1500) {
      return Response.json({ error: "Selection window expired" }, { status: 400 });
    }

    if (isPlayer1) {
      round.player1Selection = cardId;
    } else {
      round.player2Selection = cardId;
    }

    deck.rounds[String(roundNumber)] = round;

    await supabase
      .from("matches")
      .update({ power_surge_deck: deck })
      .eq("id", matchId);

    const player = isPlayer1 ? "player1" : "player2";
    await broadcastGameEvent(matchId, "power_surge_selected", {
      matchId,
      player,
      cardId,
      roundNumber,
      selectedAt: Date.now(),
    });

    // Compute stun flags and sync fight_state_snapshot immediately.
    // This makes mempool-congest authoritative even if only one player has selected so far.
    const { player1Stunned, player2Stunned } = computeStunFlags(round.player1Selection, round.player2Selection);

    await supabase
      .from("fight_state_snapshots")
      .update({
        player1_is_stunned: player1Stunned,
        player2_is_stunned: player2Stunned,
        updated_at: new Date().toISOString(),
      })
      .eq("match_id", matchId);

    await broadcastGameEvent(matchId, "fight_state_update", {
      matchId,
      update: {
        player1IsStunned: player1Stunned,
        player2IsStunned: player2Stunned,
      },
      timestamp: Date.now(),
    });

    return Response.json({ success: true });
  } catch (err) {
    console.error("[PowerSurge POST] Error:", err);
    return Response.json({ error: "Failed to select power surge" }, { status: 500 });
  }
}
