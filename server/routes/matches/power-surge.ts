/**
 * Power Surge Routes
 *
 * GET  /api/matches/:matchId/power-surge/cards?address=...&roundNumber=...
 * POST /api/matches/:matchId/power-surge/select
 */

import { getSupabase } from "../../lib/supabase";
import { broadcastGameEvent } from "../../lib/matchmaker";
import {
  isClientSignedActionConfigured,
  preparePowerSurgeOnChain,
  submitSignedPowerSurgeOnChain,
} from "../../lib/stellar-contract";

const USE_OFFCHAIN_ACTIONS = (process.env.ZK_OFFCHAIN_ACTIONS ?? "true") !== "false";
const PRIVATE_ROUNDS_ENABLED = (process.env.ZK_PRIVATE_ROUNDS ?? "false") === "true";
import {
  computeStunFlags,
  getOrCreateRoundDeck,
  isPowerSurgeCardId,
  type PowerSurgeCardId,
} from "../../lib/power-surge";

export async function handleGetPowerSurgeCards(matchId: string, req: Request): Promise<Response> {
  try {
    if (PRIVATE_ROUNDS_ENABLED) {
      return Response.json(
        { error: "Legacy power surge cards endpoint is disabled when ZK_PRIVATE_ROUNDS=true." },
        { status: 409 },
      );
    }

    const url = new URL(req.url);
    const address = url.searchParams.get("address") || "";
    const roundParam = url.searchParams.get("roundNumber") || url.searchParams.get("round") || "1";
    const roundNumber = parseInt(roundParam, 10);
    const revealSelections = url.searchParams.get("reveal") === "true";

    const supabase = getSupabase();

    const { data: match } = await supabase
      .from("matches")
      .select("id, player1_address, player2_address, power_surge_deck")
      .eq("id", matchId)
      .single();

    if (!match) return Response.json({ error: "Match not found" }, { status: 404 });

    const isPlayer1 = !!address && match.player1_address === address;
    const isPlayer2 = !!address && match.player2_address === address;
    const isParticipant = isPlayer1 || isPlayer2;

    if (address && !isParticipant) {
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

    const offeredCards = round.player1Cards as PowerSurgeCardId[];

    const canRevealPlayer1 = revealSelections || isPlayer1;
    const canRevealPlayer2 = revealSelections || isPlayer2;

    const player1Selection = {
      ready: !!round.player1Selection,
      cardId: round.player1Selection
        ? (canRevealPlayer1 ? round.player1Selection : "hidden")
        : null,
    };

    const player2Selection = {
      ready: !!round.player2Selection,
      cardId: round.player2Selection
        ? (canRevealPlayer2 ? round.player2Selection : "hidden")
        : null,
    };

    return Response.json({
      success: true,
      matchId,
      roundNumber,
      deadlineAt: round.deadlineAt,
      cardIds: offeredCards,
      data: {
        matchId,
        roundNumber,
        deadlineAt: round.deadlineAt,
        offeredCards,
        player1Selection,
        player2Selection,
      },
    });
  } catch (err) {
    console.error("[PowerSurge GET] Error:", err);
    return Response.json({ error: "Failed to get power surge cards" }, { status: 500 });
  }
}

export async function handleSelectPowerSurge(matchId: string, req: Request): Promise<Response> {
  try {
    if (PRIVATE_ROUNDS_ENABLED) {
      return Response.json(
        { error: "Legacy power surge selection is disabled when ZK_PRIVATE_ROUNDS=true. Include surge choice inside /zk/round/resolve." },
        { status: 409 },
      );
    }

    const body = (await req.json()) as {
      address?: string;
      roundNumber?: number;
      cardId?: string;
      signedAuthEntryXdr?: string;
      transactionXdr?: string;
    };
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
    const allowed = round.player1Cards;
    if (!allowed.includes(cardId as any)) {
      return Response.json({ error: "Card not in your offered deck" }, { status: 400 });
    }

    let onChainTxHash: string | null = null;

    if (!USE_OFFCHAIN_ACTIONS) {
      if (!isClientSignedActionConfigured()) {
        return Response.json(
          { error: "On-chain power surge signing is required" },
          { status: 503 },
        );
      }

      if (!body.signedAuthEntryXdr || !body.transactionXdr) {
        return Response.json(
          { error: "Missing signedAuthEntryXdr or transactionXdr. Call /power-surge/prepare first." },
          { status: 428 },
        );
      }

      const onChainResult = await submitSignedPowerSurgeOnChain(
        matchId,
        address,
        body.signedAuthEntryXdr,
        body.transactionXdr,
      );

      if (!onChainResult.success) {
        return Response.json(
          {
            error: "On-chain power surge transaction failed",
            details: onChainResult.error || "Unknown on-chain error",
          },
          { status: 502 },
        );
      }

      onChainTxHash = onChainResult.txHash || null;
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

    // Mirror selections to legacy-friendly relational table used by some frontend polling paths.
    // Keep this in sync with matches.power_surge_deck until all clients are fully migrated.
    try {
      const { data: existingSurge } = await supabase
        .from("power_surges")
        .select("player1_card_id, player2_card_id")
        .eq("match_id", matchId)
        .eq("round_number", roundNumber)
        .maybeSingle();

      const mergedPlayer1 = isPlayer1
        ? cardId
        : (existingSurge?.player1_card_id ?? round.player1Selection ?? null);
      const mergedPlayer2 = isPlayer2
        ? cardId
        : (existingSurge?.player2_card_id ?? round.player2Selection ?? null);

      await supabase
        .from("power_surges")
        .upsert(
          {
            match_id: matchId,
            round_number: roundNumber,
            player1_card_id: mergedPlayer1,
            player2_card_id: mergedPlayer2,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "match_id,round_number" },
        );
    } catch (syncErr) {
      console.warn("[PowerSurge POST] Non-fatal power_surges sync error:", syncErr);
    }

    const player = isPlayer1 ? "player1" : "player2";
    await broadcastGameEvent(matchId, "power_surge_selected", {
      matchId,
      player,
      cardId,
      roundNumber,
      selectedAt: Date.now(),
      onChainTxHash,
      onChainSkippedReason: null,
    });

    // Compute legacy stun flags and sync fight_state_snapshot immediately.
    // Current surge deck has no stun card, so these remain false.
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

    return Response.json({ success: true, onChainTxHash, onChainSkippedReason: null });
  } catch (err) {
    console.error("[PowerSurge POST] Error:", err);
    return Response.json({ error: "Failed to select power surge" }, { status: 500 });
  }
}

export async function handlePreparePowerSurge(matchId: string, req: Request): Promise<Response> {
  try {
    if (PRIVATE_ROUNDS_ENABLED) {
      return Response.json(
        { error: "Legacy power surge prepare is disabled when ZK_PRIVATE_ROUNDS=true." },
        { status: 409 },
      );
    }

    if (USE_OFFCHAIN_ACTIONS) {
      return Response.json(
        { error: "Off-chain action mode enabled; power-surge prepare is disabled" },
        { status: 409 },
      );
    }

    if (!isClientSignedActionConfigured()) {
      return Response.json(
        { error: "On-chain power surge signing is not configured" },
        { status: 503 },
      );
    }

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

    const { round } = getOrCreateRoundDeck({
      matchId,
      player1Address: match.player1_address,
      player2Address: match.player2_address,
      roundNumber,
      existingDeck: match.power_surge_deck,
    });

    const allowed = round.player1Cards;
    if (!allowed.includes(cardId as any)) {
      return Response.json({ error: "Card not in your offered deck" }, { status: 400 });
    }

    if (Date.now() > round.deadlineAt + 1500) {
      return Response.json({ error: "Selection window expired" }, { status: 400 });
    }

    const prepared = await preparePowerSurgeOnChain(
      matchId,
      address,
      roundNumber,
      cardId,
    );

    return Response.json({
      success: true,
      sessionId: prepared.sessionId,
      transactionXdr: prepared.transactionXdr,
      authEntryXdr: prepared.authEntryXdr,
      roundNumber,
      cardId,
    });
  } catch (err) {
    console.error("[PowerSurge Prepare] Error:", err);
    return Response.json({ error: "Failed to prepare power surge" }, { status: 500 });
  }
}
