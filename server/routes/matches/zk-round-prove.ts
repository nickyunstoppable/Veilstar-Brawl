import type { MoveType } from "../../lib/game-types";
import { isPowerSurgeCardId } from "../../lib/power-surge";
import { provePrivateRoundPlan } from "../../lib/zk-round-prover";

const PRIVATE_ROUNDS_ENABLED = (process.env.ZK_PRIVATE_ROUNDS ?? "true") !== "false";

interface ProveRoundBody {
    address?: string;
    roundNumber?: number;
    turnNumber?: number;
    move?: MoveType;
    surgeCardId?: string | null;
    nonce?: string;
}

function isMoveType(value: unknown): value is MoveType {
    return value === "punch" || value === "kick" || value === "block" || value === "special" || value === "stunned";
}

export async function handleProvePrivateRoundPlan(matchId: string, req: Request): Promise<Response> {
    try {
        if (!PRIVATE_ROUNDS_ENABLED) {
            return Response.json(
                { error: "ZK private round mode is disabled (set ZK_PRIVATE_ROUNDS=true)" },
                { status: 409 },
            );
        }

        const body = await req.json() as ProveRoundBody;
        const address = body.address?.trim();
        const roundNumber = Number(body.roundNumber ?? 1);
        const turnNumber = Number(body.turnNumber ?? 1);

        console.log(
            `[ZK Round Prove] Request match=${matchId} round=${roundNumber} turn=${turnNumber} player=${address?.slice(0, 6) || "n/a"}…${address?.slice(-4) || "n/a"}`,
        );

        if (!address || !Number.isInteger(roundNumber) || roundNumber < 1 || !Number.isInteger(turnNumber) || turnNumber < 1) {
            return Response.json({ error: "Missing/invalid address, roundNumber, or turnNumber" }, { status: 400 });
        }

        if (!isMoveType(body.move)) {
            return Response.json({ error: "Missing/invalid move" }, { status: 400 });
        }

        if (body.surgeCardId != null && !isPowerSurgeCardId(body.surgeCardId)) {
            return Response.json({ error: "Missing/invalid surgeCardId" }, { status: 400 });
        }

        const proof = await provePrivateRoundPlan({
            matchId,
            playerAddress: address,
            roundNumber,
            turnNumber,
            move: body.move,
            surgeCardId: body.surgeCardId ?? null,
            nonce: body.nonce,
        });

        console.log(
            `[ZK Round Prove] Proof generated match=${matchId} round=${roundNumber} turn=${turnNumber} prover=${JSON.stringify(proof.prover)}`,
        );

        return Response.json({
            success: true,
            roundNumber,
            commitment: proof.commitment,
            proof: proof.proof,
            publicInputs: proof.publicInputs,
            nonce: proof.nonce,
            prover: proof.prover,
        });
    } catch (err) {
        console.error("[ZK Round Prove] Error:", err);
        return Response.json(
            { error: err instanceof Error ? err.message : "Failed to prove private round plan" },
            { status: 500 },
        );
    }
}
