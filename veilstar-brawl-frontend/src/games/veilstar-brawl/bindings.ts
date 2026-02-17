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
    contractId: "CD5PRKC3VAHGQIIBKAIRLANWQWNYB3CUJAMQ7AEAAPCXKMVM4NKDQD4F",
  }
} as const

export const Errors = {
  1: {message:"MatchNotFound"},
  2: {message:"NotPlayer"},
  3: {message:"MatchAlreadyEnded"},
  4: {message:"MatchNotInProgress"},
  5: {message:"InsufficientBalance"},
  6: {message:"NothingToSweep"},
  7: {message:"InvalidStake"},
  8: {message:"StakeNotConfigured"},
  9: {message:"StakeAlreadyPaid"},
  10: {message:"StakeNotPaid"},
  11: {message:"SweepTooEarly"},
  12: {message:"StakeDepositExpired"},
  13: {message:"DeadlineNotReached"},
  14: {message:"MatchCancelled"},
  15: {message:"InvalidZkCommitment"},
  16: {message:"ZkCommitAlreadySubmitted"},
  17: {message:"ZkCommitRequired"},
  18: {message:"InvalidZkVerifier"},
  19: {message:"ZkCommitNotFound"},
  20: {message:"ZkVerificationAlreadySubmitted"},
  21: {message:"ZkProofInvalid"},
  22: {message:"ZkVerifierNotConfigured"},
  23: {message:"ZkMatchOutcomeRequired"},
  24: {message:"InvalidWinnerClaim"}
}


export interface Match {
  fee_accrued_stroops: i128;
  is_cancelled: boolean;
  player1: string;
  player1_moves: u32;
  player1_points: i128;
  player1_stake_paid: boolean;
  player1_zk_commits: u32;
  player1_zk_verified: u32;
  player2: string;
  player2_moves: u32;
  player2_points: i128;
  player2_stake_paid: boolean;
  player2_zk_commits: u32;
  player2_zk_verified: u32;
  stake_amount_stroops: i128;
  stake_deadline_ts: u64;
  stake_fee_bps: u32;
  total_xlm_collected: i128;
  winner: Option<string>;
}

export type DataKey = {tag: "Match", values: readonly [u32]} | {tag: "MatchSalt", values: readonly [u32]} | {tag: "ZkCommit", values: readonly [u32, Buffer, u32, u32, boolean]} | {tag: "ZkVerified", values: readonly [u32, Buffer, u32, u32, boolean]} | {tag: "ZkMatchOutcome", values: readonly [u32]} | {tag: "GameHubAddress", values: void} | {tag: "Admin", values: void} | {tag: "ZkVerifierContractAddress", values: void} | {tag: "ZkVerifierVkId", values: void} | {tag: "TreasuryAddress", values: void} | {tag: "XlmToken", values: void} | {tag: "FeeAccrued", values: void} | {tag: "LastSweepTs", values: void} | {tag: "ZkGateRequired", values: void};

export enum MoveType {
  Punch = 0,
  Kick = 1,
  Block = 2,
  Special = 3,
}


export interface ZkMatchOutcomeRecord {
  verifier_contract: string;
  vk_id: Buffer;
  winner: string;
}


export interface ZkVerificationRecord {
  commitment: Buffer;
  verifier_contract: string;
  vk_id: Buffer;
}

