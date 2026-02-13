import { rm, writeFile, readFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { MoveType } from "./game-types";
import { POWER_SURGE_CARD_IDS, type PowerSurgeCardId } from "./power-surge";

const BN254_FIELD_PRIME = BigInt("21888242871839275222246405745257275088548364400416034343698204186575808495617");

const MOVE_TO_CODE: Record<MoveType, number> = {
    stunned: 0,
    punch: 1,
    kick: 2,
    block: 3,
    special: 4,
};

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

function toFieldDecimal(input: string): string {
    const digestHex = createHash("sha256").update(input).digest("hex");
    const value = BigInt(`0x${digestHex}`) % BN254_FIELD_PRIME;
    return value.toString(10);
}

function toTomlString(value: string): string {
    return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function parseCommitmentFromNargoOutput(stdout: string): string {
    const outputRegex = /Circuit output:\s*(0x[0-9a-fA-F]+)/;
    const match = stdout.match(outputRegex);
    if (!match?.[1]) {
        throw new Error("Unable to parse commitment output from nargo execute");
    }
    return match[1].toLowerCase();
}

function resolveCircuitDir(): string {
    const configured = process.env.ZK_ROUND_CIRCUIT_DIR?.trim();
    if (configured) return configured;
    return resolve(process.cwd(), "zk_circuits", "veilstar_round_plan");
}

function resolveCircuitName(): string {
    return process.env.ZK_ROUND_CIRCUIT_NAME?.trim() || "veilstar_round_plan";
}

function toSurgeCode(cardId: PowerSurgeCardId): number {
    const idx = POWER_SURGE_CARD_IDS.indexOf(cardId);
    if (idx < 0) return 0;
    return idx + 1;
}

function normalizePlannedMoves(primaryMove: MoveType, plannedMoves?: MoveType[]): MoveType[] {
    const source = (plannedMoves || []).filter((move): move is MoveType => move in MOVE_TO_CODE);
    const normalized: MoveType[] = [];

    if (source.length > 0) {
        normalized.push(...source.slice(0, 10));
    }

    if (normalized.length === 0) {
        normalized.push(primaryMove);
    }

    while (normalized.length < 10) {
        normalized.push(normalized[0] || primaryMove || "block");
    }

    return normalized.slice(0, 10);
}

export interface ProvePrivateRoundPlanParams {
    matchId: string;
    playerAddress: string;
    roundNumber: number;
    move: MoveType;
    surgeCardId: PowerSurgeCardId;
    plannedMoves?: MoveType[];
    nonce?: string;
}

export interface ProvePrivateRoundPlanResult {
    commitment: string;
    proof: string;
    publicInputs: string;
    nonce: string;
    prover: {
        nargo: string;
        bb: string;
        circuitDir: string;
    };
}

export async function provePrivateRoundPlan(params: ProvePrivateRoundPlanParams): Promise<ProvePrivateRoundPlanResult> {
    const circuitDir = resolveCircuitDir();
    const circuitName = resolveCircuitName();

    if (!existsSync(join(circuitDir, "Nargo.toml"))) {
        throw new Error(`Noir circuit directory not found or invalid: ${circuitDir}`);
    }

    const requestId = randomUUID().replaceAll("-", "");
    const proverName = `Prover_${requestId}`;
    const witnessName = `witness_${requestId}`;
    const proverTomlPath = join(circuitDir, `${proverName}.toml`);
    const witnessPath = join(circuitDir, "target", `${witnessName}.gz`);
    const bytecodePath = join(circuitDir, "target", `${circuitName}.json`);

    const outputDir = join(tmpdir(), `vbb-zk-round-${requestId}`);
    const proofPath = join(outputDir, "proof");
    const publicInputsPath = join(outputDir, "public_inputs");

    const plannedMoves = normalizePlannedMoves(params.move, params.plannedMoves);
    const moveCodes = plannedMoves.map((move) => MOVE_TO_CODE[move]);

    const nonce = (params.nonce && params.nonce.trim().length > 0)
        ? params.nonce.trim()
        : toFieldDecimal(`${params.matchId}|${params.playerAddress}|${params.roundNumber}|${Date.now()}|${requestId}`);

    const tomlLines = [
        `match_id = ${toTomlString(toFieldDecimal(params.matchId))}`,
        `round_number = ${toTomlString(String(params.roundNumber))}`,
        `player_address = ${toTomlString(toFieldDecimal(params.playerAddress))}`,
        `surge_card = ${toTomlString(String(toSurgeCode(params.surgeCardId)))}`,
        `move_0 = ${toTomlString(String(moveCodes[0]))}`,
        `move_1 = ${toTomlString(String(moveCodes[1]))}`,
        `move_2 = ${toTomlString(String(moveCodes[2]))}`,
        `move_3 = ${toTomlString(String(moveCodes[3]))}`,
        `move_4 = ${toTomlString(String(moveCodes[4]))}`,
        `move_5 = ${toTomlString(String(moveCodes[5]))}`,
        `move_6 = ${toTomlString(String(moveCodes[6]))}`,
        `move_7 = ${toTomlString(String(moveCodes[7]))}`,
        `move_8 = ${toTomlString(String(moveCodes[8]))}`,
        `move_9 = ${toTomlString(String(moveCodes[9]))}`,
        `nonce = ${toTomlString(nonce)}`,
    ];

    const customNargo = process.env.ZK_ROUND_NARGO_CMD?.trim();
    const customBbProve = process.env.ZK_ROUND_BB_PROVE_CMD?.trim();

    const nargoCommand = customNargo
        ? parseCommandLine(customNargo)
        : ["nargo", "execute", witnessName, "--prover-name", proverName];

    const bbProveCommand = customBbProve
        ? parseCommandLine(customBbProve)
        : ["bb", "prove", "-b", bytecodePath, "-w", witnessPath, "-o", outputDir];

    if (nargoCommand.length === 0) {
        throw new Error("ZK_ROUND_NARGO_CMD is empty");
    }
    if (bbProveCommand.length === 0) {
        throw new Error("ZK_ROUND_BB_PROVE_CMD is empty");
    }

    try {
        await writeFile(proverTomlPath, `${tomlLines.join("\n")}\n`, "utf8");

        await runCommand(["nargo", "compile"], circuitDir);
        const nargoRun = await runCommand(nargoCommand, circuitDir);

        const commitment = parseCommitmentFromNargoOutput(`${nargoRun.stdout}\n${nargoRun.stderr}`);

        await runCommand(bbProveCommand, circuitDir);

        const [proofBytes, publicInputBytes] = await Promise.all([
            readFile(proofPath),
            readFile(publicInputsPath),
        ]);

        return {
            commitment,
            proof: `base64:${proofBytes.toString("base64")}`,
            publicInputs: `base64:${publicInputBytes.toString("base64")}`,
            nonce,
            prover: {
                nargo: nargoCommand.join(" "),
                bb: bbProveCommand.join(" "),
                circuitDir,
            },
        };
    } finally {
        await Promise.all([
            unlink(proverTomlPath).catch(() => {}),
            unlink(witnessPath).catch(() => {}),
            rm(outputDir, { recursive: true, force: true }).catch(() => {}),
        ]);
    }
}
