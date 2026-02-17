/// <reference path="../circomlibjs.d.ts" />

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { buildPoseidon } from "circomlibjs";

const BN254_FIELD_PRIME = BigInt("21888242871839275222246405745257275088548364400416034343698204186575808495617");

type MoveType = "punch" | "kick" | "block" | "special" | "stunned";

const MOVE_TO_CODE: Record<MoveType, number> = {
    stunned: 0,
    punch: 1,
    kick: 2,
    block: 3,
    special: 4,
};

interface CliArgs {
    inputPath: string;
    proofPath: string;
    publicInputsPath: string;
    matchId: string;
    winnerAddress: string;
}

function parseArgs(argv: string[]): CliArgs {
    const find = (flag: string): string | undefined => {
        const index = argv.indexOf(flag);
        return index >= 0 ? argv[index + 1] : undefined;
    };

    const inputPath = find("--input") || process.env.ZK_INPUT_PATH;
    const proofPath = find("--proof") || process.env.ZK_PROOF_PATH;
    const publicInputsPath = find("--public") || process.env.ZK_PUBLIC_INPUTS_PATH;
    const matchId = find("--match") || process.env.ZK_MATCH_ID;
    const winnerAddress = find("--winner") || process.env.ZK_WINNER_ADDRESS;

    if (!inputPath || !proofPath || !publicInputsPath || !matchId || !winnerAddress) {
        throw new Error(
            "Missing args. Required: --input <path> --proof <path> --public <path> --match <id> --winner <address>",
        );
    }

    return { inputPath, proofPath, publicInputsPath, matchId, winnerAddress };
}

function parseCommandLine(input: string): string[] {
    const args: string[] = [];
    let current = "";
    let quote: '"' | "'" | null = null;

    for (let index = 0; index < input.length; index++) {
        const char = input[index];
        if (quote) {
            if (char === quote) {
                quote = null;
            } else {
                current += char;
            }
            continue;
        }

        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }

        if (/\s/.test(char)) {
            if (current.length > 0) {
                args.push(current);
                current = "";
            }
            continue;
        }

        current += char;
    }

    if (current.length > 0) {
        args.push(current);
    }

    return args;
}

