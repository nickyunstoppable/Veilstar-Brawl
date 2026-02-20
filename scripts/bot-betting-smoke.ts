import { createHash, randomBytes } from "node:crypto";
import { Client as ZkBettingClient } from "../bindings/zk_betting/src/index";
import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";

const API = process.env.API_BASE_URL?.trim() || "http://127.0.0.1:3001";
const RPC_URL = process.env.VITE_SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = process.env.VITE_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015";
const CONTRACT_ID = process.env.VITE_ZK_BETTING_CONTRACT_ID || "";

const BETTOR_ADDRESS = process.env.VITE_DEV_PLAYER1_ADDRESS || "";
const BETTOR_SECRET = process.env.VITE_DEV_PLAYER1_SECRET || "";

function assertEnv(name: string, value: string) {
  if (!value) throw new Error(`Missing ${name}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function sideByte(side: "player1" | "player2"): number {
  return side === "player1" ? 0 : 1;
}

function extractTxHash(sentTx: unknown): string | undefined {
  const tx = sentTx as any;
  return tx?.hash || tx?.txHash || tx?.sendTransactionResponse?.hash || tx?.result?.hash;
}

async function getJson(path: string): Promise<any> {
  const response = await fetch(`${API}${path}`);
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${path} -> ${response.status} ${JSON.stringify(json)}`);
  return json;
}

