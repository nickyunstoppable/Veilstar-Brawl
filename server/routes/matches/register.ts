/**
 * On-chain Registration Routes (Client-signed)
 *
 * POST /api/matches/:matchId/register/prepare
 *   → Builds the start_game transaction, returns per-player auth entry XDR
 *
 * POST /api/matches/:matchId/register/auth
 *   → Receives a player's signed auth entry, stores it.
 *     When both arrive, assembles and submits the transaction.
 */

import { getSupabase } from "../../lib/supabase";
import { broadcastGameEvent } from "../../lib/matchmaker";
import { GAME_CONSTANTS } from "../../lib/game-types";
import {
    isContractConfigured,
    matchIdToSessionId,
    prepareRegistration,
    submitSignedRegistration,
    type PreparedRegistration,
} from "../../lib/stellar-contract";

// In-memory store for pending registrations.
// Keyed by matchId → { prepared data, collected signed auth entries }
interface PendingRegistration {
    prepared: PreparedRegistration;
    player1Address: string;
    player2Address: string;
    signedAuthEntries: Record<string, string>; // address → signed XDR
    submitted: boolean;
}

const pendingRegistrations = new Map<string, PendingRegistration>();

// =============================================================================
// POST /api/matches/:matchId/register/prepare
// =============================================================================

export async function handlePrepareRegistration(
    matchId: string,
    _req: Request,
): Promise<Response> {
    try {
        if (!isContractConfigured()) {
            return Response.json(
                { error: "On-chain registration is not configured" },
                { status: 503 },
            );
        }

        const supabase = getSupabase();

        // Fetch match
        const { data: match, error } = await supabase
            .from("matches")
            .select("player1_address, player2_address, status, is_bot_match")
            .eq("id", matchId)
            .single();

        if (error || !match) {
            return Response.json({ error: "Match not found" }, { status: 404 });
        }

        if (match.is_bot_match) {
            return Response.json(
                { error: "Bot matches do not require on-chain registration" },
                { status: 400 },
            );
        }

        // Allow preparation during character_select (both chars locked) or in_progress
        if (!["character_select", "in_progress"].includes(match.status)) {
            return Response.json(
                { error: `Match is in wrong phase: ${match.status}` },
                { status: 400 },
            );
        }

        // Check if already prepared
        const existing = pendingRegistrations.get(matchId);
        if (existing && !existing.submitted) {
            // Return cached preparation
            return Response.json({
                sessionId: existing.prepared.sessionId,
                authEntries: existing.prepared.authEntries,
            });
        }

        // Prepare the transaction
        const prepared = await prepareRegistration(
            matchId,
            match.player1_address,
            match.player2_address,
        );

        // Store pending registration
        pendingRegistrations.set(matchId, {
            prepared,
            player1Address: match.player1_address,
            player2Address: match.player2_address,
            signedAuthEntries: {},
            submitted: false,
        });

        return Response.json({
            sessionId: prepared.sessionId,
            authEntries: prepared.authEntries,
        });
    } catch (err) {
        console.error("[Register/prepare] Error:", err);
        return Response.json(
            { error: err instanceof Error ? err.message : "Failed to prepare registration" },
            { status: 500 },
        );
    }
}

// =============================================================================
// POST /api/matches/:matchId/register/auth
// =============================================================================

interface SubmitAuthBody {
    address: string;
    signedAuthEntryXdr: string;
}

export async function handleSubmitAuth(
    matchId: string,
    req: Request,
): Promise<Response> {
    try {
        const body = (await req.json()) as SubmitAuthBody;

        if (!body.address || !body.signedAuthEntryXdr) {
            return Response.json(
                { error: "Missing 'address' or 'signedAuthEntryXdr'" },
                { status: 400 },
            );
        }

        const pending = pendingRegistrations.get(matchId);
        if (!pending) {
            return Response.json(
                { error: "No pending registration found. Call /register/prepare first." },
                { status: 404 },
            );
        }

        if (pending.submitted) {
            return Response.json({
                success: true,
                alreadySubmitted: true,
                message: "Registration already submitted on-chain",
            });
        }

        // Verify the address is a participant
        if (
            body.address !== pending.player1Address &&
            body.address !== pending.player2Address
        ) {
            return Response.json(
                { error: "Address is not a participant in this match" },
                { status: 403 },
            );
        }

        // Store the signed auth entry
        pending.signedAuthEntries[body.address] = body.signedAuthEntryXdr;
        console.log(
            `[Register/auth] Received signed auth from ${body.address.slice(0, 8)}… for match ${matchId.slice(0, 8)}…`,
        );

        // Check if both players have signed
        const hasBoth =
            pending.signedAuthEntries[pending.player1Address] &&
            pending.signedAuthEntries[pending.player2Address];

        if (!hasBoth) {
            // Broadcast to notify the other player we've signed
            await broadcastGameEvent(matchId, "registration_auth_received", {
                address: body.address,
            });

            return Response.json({
                success: true,
                bothSigned: false,
                message: "Auth entry received, waiting for opponent",
            });
        }

        // Both signed — assemble and submit
        pending.submitted = true;

        const result = await submitSignedRegistration(
            matchId,
            pending.player1Address,
            pending.player2Address,
            pending.signedAuthEntries,
            pending.prepared.transactionXdr,
        );

        // Store on-chain session ID in match metadata
        const supabase = getSupabase();
        if (result.sessionId) {
            await supabase
                .from("matches")
                .update({
                    onchain_session_id: result.sessionId,
                    onchain_tx_hash: result.txHash || null,
                })
                .eq("id", matchId);
        }

        if (!result.success) {
            // Reset so players can retry
            pending.submitted = false;
            pending.signedAuthEntries = {};

            await broadcastGameEvent(matchId, "registration_failed", {
                error: result.error,
            });

            return Response.json(
                { error: result.error || "On-chain submission failed" },
                { status: 500 },
            );
        }

        // Broadcast success
        await broadcastGameEvent(matchId, "registration_complete", {
            sessionId: result.sessionId,
            txHash: result.txHash,
        });

        // Clean up
        pendingRegistrations.delete(matchId);

        console.log(
            `[Register/auth] On-chain registration complete for match ${matchId.slice(0, 8)}… TX: ${result.txHash || "n/a"}`,
        );

        return Response.json({
            success: true,
            bothSigned: true,
            sessionId: result.sessionId,
            txHash: result.txHash,
        });
    } catch (err) {
        console.error("[Register/auth] Error:", err);
        return Response.json(
            { error: err instanceof Error ? err.message : "Failed to submit auth" },
            { status: 500 },
        );
    }
}
