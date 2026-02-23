import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { getSupabase } from "./supabase";

interface ProveAndFinalizeParams {
    matchId: string;
    winnerAddress: string;
    allowRemoteDelegation?: boolean;
}

interface ProveAndFinalizeResult {
    success: boolean;
    proofCommand?: string;
    finalizeResponse?: unknown;
}

function getRemoteZkBaseUrl(): string {
    return (
        process.env.ZK_FINALIZE_API_BASE_URL?.trim()
        || process.env.VITE_ZK_API_BASE_URL?.trim()
        || ""
    ).replace(/\/$/, "");
}

export interface AutoProveFinalizeStatus {
    enabled: boolean;
    reason: string;
}

export function getAutoProveFinalizeStatus(): AutoProveFinalizeStatus {
    return { enabled: false, reason: "backend prove-finalize disabled; browser proving required" };
}

export function shouldAutoProveFinalize(): boolean {
    return getAutoProveFinalizeStatus().enabled;
}

export function triggerAutoProveFinalize(matchId: string, winnerAddress: string, context: string): void {
    if (!shouldAutoProveFinalize()) return;

    console.log(`[ZK AutoFinalize][${context}] queued`, {
        matchId,
        winnerAddress,
    });

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
        || `http://127.0.0.1:${process.env.ZK_SERVER_PORT || process.env.PORT || process.env.SERVER_PORT || "3001"}`;
}

function isSelfDelegationUrl(remoteBaseUrl: string): boolean {
    try {
        const remote = new URL(remoteBaseUrl);
        const currentPort = process.env.ZK_SERVER_PORT || process.env.PORT || process.env.SERVER_PORT || "3001";
        const selfHosts = new Set<string>([
            `localhost:${currentPort}`,
            `127.0.0.1:${currentPort}`,
        ]);

        const flyAppName = process.env.FLY_APP_NAME?.trim();
        if (flyAppName) {
            selfHosts.add(`${flyAppName}.fly.dev`);
        }

        return selfHosts.has(remote.host);
    } catch {
        return false;
    }
}

function stableStringify(value: unknown): string {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value);
    }

    if (Array.isArray(value)) {
        return `[${value.map((item) => stableStringify(item)).join(",")}]`;
    }

    const entries = Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`).join(",")}}`;
}

function hashTranscript(value: unknown): string {
    const canonical = stableStringify(value);
    return createHash("sha256").update(canonical).digest("hex");
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
    };
}

export async function proveAndFinalizeMatch(
    params: ProveAndFinalizeParams,
): Promise<ProveAndFinalizeResult> {
    const enabled = (process.env.ZK_PROVE_ENABLED ?? "true") !== "false";
    if (!enabled) {
        throw new Error("ZK proving is disabled (ZK_PROVE_ENABLED=false)");
    }

    const allowRemoteDelegation = params.allowRemoteDelegation !== false;
    const remoteZkBaseUrl = getRemoteZkBaseUrl();
    if (allowRemoteDelegation && remoteZkBaseUrl && !isSelfDelegationUrl(remoteZkBaseUrl)) {
        const remoteUrl = `${remoteZkBaseUrl}/api/matches/${params.matchId}/zk/prove-finalize`;
        console.log(`[ZK Finalizer] Delegating prove+finalize remotely match=${params.matchId} url=${remoteUrl}`);
        const finalizeRes = await fetch(remoteUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ winnerAddress: params.winnerAddress }),
        });

        const finalizeJson = await finalizeRes.json().catch(() => null);
        if (!finalizeRes.ok) {
            throw new Error(
                `Remote ZK prove+finalize failed (${finalizeRes.status}): ${JSON.stringify(finalizeJson)}`,
            );
        }

        console.log(`[ZK Finalizer] Remote prove+finalize succeeded match=${params.matchId}`);

        return {
            success: true,
            proofCommand: `remote:${remoteUrl}`,
            finalizeResponse: finalizeJson,
        };
    }

    if (allowRemoteDelegation && remoteZkBaseUrl && isSelfDelegationUrl(remoteZkBaseUrl)) {
        console.warn(`[ZK Finalizer] Remote delegation target resolves to self (${remoteZkBaseUrl}); using local prove/finalize path.`);
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
        console.log(`[ZK Finalizer] Local prove+finalize start match=${params.matchId}`);
        const transcript = await loadMatchTranscript(params.matchId);
        const transcriptHash = hashTranscript(transcript);
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

        console.log(`[ZK Finalizer] Executing prove command match=${params.matchId} cmd=${command}`);

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

        console.log(`[ZK Finalizer] Proof generated match=${params.matchId}, submitting finalize request`);

        const [proofBytes, publicInputsBytes] = await Promise.all([
            readFile(proofPath),
            readFile(publicInputsPath).catch(() => Buffer.from("[]", "utf8")),
        ]);

        const proof = `base64:${proofBytes.toString("base64")}`;
        const publicInputs = `base64:${publicInputsBytes.toString("base64")}`;

        const finalizeRes = await fetch(`${getServerBaseUrl()}/api/matches/${params.matchId}/zk/finalize`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                winnerAddress: params.winnerAddress,
                proof,
                publicInputs,
                transcriptHash,
                broadcast: false,
            }),
        });

        const finalizeJson = await finalizeRes.json().catch(() => null);
        if (!finalizeRes.ok) {
            throw new Error(
                `ZK finalize failed (${finalizeRes.status}): ${JSON.stringify(finalizeJson)}`,
            );
        }

        console.log(`[ZK Finalizer] Finalize endpoint accepted proof match=${params.matchId}`);

        return {
            success: true,
            proofCommand: [command, ...args].join(" "),
            finalizeResponse: finalizeJson,
        };
    } finally {
        await rm(workingDir, { recursive: true, force: true });
    }
}
