import { cp, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

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

function toTomlString(value: string): string {
    return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));

    const inputRaw = await readFile(args.inputPath, "utf8");
    const transcript = JSON.parse(inputRaw);

    const requestId = randomUUID().replaceAll("-", "");
    const workspace = await mkdtemp(join(tmpdir(), `vbb-finalize-${requestId}-`));

    const circuitDir = resolve(process.cwd(), "zk_circuits", "veilstar_round_plan");
    if (!existsSync(join(circuitDir, "Nargo.toml"))) {
        throw new Error(`Circuit directory not found: ${circuitDir}`);
    }

    const proverName = `Prover_${requestId}`;
    const witnessName = `witness_${requestId}`;
    const proverTomlPath = join(circuitDir, `${proverName}.toml`);
    const witnessPath = join(circuitDir, "target", `${witnessName}.gz`);
    const bytecodePath = join(circuitDir, "target", "veilstar_round_plan.json");

    const outDir = join(workspace, "out");
    await mkdir(outDir, { recursive: true });
    const generatedProofPath = join(outDir, "proof");
    const generatedPublicInputsPath = join(outDir, "public_inputs");

    const winnerMoves = collectWinnerMoves(transcript, args.winnerAddress);
    const selectedMove = winnerMoves[winnerMoves.length - 1] || winnerMoves[0] || "block";
    const selectedMoveCode = MOVE_TO_CODE[selectedMove];
    const turnNumber = Math.max(1, winnerMoves.length || 1);
    const roundNumber = deriveRoundNumber(transcript);
    const surgeCode = deriveSurgeCode(transcript);
    const nonce = toFieldDecimal(`${args.matchId}|${args.winnerAddress}|${roundNumber}|${turnNumber}|${Date.now()}|${requestId}`);

    const tomlLines = [
        `match_id = ${toTomlString(toFieldDecimal(args.matchId))}`,
        `round_number = ${toTomlString(String(roundNumber))}`,
        `turn_number = ${toTomlString(String(turnNumber))}`,
        `player_address = ${toTomlString(toFieldDecimal(args.winnerAddress))}`,
        `surge_card = ${toTomlString(String(surgeCode))}`,
        `selected_move = ${toTomlString(String(selectedMoveCode))}`,
        `nonce = ${toTomlString(nonce)}`,
    ];

    const customNargo = process.env.ZK_FINALIZE_NARGO_CMD?.trim();
    const customBbProve = process.env.ZK_FINALIZE_BB_PROVE_CMD?.trim();

    const nargoCommand = customNargo
        ? parseCommandLine(customNargo)
        : ["nargo", "execute", witnessName, "--prover-name", proverName];

    const bbProveCommand = customBbProve
        ? parseCommandLine(customBbProve)
        : ["bb", "prove", "-b", bytecodePath, "-w", witnessPath, "-o", outDir];

    try {
        await writeFile(proverTomlPath, `${tomlLines.join("\n")}\n`, "utf8");

        await runCommand(["nargo", "compile"], circuitDir);
        await runCommand(nargoCommand, circuitDir);
        await runCommand(bbProveCommand, circuitDir);

        await mkdir(resolve(args.proofPath, ".."), { recursive: true }).catch(() => {});
        await mkdir(resolve(args.publicInputsPath, ".."), { recursive: true }).catch(() => {});

        await cp(generatedProofPath, args.proofPath);
        await cp(generatedPublicInputsPath, args.publicInputsPath);

        console.log(JSON.stringify({
            success: true,
            circuit: "veilstar_round_plan",
            matchId: args.matchId,
            winnerAddress: args.winnerAddress,
            proofPath: args.proofPath,
            publicInputsPath: args.publicInputsPath,
        }));
    } finally {
        await Promise.all([
            unlink(proverTomlPath).catch(() => {}),
            unlink(witnessPath).catch(() => {}),
            rm(workspace, { recursive: true, force: true }).catch(() => {}),
        ]);
    }
}

void main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[zk_service/prove-finalize]", message);
    process.exit(1);
});
