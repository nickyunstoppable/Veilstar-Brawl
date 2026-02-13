import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getSupabase } from "./supabase";

interface ProveAndFinalizeParams {
    matchId: string;
    winnerAddress: string;
}

interface ProveAndFinalizeResult {
    success: boolean;
    proofCommand?: string;
    finalizeResponse?: unknown;
}

export function shouldAutoProveFinalize(): boolean {
    const autoEnabled = (process.env.ZK_AUTO_PROVE_FINALIZE ?? "true") !== "false";
    if (!autoEnabled) {
        return false;
    }

    const proveEnabled = (process.env.ZK_PROVE_ENABLED ?? "true") !== "false";
    if (!proveEnabled) {
        return false;
    }

    const proveCommand = process.env.ZK_PROVE_CMD?.trim();
    return Boolean(proveCommand);
}

export function triggerAutoProveFinalize(matchId: string, winnerAddress: string, context: string): void {
    if (!shouldAutoProveFinalize()) return;

    void proveAndFinalizeMatch({ matchId, winnerAddress })
        .then((result) => {
            console.log(`[ZK AutoFinalize][${context}] success`, {
                matchId,
                winnerAddress,
                proofCommand: result.proofCommand,
            });
        })
        .catch((err) => {
            console.error(`[ZK AutoFinalize][${context}] failed`, {
                matchId,
                winnerAddress,
                error: err instanceof Error ? err.message : String(err),
            });
        });
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

function getServerBaseUrl(): string {
    return process.env.SERVER_INTERNAL_BASE_URL
        || `http://127.0.0.1:${process.env.SERVER_PORT || "3001"}`;
}

async function loadMatchTranscript(matchId: string): Promise<unknown> {
    const supabase = getSupabase();

    const { data: match } = await supabase
        .from("matches")
        .select("*")
        .eq("id", matchId)
        .single();

    const { data: rounds } = await supabase
        .from("rounds")
        .select("*")
        .eq("match_id", matchId)
        .order("round_number", { ascending: true })
        .order("turn_number", { ascending: true });

    const roundIds = (rounds || []).map((round: any) => round.id);
    const { data: moves } = roundIds.length > 0
        ? await supabase
            .from("moves")
            .select("*")
            .in("round_id", roundIds)
        : { data: [] as any[] };

    const { data: surges } = await supabase
        .from("power_surges")
        .select("*")
        .eq("match_id", matchId)
        .order("round_number", { ascending: true });

    return {
        match,
        rounds: rounds || [],
        moves: moves || [],
        powerSurges: surges || [],
        exportedAt: new Date().toISOString(),
    };
}

export async function proveAndFinalizeMatch(
    params: ProveAndFinalizeParams,
): Promise<ProveAndFinalizeResult> {
    const enabled = (process.env.ZK_PROVE_ENABLED ?? "true") !== "false";
    if (!enabled) {
        throw new Error("ZK proving is disabled (ZK_PROVE_ENABLED=false)");
    }

    const proveCommandTemplate = process.env.ZK_PROVE_CMD;
    if (!proveCommandTemplate) {
        throw new Error("ZK_PROVE_CMD is not configured");
    }

    const workingDir = join(tmpdir(), `vbb-zk-prove-${randomUUID()}`);
    await mkdir(workingDir, { recursive: true });

    const inputPath = join(workingDir, "match_input.json");
    const proofPath = join(workingDir, "proof.bin");
    const publicInputsPath = join(workingDir, "public_inputs.json");

    try {
        const transcript = await loadMatchTranscript(params.matchId);
        await writeFile(inputPath, JSON.stringify(transcript), "utf8");

        const parsed = parseCommandLine(proveCommandTemplate);
        if (parsed.length === 0) {
            throw new Error("ZK_PROVE_CMD is empty");
        }

        const [command, ...argTemplate] = parsed;
        const args = replaceTemplateArgs(argTemplate, {
            "{INPUT_PATH}": inputPath,
            "{PROOF_PATH}": proofPath,
            "{PUBLIC_INPUTS_PATH}": publicInputsPath,
            "{MATCH_ID}": params.matchId,
            "{WINNER_ADDRESS}": params.winnerAddress,
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
                `ZK proof generation failed (exit=${exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
            );
        }

        const [proof, publicInputs] = await Promise.all([
            readFile(proofPath, "utf8"),
            readFile(publicInputsPath, "utf8").catch(() => "[]"),
        ]);

        const finalizeRes = await fetch(`${getServerBaseUrl()}/api/matches/${params.matchId}/zk/finalize`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                winnerAddress: params.winnerAddress,
                proof,
                publicInputs,
                broadcast: false,
            }),
        });

        const finalizeJson = await finalizeRes.json().catch(() => null);
        if (!finalizeRes.ok) {
            throw new Error(
                `ZK finalize failed (${finalizeRes.status}): ${JSON.stringify(finalizeJson)}`,
            );
        }

        return {
            success: true,
            proofCommand: [command, ...args].join(" "),
            finalizeResponse: finalizeJson,
        };
    } finally {
        await rm(workingDir, { recursive: true, force: true });
    }
}
