import { Buffer } from "buffer";
import { Client as ZkBettingClient, BetSide } from "../../../../bindings/zk_betting/src/index";
import type { ContractSigner } from "../../types/signer";
import { NETWORK_PASSPHRASE, RPC_URL, getContractId } from "../../utils/constants";
import { signAndSendViaLaunchtube } from "../../utils/transactionHelper";

export type BetSideLabel = "player1" | "player2";

export interface CommitBetResult {
  txHash?: string;
  commitmentHex: string;
  saltHex: string;
}

function sideToEnum(side: BetSideLabel): BetSide {
  return side === "player1" ? BetSide.Player1 : BetSide.Player2;
}

function extractTxHash(sentTx: unknown): string | undefined {
  const tx = sentTx as any;
  return tx?.hash || tx?.txHash || tx?.sendTransactionResponse?.hash || tx?.result?.hash;
}

async function sha256(input: Uint8Array): Promise<Uint8Array> {
  const bytes = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(digest);
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function fromHex(hex: string): Uint8Array {
  const clean = hex.trim().replace(/^0x/i, "");
  if (clean.length % 2 !== 0) throw new Error("Invalid hex length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function getContractClient(publicKey: string, signer: ContractSigner): ZkBettingClient {
  const contractId = getContractId("zk-betting");
  if (!contractId) {
    throw new Error("Missing VITE_ZK_BETTING_CONTRACT_ID");
  }

  return new ZkBettingClient({
    contractId,
    publicKey,
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcUrl: RPC_URL,
    signAuthEntry: signer.signAuthEntry,
    signTransaction: signer.signTransaction,
  });
}

async function signAndSend(tx: any): Promise<any> {
  return signAndSendViaLaunchtube(tx);
}

function readPoolStatusValue(rawStatus: unknown): number | null {
  if (typeof rawStatus === "number" && Number.isFinite(rawStatus)) {
    return rawStatus;
  }

  if (typeof rawStatus === "string") {
    const normalized = rawStatus.toLowerCase();
    if (normalized === "open") return 0;
    if (normalized === "locked") return 1;
    if (normalized === "settled") return 2;
    if (normalized === "refunded") return 3;
    const asNum = Number(rawStatus);
    if (Number.isFinite(asNum)) return asNum;
  }

  if (rawStatus && typeof rawStatus === "object") {
    const tagged = rawStatus as { tag?: unknown; value?: unknown; kind?: unknown };
    const tag = String(tagged.tag ?? tagged.kind ?? "").toLowerCase();
    if (tag === "open") return 0;
    if (tag === "locked") return 1;
    if (tag === "settled") return 2;
    if (tag === "refunded") return 3;

    const value = Number(tagged.value);
    if (Number.isFinite(value)) return value;
  }

  return null;
}

export async function commitBetOnChain(params: {
  poolId: number;
  bettor: string;
  side: BetSideLabel;
  amount: bigint;
  signer: ContractSigner;
}): Promise<CommitBetResult> {
  const sideByte = params.side === "player1" ? 0 : 1;
  const salt = randomBytes(32);
  const preimage = new Uint8Array(33);
  preimage[0] = sideByte;
  preimage.set(salt, 1);
  const commitment = await sha256(preimage);

  const client = getContractClient(params.bettor, params.signer);

  const poolReadTx = await client.get_pool({ pool_id: params.poolId });
  const poolReadResult = (poolReadTx as any)?.result as any;
  const poolState = (poolReadResult?.value ?? poolReadResult?.ok ?? poolReadResult) as any;
  const poolStatus = readPoolStatusValue(poolState?.status);
  if (poolStatus !== null && poolStatus !== 0) {
    throw new Error("Pool is not open on-chain. Please refresh and try the current match.");
  }

  const tx = await client.commit_bet({
    pool_id: params.poolId,
    bettor: params.bettor,
    commitment: Buffer.from(commitment),
    amount: params.amount,
  });

  let sentTx: any;
  try {
    sentTx = await signAndSend(tx);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error ?? "");
    if (msg.includes("Error(Contract, #1)")) {
      throw new Error("Pool changed. Refresh and place your bet again.");
    }
    if (msg.includes("Error(Contract, #18)")) {
      throw new Error("Betting deadline passed for this match. Please wait for the next one.");
    }
    if (msg.includes("Error(Contract, #7)")) {
      throw new Error("You already placed a bet for this match.");
    }
    if (msg.includes("Error(Contract, #2)")) {
      throw new Error("Bet failed on-chain. Refresh and try again.");
    }
    throw error;
  }

  return {
    txHash: extractTxHash(sentTx),
    commitmentHex: toHex(commitment),
    saltHex: toHex(salt),
  };
}

export async function revealBetOnChain(params: {
  poolId: number;
  bettor: string;
  side: BetSideLabel;
  saltHex: string;
  signer: ContractSigner;
}): Promise<{ txHash?: string }> {
  const client = getContractClient(params.bettor, params.signer);
  const tx = await client.reveal_bet({
    pool_id: params.poolId,
    bettor: params.bettor,
    side: sideToEnum(params.side),
    salt: Buffer.from(fromHex(params.saltHex)),
  });

  const sentTx = await signAndSend(tx);
  return { txHash: extractTxHash(sentTx) };
}

export async function claimPayoutOnChain(params: {
  poolId: number;
  bettor: string;
  signer: ContractSigner;
}): Promise<{ txHash?: string; payoutAmount?: bigint }> {
  const client = getContractClient(params.bettor, params.signer);
  const tx = await client.claim_payout({
    pool_id: params.poolId,
    bettor: params.bettor,
  });

  const sentTx = await signAndSend(tx);
  const result = (sentTx as any)?.result;
  let payoutAmount: bigint | undefined;
  if (typeof result === "bigint") payoutAmount = result;
  if (typeof result === "number") payoutAmount = BigInt(result);
  if (typeof result === "string" && /^-?\d+$/.test(result)) payoutAmount = BigInt(result);

  return {
    txHash: extractTxHash(sentTx),
    payoutAmount,
  };
}
