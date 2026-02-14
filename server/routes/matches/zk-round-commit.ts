import { getSupabase } from "../../lib/supabase";
import { broadcastGameEvent } from "../../lib/matchmaker";
import { verifyNoirProof } from "../../lib/zk-proof";
import { isValidMove } from "../../lib/round-resolver";
import type { MoveType } from "../../lib/game-types";
import { isPowerSurgeCardId, type PowerSurgeCardId } from "../../lib/power-surge";
import { resolveTurn } from "../../lib/combat-resolver";

const PRIVATE_ROUNDS_ENABLED = (process.env.ZK_PRIVATE_ROUNDS ?? "false") === "true";
const privateRoundResolveLocks = new Set<string>();

interface CommitPrivateRoundBody {
    address?: string;
    roundNumber?: number;
    commitment?: string;
    proof?: string;
    publicInputs?: unknown;
    transcriptHash?: string;
    encryptedPlan?: string;
    onChainCommitTxHash?: string;
}

interface ResolvePrivateRoundBody {
    address?: string;
    roundNumber?: number;
    move?: MoveType;
    surgeCardId?: PowerSurgeCardId | null;
    proof?: string;
    publicInputs?: unknown;
    transcriptHash?: string;
    expectedWinnerAddress?: string;
}

function privateModeGuard(): Response | null {
    if (!PRIVATE_ROUNDS_ENABLED) {
        return Response.json(
            { error: "ZK private round mode is disabled (set ZK_PRIVATE_ROUNDS=true)" },
            { status: 409 },
        );
    }
    return null;
}

async function getOrCreateRound(matchId: string, roundNumber: number) {
    const supabase = getSupabase();
    const { data: existing } = await supabase
        .from("rounds")
        .select("*")
        .eq("match_id", matchId)
        .eq("round_number", roundNumber)
        .order("turn_number", { ascending: false })
        .limit(1)
        .maybeSingle();

    if (existing) {
        const alreadyFilled = !!existing.player1_move && !!existing.player2_move;
        if (!alreadyFilled) {
            return existing;
        }

        const moveDeadlineAt = new Date(Date.now() + 20_000).toISOString();
        const { data: nextTurn, error: nextTurnError } = await supabase
            .from("rounds")
            .insert({
                match_id: matchId,
                round_number: roundNumber,
                turn_number: (existing.turn_number || 1) + 1,
                move_deadline_at: moveDeadlineAt,
                countdown_seconds: 0,
            })
            .select("*")
            .single();

        if (nextTurnError || !nextTurn) {
            throw new Error("Failed to create next private round turn");
        }

        return nextTurn;
    }

    const moveDeadlineAt = new Date(Date.now() + 20_000).toISOString();
    const { data: created, error } = await supabase
        .from("rounds")
        .insert({
            match_id: matchId,
            round_number: roundNumber,
            turn_number: 1,
            move_deadline_at: moveDeadlineAt,
            countdown_seconds: 0,
        })
        .select("*")
        .single();

    if (error || !created) {
        throw new Error("Failed to create round for private commit flow");
    }

    return created;
}

