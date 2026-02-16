import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type FeePayersFile = {
    accounts: Array<{ publicKey: string; secret: string }>;
};

function parseArgs(args: string[]) {
    const get = (long: string, short: string) => {
        const idx = args.findIndex((a) => a === long || a === short);
        return idx >= 0 ? args[idx + 1] : undefined;
    };

    const from = get("--from", "-f") || "tmp/fee-payers.testnet.json";
    const envPath = get("--env", "-e") || ".env";

    return { from, envPath };
}

function upsertEnvLine(existing: string, key: string, value: string): string {
    const lines = existing.split(/\r?\n/);
    const out: string[] = [];

    let replaced = false;
    for (const line of lines) {
        if (!line.trim() || line.trim().startsWith("#")) {
            out.push(line);
            continue;
        }

        const eq = line.indexOf("=");
        if (eq <= 0) {
            out.push(line);
            continue;
        }

        const k = line.slice(0, eq).trim();
        if (k === key) {
            out.push(`${key}=${value}`);
            replaced = true;
        } else {
            out.push(line);
        }
    }

    if (!replaced) {
        if (out.length > 0 && out[out.length - 1] !== "") out.push("");
        out.push(`# Added by scripts/apply-fee-payers-env.ts`);
        out.push(`${key}=${value}`);
    }

    // Normalize trailing newline.
    return out.join("\n").replace(/\n*$/, "\n");
}

async function main() {
    const { from, envPath } = parseArgs(process.argv.slice(2));

    const fromPath = resolve(from);
    const envFilePath = resolve(envPath);

    const raw = await readFile(fromPath, "utf-8");
    const parsed = JSON.parse(raw) as FeePayersFile;

    const secrets = (parsed.accounts || []).map((a) => a.secret).filter(Boolean);
    if (secrets.length === 0) {
        throw new Error(`No accounts found in ${from}`);
    }

    // Comma-separated list (no spaces) to keep parsing simple.
    const value = secrets.join(",");

    let existing = "";
    try {
        existing = await readFile(envFilePath, "utf-8");
    } catch {
        existing = "";
    }

    const updated = upsertEnvLine(existing, "STELLAR_FEE_PAYER_SECRETS", value);
    await writeFile(envFilePath, updated, { encoding: "utf-8" });

    process.stdout.write(`Updated ${envPath} with STELLAR_FEE_PAYER_SECRETS (${secrets.length} accounts).\n`);
    process.stdout.write("Note: the .env file now contains private keys; keep it local and never commit it.\n");
}

main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    process.exit(1);
});
