/// <reference lib="webworker" />

type WinnerSide = "player1" | "player2";

type WorkerRequest = {
  type: "prove-betting-settle";
  requestId: string;
  payload: {
    matchId: string;
    poolId: number;
    winner: WinnerSide;
    wasmUrl: string;
    zkeyUrl: string;
    vkeyUrl: string;
  };
};

type WorkerSuccess = {
  type: "prove-betting-settle:ok";
  requestId: string;
  payload: {
    proofBase64: string;
    publicInputsHex: string[];
    vkIdHex: string;
  };
};

type WorkerError = {
  type: "prove-betting-settle:error";
  requestId: string;
  error: string;
};

const BN254_FIELD_PRIME = BigInt("21888242871839275222246405745257275088548364400416034343698204186575808495617");

let groth16Promise: Promise<typeof import("snarkjs")["groth16"]> | null = null;

async function getGroth16(): Promise<typeof import("snarkjs")["groth16"]> {
  if (!groth16Promise) {
    groth16Promise = import("snarkjs").then((mod) => mod.groth16);
  }
  return groth16Promise;
}

async function sha256Bytes(input: Uint8Array): Promise<Uint8Array> {
  const bytes = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(digest);
}

async function sha256HexFromString(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await sha256Bytes(bytes);
  return Array.from(digest).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toFieldFromSha256Hex(hex: string): bigint {
  return BigInt(`0x${hex}`) % BN254_FIELD_PRIME;
}

async function matchIdToFieldDecimal(matchId: string): Promise<string> {
  const hashHex = await sha256HexFromString(matchId);
  return toFieldFromSha256Hex(hashHex).toString(10);
}

function toBytes32(value: bigint | string): Uint8Array {
  const bigint = typeof value === "bigint" ? value : BigInt(value);
  if (bigint < 0n) throw new Error("Negative field element is not supported");
  const hex = bigint.toString(16).padStart(64, "0");
  const out = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function serializeGroth16ProofToCalldataBytes(proof: any): Uint8Array {
  if (!proof?.pi_a || !proof?.pi_b || !proof?.pi_c) {
    throw new Error("Invalid Groth16 proof JSON shape");
  }

  const a = [
    toBytes32(proof.pi_a[0]),
    toBytes32(proof.pi_a[1]),
  ];

  const b = [
    toBytes32(proof.pi_b[0][1]),
    toBytes32(proof.pi_b[0][0]),
    toBytes32(proof.pi_b[1][1]),
    toBytes32(proof.pi_b[1][0]),
  ];

  const c = [
    toBytes32(proof.pi_c[0]),
    toBytes32(proof.pi_c[1]),
  ];

  const calldata = concatBytes([...a, ...b, ...c]);
  if (calldata.length !== 256) {
    throw new Error(`Serialized Groth16 calldata must be 256 bytes, got ${calldata.length}`);
  }

  return calldata;
}

async function fetchVkIdHex(vkeyUrl: string): Promise<string> {
  const response = await fetch(vkeyUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch verification key (${response.status})`);
  }
  const text = await response.text();
  const bytes = new TextEncoder().encode(text);
  const digest = await sha256Bytes(bytes);
  return `0x${bytesToHex(digest)}`;
}

async function handleProveBettingSettle(message: WorkerRequest): Promise<WorkerSuccess> {
  const winnerSide = message.payload.winner === "player1" ? 0 : 1;
  const matchIdField = await matchIdToFieldDecimal(message.payload.matchId);

  const input = {
    match_id: matchIdField,
    pool_id: String(message.payload.poolId >>> 0),
    winner_side: String(winnerSide),
    witness_match_id: matchIdField,
    witness_pool_id: String(message.payload.poolId >>> 0),
    witness_winner_side: String(winnerSide),
  };

  const groth16 = await getGroth16();
  const proveResult = await groth16.fullProve(input, message.payload.wasmUrl, message.payload.zkeyUrl);
  const proofBytes = serializeGroth16ProofToCalldataBytes((proveResult as any).proof);

  const publicSignals: unknown[] = Array.isArray((proveResult as any).publicSignals)
    ? (proveResult as any).publicSignals
    : [];

  if (publicSignals.length < 3) {
    throw new Error("Groth16 publicSignals are missing betting settle outputs");
  }

  const publicInputsHex = [0, 1, 2].map((index) => `0x${bytesToHex(toBytes32(String(publicSignals[index])) )}`);
  const vkIdHex = await fetchVkIdHex(message.payload.vkeyUrl);

  return {
    type: "prove-betting-settle:ok",
    requestId: message.requestId,
    payload: {
      proofBase64: toBase64(proofBytes),
      publicInputsHex,
      vkIdHex,
    },
  };
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  if (!message || message.type !== "prove-betting-settle") return;

  try {
    const ok = await handleProveBettingSettle(message);
    self.postMessage(ok);
  } catch (err) {
    const response: WorkerError = {
      type: "prove-betting-settle:error",
      requestId: message.requestId,
      error: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(response);
  }
};

export {};
