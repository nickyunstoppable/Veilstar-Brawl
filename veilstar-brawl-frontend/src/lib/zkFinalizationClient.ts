const API_BASE = import.meta.env.VITE_API_BASE_URL || "";

export interface ProveFinalizeResponse {
    success: boolean;
    proofCommand?: string;
    finalizeResponse?: unknown;
    error?: string;
}

export async function proveAndFinalizeMatchClient(
    matchId: string,
    winnerAddress: string,
): Promise<ProveFinalizeResponse> {
    const response = await fetch(`${API_BASE}/api/matches/${matchId}/zk/prove-finalize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ winnerAddress }),
    });

    const json = await response.json().catch(() => ({})) as ProveFinalizeResponse;
    if (!response.ok) {
        throw new Error(json.error || `ZK prove+finalize failed (${response.status})`);
    }

    return json;
}
