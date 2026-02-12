import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let envLoaded = false;

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

    envLoaded = true;
}
