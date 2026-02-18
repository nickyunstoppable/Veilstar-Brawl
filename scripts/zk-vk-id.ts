import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { mergeEnvFile, readEnvFile } from "./utils/env";

function normalizeHex32(hex: string): string {
  const trimmed = hex.trim().toLowerCase();
  const raw = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
  if (!/^[0-9a-f]+$/.test(raw)) {
    throw new Error("vk_id must be hex");
  }
  if (raw.length === 0 || raw.length > 64) {
    throw new Error("vk_id exceeds 32 bytes");
  }
  return `0x${raw.padStart(64, "0")}`;
}

function parseArgs(argv: string[]): { vkeyPath: string; write: boolean } {
  const write = argv.includes("--write") || argv.includes("-w");

  const pathFlagIndex = argv.indexOf("--vkey");
  const vkeyPath = pathFlagIndex >= 0
    ? (argv[pathFlagIndex + 1] || "")
    : "";

  return {
    vkeyPath,
    write,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const defaultPath = resolve(process.cwd(), "zk_circuits", "veilstar_round_plan_groth16", "artifacts", "verification_key.json");
  const vkeyPath = resolve(process.cwd(), args.vkeyPath || defaultPath);

  const raw = await Bun.file(vkeyPath).text();
  const digestHex = createHash("sha256").update(raw).digest("hex");
  const vkIdHex = normalizeHex32(`0x${digestHex}`);

  console.log(vkIdHex);

  if (!args.write) return;

  // Write a single source of truth. Finalize must use the same vk_id as round commits.
  await mergeEnvFile(
    ".env",
    {
      ZK_GROTH16_VK_ID: vkIdHex,
      ZK_FINALIZE_VK_ID: "",
    },
  );

  const env = await readEnvFile(".env");
  console.log(
    JSON.stringify(
      {
        wrote: true,
        ZK_GROTH16_VK_ID: env.ZK_GROTH16_VK_ID || null,
        ZK_FINALIZE_VK_ID: env.ZK_FINALIZE_VK_ID || null,
      },
      null,
      2,
    ),
  );
}

await main();
