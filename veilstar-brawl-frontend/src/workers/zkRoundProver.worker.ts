/// <reference lib="webworker" />

import { Buffer } from "buffer";
import process from "process";

const workerGlobal = globalThis as typeof globalThis & {
  Buffer?: typeof Buffer;
  process?: typeof process;
};

if (!workerGlobal.Buffer) {
  workerGlobal.Buffer = Buffer;
}

if (!workerGlobal.process) {
  workerGlobal.process = process;
}

type MoveType = "punch" | "kick" | "block" | "special" | "stunned";
type PublicMoveType = "punch" | "kick" | "block" | "special";

type WorkerRequest = {
  type: "prove-round-plan";
  requestId: string;
  payload: {
    matchId: string;
    playerAddress: string;
    roundNumber: number;
    turnNumber: number;
    movePlan: MoveType[];
    surgeCardId?: string | null;
    nonce?: string;
    wasmUrl: string;
    zkeyUrl: string;
  };
};

type WorkerSuccess = {
  type: "prove-round-plan:ok";
  requestId: string;
  payload: {
    commitment: string;
    proof: string;
    publicInputs: string;
    nonce: string;
  };
};

type WorkerError = {
  type: "prove-round-plan:error";
  requestId: string;
  error: string;
};

const BN254_FIELD_PRIME = BigInt("21888242871839275222246405745257275088548364400416034343698204186575808495617");

const MOVE_TO_CODE: Record<MoveType, number> = {
  stunned: 0,
  punch: 1,
  kick: 2,
  block: 3,
  special: 4,
};

const POWER_SURGE_CARD_IDS = [
  "dag-overclock",
  "block-fortress",
  "tx-storm",
  "mempool-congest",
  "blue-set-heal",
  "orphan-smasher",
  "10bps-barrage",
  "pruned-rage",
  "sompi-shield",
  "hash-hurricane",
  "ghost-dag",
  "finality-fist",
  "bps-blitz",
  "chainbreaker",
  "vaultbreaker",
] as const;

const SURGE_ID_ALIASES: Record<string, (typeof POWER_SURGE_CARD_IDS)[number]> = {
  dag_overclock: "dag-overclock",
  block_fortress: "block-fortress",
  tx_tempo: "tx-storm",
  mempool_mirror: "mempool-congest",
  blue_set_heal: "blue-set-heal",
  orphan_smasher: "orphan-smasher",
  tenbps_barrage: "10bps-barrage",
  pruned_rage: "pruned-rage",
  sompi_shield: "sompi-shield",
  hash_hurricane: "hash-hurricane",
  ghost_dag: "ghost-dag",
  finality_fist: "finality-fist",
  bps_blitz: "bps-blitz",
};

let poseidonPromise: Promise<any> | null = null;
let groth16Promise: Promise<typeof import("snarkjs")["groth16"]> | null = null;

async function getGroth16(): Promise<typeof import("snarkjs")["groth16"]> {
  if (!groth16Promise) {
    groth16Promise = import("snarkjs").then((mod) => mod.groth16);
  }
  return groth16Promise;
}

async function getPoseidon(): Promise<any> {
  if (!poseidonPromise) {
    poseidonPromise = import("circomlibjs").then((mod) => mod.buildPoseidon());
  }
  return poseidonPromise;
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const digestBytes = new Uint8Array(digest);
  return Array.from(digestBytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function toFieldDecimal(input: string): Promise<bigint> {
  const digestHex = await sha256Hex(input);
  return BigInt(`0x${digestHex}`) % BN254_FIELD_PRIME;
}

function normalizeHex32(input: bigint): string {
  if (input < 0n) throw new Error("Negative field element is not supported");
  const hex = input.toString(16).padStart(64, "0");
  return `0x${hex}`;
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

function randomFieldNonceDecimal(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  const asBigint = BigInt(`0x${hex}`) % BN254_FIELD_PRIME;
  return asBigint.toString(10);
}

function toSurgeCode(cardId?: string | null): number {
  if (!cardId) return 0;
  const normalized = SURGE_ID_ALIASES[cardId] || cardId;
  const index = POWER_SURGE_CARD_IDS.indexOf(normalized as (typeof POWER_SURGE_CARD_IDS)[number]);
  if (index < 0) return 0;
  return index + 1;
}

async function computeCommitmentDecimal(preimage: bigint[]): Promise<bigint> {
  const poseidon = await getPoseidon();
  const out = poseidon(preimage);
  return poseidon.F.toObject(out);
}

function ensureMovePlan(movePlan: MoveType[]): PublicMoveType[] {
  const normalized = movePlan.filter((move): move is PublicMoveType => (
    move === "punch" || move === "kick" || move === "block" || move === "special"
  ));

  if (normalized.length !== 10) {
    throw new Error("movePlan must include exactly 10 valid moves");
  }

  return normalized;
}

async function handleProveRoundPlan(message: WorkerRequest): Promise<WorkerSuccess> {
  const payload = message.payload;
  const movePlan = ensureMovePlan(payload.movePlan);
  const nonceDecimal = payload.nonce?.trim() ? payload.nonce.trim() : randomFieldNonceDecimal();

  const matchIdField = await toFieldDecimal(payload.matchId);
  const playerField = await toFieldDecimal(payload.playerAddress);
  const surgeCode = BigInt(toSurgeCode(payload.surgeCardId));
  const moveCodes = movePlan.map((move) => BigInt(MOVE_TO_CODE[move]));

  const commitmentDecimal = await computeCommitmentDecimal([
    matchIdField,
    BigInt(payload.roundNumber),
    BigInt(payload.turnNumber),
    playerField,
    surgeCode,
    BigInt(nonceDecimal),
    ...moveCodes,
  ]);

  const input = {
    commitment: commitmentDecimal.toString(10),
    match_id: matchIdField.toString(10),
    round_number: String(payload.roundNumber),
    turn_number: String(payload.turnNumber),
    player_address: playerField.toString(10),
    surge_card: surgeCode.toString(10),
    nonce: nonceDecimal,
    moves: moveCodes.map((code) => code.toString(10)),
  };

  const groth16 = await getGroth16();
  const proveResult = await groth16.fullProve(input, payload.wasmUrl, payload.zkeyUrl);
  const proofBytes = serializeGroth16ProofToCalldataBytes((proveResult as any).proof);

  const publicSignals: unknown[] = Array.isArray((proveResult as any).publicSignals)
    ? (proveResult as any).publicSignals
    : [];

  if (publicSignals.length < 1) {
    throw new Error("Groth16 publicSignals are missing commitment");
  }

  return {
    type: "prove-round-plan:ok",
    requestId: message.requestId,
    payload: {
      commitment: normalizeHex32(BigInt(String(publicSignals[0]))),
      proof: `base64:${toBase64(proofBytes)}`,
      publicInputs: JSON.stringify(publicSignals),
      nonce: nonceDecimal,
    },
  };
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  if (!message || message.type !== "prove-round-plan") return;

  try {
    const ok = await handleProveRoundPlan(message);
    self.postMessage(ok);
  } catch (err) {
    const response: WorkerError = {
      type: "prove-round-plan:error",
      requestId: message.requestId,
      error: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(response);
  }
};

export {};
