import { createHash } from "node:crypto";
import { Buffer } from "buffer";
import { Client as ZkBettingClient, BetSide } from "../../bindings/zk_betting/src/index";
import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { ensureEnvLoaded } from "./env";
import { setGroth16VerificationKeyOnChain } from "./stellar-contract";

ensureEnvLoaded();

const RPC_URL = process.env.VITE_SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = process.env.VITE_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015";
const ZK_BETTING_CONTRACT_ID = process.env.VITE_ZK_BETTING_CONTRACT_ID || "";
const ADMIN_SECRET = process.env.VITE_DEV_ADMIN_SECRET || "";
const ZK_GROTH16_VERIFIER_CONTRACT_ID = (process.env.ZK_GROTH16_VERIFIER_CONTRACT_ID || process.env.VITE_ZK_GROTH16_VERIFIER_CONTRACT_ID || "").trim();
const BN254_FIELD_PRIME = BigInt("21888242871839275222246405745257275088548364400416034343698204186575808495617");
let adminTxQueue: Promise<void> = Promise.resolve();
let configuredBettingVkIdHex = "";

type OnChainTxResult = {
  txHash?: string;
  skipped?: boolean;
  reason?: "already_locked" | "already_settled";
};

type OnChainRevealResult = {
  txHash?: string;
  skipped?: boolean;
  reason?: "already_revealed" | "invalid_reveal" | "bet_not_found" | "pool_not_locked";
};

type OnChainClaimResult = {
  txHash?: string;
  payoutAmount?: bigint;
  skipped?: boolean;
  reason?: "already_claimed" | "no_payout" | "bet_not_found" | "insufficient_liquidity";
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractTxHash(sentTx: unknown): string | undefined {
  const tx = sentTx as any;
  return tx?.hash || tx?.txHash || tx?.sendTransactionResponse?.hash || tx?.result?.hash;
}

function getAdminKeypair(): Keypair {
  if (!ADMIN_SECRET) throw new Error("Missing VITE_DEV_ADMIN_SECRET");
  return Keypair.fromSecret(ADMIN_SECRET);
}

function createSigner(keypair: Keypair) {
  return {
    signTransaction: async (xdr: string, opts?: any) => {
      const tx = TransactionBuilder.fromXDR(xdr, opts?.networkPassphrase || NETWORK_PASSPHRASE);
      tx.sign(keypair);
      return { signedTxXdr: tx.toXDR(), signerAddress: keypair.publicKey() };
    },
  };
}

function getClient(): ZkBettingClient {
  if (!ZK_BETTING_CONTRACT_ID) {
    throw new Error("Missing VITE_ZK_BETTING_CONTRACT_ID");
  }

  const admin = getAdminKeypair();
  return new ZkBettingClient({
    contractId: ZK_BETTING_CONTRACT_ID,
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcUrl: RPC_URL,
    publicKey: admin.publicKey(),
    ...createSigner(admin),
  });
}

function isRetryableSendError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error ?? "");
  return (
    msg.includes("TRY_AGAIN_LATER") ||
    msg.includes("SendFailed") ||
    msg.includes("PENDING") ||
    msg.includes("txBadSeq") ||
    msg.includes("Sending the transaction to the network failed")
  );
}

async function signAndSend(tx: any, options?: { maxRetries?: number; initialDelayMs?: number }): Promise<{ txHash?: string }> {
  const maxRetries = options?.maxRetries ?? 6;
  let delayMs = options?.initialDelayMs ?? 800;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const preparedTx = tx?.simulation
        ? tx
        : (typeof tx?.simulate === "function" ? await tx.simulate() : tx);
      const sent = await preparedTx.signAndSend();
      return { txHash: extractTxHash(sent) };
    } catch (error) {
      lastError = error;
      if (!isRetryableSendError(error) || attempt === maxRetries) {
        throw error;
      }
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, 5000);
    }
  }

  throw lastError;
}

async function runSerializedAdminTx<T>(work: () => Promise<T>): Promise<T> {
  const run = adminTxQueue.then(work, work);
  adminTxQueue = run.then(() => undefined, () => undefined);
  return run;
}

function classifyContractError(error: unknown): "already_locked" | "already_settled" | null {
  const msg = error instanceof Error ? error.message : String(error ?? "");
  if (msg.includes("Error(Contract, #6)")) return "already_locked";
  if (msg.includes("Error(Contract, #5)")) return "already_settled";
  return null;
}

