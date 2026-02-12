import { getSupabase } from "../../lib/supabase";
import { proveAndFinalizeMatch } from "../../lib/zk-finalizer-client";

interface ProveFinalizeBody {
    winnerAddress?: string;
}

export async function handleProveAndFinalize(matchId: string, req: Request): Promise<Response> {
    try {
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

        const result = await proveAndFinalizeMatch({
            matchId,
            winnerAddress,
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
