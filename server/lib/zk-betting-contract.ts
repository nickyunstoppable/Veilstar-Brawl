import { createHash } from "node:crypto";
import { Buffer } from "buffer";
import { Client as ZkBettingClient, BetSide } from "../../bindings/zk_betting/src/index";
import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { ensureEnvLoaded } from "./env";

ensureEnvLoaded();

const RPC_URL = process.env.VITE_SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = process.env.VITE_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015";
const ZK_BETTING_CONTRACT_ID = process.env.VITE_ZK_BETTING_CONTRACT_ID || "";
const ADMIN_SECRET = process.env.VITE_DEV_ADMIN_SECRET || "";
let adminTxQueue: Promise<void> = Promise.resolve();

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
    signAuthEntry: async (authEntry: string) => ({ signedAuthEntry: authEntry, signerAddress: keypair.publicKey() }),
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
      const simulated = typeof tx?.simulate === "function" ? await tx.simulate() : tx;
      const sent = await simulated.signAndSend();
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

function matchIdToBytes32(matchId: string): Buffer {
  return createHash("sha256").update(matchId).digest();
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
    const sent = await signAndSend(tx);

    const poolCounterTx = await client.get_pool_counter();
    const sim = await poolCounterTx.simulate();
    const result = sim.result as any;
    const poolId = typeof result === "number" ? result : Number(result?.value ?? result?.ok ?? result ?? 0);
    if (!poolId) throw new Error("Failed to read on-chain pool counter after create_pool");

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
  return runSerializedAdminTx(async () => {
    const client = getClient();
    const tx = await client.settle_pool({
      pool_id: poolId,
      winner: winner === "player1" ? BetSide.Player1 : BetSide.Player2,
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