async function postJson(path: string, body: unknown): Promise<any> {
  const response = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${path} -> ${response.status} ${JSON.stringify(json)}`);
  return json;
}

function createSigner(secret: string) {
  const keypair = Keypair.fromSecret(secret);
  return {
    signTransaction: async (xdr: string, opts?: any) => {
      const tx = TransactionBuilder.fromXDR(xdr, opts?.networkPassphrase || NETWORK_PASSPHRASE);
      tx.sign(keypair);
      return { signedTxXdr: tx.toXDR(), signerAddress: keypair.publicKey() };
    },
    signAuthEntry: async (authEntry: string) => ({ signedAuthEntry: authEntry, signerAddress: keypair.publicKey() }),
  };
}

async function signAndSend(tx: any): Promise<{ txHash?: string }> {
  const simulated = typeof tx?.simulate === "function" ? await tx.simulate() : tx;
  const sent = await simulated.signAndSend();
  return { txHash: extractTxHash(sent) };
}

async function commitBetOnChain(params: {
  poolId: number;
  bettor: string;
  side: "player1" | "player2";
  amount: bigint;
}) {
  const salt = randomBytes(32);
  const preimage = Buffer.concat([Buffer.from([sideByte(params.side)]), salt]);
  const commitment = createHash("sha256").update(preimage).digest();

  const client = new ZkBettingClient({
    contractId: CONTRACT_ID,
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcUrl: RPC_URL,
    publicKey: params.bettor,
    ...createSigner(BETTOR_SECRET),
  });

  const tx = await client.commit_bet({
    pool_id: params.poolId,
    bettor: params.bettor,
    commitment,
    amount: params.amount,
  });

  const sent = await signAndSend(tx);

  return {
    txHash: sent.txHash,
    commitmentHex: toHex(commitment),
    saltHex: toHex(salt),
  };
}

async function main() {
  assertEnv("VITE_ZK_BETTING_CONTRACT_ID", CONTRACT_ID);
  assertEnv("VITE_DEV_PLAYER1_ADDRESS", BETTOR_ADDRESS);
  assertEnv("VITE_DEV_PLAYER1_SECRET", BETTOR_SECRET);

  const health = await getJson("/api/health");
  if (health?.status !== "ok") throw new Error("Health check failed");

  const bot = await getJson("/api/bot-games");
  let match = bot?.match;
  if (!match?.id) throw new Error("No active bot match");

  const freshWindowMs = 10000;
  const maxFreshWaitMs = 90000;
  const initialSeenMatchId = String(match.id);
  const startedWaitingAt = Date.now();

  while (true) {
    const elapsed = Date.now() - Number(match.createdAt || 0);
    const isFresh = Number.isFinite(elapsed) && elapsed < freshWindowMs;
    if (isFresh) break;

    if (Date.now() - startedWaitingAt > maxFreshWaitMs) {
      throw new Error("Timed out waiting for a fresh bot match window");
    }

    await sleep(2500);
    const latest = await getJson("/api/bot-games");
    if (latest?.match?.id) {
      match = latest.match;
      const changed = String(match.id) !== initialSeenMatchId;
      if (changed) {
        const changedElapsed = Date.now() - Number(match.createdAt || 0);
        if (Number.isFinite(changedElapsed) && changedElapsed < freshWindowMs) {
          break;
        }
      }
    }
  }

  const side: "player1" | "player2" = Math.random() < 0.5 ? "player1" : "player2";
  const amount = 10_000_000n; // 1 XLM

  const poolSnap = await getJson(`/api/bot-betting/pool/${match.id}?address=${encodeURIComponent(BETTOR_ADDRESS)}`);
  const onchainPoolId = Number(poolSnap?.pool?.onchain_pool_id || 0);
  if (!onchainPoolId) throw new Error("On-chain pool not ready yet");

  if (!poolSnap?.userBet) {
    const commit = await commitBetOnChain({
      poolId: onchainPoolId,
      bettor: BETTOR_ADDRESS,
      side,
      amount,
    });

    await postJson("/api/bot-betting/place", {
      matchId: match.id,
      betOn: side,
      amount: Number(amount),
      bettorAddress: BETTOR_ADDRESS,
      onchainPoolId,
      txId: commit.txHash,
      commitmentHash: commit.commitmentHex,
      revealSalt: commit.saltHex,
    });
  }

  const durationMs = Number(match.totalTurns || 16) * Number(match.turnDurationMs || 2500) + 40000;
  const deadline = Date.now() + Math.max(durationMs, 60000);

  let last: any = null;
  while (Date.now() < deadline) {
    // Drive lifecycle sync that powers lock/finalize progression.
    await getJson(`/api/bot-games?matchId=${encodeURIComponent(match.id)}`).catch(() => null);
    await getJson(`/api/bot-games/sync?matchId=${encodeURIComponent(match.id)}`).catch(() => null);

    const snap = await getJson(`/api/bot-betting/pool/${match.id}?address=${encodeURIComponent(BETTOR_ADDRESS)}`);
    last = snap;
    const userBet = snap?.userBet;
    const pool = snap?.pool;

    const resolved = pool?.status === "resolved" || pool?.onchain_status === "settled";
    const wonAndClaimed = userBet?.status === "won" && !!userBet?.claim_tx_id;
    const lostResolved = userBet?.status === "lost" && resolved;

    if (wonAndClaimed || lostResolved) {
      console.log(JSON.stringify({
        ok: true,
        matchId: match.id,
        onchainPoolId,
        poolStatus: pool?.status,
        onchainStatus: pool?.onchain_status,
        winner: pool?.winner,
        betStatus: userBet?.status,
        revealed: userBet?.revealed,
        claimTxId: userBet?.claim_tx_id || null,
        payoutAmount: userBet?.payout_amount || null,
      }, null, 2));
      return;
    }

    await sleep(3000);
  }

  console.log(JSON.stringify({
    ok: false,
    reason: "timeout_waiting_for_settlement",
    matchId: match.id,
    snapshot: {
      poolStatus: last?.pool?.status,
      onchainStatus: last?.pool?.onchain_status,
      winner: last?.pool?.winner,
      betStatus: last?.userBet?.status,
      revealed: last?.userBet?.revealed,
      claimTxId: last?.userBet?.claim_tx_id || null,
      payoutAmount: last?.userBet?.payout_amount || null,
    },
  }, null, 2));
  process.exit(1);
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
