import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const BN254_FIELD_PRIME = BigInt("21888242871839275222246405745257275088548364400416034343698204186575808495617");

type WinnerSide = "player1" | "player2";

const BETTING_SETTLE_CIRCUIT_DIR = (process.env.ZK_BETTING_SETTLE_CIRCUIT_DIR || "").trim()
  || resolve(process.cwd(), "zk_circuits", "zk_betting_settle_groth16");

const REMOTE_ARTIFACT_BASE = (process.env.ZK_BETTING_SETTLE_ARTIFACT_BASE_URL || "").trim()
  || (process.env.VITE_ZK_API_BASE_URL || "").trim()
  || (process.env.API_BASE_URL || "").trim();
const REMOTE_ARTIFACT_PREFIX = "/api/zk/artifacts/betting-settle";
const DOWNLOAD_CACHE_DIR = resolve(tmpdir(), "vbb-zk-betting-settle-artifacts");
const downloadInFlight = new Map<string, Promise<string>>();
const SNARKJS_CLI_PATH = resolve(process.cwd(), "node_modules", "snarkjs", "build", "cli.cjs");
const NODE_BIN = existsSync("/usr/bin/node") ? "/usr/bin/node" : "node";
const SNARKJS_NODE_CLI = [NODE_BIN, SNARKJS_CLI_PATH];

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

function pickExisting(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveLocalArtifacts(): { wasmPath: string; zkeyPath: string; vkeyPath: string } | null {
  const wasmPath = pickExisting([
    resolve(BETTING_SETTLE_CIRCUIT_DIR, "artifacts", "betting_settle.wasm"),
    resolve(BETTING_SETTLE_CIRCUIT_DIR, "artifacts", "betting_settle_js", "betting_settle.wasm"),
    resolve(BETTING_SETTLE_CIRCUIT_DIR, "betting_settle_js", "betting_settle.wasm"),
  ]);
  const zkeyPath = pickExisting([
    resolve(BETTING_SETTLE_CIRCUIT_DIR, "artifacts", "betting_settle_final.zkey"),
    resolve(BETTING_SETTLE_CIRCUIT_DIR, "betting_settle_final.zkey"),
  ]);
  const vkeyPath = pickExisting([
    resolve(BETTING_SETTLE_CIRCUIT_DIR, "artifacts", "verification_key.json"),
    resolve(BETTING_SETTLE_CIRCUIT_DIR, "verification_key.json"),
  ]);

  if (!wasmPath || !zkeyPath || !vkeyPath) {
    return null;
  }

  return { wasmPath, zkeyPath, vkeyPath };
}

async function downloadArtifact(fileName: string): Promise<string> {
  const existing = resolve(DOWNLOAD_CACHE_DIR, fileName);
  if (existsSync(existing)) return existing;

  const inFlight = downloadInFlight.get(fileName);
  if (inFlight) return inFlight;

  const downloadPromise = (async () => {
    if (!REMOTE_ARTIFACT_BASE) {
      throw new Error(`Missing betting settle artifact base URL and local artifact ${fileName}`);
    }

    const base = REMOTE_ARTIFACT_BASE.replace(/\/$/, "");
    const url = `${base}${REMOTE_ARTIFACT_PREFIX}/${fileName}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download betting settle artifact ${fileName} (${response.status})`);
    }

    const data = await response.arrayBuffer();
    await mkdir(DOWNLOAD_CACHE_DIR, { recursive: true });
    const outPath = resolve(DOWNLOAD_CACHE_DIR, fileName);
    await writeFile(outPath, Buffer.from(data));
    return outPath;
  })();

  downloadInFlight.set(fileName, downloadPromise);
  try {
    return await downloadPromise;
  } finally {
    downloadInFlight.delete(fileName);
  }
}

async function resolveArtifacts(): Promise<{ wasmPath: string; zkeyPath: string; vkeyPath: string }> {
  const local = resolveLocalArtifacts();
  if (local) return local;

  const [wasmPath, zkeyPath, vkeyPath] = await Promise.all([
    downloadArtifact("betting_settle.wasm"),
    downloadArtifact("betting_settle_final.zkey"),
    downloadArtifact("verification_key.json"),
  ]);

  return { wasmPath, zkeyPath, vkeyPath };
}

async function runCommand(cmd: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn({
    cmd,
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`Command failed (exit=${exitCode}): ${cmd.join(" ")}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
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
  const { wasmPath, zkeyPath, vkeyPath } = await resolveArtifacts();
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

  const requestId = randomUUID().replaceAll("-", "");
  const workDir = resolve(tmpdir(), `vbb-betting-settle-${requestId}`);
  await mkdir(workDir, { recursive: true });

  const inputPath = resolve(workDir, "input.json");
  const proofPath = resolve(workDir, "proof.json");
  const publicPath = resolve(workDir, "public.json");

  await writeFile(inputPath, JSON.stringify(input), "utf8");

  try {
    await runCommand([
      ...SNARKJS_NODE_CLI,
      "groth16",
      "fullprove",
      inputPath,
      wasmPath,
      zkeyPath,
      proofPath,
      publicPath,
    ], process.cwd());

    const [proofJsonRaw, publicJsonRaw] = await Promise.all([
      readFile(proofPath, "utf8"),
      readFile(publicPath, "utf8"),
    ]);

    const proofJson = JSON.parse(proofJsonRaw);
    const publicSignals: unknown[] = JSON.parse(publicJsonRaw);

    if (!Array.isArray(publicSignals) || publicSignals.length < 3) {
      throw new Error("Groth16 publicSignals are missing betting settle outputs");
    }

    const proof = serializeGroth16ProofToCalldataBytes(proofJson);
    const publicInputs = [0, 1, 2].map((index) => toBytes32FromDecimal(String(publicSignals[index])));

    const vkBytes = await readFile(vkeyPath);
    const vkIdHex = `0x${createHash("sha256").update(vkBytes).digest("hex")}`;

    return {
      proof,
      publicInputs,
      vkIdHex,
      verificationKeyPath: vkeyPath,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