export interface Client {
  /**
   * Construct and simulate a get_hub transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_hub: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a set_hub transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_hub: ({new_hub}: {new_hub: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a upgrade transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  upgrade: ({new_wasm_hash}: {new_wasm_hash: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a end_game transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * End a game and report to Game Hub.
   * Only admin can finalise a game result.
   */
  end_game: ({session_id, player1_won}: {session_id: u32, player1_won: boolean}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_admin: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a get_match transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get match state.
   */
  get_match: ({session_id}: {session_id: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Match>>>

  /**
   * Construct and simulate a set_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_admin: ({new_admin}: {new_admin: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a start_game transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Start a new game – calls Game Hub `start_game`.
   */
  start_game: ({session_id, player1, player2, player1_points, player2_points}: {session_id: u32, player1: string, player2: string, player1_points: i128, player2_points: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a submit_move transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Record a combat move on-chain and collect 0.0001 XLM from the player.
   */
  submit_move: ({session_id, player, move_type, turn}: {session_id: u32, player: string, move_type: MoveType, turn: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a cancel_match transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Cancel an active match and refund any paid stakes.
   * Intended for abandonment/disconnect cancellation.
   */
  cancel_match: ({session_id}: {session_id: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a expire_stake transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Expire stake deposit window and cancel the match.
   * - If both deposits are missing: cancel without transfers.
   * - If exactly one player deposited: refund full deposited amount (stake + fee) to that player.
   */
  expire_stake: ({session_id}: {session_id: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_treasury transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_treasury: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a set_treasury transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_treasury: ({new_treasury}: {new_treasury: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a deposit_stake transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Player deposit for stake-enabled matches.
   * Required amount is stake + 0.1% fee, transferred to this contract.
   */
  deposit_stake: ({session_id, player}: {session_id: u32, player: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a sweep_treasury transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Transfer accrued protocol fees to treasury wallet at most once every 24 hours.
   */
  sweep_treasury: (options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a get_fee_accrued transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_fee_accrued: (options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a set_match_stake transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Configure stake for a session before deposits begin.
   * Stake amount is the base wager (e.g. 1 XLM). Each player deposits stake + 0.1% fee.
   */
  set_match_stake: ({session_id, stake_amount_stroops}: {session_id: u32, stake_amount_stroops: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a submit_zk_commit transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  submit_zk_commit: ({session_id, player, round, turn, commitment}: {session_id: u32, player: string, round: u32, turn: u32, commitment: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_last_sweep_ts transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_last_sweep_ts: (options?: MethodOptions) => Promise<AssembledTransaction<u64>>

  /**
   * Construct and simulate a submit_power_surge transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Record a power surge pick on-chain and collect 0.0001 XLM from the player.
   */
  submit_power_surge: ({session_id, player, round, card_code}: {session_id: u32, player: string, round: u32, card_code: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_zk_gate_required transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_zk_gate_required: (options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a get_zk_match_outcome transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_zk_match_outcome: ({session_id}: {session_id: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<ZkMatchOutcomeRecord>>>

  /**
   * Construct and simulate a set_zk_gate_required transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_zk_gate_required: ({required}: {required: boolean}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a get_zk_verifier_vk_id transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_zk_verifier_vk_id: (options?: MethodOptions) => Promise<AssembledTransaction<Buffer>>

  /**
   * Construct and simulate a set_zk_verifier_vk_id transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_zk_verifier_vk_id: ({vk_id}: {vk_id: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a submit_zk_verification transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  submit_zk_verification: ({session_id, player, round, turn, commitment, vk_id, proof, public_inputs}: {session_id: u32, player: string, round: u32, turn: u32, commitment: Buffer, vk_id: Buffer, proof: Buffer, public_inputs: Array<Buffer>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a submit_zk_match_outcome transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  submit_zk_match_outcome: ({session_id, winner, vk_id, proof, public_inputs}: {session_id: u32, winner: string, vk_id: Buffer, proof: Buffer, public_inputs: Array<Buffer>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_zk_verifier_contract transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_zk_verifier_contract: (options?: MethodOptions) => Promise<AssembledTransaction<Result<string>>>

  /**
   * Construct and simulate a set_zk_verifier_contract transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_zk_verifier_contract: ({verifier_contract}: {verifier_contract: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
        /** Constructor/Initialization Args for the contract's `__constructor` method */
        {admin, game_hub, treasury, xlm_token}: {admin: string, game_hub: string, treasury: string, xlm_token: string},
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
    return ContractClient.deploy({admin, game_hub, treasury, xlm_token}, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAAGAAAAAAAAAANTWF0Y2hOb3RGb3VuZAAAAAAAAAEAAAAAAAAACU5vdFBsYXllcgAAAAAAAAIAAAAAAAAAEU1hdGNoQWxyZWFkeUVuZGVkAAAAAAAAAwAAAAAAAAASTWF0Y2hOb3RJblByb2dyZXNzAAAAAAAEAAAAAAAAABNJbnN1ZmZpY2llbnRCYWxhbmNlAAAAAAUAAAAAAAAADk5vdGhpbmdUb1N3ZWVwAAAAAAAGAAAAAAAAAAxJbnZhbGlkU3Rha2UAAAAHAAAAAAAAABJTdGFrZU5vdENvbmZpZ3VyZWQAAAAAAAgAAAAAAAAAEFN0YWtlQWxyZWFkeVBhaWQAAAAJAAAAAAAAAAxTdGFrZU5vdFBhaWQAAAAKAAAAAAAAAA1Td2VlcFRvb0Vhcmx5AAAAAAAACwAAAAAAAAATU3Rha2VEZXBvc2l0RXhwaXJlZAAAAAAMAAAAAAAAABJEZWFkbGluZU5vdFJlYWNoZWQAAAAAAA0AAAAAAAAADk1hdGNoQ2FuY2VsbGVkAAAAAAAOAAAAAAAAABNJbnZhbGlkWmtDb21taXRtZW50AAAAAA8AAAAAAAAAGFprQ29tbWl0QWxyZWFkeVN1Ym1pdHRlZAAAABAAAAAAAAAAEFprQ29tbWl0UmVxdWlyZWQAAAARAAAAAAAAABFJbnZhbGlkWmtWZXJpZmllcgAAAAAAABIAAAAAAAAAEFprQ29tbWl0Tm90Rm91bmQAAAATAAAAAAAAAB5aa1ZlcmlmaWNhdGlvbkFscmVhZHlTdWJtaXR0ZWQAAAAAABQAAAAAAAAADlprUHJvb2ZJbnZhbGlkAAAAAAAVAAAAAAAAABdaa1ZlcmlmaWVyTm90Q29uZmlndXJlZAAAAAAWAAAAAAAAABZaa01hdGNoT3V0Y29tZVJlcXVpcmVkAAAAAAAXAAAAAAAAABJJbnZhbGlkV2lubmVyQ2xhaW0AAAAAABg=",
        "AAAAAQAAAAAAAAAAAAAABU1hdGNoAAAAAAAAEwAAAAAAAAATZmVlX2FjY3J1ZWRfc3Ryb29wcwAAAAALAAAAAAAAAAxpc19jYW5jZWxsZWQAAAABAAAAAAAAAAdwbGF5ZXIxAAAAABMAAAAAAAAADXBsYXllcjFfbW92ZXMAAAAAAAAEAAAAAAAAAA5wbGF5ZXIxX3BvaW50cwAAAAAACwAAAAAAAAAScGxheWVyMV9zdGFrZV9wYWlkAAAAAAABAAAAAAAAABJwbGF5ZXIxX3prX2NvbW1pdHMAAAAAAAQAAAAAAAAAE3BsYXllcjFfemtfdmVyaWZpZWQAAAAABAAAAAAAAAAHcGxheWVyMgAAAAATAAAAAAAAAA1wbGF5ZXIyX21vdmVzAAAAAAAABAAAAAAAAAAOcGxheWVyMl9wb2ludHMAAAAAAAsAAAAAAAAAEnBsYXllcjJfc3Rha2VfcGFpZAAAAAAAAQAAAAAAAAAScGxheWVyMl96a19jb21taXRzAAAAAAAEAAAAAAAAABNwbGF5ZXIyX3prX3ZlcmlmaWVkAAAAAAQAAAAAAAAAFHN0YWtlX2Ftb3VudF9zdHJvb3BzAAAACwAAAAAAAAARc3Rha2VfZGVhZGxpbmVfdHMAAAAAAAAGAAAAAAAAAA1zdGFrZV9mZWVfYnBzAAAAAAAABAAAAAAAAAATdG90YWxfeGxtX2NvbGxlY3RlZAAAAAALAAAAAAAAAAZ3aW5uZXIAAAAAA+gAAAAT",
        "AAAAAgAAAAAAAAAAAAAAB0RhdGFLZXkAAAAADgAAAAEAAAAAAAAABU1hdGNoAAAAAAAAAQAAAAQAAAABAAAAAAAAAAlNYXRjaFNhbHQAAAAAAAABAAAABAAAAAEAAAAAAAAACFprQ29tbWl0AAAABQAAAAQAAAPuAAAAIAAAAAQAAAAEAAAAAQAAAAEAAAAAAAAAClprVmVyaWZpZWQAAAAAAAUAAAAEAAAD7gAAACAAAAAEAAAABAAAAAEAAAABAAAAAAAAAA5aa01hdGNoT3V0Y29tZQAAAAAAAQAAAAQAAAAAAAAAAAAAAA5HYW1lSHViQWRkcmVzcwAAAAAAAAAAAAAAAAAFQWRtaW4AAAAAAAAAAAAAAAAAABlaa1ZlcmlmaWVyQ29udHJhY3RBZGRyZXNzAAAAAAAAAAAAAAAAAAAOWmtWZXJpZmllclZrSWQAAAAAAAAAAAAAAAAAD1RyZWFzdXJ5QWRkcmVzcwAAAAAAAAAAAAAAAAhYbG1Ub2tlbgAAAAAAAAAAAAAACkZlZUFjY3J1ZWQAAAAAAAAAAAAAAAAAC0xhc3RTd2VlcFRzAAAAAAAAAAAAAAAADlprR2F0ZVJlcXVpcmVkAAA=",
        "AAAAAwAAAAAAAAAAAAAACE1vdmVUeXBlAAAABAAAAAAAAAAFUHVuY2gAAAAAAAAAAAAAAAAAAARLaWNrAAAAAQAAAAAAAAAFQmxvY2sAAAAAAAACAAAAAAAAAAdTcGVjaWFsAAAAAAM=",
        "AAAAAQAAAAAAAAAAAAAAFFprTWF0Y2hPdXRjb21lUmVjb3JkAAAAAwAAAAAAAAARdmVyaWZpZXJfY29udHJhY3QAAAAAAAATAAAAAAAAAAV2a19pZAAAAAAAA+4AAAAgAAAAAAAAAAZ3aW5uZXIAAAAAABM=",
        "AAAAAQAAAAAAAAAAAAAAFFprVmVyaWZpY2F0aW9uUmVjb3JkAAAAAwAAAAAAAAAKY29tbWl0bWVudAAAAAAD7gAAACAAAAAAAAAAEXZlcmlmaWVyX2NvbnRyYWN0AAAAAAAAEwAAAAAAAAAFdmtfaWQAAAAAAAPuAAAAIA==",
        "AAAAAAAAAAAAAAAHZ2V0X2h1YgAAAAAAAAAAAQAAABM=",
        "AAAAAAAAAAAAAAAHc2V0X2h1YgAAAAABAAAAAAAAAAduZXdfaHViAAAAABMAAAAA",
        "AAAAAAAAAAAAAAAHdXBncmFkZQAAAAABAAAAAAAAAA1uZXdfd2FzbV9oYXNoAAAAAAAD7gAAACAAAAAA",
        "AAAAAAAAAElFbmQgYSBnYW1lIGFuZCByZXBvcnQgdG8gR2FtZSBIdWIuCk9ubHkgYWRtaW4gY2FuIGZpbmFsaXNlIGEgZ2FtZSByZXN1bHQuAAAAAAAACGVuZF9nYW1lAAAAAgAAAAAAAAAKc2Vzc2lvbl9pZAAAAAAABAAAAAAAAAALcGxheWVyMV93b24AAAAAAQAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAAAAAAAJZ2V0X2FkbWluAAAAAAAAAAAAAAEAAAAT",
        "AAAAAAAAABBHZXQgbWF0Y2ggc3RhdGUuAAAACWdldF9tYXRjaAAAAAAAAAEAAAAAAAAACnNlc3Npb25faWQAAAAAAAQAAAABAAAD6QAAB9AAAAAFTWF0Y2gAAAAAAAAD",
        "AAAAAAAAAAAAAAAJc2V0X2FkbWluAAAAAAAAAQAAAAAAAAAJbmV3X2FkbWluAAAAAAAAEwAAAAA=",
        "AAAAAAAAADFTdGFydCBhIG5ldyBnYW1lIOKAkyBjYWxscyBHYW1lIEh1YiBgc3RhcnRfZ2FtZWAuAAAAAAAACnN0YXJ0X2dhbWUAAAAAAAUAAAAAAAAACnNlc3Npb25faWQAAAAAAAQAAAAAAAAAB3BsYXllcjEAAAAAEwAAAAAAAAAHcGxheWVyMgAAAAATAAAAAAAAAA5wbGF5ZXIxX3BvaW50cwAAAAAACwAAAAAAAAAOcGxheWVyMl9wb2ludHMAAAAAAAsAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAEVSZWNvcmQgYSBjb21iYXQgbW92ZSBvbi1jaGFpbiBhbmQgY29sbGVjdCAwLjAwMDEgWExNIGZyb20gdGhlIHBsYXllci4AAAAAAAALc3VibWl0X21vdmUAAAAABAAAAAAAAAAKc2Vzc2lvbl9pZAAAAAAABAAAAAAAAAAGcGxheWVyAAAAAAATAAAAAAAAAAltb3ZlX3R5cGUAAAAAAAfQAAAACE1vdmVUeXBlAAAAAAAAAAR0dXJuAAAABAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAGRDYW5jZWwgYW4gYWN0aXZlIG1hdGNoIGFuZCByZWZ1bmQgYW55IHBhaWQgc3Rha2VzLgpJbnRlbmRlZCBmb3IgYWJhbmRvbm1lbnQvZGlzY29ubmVjdCBjYW5jZWxsYXRpb24uAAAADGNhbmNlbF9tYXRjaAAAAAEAAAAAAAAACnNlc3Npb25faWQAAAAAAAQAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAMlFeHBpcmUgc3Rha2UgZGVwb3NpdCB3aW5kb3cgYW5kIGNhbmNlbCB0aGUgbWF0Y2guCi0gSWYgYm90aCBkZXBvc2l0cyBhcmUgbWlzc2luZzogY2FuY2VsIHdpdGhvdXQgdHJhbnNmZXJzLgotIElmIGV4YWN0bHkgb25lIHBsYXllciBkZXBvc2l0ZWQ6IHJlZnVuZCBmdWxsIGRlcG9zaXRlZCBhbW91bnQgKHN0YWtlICsgZmVlKSB0byB0aGF0IHBsYXllci4AAAAAAAAMZXhwaXJlX3N0YWtlAAAAAQAAAAAAAAAKc2Vzc2lvbl9pZAAAAAAABAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAAAAAAAMZ2V0X3RyZWFzdXJ5AAAAAAAAAAEAAAAT",
        "AAAAAAAAAAAAAAAMc2V0X3RyZWFzdXJ5AAAAAQAAAAAAAAAMbmV3X3RyZWFzdXJ5AAAAEwAAAAA=",
        "AAAAAAAAAPJJbml0aWFsaXNlIHRoZSBjb250cmFjdC4KCiMgQXJndW1lbnRzCiogYGFkbWluYCAgICAg4oCTIGFkbWluIHdhbGxldCAoY2FuIHN3ZWVwLCB1cGdyYWRlLCBldGMuKQoqIGBnYW1lX2h1YmAgIOKAkyBHYW1lIEh1YiBjb250cmFjdCBhZGRyZXNzCiogYHRyZWFzdXJ5YCAg4oCTIHdhbGxldCB0aGF0IHJlY2VpdmVzIHN3ZXB0IFhMTQoqIGB4bG1fdG9rZW5gIOKAkyBTQUMgY29udHJhY3QgYWRkcmVzcyBmb3IgbmF0aXZlIFhMTQAAAAAADV9fY29uc3RydWN0b3IAAAAAAAAEAAAAAAAAAAVhZG1pbgAAAAAAABMAAAAAAAAACGdhbWVfaHViAAAAEwAAAAAAAAAIdHJlYXN1cnkAAAATAAAAAAAAAAl4bG1fdG9rZW4AAAAAAAATAAAAAA==",
        "AAAAAAAAAGxQbGF5ZXIgZGVwb3NpdCBmb3Igc3Rha2UtZW5hYmxlZCBtYXRjaGVzLgpSZXF1aXJlZCBhbW91bnQgaXMgc3Rha2UgKyAwLjElIGZlZSwgdHJhbnNmZXJyZWQgdG8gdGhpcyBjb250cmFjdC4AAAANZGVwb3NpdF9zdGFrZQAAAAAAAAIAAAAAAAAACnNlc3Npb25faWQAAAAAAAQAAAAAAAAABnBsYXllcgAAAAAAEwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAE5UcmFuc2ZlciBhY2NydWVkIHByb3RvY29sIGZlZXMgdG8gdHJlYXN1cnkgd2FsbGV0IGF0IG1vc3Qgb25jZSBldmVyeSAyNCBob3Vycy4AAAAAAA5zd2VlcF90cmVhc3VyeQAAAAAAAAAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAAAAAAAPZ2V0X2ZlZV9hY2NydWVkAAAAAAAAAAABAAAACw==",
        "AAAAAAAAAIhDb25maWd1cmUgc3Rha2UgZm9yIGEgc2Vzc2lvbiBiZWZvcmUgZGVwb3NpdHMgYmVnaW4uClN0YWtlIGFtb3VudCBpcyB0aGUgYmFzZSB3YWdlciAoZS5nLiAxIFhMTSkuIEVhY2ggcGxheWVyIGRlcG9zaXRzIHN0YWtlICsgMC4xJSBmZWUuAAAAD3NldF9tYXRjaF9zdGFrZQAAAAACAAAAAAAAAApzZXNzaW9uX2lkAAAAAAAEAAAAAAAAABRzdGFrZV9hbW91bnRfc3Ryb29wcwAAAAsAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAAQc3VibWl0X3prX2NvbW1pdAAAAAUAAAAAAAAACnNlc3Npb25faWQAAAAAAAQAAAAAAAAABnBsYXllcgAAAAAAEwAAAAAAAAAFcm91bmQAAAAAAAAEAAAAAAAAAAR0dXJuAAAABAAAAAAAAAAKY29tbWl0bWVudAAAAAAD7gAAACAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAARZ2V0X2xhc3Rfc3dlZXBfdHMAAAAAAAAAAAAAAQAAAAY=",
        "AAAAAAAAAEpSZWNvcmQgYSBwb3dlciBzdXJnZSBwaWNrIG9uLWNoYWluIGFuZCBjb2xsZWN0IDAuMDAwMSBYTE0gZnJvbSB0aGUgcGxheWVyLgAAAAAAEnN1Ym1pdF9wb3dlcl9zdXJnZQAAAAAABAAAAAAAAAAKc2Vzc2lvbl9pZAAAAAAABAAAAAAAAAAGcGxheWVyAAAAAAATAAAAAAAAAAVyb3VuZAAAAAAAAAQAAAAAAAAACWNhcmRfY29kZQAAAAAAAAQAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAAUZ2V0X3prX2dhdGVfcmVxdWlyZWQAAAAAAAAAAQAAAAE=",
        "AAAAAAAAAAAAAAAUZ2V0X3prX21hdGNoX291dGNvbWUAAAABAAAAAAAAAApzZXNzaW9uX2lkAAAAAAAEAAAAAQAAA+kAAAfQAAAAFFprTWF0Y2hPdXRjb21lUmVjb3JkAAAAAw==",
        "AAAAAAAAAAAAAAAUc2V0X3prX2dhdGVfcmVxdWlyZWQAAAABAAAAAAAAAAhyZXF1aXJlZAAAAAEAAAAA",
        "AAAAAAAAAAAAAAAVZ2V0X3prX3ZlcmlmaWVyX3ZrX2lkAAAAAAAAAAAAAAEAAAPuAAAAIA==",
        "AAAAAAAAAAAAAAAVc2V0X3prX3ZlcmlmaWVyX3ZrX2lkAAAAAAAAAQAAAAAAAAAFdmtfaWQAAAAAAAPuAAAAIAAAAAA=",
        "AAAAAAAAAAAAAAAWc3VibWl0X3prX3ZlcmlmaWNhdGlvbgAAAAAACAAAAAAAAAAKc2Vzc2lvbl9pZAAAAAAABAAAAAAAAAAGcGxheWVyAAAAAAATAAAAAAAAAAVyb3VuZAAAAAAAAAQAAAAAAAAABHR1cm4AAAAEAAAAAAAAAApjb21taXRtZW50AAAAAAPuAAAAIAAAAAAAAAAFdmtfaWQAAAAAAAPuAAAAIAAAAAAAAAAFcHJvb2YAAAAAAAAOAAAAAAAAAA1wdWJsaWNfaW5wdXRzAAAAAAAD6gAAA+4AAAAgAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAAXc3VibWl0X3prX21hdGNoX291dGNvbWUAAAAABQAAAAAAAAAKc2Vzc2lvbl9pZAAAAAAABAAAAAAAAAAGd2lubmVyAAAAAAATAAAAAAAAAAV2a19pZAAAAAAAA+4AAAAgAAAAAAAAAAVwcm9vZgAAAAAAAA4AAAAAAAAADXB1YmxpY19pbnB1dHMAAAAAAAPqAAAD7gAAACAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAAYZ2V0X3prX3ZlcmlmaWVyX2NvbnRyYWN0AAAAAAAAAAEAAAPpAAAAEwAAAAM=",
        "AAAAAAAAAAAAAAAYc2V0X3prX3ZlcmlmaWVyX2NvbnRyYWN0AAAAAQAAAAAAAAARdmVyaWZpZXJfY29udHJhY3QAAAAAAAATAAAAAA==" ]),
      options
    )
  }
  public readonly fromJSON = {
    get_hub: this.txFromJSON<string>,
        set_hub: this.txFromJSON<null>,
        upgrade: this.txFromJSON<null>,
        end_game: this.txFromJSON<Result<void>>,
        get_admin: this.txFromJSON<string>,
        get_match: this.txFromJSON<Result<Match>>,
        set_admin: this.txFromJSON<null>,
        start_game: this.txFromJSON<Result<void>>,
        submit_move: this.txFromJSON<Result<void>>,
        cancel_match: this.txFromJSON<Result<void>>,
        expire_stake: this.txFromJSON<Result<void>>,
        get_treasury: this.txFromJSON<string>,
        set_treasury: this.txFromJSON<null>,
        deposit_stake: this.txFromJSON<Result<void>>,
        sweep_treasury: this.txFromJSON<Result<i128>>,
        get_fee_accrued: this.txFromJSON<i128>,
        set_match_stake: this.txFromJSON<Result<void>>,
        submit_zk_commit: this.txFromJSON<Result<void>>,
        get_last_sweep_ts: this.txFromJSON<u64>,
        submit_power_surge: this.txFromJSON<Result<void>>,
        get_zk_gate_required: this.txFromJSON<boolean>,
        get_zk_match_outcome: this.txFromJSON<Result<ZkMatchOutcomeRecord>>,
        set_zk_gate_required: this.txFromJSON<null>,
        get_zk_verifier_vk_id: this.txFromJSON<Buffer>,
        set_zk_verifier_vk_id: this.txFromJSON<null>,
        submit_zk_verification: this.txFromJSON<Result<void>>,
        submit_zk_match_outcome: this.txFromJSON<Result<void>>,
        get_zk_verifier_contract: this.txFromJSON<Result<string>>,
        set_zk_verifier_contract: this.txFromJSON<null>
  }
}