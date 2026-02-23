import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const BN254_FIELD_PRIME = BigInt("21888242871839275222246405745257275088548364400416034343698204186575808495617");

type WinnerSide = "player1" | "player2";

const BETTING_SETTLE_CIRCUIT_DIR = (process.env.ZK_BETTING_SETTLE_CIRCUIT_DIR || "").trim()
  || resolve(process.cwd(), "zk_circuits", "zk_betting_settle_groth16");

function toFieldFromSha256Hex(hex: string): bigint {
  return BigInt(`0x${hex}`) % BN254_FIELD_PRIME;
}

function toBytes32FromDecimal(value: string | bigint): Buffer {
  const bigint = typeof value === "bigint" ? value : BigInt(value);
  if (bigint < 0n) throw new Error("Negative field element is not supported");
  const hex = bigint.toString(16).padStart(64, "0");
  return Buffer.from(hex, "hex");
}

function serializeGroth16ProofToCalldataBytes(proof: any): Buffer {
  if (!proof?.pi_a || !proof?.pi_b || !proof?.pi_c) {
    throw new Error("Invalid Groth16 proof JSON shape");
  }

  const a = [
    toBytes32FromDecimal(String(proof.pi_a[0])),
    toBytes32FromDecimal(String(proof.pi_a[1])),
  ];

  const b = [
    toBytes32FromDecimal(String(proof.pi_b[0][1])),
    toBytes32FromDecimal(String(proof.pi_b[0][0])),
    toBytes32FromDecimal(String(proof.pi_b[1][1])),
    toBytes32FromDecimal(String(proof.pi_b[1][0])),
  ];

  const c = [
    toBytes32FromDecimal(String(proof.pi_c[0])),
    toBytes32FromDecimal(String(proof.pi_c[1])),
  ];

  const calldata = Buffer.concat([...a, ...b, ...c]);
  if (calldata.length !== 256) {
    throw new Error(`Serialized Groth16 calldata must be 256 bytes, got ${calldata.length}`);
  }

  return calldata;
}

function matchIdToFieldDecimal(matchId: string): string {
  const hashHex = createHash("sha256").update(matchId).digest("hex");
  return toFieldFromSha256Hex(hashHex).toString(10);
}

function resolveArtifacts(): { wasmPath: string; zkeyPath: string; vkeyPath: string } {
  const wasmPath = resolve(BETTING_SETTLE_CIRCUIT_DIR, "artifacts", "betting_settle.wasm");
  const zkeyPath = resolve(BETTING_SETTLE_CIRCUIT_DIR, "artifacts", "betting_settle_final.zkey");
  const vkeyPath = resolve(BETTING_SETTLE_CIRCUIT_DIR, "artifacts", "verification_key.json");

  if (!existsSync(wasmPath)) throw new Error(`Missing betting settle wasm: ${wasmPath}`);
  if (!existsSync(zkeyPath)) throw new Error(`Missing betting settle zkey: ${zkeyPath}`);
  if (!existsSync(vkeyPath)) throw new Error(`Missing betting settle verification key: ${vkeyPath}`);

  return { wasmPath, zkeyPath, vkeyPath };
}

let groth16Promise: Promise<any> | null = null;

async function getGroth16(): Promise<any> {
  if (!groth16Promise) {
    groth16Promise = import("snarkjs").then((mod: any) => mod.groth16);
  }
  return groth16Promise;
}

export async function proveBettingSettlement(params: {
  matchId: string;
  poolId: number;
  winner: WinnerSide;
}): Promise<{
  proof: Buffer;
  publicInputs: Buffer[];
  vkIdHex: string;
  verificationKeyPath: string;
}> {
  const { wasmPath, zkeyPath, vkeyPath } = resolveArtifacts();
  const winnerSide = params.winner === "player1" ? 0 : 1;
  const matchIdField = matchIdToFieldDecimal(params.matchId);
  const poolId = String(params.poolId >>> 0);

  const input = {
    match_id: matchIdField,
    pool_id: poolId,
    winner_side: String(winnerSide),
    witness_match_id: matchIdField,
    witness_pool_id: poolId,
    witness_winner_side: String(winnerSide),
  };

  const groth16 = await getGroth16();
  const proveResult = await groth16.fullProve(input, wasmPath, zkeyPath);

  const publicSignals: unknown[] = Array.isArray((proveResult as any).publicSignals)
    ? (proveResult as any).publicSignals
    : [];

  if (publicSignals.length < 3) {
    throw new Error("Groth16 publicSignals are missing betting settle outputs");
  }

  const proof = serializeGroth16ProofToCalldataBytes((proveResult as any).proof);
  const publicInputs = [0, 1, 2].map((index) => toBytes32FromDecimal(String(publicSignals[index])));

  const vkBytes = await readFile(vkeyPath);
  const vkIdHex = `0x${createHash("sha256").update(vkBytes).digest("hex")}`;

  return {
    proof,
    publicInputs,
    vkIdHex,
    verificationKeyPath: vkeyPath,
  };
}
