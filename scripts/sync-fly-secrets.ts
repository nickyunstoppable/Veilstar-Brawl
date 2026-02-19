#!/usr/bin/env bun

import { spawn } from "bun";
import { readEnvFile } from "./utils/env";

function usage() {
	console.log(`
Usage: bun run scripts/sync-fly-secrets.ts [--app <fly-app-name>] [--env-file <path>]

Defaults:
	--app veilstar-brawl-zk
	--env-file .env
`);
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
	usage();
	process.exit(0);
}

const appFlagIndex = args.indexOf("--app");
const envFlagIndex = args.indexOf("--env-file");

const appName = appFlagIndex >= 0 ? args[appFlagIndex + 1] : "veilstar-brawl-zk";
const envFilePath = envFlagIndex >= 0 ? args[envFlagIndex + 1] : ".env";

if (!appName) {
	console.error("❌ Missing app name. Use --app <fly-app-name>");
	process.exit(1);
}

const env = await readEnvFile(envFilePath);

const secretLines = Object.entries(env)
	.filter(([key, value]) => {
		if (!key.trim()) return false;
		if (value === undefined || value === null) return false;
		if (String(value).trim() === "") return false;
		return true;
	})
	.map(([key, value]) => `${key}=${value}`);

if (secretLines.length === 0) {
	console.error(`❌ No non-empty key=value pairs found in ${envFilePath}`);
	process.exit(1);
}

console.log(`🔐 Syncing ${secretLines.length} secrets to Fly app: ${appName}`);

const proc = spawn({
	cmd: ["flyctl", "secrets", "import", "--app", appName],
	stdin: "pipe",
	stdout: "inherit",
	stderr: "inherit",
});

proc.stdin.write(secretLines.join("\n") + "\n");
proc.stdin.end();

const exitCode = await proc.exited;
if (exitCode !== 0) {
	console.error(`❌ flyctl secrets import failed with exit code ${exitCode}`);
	process.exit(exitCode);
}

console.log("✅ Fly secrets synchronized successfully");
