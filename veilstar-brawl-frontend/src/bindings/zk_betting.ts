import { Buffer } from "buffer";
import { Address } from "@stellar/stellar-sdk";
import {
  AssembledTransaction,
  Client as ContractClient,
  ClientOptions as ContractClientOptions,
  MethodOptions,
  Result,
  Spec as ContractSpec,
} from "@stellar/stellar-sdk/contract";
import type {
  u32,
  i32,
  u64,
  i64,
  u128,
  i128,
  u256,
  i256,
  Option,
  Timepoint,
  Duration,
} from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";

if (typeof window !== "undefined") {
  //@ts-ignore Buffer exists
  window.Buffer = window.Buffer || Buffer;
}


export const networks = {
  testnet: {
    networkPassphrase: "Test SDF Network ; September 2015",
    contractId: "CAXLEDHRDFD3E3NYMBJTIIGFAXUVKKE7352XSMUALPSOEMPF7SA7F5AH",
  }
} as const

export const Errors = {
  1: {message:"PoolNotFound"},
  2: {message:"PoolNotOpen"},
  3: {message:"PoolNotLocked"},
  4: {message:"PoolNotSettled"},
  5: {message:"PoolAlreadySettled"},
  6: {message:"PoolAlreadyLocked"},
  7: {message:"AlreadyCommitted"},
  8: {message:"BetNotFound"},
  9: {message:"AlreadyRevealed"},
  10: {message:"InvalidReveal"},
  11: {message:"InvalidAmount"},
  12: {message:"InvalidWinner"},
  13: {message:"NoPayout"},
  14: {message:"AlreadyClaimed"},
  15: {message:"Unauthorized"},
  16: {message:"ZkVerifierNotConfigured"},
  17: {message:"ZkProofInvalid"},
  18: {message:"BettingDeadlinePassed"},
  19: {message:"NothingToSweep"},
  20: {message:"SweepTooEarly"}
}


export interface BetPool {
  bet_count: u32;
  deadline_ts: u64;
  match_id: Buffer;
  player1_total: i128;
  player2_total: i128;
  pool_id: u32;
  reveal_count: u32;
  status: PoolStatus;
  total_fees: i128;
  total_pool: i128;
  /**
 * Winner side: 0=Player1, 1=Player2, 255=None
 */
winner_side: u32;
}

export enum BetSide {
  Player1 = 0,
  Player2 = 1,
}

export type DataKey = {tag: "Admin", values: void} | {tag: "Treasury", values: void} | {tag: "XlmToken", values: void} | {tag: "ZkVerifier", values: void} | {tag: "ZkVkId", values: void} | {tag: "FeeAccrued", values: void} | {tag: "LastSweepTs", values: void} | {tag: "PoolCounter", values: void} | {tag: "Pool", values: readonly [u32]} | {tag: "Bet", values: readonly [u32, string]} | {tag: "PoolBettors", values: readonly [u32]};


export interface BetCommit {
  amount: i128;
  bettor: string;
  claimed: boolean;
  commitment: Buffer;
  fee_paid: i128;
  revealed: boolean;
  /**
 * Revealed side: 0=Player1, 1=Player2, 255=None
 */
side: u32;
}

export enum PoolStatus {
  Open = 0,
  Locked = 1,
  Settled = 2,
  Refunded = 3,
}

