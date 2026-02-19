/**
 * Public Match Details
 * GET /api/matches/:matchId/public
 *
 * Returns a match summary intended for the public match page (/m/:matchId)
 * including a transaction-like timeline and ZK artifacts (commitments/proofs).
 */

import { getSupabase } from "../../lib/supabase";

const NO_STORE_HEADERS: Record<string, string> = {
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
    Pragma: "no-cache",
    Expires: "0",
};

export interface TransactionData {
    txId: string;
    moveType: string;
    playerAddress: string;
    roundNumber: number;
    confirmedAt: string | null;
    createdAt: string;
}

export async function handleGetMatchPublic(matchId: string): Promise<Response> {
    try {
        const supabase = getSupabase();

        const { data: match, error: matchError } = await supabase
            .from("matches")
            .select("*")
            .eq("id", matchId)
            .single();

        if (matchError || !match) {
            return Response.json({ error: "Match not found" }, { status: 404, headers: NO_STORE_HEADERS });
        }

        const [{ data: rounds }, { data: privateCommits }] = await Promise.all([
            supabase
                .from("rounds")
                .select("*")
                .eq("match_id", matchId)
                .order("round_number", { ascending: true })
                .order("turn_number", { ascending: true }),
            supabase
                .from("round_private_commits")
                .select("match_id,round_number,player_address,commitment,transcript_hash,proof_public_inputs,onchain_commit_tx_hash,verified_at,resolved_at,created_at")
                .eq("match_id", matchId)
                .order("round_number", { ascending: true })
                .order("created_at", { ascending: true }),
        ]);

        const transactions: TransactionData[] = [];

        // Lifecycle: start_game (registration)
        if (match.onchain_tx_hash) {
            transactions.push({
                txId: match.onchain_tx_hash,
                moveType: "start_game",
                playerAddress: match.player1_address,
                roundNumber: 0,
                confirmedAt: match.started_at ?? null,
                createdAt: match.started_at ?? match.created_at,
            });
        }

        // Stakes
        if (match.player1_stake_tx_id) {
            transactions.push({
                txId: match.player1_stake_tx_id,
                moveType: "stake",
                playerAddress: match.player1_address,
                roundNumber: 0,
                confirmedAt: match.player1_stake_confirmed_at ?? null,
                createdAt: match.started_at ?? match.created_at,
            });
        }
        if (match.player2_stake_tx_id && match.player2_address) {
            transactions.push({
                txId: match.player2_stake_tx_id,
                moveType: "stake",
                playerAddress: match.player2_address,
                roundNumber: 0,
                confirmedAt: match.player2_stake_confirmed_at ?? null,
                createdAt: match.started_at ?? match.created_at,
            });
        }

        // ZK private round commits (on-chain)
        for (const commit of privateCommits || []) {
            if (!commit.onchain_commit_tx_hash) continue;
            transactions.push({
                txId: commit.onchain_commit_tx_hash,
                moveType: `zk_commit:r${commit.round_number}`,
                playerAddress: commit.player_address,
                roundNumber: commit.round_number,
                confirmedAt: commit.verified_at ?? null,
                createdAt: commit.created_at,
            });
        }

        // Lifecycle: end_game (finalize) if present
        if (match.onchain_result_tx_hash) {
            transactions.push({
                txId: match.onchain_result_tx_hash,
                moveType: "end_game",
                playerAddress: match.winner_address ?? match.player1_address,
                roundNumber: (match.player1_rounds_won || 0) + (match.player2_rounds_won || 0),
                confirmedAt: match.completed_at ?? null,
                createdAt: match.completed_at ?? match.updated_at ?? match.created_at,
            });
        }

        // ZK match outcome proof tx (submit_zk_match_outcome) if persisted
        if ((match as any).onchain_outcome_tx_hash) {
            transactions.push({
                txId: (match as any).onchain_outcome_tx_hash,
                moveType: "zk_match_outcome",
                playerAddress: match.winner_address ?? match.player1_address,
                roundNumber: (match.player1_rounds_won || 0) + (match.player2_rounds_won || 0),
                confirmedAt: match.completed_at ?? null,
                createdAt: match.completed_at ?? match.updated_at ?? match.created_at,
            });
        }

        // Sort by createdAt (fallback to lexical ISO ordering)
        transactions.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

        const zkSummary = {
            privateCommits: privateCommits || [],
            counts: {
                total: (privateCommits || []).length,
                verified: (privateCommits || []).filter((c: any) => Boolean(c.verified_at)).length,
                onChain: (privateCommits || []).filter((c: any) => Boolean(c.onchain_commit_tx_hash)).length,
            },
        };

        return Response.json(
            {
                match,
                rounds: rounds || [],
                transactions,
                zk: zkSummary,
            },
            { headers: NO_STORE_HEADERS },
        );
    } catch (err) {
        console.error("[Match Public GET] Error:", err);
        return Response.json({ error: "Failed to get match" }, { status: 500, headers: NO_STORE_HEADERS });
    }
}
