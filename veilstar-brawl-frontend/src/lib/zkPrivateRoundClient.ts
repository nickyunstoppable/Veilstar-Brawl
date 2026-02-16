const API_BASE = import.meta.env.VITE_API_BASE_URL || "";
const ZK_API_BASE = import.meta.env.VITE_ZK_API_BASE_URL || API_BASE;
const ZK_COMMIT_FETCH_TIMEOUT_MS = Number(import.meta.env.VITE_ZK_COMMIT_FETCH_TIMEOUT_MS || "45000");

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(input, {
            ...init,
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timeoutHandle);
    }
}

export interface CommitPrivateRoundPlanRequest {
    clientTraceId?: string;
    address: string;
    roundNumber: number;
    turnNumber: number;
    commitment: string;
    proof: string;
    publicInputs?: unknown;
    transcriptHash?: string;
    encryptedPlan?: string;
    onChainCommitTxHash?: string;
    signedAuthEntryXdr?: string;
    transactionXdr?: string;
}

export interface PreparePrivateRoundCommitRequest {
    clientTraceId?: string;
    address: string;
    roundNumber: number;
    turnNumber: number;
    commitment: string;
}

export interface PreparePrivateRoundCommitResponse {
    success: boolean;
    sessionId: number;
    authEntryXdr: string;
    transactionXdr: string;
}

export interface ResolvePrivateRoundRequest {
    address: string;
    roundNumber: number;
    turnNumber: number;
    move: "punch" | "kick" | "block" | "special" | "stunned";
    movePlan?: Array<"punch" | "kick" | "block" | "special" | "stunned">;
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
    movePlan?: Array<"punch" | "kick" | "block" | "special" | "stunned">;
    surgeCardId?: string | null;
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
    console.info("[zkPrivateRoundClient] commit:start", {
        matchId,
        clientTraceId: request.clientTraceId,
        roundNumber: request.roundNumber,
        turnNumber: request.turnNumber,
        player: `${request.address?.slice(0, 6)}…${request.address?.slice(-4)}`,
        hasSignedAuth: Boolean(request.signedAuthEntryXdr),
        hasTxXdr: Boolean(request.transactionXdr),
    });

    let response: Response;
    try {
        response = await fetchWithTimeout(
            `${ZK_API_BASE}/api/matches/${matchId}/zk/round/commit`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(request),
            },
            ZK_COMMIT_FETCH_TIMEOUT_MS,
        );
    } catch (error) {
        const isTimeout = error instanceof DOMException && error.name === "AbortError";
        const hasSignedPayload = Boolean(request.signedAuthEntryXdr || request.transactionXdr);

        // IMPORTANT: once an auth entry is signed, it contains a Soroban auth nonce.
        // Retrying the exact same payload can fail with "nonce already exists for address".
        // Let the caller re-run /commit/prepare to get a fresh auth nonce instead.
        if (isTimeout && hasSignedPayload) {
            throw new Error(
                `Private round commit request timed out after ${ZK_COMMIT_FETCH_TIMEOUT_MS}ms. ` +
                    "Do not retry with the same signedAuthEntryXdr/transactionXdr; re-prepare and re-sign to get a fresh auth nonce.",
            );
        }

        if (isTimeout) {
            console.warn("[zkPrivateRoundClient] commit:timeout, retrying once", {
                matchId,
                clientTraceId: request.clientTraceId,
                timeoutMs: ZK_COMMIT_FETCH_TIMEOUT_MS,
            });

            response = await fetchWithTimeout(
                `${ZK_API_BASE}/api/matches/${matchId}/zk/round/commit`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(request),
                },
                ZK_COMMIT_FETCH_TIMEOUT_MS,
            );
        } else {
            throw error;
        }
    }

    const json = await parseJson<any>(response);
    console.info("[zkPrivateRoundClient] commit:response", {
        matchId,
        clientTraceId: request.clientTraceId,
        ok: response.ok,
        status: response.status,
        bothCommitted: Boolean(json?.bothCommitted),
        player1Committed: Boolean(json?.player1Committed),
        player2Committed: Boolean(json?.player2Committed),
        onChainCommitTxHash: json?.onChainCommitTxHash || null,
        onChainVerificationTxHash: json?.onChainVerificationTxHash || null,
        error: json?.error || null,
        details: json?.details || null,
    });

    if (!response.ok) {
        const detail = json?.details ? `: ${json.details}` : "";
        throw new Error((json?.error || `Failed to commit private round plan (${response.status})`) + detail);
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

export async function preparePrivateRoundCommit(
    matchId: string,
    request: PreparePrivateRoundCommitRequest,
): Promise<PreparePrivateRoundCommitResponse> {
    console.info("[zkPrivateRoundClient] prepare:start", {
        matchId,
        clientTraceId: request.clientTraceId,
        roundNumber: request.roundNumber,
        turnNumber: request.turnNumber,
        player: `${request.address?.slice(0, 6)}…${request.address?.slice(-4)}`,
    });

    const response = await fetchWithTimeout(
        `${ZK_API_BASE}/api/matches/${matchId}/zk/round/commit/prepare`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(request),
        },
        ZK_COMMIT_FETCH_TIMEOUT_MS,
    );

    const json = await parseJson<PreparePrivateRoundCommitResponse & { error?: string }>(response);
    console.info("[zkPrivateRoundClient] prepare:response", {
        matchId,
        clientTraceId: request.clientTraceId,
        ok: response.ok,
        status: response.status,
        sessionId: json?.sessionId,
        hasAuthEntryXdr: Boolean(json?.authEntryXdr),
        hasTransactionXdr: Boolean(json?.transactionXdr),
        error: json?.error || null,
    });

    if (!response.ok) {
        throw new Error(json?.error || `Failed to prepare private round commit (${response.status})`);
    }
    return json;
}