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

type OnChainTxResult = {
  txHash?: string;
  skipped?: boolean;
  reason?: "already_locked" | "already_settled";
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
  return msg.includes("TRY_AGAIN_LATER") || msg.includes("SendFailed") || msg.includes("PENDING");
}

async function signAndSend(tx: any, options?: { maxRetries?: number; initialDelayMs?: number }): Promise<{ txHash?: string }> {
  const maxRetries = options?.maxRetries ?? 4;
  let delayMs = options?.initialDelayMs ?? 600;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const sent = await tx.signAndSend();
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

function classifyContractError(error: unknown): "already_locked" | "already_settled" | null {
  const msg = error instanceof Error ? error.message : String(error ?? "");
  if (msg.includes("Error(Contract, #6)")) return "already_locked";
  if (msg.includes("Error(Contract, #5)")) return "already_settled";
  return null;
}

function matchIdToBytes32(matchId: string): Buffer {
  return createHash("sha256").update(matchId).digest();
}

export function isZkBettingConfigured(): boolean {
  return !!(ZK_BETTING_CONTRACT_ID && ADMIN_SECRET);
}

export async function createOnChainBotPool(matchId: string, deadlineTs: number): Promise<{ poolId: number; txHash?: string }> {
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
}

export async function lockOnChainPool(poolId: number): Promise<OnChainTxResult> {
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
}

export async function settleOnChainPool(poolId: number, winner: "player1" | "player2"): Promise<OnChainTxResult> {
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
}