async function runCommand(cmd: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
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
        throw new Error(
            `Command failed (${cmd.join(" ")}) exit=${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        );
    }

    return { stdout, stderr };
}

function toFieldDecimal(input: string): string {
    const digestHex = createHash("sha256").update(input).digest("hex");
    const value = BigInt(`0x${digestHex}`) % BN254_FIELD_PRIME;
    return value.toString(10);
}

function toFieldBigint(input: string): bigint {
    const digestHex = createHash("sha256").update(input).digest("hex");
    return BigInt(`0x${digestHex}`) % BN254_FIELD_PRIME;
}

function parseFirstPublicInputAsDecimal(publicInputsJson: unknown): string {
    if (!Array.isArray(publicInputsJson) || publicInputsJson.length < 1) {
        throw new Error("Groth16 public outputs must be a non-empty array");
    }

    const first = publicInputsJson[0];
    const text = typeof first === "string" ? first.trim() : String(first ?? "").trim();
    if (!/^[0-9]+$/.test(text)) {
        throw new Error("Groth16 public output[0] must be a decimal field element");
    }

    return text;
}

function toBytes32FromDecimal(value: string): Buffer {
    const bigint = BigInt(value);
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

    // snarkjs JSON uses [[x_c0, x_c1], [y_c0, y_c1]] for G2 points.
    // Solidity calldata ordering is (b00,b01,b10,b11) with inner swapped.
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

let poseidonPromise: Promise<any> | null = null;
async function getPoseidon(): Promise<any> {
    if (!poseidonPromise) {
        poseidonPromise = buildPoseidon();
    }
    return poseidonPromise;
}

async function computePoseidonCommitmentDecimal(preimage: bigint[]): Promise<string> {
    const poseidon = await getPoseidon();
    const out = poseidon(preimage);
    const asBigint: bigint = poseidon.F.toObject(out);
    return asBigint.toString(10);
}

function normalizeMove(move: unknown): MoveType {
    if (move === "punch" || move === "kick" || move === "block" || move === "special" || move === "stunned") {
        return move;
    }
    return "block";
}

function collectWinnerMoves(transcript: any, winnerAddress: string): MoveType[] {
    const moves: MoveType[] = [];
    const rows = Array.isArray(transcript?.moves) ? transcript.moves : [];

    for (const row of rows) {
        const addr = String(row?.player_address || "");
        if (addr !== winnerAddress) continue;
        moves.push(normalizeMove(row?.move_type));
        if (moves.length >= 10) break;
    }

    return moves;
}

function padOrTrimMovePlan(moves: MoveType[], desiredLength: number): MoveType[] {
    const normalized = Array.isArray(moves) ? moves.slice(0, desiredLength) : [];
    while (normalized.length < desiredLength) {
        normalized.push("block");
    }
    return normalized;
}

function deriveRoundNumber(transcript: any): number {
    const rounds = Array.isArray(transcript?.rounds) ? transcript.rounds : [];
    let maxRound = 1;
    for (const row of rounds) {
        const n = Number(row?.round_number || 1);
        if (Number.isFinite(n) && n > maxRound) maxRound = n;
    }
    return Math.max(1, Math.floor(maxRound));
}

function deriveSurgeCode(transcript: any): number {
    const surges = Array.isArray(transcript?.powerSurges) ? transcript.powerSurges : [];
    const first = surges[0];
    if (!first) return 0;

    const value = Number(first?.player1_card_id ?? first?.player2_card_id ?? 0);
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

const SNARKJS_CLI_PATH = resolve(process.cwd(), "node_modules", "snarkjs", "build", "cli.cjs");
const JS_RUNTIME_BIN = existsSync("/usr/bin/node") || existsSync("/bin/node")
    ? (existsSync("/usr/bin/node") ? "/usr/bin/node" : "/bin/node")
    : (process.env.SNARKJS_JS_RUNTIME?.trim() || "bun");
const SNARKJS_NODE_CLI = [JS_RUNTIME_BIN, SNARKJS_CLI_PATH];

function resolveGroth16CircuitDir(): string {
    const configured = process.env.ZK_GROTH16_FINALIZE_CIRCUIT_DIR?.trim();
    if (configured) return configured;
    return resolve(process.cwd(), "zk_circuits", "veilstar_round_plan_groth16");
}

async function main() {
    const args = parseArgs(process.argv.slice(2));

    const inputRaw = await readFile(args.inputPath, "utf8");
    const transcript = JSON.parse(inputRaw);

    const requestId = randomUUID().replaceAll("-", "");
    const workspace = await mkdtemp(join(tmpdir(), `vbb-finalize-${requestId}-`));

    const circuitDir = resolveGroth16CircuitDir();
    const artifactsDir = join(circuitDir, "artifacts");
    const wasmPath = join(artifactsDir, "round_plan_js", "round_plan.wasm");
    const zkeyPath = join(artifactsDir, "round_plan_final.zkey");

    if (!existsSync(join(circuitDir, "round_plan.circom")) || !existsSync(wasmPath) || !existsSync(zkeyPath)) {
        throw new Error(`Groth16 finalize artifacts missing. Need round_plan.circom + wasm + zkey in ${circuitDir}`);
    }

    const outDir = join(workspace, "out");
    await mkdir(outDir, { recursive: true });

    const inputPath = join(outDir, "input.json");
    const proofJsonPath = join(outDir, "proof.json");
    const publicJsonPath = join(outDir, "public.json");

    const winnerMoves = collectWinnerMoves(transcript, args.winnerAddress);
    const movePlan = padOrTrimMovePlan(winnerMoves, 10);
    const movePlanCodes = movePlan.map((move) => BigInt(MOVE_TO_CODE[move] ?? MOVE_TO_CODE.block));

    // Keep turn number deterministic for the finalize proof.
    const turnNumber = 1;
    const roundNumber = deriveRoundNumber(transcript);
    const surgeCode = BigInt(deriveSurgeCode(transcript));

    const nonceValue = toFieldBigint(`${args.matchId}|${args.winnerAddress}|${roundNumber}|${turnNumber}|${Date.now()}|${requestId}`);
    const matchIdField = toFieldBigint(args.matchId);
    const playerField = toFieldBigint(args.winnerAddress);

    const commitmentDecimal = await computePoseidonCommitmentDecimal([
        matchIdField,
        BigInt(roundNumber),
        BigInt(turnNumber),
        playerField,
        surgeCode,
        nonceValue,
        ...movePlanCodes,
    ]);

    const input = {
        commitment: commitmentDecimal,
        match_id: matchIdField.toString(),
        round_number: String(roundNumber),
        turn_number: String(turnNumber),
        player_address: playerField.toString(),
        surge_card: surgeCode.toString(),
        nonce: nonceValue.toString(),
        moves: movePlanCodes.map((code) => code.toString(10)),
    };

    try {
        await writeFile(inputPath, JSON.stringify(input), "utf8");

        await runCommand([
            ...SNARKJS_NODE_CLI,
            "groth16",
            "fullprove",
            inputPath,
            wasmPath,
            zkeyPath,
            proofJsonPath,
            publicJsonPath,
        ], circuitDir);

        const [proofJsonRaw, publicJsonRaw] = await Promise.all([
            readFile(proofJsonPath, "utf8"),
            readFile(publicJsonPath, "utf8"),
        ]);

        const proofJson = JSON.parse(proofJsonRaw);
        const publicInputsJson = JSON.parse(publicJsonRaw);
        const proofBytes = serializeGroth16ProofToCalldataBytes(proofJson);

        const commitmentBytes32 = toBytes32FromDecimal(String(publicInputsJson?.[0] ?? commitmentDecimal));

        await mkdir(resolve(args.proofPath, ".."), { recursive: true }).catch(() => {});
        await mkdir(resolve(args.publicInputsPath, ".."), { recursive: true }).catch(() => {});

        await writeFile(args.proofPath, proofBytes);
        await writeFile(args.publicInputsPath, publicJsonRaw, "utf8");

        console.log(JSON.stringify({
            success: true,
            circuit: "veilstar_round_plan_groth16",
            proofBytes: proofBytes.length,
            matchId: args.matchId,
            winnerAddress: args.winnerAddress,
            proofPath: args.proofPath,
            publicInputsPath: args.publicInputsPath,
            commitment: `0x${commitmentBytes32.toString("hex")}`,
        }));
    } finally {
        await rm(workspace, { recursive: true, force: true }).catch(() => {});
    }
}

void main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[zk_service/prove-finalize]", message);
    process.exit(1);
});
