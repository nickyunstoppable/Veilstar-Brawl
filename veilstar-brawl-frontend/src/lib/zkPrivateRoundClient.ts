const API_BASE = import.meta.env.VITE_API_BASE_URL || "";
const ZK_API_BASE = import.meta.env.VITE_ZK_API_BASE_URL || API_BASE;

export interface CommitPrivateRoundPlanRequest {
    address: string;
    roundNumber: number;
    turnNumber: number;
    commitment: string;
    proof: string;
    publicInputs?: unknown;
    transcriptHash?: string;
    encryptedPlan?: string;
    onChainCommitTxHash?: string;
}

export interface ResolvePrivateRoundRequest {
    address: string;
    roundNumber: number;
    turnNumber: number;
    move: "punch" | "kick" | "block" | "special" | "stunned";
    surgeCardId?: string | null;
    proof: string;
    publicInputs?: unknown;
    transcriptHash?: string;
    expectedWinnerAddress?: string;
}

export interface ProvePrivateRoundPlanRequest {
    address: string;
    roundNumber: number;
    turnNumber: number;
    move: "punch" | "kick" | "block" | "special" | "stunned";
    surgeCardId: string;
    nonce?: string;
}

export interface ProvePrivateRoundPlanResponse {
    success: boolean;
    commitment: string;
    proof: string;
    publicInputs: string;
    nonce: string;
}

async function parseJson<T>(response: Response): Promise<T> {
    return response.json().catch(() => ({} as T));
}

export async function commitPrivateRoundPlan(
    matchId: string,
    request: CommitPrivateRoundPlanRequest,
): Promise<any> {
    const response = await fetch(`${ZK_API_BASE}/api/matches/${matchId}/zk/round/commit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
    });

    const json = await parseJson<any>(response);
    if (!response.ok) {
        throw new Error(json?.error || `Failed to commit private round plan (${response.status})`);
    }
    return json;
}

export async function resolvePrivateRound(
    matchId: string,
    request: ResolvePrivateRoundRequest,
): Promise<any> {
    const response = await fetch(`${ZK_API_BASE}/api/matches/${matchId}/zk/round/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
    });

    const json = await parseJson<any>(response);
    if (!response.ok) {
        throw new Error(json?.error || `Failed to resolve private round (${response.status})`);
    }
    return json;
}

export async function provePrivateRoundPlan(
    matchId: string,
    request: ProvePrivateRoundPlanRequest,
): Promise<ProvePrivateRoundPlanResponse> {
    const response = await fetch(`${ZK_API_BASE}/api/matches/${matchId}/zk/round/prove`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
    });

    const json = await parseJson<ProvePrivateRoundPlanResponse & { error?: string }>(response);
    if (!response.ok) {
        throw new Error(json?.error || `Failed to prove private round plan (${response.status})`);
    }
    return json;
}