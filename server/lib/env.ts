import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

let envLoaded = false;

function materializeZkVkFromEnv(): void {
    const alreadyConfiguredPath = process.env.ZK_VK_PATH?.trim();
    if (alreadyConfiguredPath) return;

    const rawBase64 = process.env.ZK_VK_BASE64?.trim();
    if (!rawBase64) return;

    try {
        const outDir = resolve(tmpdir(), "veilstar-zk");
        mkdirSync(outDir, { recursive: true });
        const outPath = resolve(outDir, "verification.key");
        const content = Buffer.from(rawBase64, "base64");
        writeFileSync(outPath, content);
        process.env.ZK_VK_PATH = outPath;
        console.log("[env] ZK verification key materialized from ZK_VK_BASE64");
    } catch (error) {
        console.error("[env] Failed to materialize ZK_VK_BASE64:", error);
    }
}

function loadEnvFile(envPath: string): void {
    if (!existsSync(envPath)) return;

    const raw = readFileSync(envPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;

        const eqIndex = trimmed.indexOf("=");
        if (eqIndex <= 0) continue;

        const key = trimmed.slice(0, eqIndex).trim();
        const value = trimmed.slice(eqIndex + 1).trim();

        if (!key) continue;
        if (process.env[key] === undefined || process.env[key] === "") {
            process.env[key] = value;
        }
    }
}

export function ensureEnvLoaded(): void {
    if (envLoaded) return;

    const cwdEnv = resolve(process.cwd(), ".env");
    loadEnvFile(cwdEnv);

    const thisDir = dirname(fileURLToPath(import.meta.url));
    const repoRootEnv = resolve(thisDir, "..", "..", ".env");
    if (repoRootEnv !== cwdEnv) {
        loadEnvFile(repoRootEnv);
    }

    materializeZkVkFromEnv();

    envLoaded = true;
}