function classifyRevealError(error: unknown): OnChainRevealResult["reason"] | null {
  const msg = error instanceof Error ? error.message : String(error ?? "");
  if (msg.includes("Error(Contract, #3)")) return "pool_not_locked";
  if (msg.includes("Error(Contract, #9)")) return "already_revealed";
  if (msg.includes("Error(Contract, #10)")) return "invalid_reveal";
  if (msg.includes("Error(Contract, #8)")) return "bet_not_found";
  return null;
}

function classifyClaimError(error: unknown): OnChainClaimResult["reason"] | null {
  const msg = error instanceof Error ? error.message : String(error ?? "");
  if (msg.includes("balance is not sufficient to spend")) return "insufficient_liquidity";
  if (msg.includes("Error(Contract, #14)")) return "already_claimed";
  if (msg.includes("Error(Contract, #13)")) return "no_payout";
  if (msg.includes("Error(Contract, #8)")) return "bet_not_found";
  return null;
}

function normalizeHexToBuffer(hex: string): Buffer {
  const clean = hex.trim().replace(/^0x/i, "");
  if (clean.length !== 64) {
    throw new Error("Expected 32-byte hex salt");
  }
  return Buffer.from(clean, "hex");
}

function bytesToFieldBytes32(value: Buffer): Buffer {
  const asBigint = BigInt(`0x${value.toString("hex")}`) % BN254_FIELD_PRIME;
  return Buffer.from(asBigint.toString(16).padStart(64, "0"), "hex");
}

export function matchIdToBytes32(matchId: string): Buffer {
  const digest = createHash("sha256").update(matchId).digest();
  return bytesToFieldBytes32(digest);
}

export function isZkBettingConfigured(): boolean {
  return !!(ZK_BETTING_CONTRACT_ID && ADMIN_SECRET);
}

export async function createOnChainBotPool(matchId: string, deadlineTs: number): Promise<{ poolId: number; txHash?: string }> {
  return runSerializedAdminTx(async () => {
    const client = getClient();
    const tx = await client.create_pool({
      match_id: matchIdToBytes32(matchId),
      deadline_ts: BigInt(Math.max(0, Math.floor(deadlineTs))),
    });
    const primaryResult = (tx as any)?.result;
    const fallbackResult = (tx as any)?.simulation?.result;
    const simResult = primaryResult ?? fallbackResult;
    const poolId = typeof simResult === "number"
      ? simResult
      : Number((simResult as any)?.value ?? (simResult as any)?.ok ?? simResult ?? 0);
    if (!poolId) throw new Error("Failed to read create_pool result");

    const sent = await signAndSend(tx);

    return { poolId, txHash: sent.txHash };
  });
}

export async function lockOnChainPool(poolId: number): Promise<OnChainTxResult> {
  return runSerializedAdminTx(async () => {
    const client = getClient();
    const tx = await client.lock_pool({ pool_id: poolId });
    try {
      return await signAndSend(tx);
    } catch (error) {
      const reason = classifyContractError(error);
      if (reason === "already_locked" || reason === "already_settled") {
        return { skipped: true, reason };
      }
      throw error;
    }
  });
}

export async function settleOnChainPool(poolId: number, winner: "player1" | "player2"): Promise<OnChainTxResult> {
  throw new Error("settleOnChainPool is deprecated. Use settleOnChainPoolZk");
}

type SettleOnChainPoolZkParams = {
  poolId: number;
  winner: "player1" | "player2";
  vkIdHex: string;
  proof: Buffer;
  publicInputs: Buffer[];
};

function normalizeHex32(value: string): Buffer {
  const clean = String(value || "").trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
    throw new Error("vkIdHex must be a 32-byte hex string");
  }
  return Buffer.from(clean, "hex");
}

function normalizePublicInputBytes32(value: Buffer, index: number): Buffer {
  if (!Buffer.isBuffer(value)) {
    throw new Error(`publicInputs[${index}] must be a Buffer`);
  }
  if (value.length !== 32) {
    throw new Error(`publicInputs[${index}] must be 32 bytes`);
  }
  return value;
}

