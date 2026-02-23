import { provePrivateRoundPlan } from "./zkPrivateRoundClient";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "";
const ZK_API_BASE = import.meta.env.VITE_ZK_API_BASE_URL || API_BASE;

type MoveType = "punch" | "kick" | "block" | "special" | "stunned";

interface FinalizePlanResponse {
  success: boolean;
  matchId: string;
  winnerAddress: string;
  roundNumber: number;
  turnNumber: number;
  movePlan: MoveType[];
  surgeCardId: string | null;
  transcriptHash: string;
}

interface FinalizeWithZkResponse {
  success: boolean;
  onChainTxHash?: string | null;
  onChainOutcomeTxHash?: string | null;
  onChainResultPending?: boolean;
  onChainResultError?: string | null;
  zkProofAccepted?: boolean;
  error?: string;
}

function isMoveType(value: unknown): value is MoveType {
  return value === "punch" || value === "kick" || value === "block" || value === "special" || value === "stunned";
}

function normalizeMovePlan(moves: unknown): MoveType[] {
  const filtered = Array.isArray(moves) ? moves.filter(isMoveType) : [];
  const out = filtered.slice(0, 10);
  while (out.length < 10) out.push("block");
  return out;
}

export async function proveAndFinalizeMatchInBrowser(params: {
  matchId: string;
  winnerAddress: string;
}): Promise<FinalizeWithZkResponse> {
  const planRes = await fetch(
    `${ZK_API_BASE}/api/matches/${params.matchId}/zk/finalize-plan?winnerAddress=${encodeURIComponent(params.winnerAddress)}`,
    {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    },
  );
  console.log("[BrowserFinalizeClient] start", {
    matchId: params.matchId,
    winnerAddress: params.winnerAddress,
    apiBase: ZK_API_BASE,
  });

  const planJson = (await planRes.json().catch(() => ({}))) as FinalizePlanResponse & { error?: string };
  console.log("[BrowserFinalizeClient] finalize-plan response", {
    matchId: params.matchId,
    status: planRes.status,
    ok: planRes.ok,
    error: planJson?.error,
  });
  if (!planRes.ok || !planJson?.success) {
    throw new Error(planJson?.error || `Failed to fetch finalize plan (${planRes.status})`);
  }

  const movePlan = normalizeMovePlan(planJson.movePlan);
  const proveRes = await provePrivateRoundPlan(params.matchId, {
    address: planJson.winnerAddress,
    roundNumber: Number(planJson.roundNumber || 1),
    turnNumber: Number(planJson.turnNumber || 1),
    move: movePlan[0] || "block",
    movePlan,
    surgeCardId: planJson.surgeCardId,
  });

  const finalizeRes = await fetch(`${ZK_API_BASE}/api/matches/${params.matchId}/zk/finalize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      winnerAddress: planJson.winnerAddress,
      proof: proveRes.proof,
      publicInputs: proveRes.publicInputs,
      transcriptHash: planJson.transcriptHash,
      broadcast: false,
    }),
  });

  const finalizeJson = (await finalizeRes.json().catch(() => ({}))) as FinalizeWithZkResponse;
  console.log("[BrowserFinalizeClient] finalize response", {
    matchId: params.matchId,
    status: finalizeRes.status,
    ok: finalizeRes.ok,
    error: (finalizeJson as any)?.error,
    onChainResultPending: finalizeJson?.onChainResultPending,
    onChainTxHash: finalizeJson?.onChainTxHash || finalizeJson?.onChainOutcomeTxHash || null,
  });
  if (!finalizeRes.ok) {
    throw new Error(finalizeJson?.error || `Failed to finalize with browser proof (${finalizeRes.status})`);
  }

  return finalizeJson;
}
