import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface ZkProofPayload {
    proof: string;
    publicInputs?: unknown;
    transcriptHash?: string;
    matchId: string;
    winnerAddress: string;
}

export interface ZkVerificationResult {
    ok: boolean;
    backend: string;
    command: string;
    output?: string;
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

function replaceTemplateArgs(args: string[], replacements: Record<string, string>): string[] {
    return args.map((arg) => {
        let next = arg;
        for (const [key, value] of Object.entries(replacements)) {
            next = next.replaceAll(key, value);
        }
        return next;
    });
}

function stringifyPublicInputs(publicInputs: unknown): string {
    if (publicInputs === undefined || publicInputs === null) {
        return "[]";
    }

    if (typeof publicInputs === "string") {
        return publicInputs;
    }

    return JSON.stringify(publicInputs);
}

function decodeMaybeBase64(value: unknown): Buffer | null {
    if (typeof value !== "string") return null;
    if (!value.startsWith("base64:")) return null;
    const raw = value.slice("base64:".length);
    return Buffer.from(raw, "base64");
}

export async function verifyNoirProof(payload: ZkProofPayload): Promise<ZkVerificationResult> {
    const verifyEnabled = (process.env.ZK_VERIFY_ENABLED ?? "true") !== "false";
    if (!verifyEnabled) {
        return {
            ok: true,
            backend: "disabled",
            command: "none",
            output: "ZK verification disabled by ZK_VERIFY_ENABLED=false",
        };
    }

    const verificationKeyPath = process.env.ZK_VK_PATH;
    if (!verificationKeyPath) {
        throw new Error("ZK verification is enabled but ZK_VK_PATH is not configured");
    }

    const commandTemplate = process.env.ZK_VERIFY_CMD
        || "bb verify -k {VK_PATH} -p {PROOF_PATH} -i {PUBLIC_INPUTS_PATH}";

    const workingDir = join(tmpdir(), `vbb-zk-${randomUUID()}`);
    await mkdir(workingDir, { recursive: true });

    const proofPath = join(workingDir, "proof.bin");
    const publicInputsPath = join(workingDir, "public_inputs.json");

    try {
        const proofBytes = decodeMaybeBase64(payload.proof);
        if (proofBytes) {
            await writeFile(proofPath, proofBytes);
        } else {
            await writeFile(proofPath, payload.proof, "utf8");
        }

        const publicInputBytes = decodeMaybeBase64(payload.publicInputs);
        if (publicInputBytes) {
            await writeFile(publicInputsPath, publicInputBytes);
        } else {
            await writeFile(publicInputsPath, stringifyPublicInputs(payload.publicInputs), "utf8");
        }

        const parsed = parseCommandLine(commandTemplate);
        if (parsed.length === 0) {
            throw new Error("ZK_VERIFY_CMD is empty");
        }

        const [command, ...argTemplate] = parsed;
        const args = replaceTemplateArgs(argTemplate, {
            "{VK_PATH}": verificationKeyPath,
            "{PROOF_PATH}": proofPath,
            "{PUBLIC_INPUTS_PATH}": publicInputsPath,
            "{MATCH_ID}": payload.matchId,
            "{WINNER_ADDRESS}": payload.winnerAddress,
            "{TRANSCRIPT_HASH}": payload.transcriptHash ?? "",
        });

        const proc = Bun.spawn({
            cmd: [command, ...args],
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
                `Noir verification failed (exit=${exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
            );
        }

        return {
            ok: true,
            backend: "external",
            command: [command, ...args].join(" "),
            output: `${stdout}\n${stderr}`.trim(),
        };
    } finally {
        await rm(workingDir, { recursive: true, force: true });
    }
}
