import { Keypair } from "@stellar/stellar-sdk";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

type GeneratedFeePayersFile = {
    network: "testnet";
    friendbotUrl: string;
    generatedAt: string;
    accounts: Array<{ publicKey: string; secret: string; funded: boolean; fundedAt?: string }>;
};

function parseCount(args: string[]): number {
    const flagIdx = args.findIndex((a) => a === "--count" || a === "-n");
    const raw = flagIdx >= 0 ? args[flagIdx + 1] : undefined;
    const count = raw ? Number(raw) : 10;
    if (!Number.isFinite(count) || count <= 0 || count > 100) {
        throw new Error("--count must be a number between 1 and 100");
    }
    return Math.floor(count);
}

function parseOut(args: string[]): string {
    const flagIdx = args.findIndex((a) => a === "--out" || a === "-o");
    const raw = flagIdx >= 0 ? args[flagIdx + 1] : undefined;
    return raw || "tmp/fee-payers.testnet.json";
}

function parseResume(args: string[]): boolean {
    return args.includes("--resume");
}

async function fundWithFriendbot(friendbotUrl: string, publicKey: string): Promise<void> {
    const url = `${friendbotUrl}?addr=${encodeURIComponent(publicKey)}`;
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Friendbot funding failed (${res.status}): ${text.slice(0, 200)}`);
    }
}

async function fundWithRetry(friendbotUrl: string, publicKey: string): Promise<void> {
    const maxAttempts = 8;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            await fundWithFriendbot(friendbotUrl, publicKey);
            return;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const retryable = /\b429\b|rate|timeout|temporar|ECONNRESET|ENOTFOUND|EAI_AGAIN/i.test(message);
            if (!retryable || attempt >= maxAttempts) {
                throw err;
            }

            const backoffMs = Math.min(15_000, 750 * attempt * attempt);
            process.stdout.write(`Friendbot retry ${attempt}/${maxAttempts} in ${backoffMs}ms for ${publicKey}\n`);
            await new Promise((r) => setTimeout(r, backoffMs));
        }
    }
}

async function main() {
    const args = process.argv.slice(2);
    const count = parseCount(args);
    const outRel = parseOut(args);
    const resume = parseResume(args);

    const friendbotUrl = process.env.FRIENDBOT_URL || "https://friendbot.stellar.org";

    const outPath = resolve(outRel);
    await mkdir(dirname(outPath), { recursive: true });

    let file: GeneratedFeePayersFile | null = null;

    if (resume) {
        try {
            const existingRaw = await readFile(outPath, "utf-8");
            const parsed = JSON.parse(existingRaw) as GeneratedFeePayersFile;
            if (parsed?.accounts?.length) {
                file = parsed;
            }
        } catch {
            // ignore; will generate fresh
        }
    }

    if (!file) {
        const accounts: GeneratedFeePayersFile["accounts"] = [];
        for (let i = 0; i < count; i++) {
            const kp = Keypair.random();
            accounts.push({ publicKey: kp.publicKey(), secret: kp.secret(), funded: false });
        }

        file = {
            network: "testnet",
            friendbotUrl,
            generatedAt: new Date().toISOString(),
            accounts,
        };

        // Write immediately so we can resume if Friendbot rate-limits mid-way.
        await writeFile(outPath, JSON.stringify(file, null, 2) + "\n", { encoding: "utf-8" });
    }

    const accounts = file.accounts;
    const total = accounts.length;
    for (let i = 0; i < total; i++) {
        const acct = accounts[i]!;
        if (acct.funded) continue;

        process.stdout.write(`Funding ${i + 1}/${total}: ${acct.publicKey}\n`);
        await fundWithRetry(friendbotUrl, acct.publicKey);
        acct.funded = true;
        acct.fundedAt = new Date().toISOString();
        await writeFile(outPath, JSON.stringify(file, null, 2) + "\n", { encoding: "utf-8" });

        // Small delay for politeness / rate limiting.
        await new Promise((r) => setTimeout(r, 400));
    }

    process.stdout.write(`\nWrote ${accounts.length} funded fee-payer accounts to: ${outRel}\n`);
    process.stdout.write("Keep this file secret (it contains private keys).\n");
    process.stdout.write("\nTo configure the server, set STELLAR_FEE_PAYER_SECRETS to a comma-separated list of the secrets from that file.\n");
}

main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    process.exit(1);
});