export async function handleCommitPrivateRoundPlan(matchId: string, req: Request): Promise<Response> {
    try {
        const guard = privateModeGuard();
        if (guard) return guard;

        const body = await req.json() as CommitPrivateRoundBody;
        const address = body.address?.trim();
        const commitment = body.commitment?.trim();
        const proof = body.proof?.trim();
        const roundNumber = Number(body.roundNumber ?? 1);

        console.log(
            `[ZK Round Commit] Request match=${matchId} round=${roundNumber} player=${address?.slice(0, 6) || "n/a"}…${address?.slice(-4) || "n/a"}`,
        );

        if (!address || !commitment || !proof || !Number.isInteger(roundNumber) || roundNumber < 1) {
            return Response.json(
                { error: "Missing/invalid address, roundNumber, commitment, or proof" },
                { status: 400 },
            );
        }

        const supabase = getSupabase();
        const { data: match, error: matchError } = await supabase
            .from("matches")
            .select("id, status, player1_address, player2_address")
            .eq("id", matchId)
            .single();

        if (matchError || !match) {
            return Response.json({ error: "Match not found" }, { status: 404 });
        }

        const isParticipant = address === match.player1_address || address === match.player2_address;
        if (!isParticipant) {
            return Response.json({ error: "Not a participant in this match" }, { status: 403 });
        }

        const isPlayer1 = address === match.player1_address;
        const opponentAddress = isPlayer1 ? match.player2_address : match.player1_address;

        const { data: stunSnapshot } = await supabase
            .from("fight_state_snapshots")
            .select("player1_is_stunned, player2_is_stunned")
            .eq("match_id", matchId)
            .maybeSingle();

        const opponentIsStunned = isPlayer1
            ? Boolean(stunSnapshot?.player2_is_stunned)
            : Boolean(stunSnapshot?.player1_is_stunned);

        if (match.status !== "in_progress") {
            return Response.json(
                { error: `Match is not in progress (status: ${match.status})` },
                { status: 400 },
            );
        }

        const verification = await verifyNoirProof({
            proof,
            publicInputs: body.publicInputs,
            transcriptHash: body.transcriptHash,
            matchId,
            winnerAddress: address,
        });

        if (!verification.ok) {
            return Response.json({ error: "Commit proof verification failed" }, { status: 400 });
        }

        console.log(`[ZK Round Commit] Proof verified match=${matchId} round=${roundNumber} backend=${verification.backend}`);

        const { error: upsertError } = await supabase
            .from("round_private_commits")
            .upsert(
                {
                    match_id: matchId,
                    round_number: roundNumber,
                    player_address: address,
                    commitment,
                    encrypted_plan: body.encryptedPlan || null,
                    proof_public_inputs: body.publicInputs ?? null,
                    transcript_hash: body.transcriptHash ?? null,
                    onchain_commit_tx_hash: body.onChainCommitTxHash ?? null,
                    verified_at: new Date().toISOString(),
                    resolved_at: null,
                    resolved_round_id: null,
                    updated_at: new Date().toISOString(),
                },
                { onConflict: "match_id,round_number,player_address" },
            );

        if (upsertError) {
            return Response.json(
                { error: `Failed to persist private round commitment: ${upsertError.message}` },
                { status: 500 },
            );
        }

        const { data: commits } = await supabase
            .from("round_private_commits")
            .select("player_address, encrypted_plan")
            .eq("match_id", matchId)
            .eq("round_number", roundNumber)
            .is("resolved_round_id", null);

        const alreadyCommitted = new Set((commits || []).map((row: any) => row.player_address));
        if (opponentIsStunned && !alreadyCommitted.has(opponentAddress)) {
            await supabase
                .from("round_private_commits")
                .upsert(
                    {
                        match_id: matchId,
                        round_number: roundNumber,
                        player_address: opponentAddress,
                        commitment: `auto-stunned:${matchId}:${roundNumber}:${opponentAddress}`,
                        encrypted_plan: JSON.stringify({ move: "stunned", surgeCardId: null }),
                        proof_public_inputs: null,
                        transcript_hash: null,
                        onchain_commit_tx_hash: null,
                        verified_at: new Date().toISOString(),
                        resolved_at: null,
                        resolved_round_id: null,
                        updated_at: new Date().toISOString(),
                    },
                    { onConflict: "match_id,round_number,player_address" },
                );
        }

        const { data: commitsAfterAuto } = await supabase
            .from("round_private_commits")
            .select("player_address, encrypted_plan")
            .eq("match_id", matchId)
            .eq("round_number", roundNumber)
            .is("resolved_round_id", null);

        const committedPlayers = new Set((commitsAfterAuto || []).map((row: any) => row.player_address));
        const player1Committed = committedPlayers.has(match.player1_address);
        const player2Committed = committedPlayers.has(match.player2_address);
        const bothCommitted = player1Committed && player2Committed;

        await broadcastGameEvent(matchId, "round_plan_committed", {
            matchId,
            roundNumber,
            committedBy: address,
            player1Committed,
            player2Committed,
            bothCommitted,
        });

        if (bothCommitted) {
            await broadcastGameEvent(matchId, "round_plan_ready", {
                matchId,
                roundNumber,
            });

            console.log(`[ZK Round Commit] Both players committed match=${matchId} round=${roundNumber}`);
        }

        return Response.json({
            success: true,
            roundNumber,
            player1Committed,
            player2Committed,
            bothCommitted,
            zkVerification: {
                backend: verification.backend,
                command: verification.command,
            },
        });
    } catch (err) {
        console.error("[ZK Round Commit] Error:", err);
        return Response.json(
            { error: err instanceof Error ? err.message : "Failed to commit private round plan" },
            { status: 500 },
        );
    }
}