export interface Client {
  /**
   * Construct and simulate a get_bet transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_bet: ({pool_id, bettor}: {pool_id: u32, bettor: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<BetCommit>>>

  /**
   * Construct and simulate a upgrade transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  upgrade: ({new_wasm_hash}: {new_wasm_hash: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a get_pool transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_pool: ({pool_id}: {pool_id: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<BetPool>>>

  /**
   * Construct and simulate a get_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_admin: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a lock_pool transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Lock the pool — no more bets accepted.
   */
  lock_pool: ({pool_id}: {pool_id: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_admin: ({new_admin}: {new_admin: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a commit_bet transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Commit a bet with a hidden side.
   * 
   * The commitment is SHA256(side_byte || salt_bytes).
   * - side_byte: 0 = Player1, 1 = Player2
   * - salt_bytes: 32 random bytes chosen by bettor
   * 
   * Bettor deposits `amount + 1% fee` in XLM.
   */
  commit_bet: ({pool_id, bettor, commitment, amount}: {pool_id: u32, bettor: string, commitment: Buffer, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a reveal_bet transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Reveal the bet — bettor provides the original `side` + `salt`.
   * Contract verifies SHA256(side_byte || salt) == stored commitment.
   */
  reveal_bet: ({pool_id, bettor, side, salt}: {pool_id: u32, bettor: string, side: BetSide, salt: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a create_pool transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Create a new betting pool for a match.
   * 
   * # Arguments
   * * `match_id`    – 32-byte match identifier (SHA256 of UUID or similar)
   * * `deadline_ts` – Unix timestamp when betting closes
   */
  create_pool: ({match_id, deadline_ts}: {match_id: Buffer, deadline_ts: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u32>>>

  /**
   * Construct and simulate a refund_pool transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Refund all bettors (match cancelled).
   */
  refund_pool: ({pool_id}: {pool_id: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a settle_pool transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Settle the pool — admin declares the winner.
   * Unrevealed bets are treated as losses (forfeited).
   */
  settle_pool: ({pool_id, winner}: {pool_id: u32, winner: BetSide}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a claim_payout transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Claim payout after settlement.
   * 
   * House model payout:
   * - Winning revealed bet gets fixed `2x` of stake amount.
   * - Losing or unrevealed bet gets no payout.
   */
  claim_payout: ({pool_id, bettor}: {pool_id: u32, bettor: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a set_treasury transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_treasury: ({new_treasury}: {new_treasury: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a settle_pool_zk transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Settle using a ZK proof of the match outcome.
   * The proof is verified against the configured zk-groth16-verifier contract.
   */
  settle_pool_zk: ({pool_id, winner, vk_id, proof, public_inputs}: {pool_id: u32, winner: BetSide, vk_id: Buffer, proof: Buffer, public_inputs: Array<Buffer>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a sweep_treasury transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Transfer accrued protocol fees to treasury (max once per 24h).
   */
  sweep_treasury: (options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a get_fee_accrued transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_fee_accrued: (options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a set_zk_verifier transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_zk_verifier: ({verifier, vk_id}: {verifier: string, vk_id: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a admin_reveal_bet transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Admin reveal path for house-managed bot betting flow.
   * Uses bettor commitment + provided side/salt but does not require bettor auth.
   */
  admin_reveal_bet: ({pool_id, bettor, side, salt}: {pool_id: u32, bettor: string, side: BetSide, salt: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_pool_counter transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_pool_counter: (options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a admin_claim_payout transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Admin claim path for house-managed bot betting flow.
   * Transfers payout directly to bettor without requiring bettor auth.
   */
  admin_claim_payout: ({pool_id, bettor}: {pool_id: u32, bettor: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
        /** Constructor/Initialization Args for the contract's `__constructor` method */
        {admin, treasury, xlm_token}: {admin: string, treasury: string, xlm_token: string},
    /** Options for initializing a Client as well as for calling a method, with extras specific to deploying. */
    options: MethodOptions &
      Omit<ContractClientOptions, "contractId"> & {
        /** The hash of the Wasm blob, which must already be installed on-chain. */
        wasmHash: Buffer | string;
        /** Salt used to generate the contract's ID. Passed through to {@link Operation.createCustomContract}. Default: random. */
        salt?: Buffer | Uint8Array;
        /** The format used to decode `wasmHash`, if it's provided as a string. */
        format?: "hex" | "base64";
      }
  ): Promise<AssembledTransaction<T>> {
    return ContractClient.deploy({admin, treasury, xlm_token}, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "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",
        "AAAAAAAAAAAAAAAJZ2V0X2FkbWluAAAAAAAAAAAAAAEAAAAT",
        "AAAAAAAAAChMb2NrIHRoZSBwb29sIOKAlCBubyBtb3JlIGJldHMgYWNjZXB0ZWQuAAAACWxvY2tfcG9vbAAAAAAAAAEAAAAAAAAAB3Bvb2xfaWQAAAAABAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAAAAAAAJc2V0X2FkbWluAAAAAAAAAQAAAAAAAAAJbmV3X2FkbWluAAAAAAAAEwAAAAA=",
        "AAAAAAAAANRDb21taXQgYSBiZXQgd2l0aCBhIGhpZGRlbiBzaWRlLgoKVGhlIGNvbW1pdG1lbnQgaXMgU0hBMjU2KHNpZGVfYnl0ZSB8fCBzYWx0X2J5dGVzKS4KLSBzaWRlX2J5dGU6IDAgPSBQbGF5ZXIxLCAxID0gUGxheWVyMgotIHNhbHRfYnl0ZXM6IDMyIHJhbmRvbSBieXRlcyBjaG9zZW4gYnkgYmV0dG9yCgpCZXR0b3IgZGVwb3NpdHMgYGFtb3VudCArIDElIGZlZWAgaW4gWExNLgAAAApjb21taXRfYmV0AAAAAAAEAAAAAAAAAAdwb29sX2lkAAAAAAQAAAAAAAAABmJldHRvcgAAAAAAEwAAAAAAAAAKY29tbWl0bWVudAAAAAAD7gAAACAAAAAAAAAABmFtb3VudAAAAAAACwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAIJSZXZlYWwgdGhlIGJldCDigJQgYmV0dG9yIHByb3ZpZGVzIHRoZSBvcmlnaW5hbCBgc2lkZWAgKyBgc2FsdGAuCkNvbnRyYWN0IHZlcmlmaWVzIFNIQTI1NihzaWRlX2J5dGUgfHwgc2FsdCkgPT0gc3RvcmVkIGNvbW1pdG1lbnQuAAAAAAAKcmV2ZWFsX2JldAAAAAAABAAAAAAAAAAHcG9vbF9pZAAAAAAEAAAAAAAAAAZiZXR0b3IAAAAAABMAAAAAAAAABHNpZGUAAAfQAAAAB0JldFNpZGUAAAAAAAAAAARzYWx0AAAD7gAAACAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAALNDcmVhdGUgYSBuZXcgYmV0dGluZyBwb29sIGZvciBhIG1hdGNoLgoKIyBBcmd1bWVudHMKKiBgbWF0Y2hfaWRgICAgIOKAkyAzMi1ieXRlIG1hdGNoIGlkZW50aWZpZXIgKFNIQTI1NiBvZiBVVUlEIG9yIHNpbWlsYXIpCiogYGRlYWRsaW5lX3RzYCDigJMgVW5peCB0aW1lc3RhbXAgd2hlbiBiZXR0aW5nIGNsb3NlcwAAAAALY3JlYXRlX3Bvb2wAAAAAAgAAAAAAAAAIbWF0Y2hfaWQAAAPuAAAAIAAAAAAAAAALZGVhZGxpbmVfdHMAAAAABgAAAAEAAAPpAAAABAAAAAM=",
        "AAAAAAAAACVSZWZ1bmQgYWxsIGJldHRvcnMgKG1hdGNoIGNhbmNlbGxlZCkuAAAAAAAAC3JlZnVuZF9wb29sAAAAAAEAAAAAAAAAB3Bvb2xfaWQAAAAABAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAGFTZXR0bGUgdGhlIHBvb2wg4oCUIGFkbWluIGRlY2xhcmVzIHRoZSB3aW5uZXIuClVucmV2ZWFsZWQgYmV0cyBhcmUgdHJlYXRlZCBhcyBsb3NzZXMgKGZvcmZlaXRlZCkuAAAAAAAAC3NldHRsZV9wb29sAAAAAAIAAAAAAAAAB3Bvb2xfaWQAAAAABAAAAAAAAAAGd2lubmVyAAAAAAfQAAAAB0JldFNpZGUAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAJZDbGFpbSBwYXlvdXQgYWZ0ZXIgc2V0dGxlbWVudC4KCkhvdXNlIG1vZGVsIHBheW91dDoKLSBXaW5uaW5nIHJldmVhbGVkIGJldCBnZXRzIGZpeGVkIGAyeGAgb2Ygc3Rha2UgYW1vdW50LgotIExvc2luZyBvciB1bnJldmVhbGVkIGJldCBnZXRzIG5vIHBheW91dC4AAAAAAAxjbGFpbV9wYXlvdXQAAAACAAAAAAAAAAdwb29sX2lkAAAAAAQAAAAAAAAABmJldHRvcgAAAAAAEwAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAAAAAAAMc2V0X3RyZWFzdXJ5AAAAAQAAAAAAAAAMbmV3X3RyZWFzdXJ5AAAAEwAAAAA=",
        "AAAAAAAAAAAAAAANX19jb25zdHJ1Y3RvcgAAAAAAAAMAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAAIdHJlYXN1cnkAAAATAAAAAAAAAAl4bG1fdG9rZW4AAAAAAAATAAAAAA==",
        "AAAAAAAAAHhTZXR0bGUgdXNpbmcgYSBaSyBwcm9vZiBvZiB0aGUgbWF0Y2ggb3V0Y29tZS4KVGhlIHByb29mIGlzIHZlcmlmaWVkIGFnYWluc3QgdGhlIGNvbmZpZ3VyZWQgemstZ3JvdGgxNi12ZXJpZmllciBjb250cmFjdC4AAAAOc2V0dGxlX3Bvb2xfemsAAAAAAAUAAAAAAAAAB3Bvb2xfaWQAAAAABAAAAAAAAAAGd2lubmVyAAAAAAfQAAAAB0JldFNpZGUAAAAAAAAAAAV2a19pZAAAAAAAA+4AAAAgAAAAAAAAAAVwcm9vZgAAAAAAAA4AAAAAAAAADXB1YmxpY19pbnB1dHMAAAAAAAPqAAAD7gAAACAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAD5UcmFuc2ZlciBhY2NydWVkIHByb3RvY29sIGZlZXMgdG8gdHJlYXN1cnkgKG1heCBvbmNlIHBlciAyNGgpLgAAAAAADnN3ZWVwX3RyZWFzdXJ5AAAAAAAAAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAAAAAAAAPZ2V0X2ZlZV9hY2NydWVkAAAAAAAAAAABAAAACw==",
        "AAAAAAAAAAAAAAAPc2V0X3prX3ZlcmlmaWVyAAAAAAIAAAAAAAAACHZlcmlmaWVyAAAAEwAAAAAAAAAFdmtfaWQAAAAAAAPuAAAAIAAAAAA=",
        "AAAAAAAAAINBZG1pbiByZXZlYWwgcGF0aCBmb3IgaG91c2UtbWFuYWdlZCBib3QgYmV0dGluZyBmbG93LgpVc2VzIGJldHRvciBjb21taXRtZW50ICsgcHJvdmlkZWQgc2lkZS9zYWx0IGJ1dCBkb2VzIG5vdCByZXF1aXJlIGJldHRvciBhdXRoLgAAAAAQYWRtaW5fcmV2ZWFsX2JldAAAAAQAAAAAAAAAB3Bvb2xfaWQAAAAABAAAAAAAAAAGYmV0dG9yAAAAAAATAAAAAAAAAARzaWRlAAAH0AAAAAdCZXRTaWRlAAAAAAAAAAAEc2FsdAAAA+4AAAAgAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAAQZ2V0X3Bvb2xfY291bnRlcgAAAAAAAAABAAAABA==",
        "AAAAAAAAAHdBZG1pbiBjbGFpbSBwYXRoIGZvciBob3VzZS1tYW5hZ2VkIGJvdCBiZXR0aW5nIGZsb3cuClRyYW5zZmVycyBwYXlvdXQgZGlyZWN0bHkgdG8gYmV0dG9yIHdpdGhvdXQgcmVxdWlyaW5nIGJldHRvciBhdXRoLgAAAAASYWRtaW5fY2xhaW1fcGF5b3V0AAAAAAACAAAAAAAAAAdwb29sX2lkAAAAAAQAAAAAAAAABmJldHRvcgAAAAAAEwAAAAEAAAPpAAAACwAAAAM=" ]),
      options
    )
  }
  public readonly fromJSON = {
    get_bet: this.txFromJSON<Result<BetCommit>>,
        upgrade: this.txFromJSON<null>,
        get_pool: this.txFromJSON<Result<BetPool>>,
        get_admin: this.txFromJSON<string>,
        lock_pool: this.txFromJSON<Result<void>>,
        set_admin: this.txFromJSON<null>,
        commit_bet: this.txFromJSON<Result<void>>,
        reveal_bet: this.txFromJSON<Result<void>>,
        create_pool: this.txFromJSON<Result<u32>>,
        refund_pool: this.txFromJSON<Result<void>>,
        settle_pool: this.txFromJSON<Result<void>>,
        claim_payout: this.txFromJSON<Result<i128>>,
        set_treasury: this.txFromJSON<null>,
        settle_pool_zk: this.txFromJSON<Result<void>>,
        sweep_treasury: this.txFromJSON<Result<i128>>,
        get_fee_accrued: this.txFromJSON<i128>,
        set_zk_verifier: this.txFromJSON<null>,
        admin_reveal_bet: this.txFromJSON<Result<void>>,
        get_pool_counter: this.txFromJSON<u32>,
        admin_claim_payout: this.txFromJSON<Result<i128>>
  }
}
