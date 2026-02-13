import type { MoveType } from "../../lib/game-types";
import { isPowerSurgeCardId } from "../../lib/power-surge";
import { provePrivateRoundPlan } from "../../lib/zk-round-prover";

const PRIVATE_ROUNDS_ENABLED = (process.env.ZK_PRIVATE_ROUNDS ?? "false") === "true";

interface ProveRoundBody {
    address?: string;
    roundNumber?: number;
    move?: MoveType;
    surgeCardId?: string;
    plannedMoves?: MoveType[];
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

        if (!address || !Number.isInteger(roundNumber) || roundNumber < 1) {
            return Response.json({ error: "Missing/invalid address or roundNumber" }, { status: 400 });
        }

        if (!isMoveType(body.move)) {
            return Response.json({ error: "Missing/invalid move" }, { status: 400 });
        }

        if (!isPowerSurgeCardId(body.surgeCardId)) {
            return Response.json({ error: "Missing/invalid surgeCardId" }, { status: 400 });
        }

        const plannedMoves = Array.isArray(body.plannedMoves)
            ? body.plannedMoves.filter(isMoveType).slice(0, 10)
            : undefined;

        const proof = await provePrivateRoundPlan({
            matchId,
            playerAddress: address,
            roundNumber,
            move: body.move,
            surgeCardId: body.surgeCardId,
            plannedMoves,
            nonce: body.nonce,
        });

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