export async function handleResolvePrivateRound(matchId: string, req: Request): Promise<Response> {
    try {
        const guard = privateModeGuard();
        if (guard) return guard;

        const body = await req.json() as ResolvePrivateRoundBody;
        const address = body.address?.trim();
        const roundNumber = Number(body.roundNumber ?? 1);
        const proof = body.proof?.trim();

        console.log(
            `[ZK Round Resolve] Request match=${matchId} round=${roundNumber} player=${address?.slice(0, 6) || "n/a"}…${address?.slice(-4) || "n/a"}`,
        );

        if (!address || !Number.isInteger(roundNumber) || roundNumber < 1 || !proof) {
            return Response.json(
                { error: "Missing/invalid address, roundNumber, or proof" },
                { status: 400 },
            );
        }

        if (!body.move || !isValidMove(body.move)) {
            return Response.json(
                { error: "Missing or invalid move for private round reveal" },
                { status: 400 },
            );
        }

        if (body.surgeCardId && !isPowerSurgeCardId(body.surgeCardId)) {
            return Response.json({ error: "Invalid surgeCardId" }, { status: 400 });
        }

        const supabase = getSupabase();
        const { data: match, error: matchError } = await supabase
            .from("matches")
            .select("id, status, player1_address, player2_address")
            .eq("id", matchId)
            .single();

        if (matchError || !match) {
            return Response.json({ error: "Match not found" }, { status: 404 });
        }

        if (match.status !== "in_progress") {
            return Response.json(
                { error: `Match is not in progress (status: ${match.status})` },
                { status: 400 },
            );
        }

        const isPlayer1 = address === match.player1_address;
        const isPlayer2 = address === match.player2_address;
        if (!isPlayer1 && !isPlayer2) {
            return Response.json({ error: "Not a participant in this match" }, { status: 403 });
        }

        const opponentAddress = isPlayer1 ? match.player2_address : match.player1_address;

        const { data: preCommitStunSnapshot } = await supabase
            .from("fight_state_snapshots")
            .select("player1_is_stunned, player2_is_stunned")
            .eq("match_id", matchId)
            .maybeSingle();

        const opponentIsStunnedPreCommit = isPlayer1
            ? Boolean(preCommitStunSnapshot?.player2_is_stunned)
            : Boolean(preCommitStunSnapshot?.player1_is_stunned);

        const { data: stunSnapshot } = await supabase
            .from("fight_state_snapshots")
            .select("player1_is_stunned, player2_is_stunned")
            .eq("match_id", matchId)
            .maybeSingle();

        const submitterIsStunned = isPlayer1
            ? Boolean(stunSnapshot?.player1_is_stunned)
            : Boolean(stunSnapshot?.player2_is_stunned);
        const resolvedMove = submitterIsStunned ? "stunned" : body.move;

        const { data: commits } = await supabase
            .from("round_private_commits")
            .select("player_address, encrypted_plan")
            .eq("match_id", matchId)
            .eq("round_number", roundNumber)
            .is("resolved_round_id", null);

        const existingCommitters = new Set((commits || []).map((row: any) => row.player_address));
        if (opponentIsStunnedPreCommit && !existingCommitters.has(opponentAddress)) {
            await supabase
                .from("round_private_commits")
                .upsert(
                    {
                        match_id: matchId,
                        round_number: roundNumber,
                        player_address: opponentAddress,
                        commitment: `auto-stunned:${matchId}:${roundNumber}:${opponentAddress}`,
                        encrypted_plan: JSON.stringify({ move: "stunned", surgeCardId: null }),
                        proof_public_inputs: null,
                        transcript_hash: null,
                        onchain_commit_tx_hash: null,
                        verified_at: new Date().toISOString(),
                        resolved_at: null,
                        resolved_round_id: null,
                        updated_at: new Date().toISOString(),
                    },
                    { onConflict: "match_id,round_number,player_address" },
                );
        }

        const { data: commitsAfterAuto } = await supabase
            .from("round_private_commits")
            .select("player_address, encrypted_plan")
            .eq("match_id", matchId)
            .eq("round_number", roundNumber)
            .is("resolved_round_id", null);

        const committedPlayers = new Set((commitsAfterAuto || []).map((row: any) => row.player_address));
        if (!committedPlayers.has(match.player1_address) || !committedPlayers.has(match.player2_address)) {
            return Response.json(
                { error: "Cannot resolve: both players have not committed yet" },
                { status: 409 },
            );
        }

        const verification = await verifyNoirProof({
            proof,
            publicInputs: body.publicInputs,
            transcriptHash: body.transcriptHash,
            matchId,
            winnerAddress: body.expectedWinnerAddress?.trim() || address,
        });

        if (!verification.ok) {
            return Response.json({ error: "Round resolution proof verification failed" }, { status: 400 });
        }

        console.log(`[ZK Round Resolve] Proof verified match=${matchId} round=${roundNumber} backend=${verification.backend}`);

        const parseStoredPlan = (raw: unknown): { move?: MoveType; surgeCardId?: PowerSurgeCardId | null } => {
            if (!raw || typeof raw !== "string") return {};

            const parseJsonPlan = (jsonText: string) => {
                const parsed = JSON.parse(jsonText) as { move?: MoveType; surgeCardId?: PowerSurgeCardId | null };
                return {
                    move: parsed.move,
                    surgeCardId: parsed.surgeCardId,
                };
            };

            try {
                return parseJsonPlan(raw);
            } catch {
                try {
                    const decoded = Buffer.from(raw, "base64").toString("utf8");
                    return parseJsonPlan(decoded);
                } catch {
                    return {};
                }
            }
        };

        await supabase
            .from("round_private_commits")
            .update({
                encrypted_plan: JSON.stringify({
                    move: resolvedMove,
                    surgeCardId: body.surgeCardId || null,
                }),
                proof_public_inputs: body.publicInputs ?? null,
                transcript_hash: body.transcriptHash ?? null,
                updated_at: new Date().toISOString(),
            })
            .eq("match_id", matchId)
            .eq("round_number", roundNumber)
            .eq("player_address", address)
            .is("resolved_round_id", null);

        const { data: revealRows } = await supabase
            .from("round_private_commits")
            .select("player_address, encrypted_plan, resolved_at")
            .eq("match_id", matchId)
            .eq("round_number", roundNumber)
            .is("resolved_round_id", null);

        const parsePlan = (raw: unknown): { move?: MoveType; surgeCardId?: PowerSurgeCardId | null } => parseStoredPlan(raw);

        const byAddress = new Map<string, { move?: MoveType; surgeCardId?: PowerSurgeCardId | null }>();
        for (const row of revealRows || []) {
            byAddress.set(row.player_address, parsePlan((row as any).encrypted_plan));
        }

        const p1RawPlan = byAddress.get(match.player1_address) || {};
        const p2RawPlan = byAddress.get(match.player2_address) || {};

        const p1Move = (p1RawPlan.move && isValidMove(p1RawPlan.move))
            ? p1RawPlan.move
            : (stunSnapshot?.player1_is_stunned ? "stunned" : undefined);
        const p2Move = (p2RawPlan.move && isValidMove(p2RawPlan.move))
            ? p2RawPlan.move
            : (stunSnapshot?.player2_is_stunned ? "stunned" : undefined);

        const p1Plan = {
            ...p1RawPlan,
            move: p1Move,
        };
        const p2Plan = {
            ...p2RawPlan,
            move: p2Move,
        };

        const p1Revealed = !!(p1Plan.move && isValidMove(p1Plan.move));
        const p2Revealed = !!(p2Plan.move && isValidMove(p2Plan.move));
        const bothRevealed = p1Revealed && p2Revealed;

        await broadcastGameEvent(matchId, "round_plan_revealed", {
            matchId,
            roundNumber,
            revealedBy: address,
            player1Revealed: p1Revealed,
            player2Revealed: p2Revealed,
            bothRevealed,
        });

        if (!bothRevealed) {
            console.log(`[ZK Round Resolve] Waiting for opponent reveal match=${matchId} round=${roundNumber}`);
            return Response.json({
                success: true,
                roundNumber,
                awaitingOpponent: true,
                player1Revealed: p1Revealed,
                player2Revealed: p2Revealed,
                zkVerification: {
                    backend: verification.backend,
                    command: verification.command,
                },
            });
        }

        const resolveLockKey = `${matchId}:${roundNumber}`;
        if (privateRoundResolveLocks.has(resolveLockKey)) {
            console.log(`[ZK Round Resolve] Resolver lock active match=${matchId} round=${roundNumber}`);
            return Response.json({
                success: true,
                roundNumber,
                awaitingResolver: true,
                resolver: "in_progress",
                zkVerification: {
                    backend: verification.backend,
                    command: verification.command,
                },
            });
        }

        privateRoundResolveLocks.add(resolveLockKey);

        try {

            await supabase
                .from("power_surges")
                .upsert(
                    {
                        match_id: matchId,
                        round_number: roundNumber,
                        player1_card_id: p1Plan.surgeCardId || null,
                        player2_card_id: p2Plan.surgeCardId || null,
                        updated_at: new Date().toISOString(),
                    },
                    { onConflict: "match_id,round_number" },
                );

            const round = await getOrCreateRound(matchId, roundNumber);

            const p1FirstMove = p1Plan.move;
            const p2FirstMove = p2Plan.move;

            await supabase
                .from("rounds")
                .update({
                    player1_move: p1FirstMove,
                    player2_move: p2FirstMove,
                })
                .eq("id", round.id);

            await supabase
                .from("fight_state_snapshots")
                .update({
                    player1_has_submitted_move: true,
                    player2_has_submitted_move: true,
                    updated_at: new Date().toISOString(),
                })
                .eq("match_id", matchId);

            const resolution = await resolveTurn(matchId, round.id);

            console.log(
                `[ZK Round Resolve] Turn resolved match=${matchId} round=${roundNumber} turnId=${round.id} matchWinner=${resolution.matchWinner || "n/a"}`,
            );

            await supabase
                .from("round_private_commits")
                .update({
                    resolved_at: new Date().toISOString(),
                    resolved_round_id: round.id,
                    updated_at: new Date().toISOString(),
                })
                .eq("match_id", matchId)
                .eq("round_number", roundNumber)
                .is("resolved_round_id", null);

            return Response.json({
                success: true,
                roundNumber,
                resolution,
                zkVerification: {
                    backend: verification.backend,
                    command: verification.command,
                },
            });
        } finally {
            privateRoundResolveLocks.delete(resolveLockKey);
        }
    } catch (err) {
        console.error("[ZK Round Resolve] Error:", err);
        return Response.json(
            { error: err instanceof Error ? err.message : "Failed to resolve private round" },
            { status: 500 },
        );
    }
}