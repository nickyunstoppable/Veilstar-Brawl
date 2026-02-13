import { getSupabase } from "../../lib/supabase";
import { proveAndFinalizeMatch } from "../../lib/zk-finalizer-client";

interface ProveFinalizeBody {
    winnerAddress?: string;
}

export async function handleProveAndFinalize(matchId: string, req: Request): Promise<Response> {
    try {
        console.log(`[ZK Prove+Finalize] Request received for match ${matchId}`);
        const body = await req.json() as ProveFinalizeBody;

        let winnerAddress = body.winnerAddress?.trim();
        if (!winnerAddress) {
            const supabase = getSupabase();
            const { data: match, error } = await supabase
                .from("matches")
                .select("winner_address")
                .eq("id", matchId)
                .single();

            if (error || !match) {
                return Response.json({ error: "Match not found" }, { status: 404 });
            }

            winnerAddress = match.winner_address || undefined;
        }

        if (!winnerAddress) {
            return Response.json(
                { error: "winnerAddress required (or match must already have winner_address)" },
                { status: 400 },
            );
        }

        console.log(`[ZK Prove+Finalize] Starting proof/finalize for match ${matchId} winner ${winnerAddress}`);
        const result = await proveAndFinalizeMatch({
            matchId,
            winnerAddress,
            allowRemoteDelegation: false,
        });

        console.log(`[ZK Prove+Finalize] Completed for match ${matchId}`, {
            success: result.success,
            proofCommand: result.proofCommand,
        });

        return Response.json(result);
    } catch (err) {
        console.error("[ZK Prove+Finalize] Error:", err);
        return Response.json(
            { error: err instanceof Error ? err.message : "Failed to prove and finalize" },
            { status: 500 },
        );
    }
}
