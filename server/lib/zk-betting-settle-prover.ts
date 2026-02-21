import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";

const BN254_FIELD_PRIME = BigInt("21888242871839275222246405745257275088548364400416034343698204186575808495617");
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

function resolveCircuitDir(): string {
    const configured = process.env.ZK_BETTING_SETTLE_CIRCUIT_DIR?.trim();
    if (configured) return configured;
    return resolve(process.cwd(), "zk_circuits", "zk_betting_settle_groth16");
}

function bytes32ToDecimal(value: Buffer): string {
    if (!Buffer.isBuffer(value) || value.length !== 32) {
        throw new Error("Expected a 32-byte buffer");
    }
    const asBigint = BigInt(`0x${value.toString("hex")}`);
    if (asBigint >= BN254_FIELD_PRIME) {
        throw new Error("match_id field element exceeds BN254 field modulus");
    }
    return asBigint.toString(10);
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

        const r1csPath = join(artifactsDir, "betting_settle.r1cs");
        const wasmPath = join(artifactsDir, "betting_settle_js", "betting_settle.wasm");
        const ptauFinalPath = join(artifactsDir, "pot12_final.ptau");
        const zkeyFinalPath = join(artifactsDir, "betting_settle_final.zkey");
        const vkeyPath = join(artifactsDir, "verification_key.json");

        const circomCmd = process.env.ZK_BETTING_SETTLE_CIRCOM_CMD?.trim()
            ? parseCommandLine(process.env.ZK_BETTING_SETTLE_CIRCOM_CMD)
            : [
                "npx",
                "circom2",
                "betting_settle.circom",
                "--r1cs",
                "--wasm",
                "--sym",
                "-o",
                "artifacts",
                "-l",
                "../../node_modules",
            ];

        if (!existsSync(r1csPath) || !existsSync(wasmPath)) {
            await runCommand(circomCmd, circuitDir);
        }

        if (!existsSync(ptauFinalPath)) {
            await runCommand([...SNARKJS_NODE_CLI, "powersoftau", "new", "bn128", "12", "artifacts/pot12_0000.ptau", "-v"], circuitDir);

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
                ...SNARKJS_NODE_CLI,
                "powersoftau",
                "prepare",
                "phase2",
                "artifacts/pot12_0001.ptau",
                "artifacts/pot12_final.ptau",
            ], circuitDir);
        }

        if (!existsSync(zkeyFinalPath) || !existsSync(vkeyPath)) {
            await runCommand([
                ...SNARKJS_NODE_CLI,
                "groth16",
                "setup",
                "artifacts/betting_settle.r1cs",
                "artifacts/pot12_final.ptau",
                "artifacts/betting_settle_0000.zkey",
            ], circuitDir);

            const beaconHash = (process.env.ZK_GROTH16_BEACON_HASH || "").trim()
                || "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
            const beaconItersExp = (process.env.ZK_GROTH16_BEACON_ITERS_EXP || "10").trim();

            await runCommand([
                ...SNARKJS_NODE_CLI,
                "zkey",
                "beacon",
                "artifacts/betting_settle_0000.zkey",
                "artifacts/betting_settle_final.zkey",
                beaconHash,
                beaconItersExp,
            ], circuitDir);

            await runCommand([
                ...SNARKJS_NODE_CLI,
                "zkey",
                "export",
                "verificationkey",
                "artifacts/betting_settle_final.zkey",
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

export interface ProveBotBettingSettleParams {
    matchIdFieldBytes: Buffer;
    poolId: number;
    winnerSide: number;
}

export interface ProveBotBettingSettleResult {
    proof: Buffer;
    publicInputs: Buffer[];
    vkIdHex: string;
    verificationKeyPath: string;
    circuitDir: string;
}

export async function proveBotBettingSettlement(params: ProveBotBettingSettleParams): Promise<ProveBotBettingSettleResult> {
    const circuitDir = resolveCircuitDir();
    if (!existsSync(join(circuitDir, "betting_settle.circom"))) {
        throw new Error(`Betting-settle circuit not found: ${join(circuitDir, "betting_settle.circom")}`);
    }

    await ensureGroth16Artifacts(circuitDir);

    const artifactsDir = join(circuitDir, "artifacts");
    const wasmPath = join(artifactsDir, "betting_settle_js", "betting_settle.wasm");
    const zkeyPath = join(artifactsDir, "betting_settle_final.zkey");
    const vkeyPath = join(artifactsDir, "verification_key.json");

    const requestId = randomUUID().replaceAll("-", "");
    const workDir = join(tmpdir(), `vbb-zk-betting-settle-${requestId}`);
    await mkdir(workDir, { recursive: true });

    const inputPath = join(workDir, "input.json");
    const proofPath = join(workDir, "proof.json");
    const publicPath = join(workDir, "public.json");

    const matchIdDecimal = bytes32ToDecimal(params.matchIdFieldBytes);
    const poolIdDecimal = String(params.poolId >>> 0);
    const winnerSideDecimal = String(params.winnerSide >>> 0);

    const input = {
        match_id: matchIdDecimal,
        pool_id: poolIdDecimal,
        winner_side: winnerSideDecimal,
        witness_match_id: matchIdDecimal,
        witness_pool_id: poolIdDecimal,
        witness_winner_side: winnerSideDecimal,
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
            proofPath,
            publicPath,
        ], circuitDir);

        const [proofJsonRaw, publicJsonRaw, verificationKeyRaw] = await Promise.all([
            readFile(proofPath, "utf8"),
            readFile(publicPath, "utf8"),
            readFile(vkeyPath, "utf8"),
        ]);

        const proofJson = JSON.parse(proofJsonRaw);
        const publicSignals = JSON.parse(publicJsonRaw);
        if (!Array.isArray(publicSignals) || publicSignals.length < 3) {
            throw new Error("betting settle proof must return at least 3 public inputs");
        }

        const proof = serializeGroth16ProofToCalldataBytes(proofJson);
        const publicInputs = [
            toBytes32FromDecimal(String(publicSignals[0])),
            toBytes32FromDecimal(String(publicSignals[1])),
            toBytes32FromDecimal(String(publicSignals[2])),
        ];

        const vkIdHex = `0x${createHash("sha256").update(verificationKeyRaw).digest("hex")}`;

        return {
            proof,
            publicInputs,
            vkIdHex,
            verificationKeyPath: vkeyPath,
            circuitDir,
        };
    } finally {
        await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
}
