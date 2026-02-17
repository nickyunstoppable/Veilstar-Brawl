/// <reference path="../../circomlibjs.d.ts" />

import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import type { MoveType } from "./game-types";
import { POWER_SURGE_CARD_IDS, type PowerSurgeCardId } from "./power-surge";
import { buildPoseidon } from "circomlibjs";

const BN254_FIELD_PRIME = BigInt("21888242871839275222246405745257275088548364400416034343698204186575808495617");

const MOVE_TO_CODE: Record<MoveType, number> = {
    stunned: 0,
    punch: 1,
    kick: 2,
    block: 3,
    special: 4,
};

const setupInFlight = new Map<string, Promise<void>>();
const SNARKJS_CLI_PATH = resolve(process.cwd(), "node_modules", "snarkjs", "build", "cli.cjs");
const NODE_BIN = existsSync("/usr/bin/node") ? "/usr/bin/node" : "node";
const SNARKJS_NODE_CLI = [NODE_BIN, SNARKJS_CLI_PATH];

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
        throw new Error(`Command failed (exit=${exitCode}): ${cmd.join(" ")}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }

    return { stdout, stderr };
}

function toFieldDecimal(input: string): bigint {
    const digestHex = createHash("sha256").update(input).digest("hex");
    return BigInt(`0x${digestHex}`) % BN254_FIELD_PRIME;
}

function resolveCircuitDir(): string {
    const configured = process.env.ZK_GROTH16_ROUND_CIRCUIT_DIR?.trim();
    if (configured) return configured;
    return resolve(process.cwd(), "zk_circuits", "veilstar_round_plan_groth16");
}

function toSurgeCode(cardId?: PowerSurgeCardId | null): number {
    if (!cardId) return 0;
    const idx = POWER_SURGE_CARD_IDS.indexOf(cardId);
    if (idx < 0) return 0;
    return idx + 1;
}

function toBytes32FromDecimal(value: string): Buffer {
    const bigint = BigInt(value);
    if (bigint < 0n) throw new Error("Negative field element is not supported");
    const hex = bigint.toString(16).padStart(64, "0");
    return Buffer.from(hex, "hex");
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

async function ensureGroth16Artifacts(circuitDir: string): Promise<void> {
    const key = circuitDir;
    const inFlight = setupInFlight.get(key);
    if (inFlight) {
        await inFlight;
        return;
    }

    const setupPromise = (async () => {
        const artifactsDir = join(circuitDir, "artifacts");
        await mkdir(artifactsDir, { recursive: true });

        const r1csPath = join(artifactsDir, "round_plan.r1cs");
        const wasmPath = join(artifactsDir, "round_plan_js", "round_plan.wasm");
        const ptauFinalPath = join(artifactsDir, "pot12_final.ptau");
        const zkeyFinalPath = join(artifactsDir, "round_plan_final.zkey");
        const vkeyPath = join(artifactsDir, "verification_key.json");

        const circomCmd = process.env.ZK_GROTH16_CIRCOM_CMD?.trim()
            ? parseCommandLine(process.env.ZK_GROTH16_CIRCOM_CMD)
            : [
                "npx",
                "circom2",
                "round_plan.circom",
                "--r1cs",
                "--wasm",
                "--sym",
                "-o",
                "artifacts",
                // Resolve `include "circomlib/..."` from repo-root node_modules.
                "-l",
                "../../node_modules",
            ];

        if (!existsSync(r1csPath) || !existsSync(wasmPath)) {
            await runCommand(circomCmd, circuitDir);
        }

        if (!existsSync(ptauFinalPath)) {
            await runCommand([...SNARKJS_NODE_CLI, "powersoftau", "new", "bn128", "12", "artifacts/pot12_0000.ptau", "-v"], circuitDir);

            // snarkjs@0.7.6 does not support non-interactive flags for `powersoftau contribute`.
            // Use a deterministic beacon so this step can run unattended.
            const ptauBeaconHash = (process.env.ZK_GROTH16_PTAU_BEACON_HASH || "").trim()
                || (process.env.ZK_GROTH16_BEACON_HASH || "").trim()
                || "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
            const ptauBeaconItersExp = (process.env.ZK_GROTH16_PTAU_BEACON_ITERS_EXP || "").trim()
                || (process.env.ZK_GROTH16_BEACON_ITERS_EXP || "10").trim();

            await runCommand([
                ...SNARKJS_NODE_CLI,
                "powersoftau",
                "beacon",
                "artifacts/pot12_0000.ptau",
                "artifacts/pot12_0001.ptau",
                ptauBeaconHash,
                ptauBeaconItersExp,
            ], circuitDir);

            await runCommand([
                ...SNARKJS_NODE_CLI, "powersoftau", "prepare", "phase2",
                "artifacts/pot12_0001.ptau",
                "artifacts/pot12_final.ptau",
            ], circuitDir);
        }

        if (!existsSync(zkeyFinalPath) || !existsSync(vkeyPath)) {
            await runCommand([
                ...SNARKJS_NODE_CLI, "groth16", "setup",
                "artifacts/round_plan.r1cs",
                "artifacts/pot12_final.ptau",
                "artifacts/round_plan_0000.zkey",
            ], circuitDir);

            // snarkjs@0.7.6 does not support non-interactive flags for `zkey contribute`.
            // Use `zkey beacon` instead so CI/Fly builds don't hang waiting for entropy.
            const beaconHash = (process.env.ZK_GROTH16_BEACON_HASH || "").trim()
                || "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
            const beaconItersExp = (process.env.ZK_GROTH16_BEACON_ITERS_EXP || "10").trim();

            await runCommand([
                ...SNARKJS_NODE_CLI,
                "zkey",
                "beacon",
                "artifacts/round_plan_0000.zkey",
                "artifacts/round_plan_final.zkey",
                beaconHash,
                beaconItersExp,
            ], circuitDir);

            await runCommand([
                ...SNARKJS_NODE_CLI, "zkey", "export", "verificationkey",
                "artifacts/round_plan_final.zkey",
                "artifacts/verification_key.json",
            ], circuitDir);
        }
    })();

    setupInFlight.set(key, setupPromise);
    try {
        await setupPromise;
    } finally {
        setupInFlight.delete(key);
    }
}

export interface ProvePrivateRoundPlanParams {
    matchId: string;
    playerAddress: string;
    roundNumber: number;
    turnNumber: number;
    move: MoveType;
    movePlan: MoveType[];
    surgeCardId?: PowerSurgeCardId | null;
    nonce?: string;
}

export interface ProvePrivateRoundPlanResult {
    commitment: string;
    proof: string;
    publicInputs: string;
    nonce: string;
    prover: {
        backend: string;
        circuitDir: string;
        verifyKeyPath: string;
    };
}

export async function provePrivateRoundPlan(params: ProvePrivateRoundPlanParams): Promise<ProvePrivateRoundPlanResult> {
    const circuitDir = resolveCircuitDir();

    if (!existsSync(join(circuitDir, "round_plan.circom"))) {
        throw new Error(`Groth16 circuit not found: ${join(circuitDir, "round_plan.circom")}`);
    }

    await ensureGroth16Artifacts(circuitDir);

    const artifactsDir = join(circuitDir, "artifacts");
    const wasmPath = join(artifactsDir, "round_plan_js", "round_plan.wasm");
    const zkeyPath = join(artifactsDir, "round_plan_final.zkey");
    const vkeyPath = join(artifactsDir, "verification_key.json");

    const requestId = randomUUID().replaceAll("-", "");
    const workDir = join(tmpdir(), `vbb-groth16-round-${requestId}`);
    await mkdir(workDir, { recursive: true });

    const inputPath = join(workDir, "input.json");
    const proofPath = join(workDir, "proof.json");
    const publicPath = join(workDir, "public.json");

    const moveCode = MOVE_TO_CODE[params.move] ?? MOVE_TO_CODE.block;

    const movePlan = Array.isArray(params.movePlan)
        ? params.movePlan.filter((move): move is MoveType => !!move)
        : [];
    if (movePlan.length !== 10) {
        throw new Error("movePlan must contain exactly 10 moves");
    }

    const movePlanCodes = movePlan.map((move) => MOVE_TO_CODE[move] ?? MOVE_TO_CODE.block);

    const nonceValue = (params.nonce && params.nonce.trim().length > 0)
        ? BigInt(params.nonce.trim())
        : toFieldDecimal(`${params.matchId}|${params.playerAddress}|${params.roundNumber}|${params.turnNumber}|${Date.now()}|${requestId}`);

    const matchIdField = toFieldDecimal(params.matchId);
    const playerField = toFieldDecimal(params.playerAddress);
    const surgeCode = BigInt(toSurgeCode(params.surgeCardId));

    const commitmentDecimal = await computePoseidonCommitmentDecimal([
        matchIdField,
        BigInt(params.roundNumber),
        BigInt(params.turnNumber),
        playerField,
        surgeCode,
        nonceValue,
        ...movePlanCodes.map((code) => BigInt(code)),
    ]);

    const input = {
        commitment: commitmentDecimal,
        match_id: matchIdField.toString(),
        round_number: String(params.roundNumber),
        turn_number: String(params.turnNumber),
        player_address: playerField.toString(),
        surge_card: surgeCode.toString(),
        nonce: nonceValue.toString(),
        moves: movePlanCodes.map(String),
    };

    try {
        await writeFile(inputPath, JSON.stringify(input), "utf8");

        await runCommand([
            ...SNARKJS_NODE_CLI, "groth16", "fullprove",
            inputPath,
            wasmPath,
            zkeyPath,
            proofPath,
            publicPath,
        ], circuitDir);

        const [proofJsonRaw, publicJsonRaw] = await Promise.all([
            readFile(proofPath, "utf8"),
            readFile(publicPath, "utf8"),
        ]);

        const proofJson = JSON.parse(proofJsonRaw);
        const publicInputsJson = JSON.parse(publicJsonRaw);

        const proofBytes = serializeGroth16ProofToCalldataBytes(proofJson);

        // commitment is the single public input/output at index 0.
        const commitmentBytes32 = toBytes32FromDecimal(String(publicInputsJson?.[0] ?? commitmentDecimal));

        return {
            commitment: `0x${commitmentBytes32.toString("hex")}`,
            proof: `base64:${proofBytes.toString("base64")}`,
            publicInputs: JSON.stringify(publicInputsJson),
            nonce: nonceValue.toString(),
            prover: {
                backend: "circom2-snarkjs-groth16",
                circuitDir,
                verifyKeyPath: vkeyPath,
            },
        };
    } finally {
        await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
}