export async function settleOnChainPoolZk(params: SettleOnChainPoolZkParams): Promise<OnChainTxResult> {
  return runSerializedAdminTx(async () => {
    const client = getClient();
    if (!Buffer.isBuffer(params.proof) || params.proof.length !== 256) {
      throw new Error("proof must be a 256-byte Groth16 calldata buffer");
    }
    if (!Array.isArray(params.publicInputs) || params.publicInputs.length < 3) {
      throw new Error("publicInputs must include at least [match_id, pool_id, winner_side]");
    }

    const normalizedPublicInputs = params.publicInputs.map((value, index) => normalizePublicInputBytes32(value, index));

    const tx = await client.settle_pool_zk({
      pool_id: params.poolId,
      winner: params.winner === "player1" ? BetSide.Player1 : BetSide.Player2,
      vk_id: normalizeHex32(params.vkIdHex),
      proof: params.proof,
      public_inputs: normalizedPublicInputs,
    });

    try {
      return await signAndSend(tx);
    } catch (error) {
      const reason = classifyContractError(error);
      if (reason === "already_settled") {
        return { skipped: true, reason };
      }
      throw error;
    }
  });
}

export async function ensureZkBettingVerifierConfigured(params: {
  vkIdHex: string;
  verificationKeyPath: string;
}): Promise<void> {
  return runSerializedAdminTx(async () => {
    const normalizedVk = `0x${normalizeHex32(params.vkIdHex).toString("hex")}`;

    if (!ZK_GROTH16_VERIFIER_CONTRACT_ID) {
      throw new Error("Missing ZK_GROTH16_VERIFIER_CONTRACT_ID");
    }

    if (configuredBettingVkIdHex === normalizedVk) {
      return;
    }

    const upload = await setGroth16VerificationKeyOnChain(
      ZK_GROTH16_VERIFIER_CONTRACT_ID,
      normalizedVk,
      params.verificationKeyPath,
    );
    if (!upload.success) {
      throw new Error(upload.error || "Failed to upload Groth16 verification key for zk-betting");
    }

    const client = getClient();
    const tx = await client.set_zk_verifier({
      verifier: ZK_GROTH16_VERIFIER_CONTRACT_ID,
      vk_id: normalizeHex32(normalizedVk),
    });
    await signAndSend(tx);

    configuredBettingVkIdHex = normalizedVk;
  });
}

export async function getOnChainPoolStatus(poolId: number): Promise<{ status: number; winnerSide: number } | null> {
  return runSerializedAdminTx(async () => {
    try {
      const client = getClient();
      const tx = await client.get_pool({ pool_id: poolId });
      const sim = await tx.simulate();
      const result = sim.result as any;
      if (!result) return null;
      const status = Number(result.status ?? result?.value?.status ?? -1);
      const winnerSide = Number(result.winner_side ?? result?.value?.winner_side ?? 255);
      if (!Number.isFinite(status)) return null;
      return { status, winnerSide };
    } catch {
      return null;
    }
  });
}

export async function revealOnChainBetAsAdmin(params: {
  poolId: number;
  bettor: string;
  side: "player1" | "player2";
  saltHex: string;
}): Promise<OnChainRevealResult> {
  return runSerializedAdminTx(async () => {
    const client = getClient();
    const tx = await client.admin_reveal_bet({
      pool_id: params.poolId,
      bettor: params.bettor,
      side: params.side === "player1" ? BetSide.Player1 : BetSide.Player2,
      salt: normalizeHexToBuffer(params.saltHex),
    });
    try {
      return await signAndSend(tx);
    } catch (error) {
      const reason = classifyRevealError(error);
      if (reason) {
        return { skipped: true, reason };
      }
      throw error;
    }
  });
}

export async function claimOnChainPayoutAsAdmin(params: {
  poolId: number;
  bettor: string;
}): Promise<OnChainClaimResult> {
  return runSerializedAdminTx(async () => {
    const client = getClient();
    const tx = await client.admin_claim_payout({
      pool_id: params.poolId,
      bettor: params.bettor,
    });

    try {
      const sent = await signAndSend(tx);
      const result = (sent as any)?.result;
      let payoutAmount: bigint | undefined;
      if (typeof result === "bigint") payoutAmount = result;
      if (typeof result === "number") payoutAmount = BigInt(result);
      if (typeof result === "string" && /^-?\d+$/.test(result)) payoutAmount = BigInt(result);
      return { txHash: extractTxHash(sent), payoutAmount };
    } catch (error) {
      const reason = classifyClaimError(error);
      if (reason) {
        return { skipped: true, reason };
      }
      throw error;
    }
  });
}
