import type { ProvePrivateRoundPlanRequest, ProvePrivateRoundPlanResponse } from "./zkPrivateRoundClient";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "";
const ZK_API_BASE = import.meta.env.VITE_ZK_API_BASE_URL || API_BASE;

const DEFAULT_WASM_URL = `${ZK_API_BASE}/api/zk/artifacts/round-plan/round_plan.wasm`;
const DEFAULT_ZKEY_URL = `${ZK_API_BASE}/api/zk/artifacts/round-plan/round_plan_final.zkey`;

const ROUND_PLAN_WASM_URL = (import.meta.env.VITE_ZK_ROUND_PLAN_WASM_URL || DEFAULT_WASM_URL).trim();
const ROUND_PLAN_ZKEY_URL = (import.meta.env.VITE_ZK_ROUND_PLAN_ZKEY_URL || DEFAULT_ZKEY_URL).trim();

let worker: Worker | null = null;

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("../workers/zkRoundProver.worker.ts", import.meta.url), {
      type: "module",
      name: "zk-round-prover",
    });
  }
  return worker;
}

function makeRequestId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `zk-browser-${Date.now()}-${rand}`;
}

export async function provePrivateRoundPlanInBrowser(
  matchId: string,
  request: ProvePrivateRoundPlanRequest,
): Promise<ProvePrivateRoundPlanResponse> {
  if (!request.address?.trim()) {
    throw new Error("Missing address for browser proving");
  }

  const movePlan = Array.isArray(request.movePlan) ? request.movePlan : [];
  if (movePlan.length !== 10) {
    throw new Error("Missing/invalid movePlan (exactly 10 moves required)");
  }

  const instance = getWorker();
  const requestId = makeRequestId();

  return new Promise<ProvePrivateRoundPlanResponse>((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      instance.removeEventListener("message", onMessage);
      reject(new Error("Browser prover timed out"));
    }, 120000);

    const onMessage = (event: MessageEvent<any>) => {
      const message = event.data;
      if (!message || message.requestId !== requestId) return;

      clearTimeout(timeoutHandle);
      instance.removeEventListener("message", onMessage);

      if (message.type === "prove-round-plan:error") {
        reject(new Error(message.error || "Browser proving failed"));
        return;
      }

      if (message.type !== "prove-round-plan:ok") {
        reject(new Error("Unexpected browser prover response"));
        return;
      }

      resolve({
        success: true,
        commitment: String(message.payload.commitment),
        proof: String(message.payload.proof),
        publicInputs: String(message.payload.publicInputs),
        nonce: String(message.payload.nonce),
      });
    };

    instance.addEventListener("message", onMessage);

    instance.postMessage({
      type: "prove-round-plan",
      requestId,
      payload: {
        matchId,
        playerAddress: request.address,
        roundNumber: Number(request.roundNumber ?? 1),
        turnNumber: Number(request.turnNumber ?? 1),
        movePlan,
        surgeCardId: request.surgeCardId ?? null,
        nonce: request.nonce,
        wasmUrl: ROUND_PLAN_WASM_URL,
        zkeyUrl: ROUND_PLAN_ZKEY_URL,
      },
    });
  });
}
