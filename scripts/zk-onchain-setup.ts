import { resolve } from "node:path";
import {
  getConfiguredContractId,
  setGroth16VerificationKeyOnChain,
  setZkVerifierContractOnChain,
  setZkVerifierVkIdOnChain,
} from "../server/lib/stellar-contract";

function parseArgs(argv: string[]) {
  const find = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  return {
    verifierContractId: (find("--verifier") || process.env.ZK_GROTH16_VERIFIER_CONTRACT_ID || "").trim(),
    vkId: (find("--vk") || process.env.ZK_GROTH16_VK_ID || "").trim(),
    vkeyPath: (find("--vkey") || process.env.ZK_GROTH16_ROUND_VKEY_PATH || "").trim(),
    gameContractId: (find("--game") || getConfiguredContractId() || "").trim(),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.verifierContractId) {
    throw new Error("Missing verifier contract id (set ZK_GROTH16_VERIFIER_CONTRACT_ID or pass --verifier)");
  }
  if (!args.vkId) {
    throw new Error("Missing vk id (set ZK_GROTH16_VK_ID or pass --vk)");
  }
  if (!args.gameContractId) {
    throw new Error("Missing game contract id (set VITE_VEILSTAR_BRAWL_CONTRACT_ID or pass --game)");
  }

  const defaultVkeyPath = resolve(
    process.cwd(),
    "zk_circuits",
    "veilstar_round_plan_groth16",
    "artifacts",
    "verification_key.json",
  );
  const vkeyPath = resolve(process.cwd(), args.vkeyPath || defaultVkeyPath);

  console.log("[zk-onchain-setup] verifier=", args.verifierContractId);
  console.log("[zk-onchain-setup] game=", args.gameContractId);
  console.log("[zk-onchain-setup] vkId=", args.vkId);
  console.log("[zk-onchain-setup] vkeyPath=", vkeyPath);

  const upload = await setGroth16VerificationKeyOnChain(args.verifierContractId, args.vkId, vkeyPath);
  if (!upload.success) {
    throw new Error(upload.error || "Failed to upload Groth16 verification key");
  }
  console.log("[zk-onchain-setup] uploaded vkey tx=", upload.txHash || "n/a");

  const setVerifier = await setZkVerifierContractOnChain(args.verifierContractId, { contractId: args.gameContractId });
  if (!setVerifier.success) {
    throw new Error(setVerifier.error || "Failed to set verifier contract on game");
  }
  console.log("[zk-onchain-setup] set verifier tx=", setVerifier.txHash || "n/a");

  const setVk = await setZkVerifierVkIdOnChain(args.vkId, { contractId: args.gameContractId });
  if (!setVk.success) {
    throw new Error(setVk.error || "Failed to set vk id on game");
  }
  console.log("[zk-onchain-setup] set vk id tx=", setVk.txHash || "n/a");

  console.log("[zk-onchain-setup] ok");
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error("[zk-onchain-setup]", message);
  process.exit(1);
});
