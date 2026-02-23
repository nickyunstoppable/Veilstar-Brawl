const API_BASE = import.meta.env.VITE_API_BASE_URL || "";
const ZK_API_BASE = import.meta.env.VITE_ZK_API_BASE_URL || API_BASE;

const DEFAULT_WASM_URL = `${ZK_API_BASE}/api/zk/artifacts/betting-settle/betting_settle.wasm`;
const DEFAULT_ZKEY_URL = `${ZK_API_BASE}/api/zk/artifacts/betting-settle/betting_settle_final.zkey`;
const DEFAULT_VKEY_URL = `${ZK_API_BASE}/api/zk/artifacts/betting-settle/verification_key.json`;

const BETTING_WASM_URL = (import.meta.env.VITE_ZK_BETTING_SETTLE_WASM_URL || DEFAULT_WASM_URL).trim();
const BETTING_ZKEY_URL = (import.meta.env.VITE_ZK_BETTING_SETTLE_ZKEY_URL || DEFAULT_ZKEY_URL).trim();
const BETTING_VKEY_URL = (import.meta.env.VITE_ZK_BETTING_SETTLE_VKEY_URL || DEFAULT_VKEY_URL).trim();

let worker: Worker | null = null;

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("../workers/zkBettingSettleProver.worker.ts", import.meta.url), {
      type: "module",
      name: "zk-betting-settle-prover",
    });
  }
  return worker;
}

function makeRequestId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `zk-betting-browser-${Date.now()}-${rand}`;
}

export async function proveBettingSettlementInBrowser(params: {
  matchId: string;
  poolId: number;
  winner: "player1" | "player2";
}): Promise<{ proofBase64: string; publicInputsHex: string[]; vkIdHex: string }> {
  const instance = getWorker();
  const requestId = makeRequestId();

  return new Promise((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      instance.removeEventListener("message", onMessage);
      reject(new Error("Browser betting prover timed out"));
    }, 120000);

    const onMessage = (event: MessageEvent<any>) => {
      const message = event.data;
      if (!message || message.requestId !== requestId) return;

      clearTimeout(timeoutHandle);
      instance.removeEventListener("message", onMessage);

      if (message.type === "prove-betting-settle:error") {
        reject(new Error(message.error || "Browser betting proving failed"));
        return;
      }

      if (message.type !== "prove-betting-settle:ok") {
        reject(new Error("Unexpected browser betting prover response"));
        return;
      }

      resolve({
        proofBase64: String(message.payload.proofBase64),
        publicInputsHex: Array.isArray(message.payload.publicInputsHex)
          ? message.payload.publicInputsHex.map((value: unknown) => String(value))
          : [],
        vkIdHex: String(message.payload.vkIdHex),
      });
    };

    instance.addEventListener("message", onMessage);

    instance.postMessage({
      type: "prove-betting-settle",
      requestId,
      payload: {
        matchId: params.matchId,
        poolId: Number(params.poolId),
        winner: params.winner,
        wasmUrl: BETTING_WASM_URL,
        zkeyUrl: BETTING_ZKEY_URL,
        vkeyUrl: BETTING_VKEY_URL,
      },
    });
  });
}
