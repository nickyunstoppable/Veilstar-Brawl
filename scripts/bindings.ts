#!/usr/bin/env bun

/**
 * Generate TypeScript bindings for contracts
 *
 * Generates type-safe client bindings from deployed contracts
 */

import { $ } from "bun";
import { copyFileSync, existsSync } from "fs";
import { join } from "path";
import { readEnvFile, getEnvValue } from "./utils/env";
import { getWorkspaceContracts, listContractNames, selectContracts } from "./utils/contracts";

import { ensureTlsCerts } from "./utils/tls";

function usage() {
  console.log(`
Usage: bun run bindings [contract-name...]

Examples:
  bun run bindings
  bun run bindings number-guess
  bun run bindings twenty-one number-guess
`);
}

console.log("📦 Generating TypeScript bindings...\n");

// Stellar network configuration
process.env.STELLAR_RPC_URL = "https://soroban-testnet.stellar.org";
process.env.STELLAR_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
process.env.SOROBAN_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

// Ensure TLS certificates are available for the Stellar CLI on Windows
await ensureTlsCerts();

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  usage();
  process.exit(0);
}

const contracts = await getWorkspaceContracts();
const selection = selectContracts(contracts, args);
if (selection.unknown.length > 0 || selection.ambiguous.length > 0) {
  console.error("❌ Error: Unknown or ambiguous contract names.");
  if (selection.unknown.length > 0) {
    console.error("Unknown:");
    for (const name of selection.unknown) console.error(`  - ${name}`);
  }
  if (selection.ambiguous.length > 0) {
    console.error("Ambiguous:");
    for (const entry of selection.ambiguous) {
      console.error(`  - ${entry.target}: ${entry.matches.join(", ")}`);
    }
  }
  console.error(`\nAvailable contracts: ${listContractNames(contracts)}`);
  process.exit(1);
}

const contractsToBind = selection.contracts;
const contractIds: Record<string, string> = {};

function trySyncFrontendBinding(contractName: string, generatedDir: string): string[] {
  const copiedTo: string[] = [];
  const generatedIndex = join(generatedDir, "src", "index.ts");

  if (!existsSync(generatedIndex)) {
    return copiedTo;
  }

  const candidateTargets = [
    join(`${contractName}-frontend`, "src", "games", contractName, "bindings.ts"),
    join("sgs_frontend", "src", "games", contractName, "bindings.ts"),
  ];

  for (const target of candidateTargets) {
    if (!existsSync(target)) continue;
    copyFileSync(generatedIndex, target);
    copiedTo.push(target);
  }

  return copiedTo;
}

if (existsSync("deployment.json")) {
  const deploymentInfo = await Bun.file("deployment.json").json();
  if (deploymentInfo?.contracts && typeof deploymentInfo.contracts === 'object') {
    Object.assign(contractIds, deploymentInfo.contracts);
  } else {
    // Backwards compatible fallback
    if (deploymentInfo?.mockGameHubId) contractIds["mock-game-hub"] = deploymentInfo.mockGameHubId;
    if (deploymentInfo?.twentyOneId) contractIds["twenty-one"] = deploymentInfo.twentyOneId;
    if (deploymentInfo?.numberGuessId) contractIds["number-guess"] = deploymentInfo.numberGuessId;
  }
} else {
  const env = await readEnvFile('.env');
  for (const contract of contracts) {
    contractIds[contract.packageName] = getEnvValue(env, `VITE_${contract.envKey}_CONTRACT_ID`);
  }
}

const missing: string[] = [];
for (const contract of contractsToBind) {
  const id = contractIds[contract.packageName];
  if (!id) missing.push(`VITE_${contract.envKey}_CONTRACT_ID`);
}

if (missing.length > 0) {
  console.error("❌ Error: Missing contract IDs (need either deployment.json or .env):");
  for (const k of missing) console.error(`  - ${k}`);
  process.exit(1);
}

for (const contract of contractsToBind) {
  const contractId = contractIds[contract.packageName];
  console.log(`Generating bindings for ${contract.packageName}...`);
  try {
    await $`stellar contract bindings typescript --contract-id ${contractId} --output-dir ${contract.bindingsOutDir} --network testnet --rpc-url https://soroban-testnet.stellar.org --network-passphrase "Test SDF Network ; September 2015" --overwrite`;
    const syncedTargets = trySyncFrontendBinding(contract.packageName, contract.bindingsOutDir);
    if (syncedTargets.length > 0) {
      for (const target of syncedTargets) {
        console.log(`🔁 Synced frontend binding: ${target}`);
      }
    }
    console.log(`✅ ${contract.packageName} bindings generated\n`);
  } catch (error) {
    console.error(`❌ Failed to generate ${contract.packageName} bindings:`, error);
    process.exit(1);
  }
}

console.log("🎉 Bindings generated successfully!");
console.log("\nGenerated files:");
for (const contract of contractsToBind) {
  console.log(`  - ${contract.bindingsOutDir}/`);
}
