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
export { Address } from "@stellar/stellar-sdk";
export type {
  AssembledTransaction,
  Client as ContractClient,
  ClientOptions as ContractClientOptions,
  MethodOptions,
  Result,
  Spec as ContractSpec,
} from "@stellar/stellar-sdk/contract";
export type {
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

if (typeof window !== "undefined") {
  //@ts-ignore Buffer exists
  window.Buffer = window.Buffer || Buffer;
}


export const networks = {
  testnet: {
    networkPassphrase: "Test SDF Network ; September 2015",
    contractId: "CAPBCVLDP2XIFPN77G4ENVE4PPQ3WVLF5DWDSFG4MET35Z674K6XLZPN",
  }
} as const

export const Errors = {
  1: {message:"MatchNotFound"},
  2: {message:"NotPlayer"},
  3: {message:"MatchAlreadyEnded"},
  4: {message:"MatchNotInProgress"},
  5: {message:"InsufficientBalance"},
  6: {message:"NothingToSweep"}
}


export interface Match {
  player1: string;
  player1_moves: u32;
  player1_points: i128;
  player2: string;
  player2_moves: u32;
  player2_points: i128;
  total_xlm_collected: i128;
  winner: Option<string>;
}

export type DataKey = {tag: "Match", values: readonly [u32]} | {tag: "GameHubAddress", values: void} | {tag: "Admin", values: void} | {tag: "TreasuryAddress", values: void} | {tag: "XlmToken", values: void};

export enum MoveType {
  Punch = 0,
  Kick = 1,
  Block = 2,
  Special = 3,
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
   * Construct and simulate a get_treasury transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_treasury: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a set_treasury transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_treasury: ({new_treasury}: {new_treasury: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a sweep_treasury transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Transfer accumulated XLM to the treasury wallet, keeping a 10 XLM reserve.
   */
  sweep_treasury: (options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a submit_power_surge transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Record a power surge pick on-chain and collect 0.0001 XLM from the player.
   */
  submit_power_surge: ({session_id, player, round, card_code}: {session_id: u32, player: string, round: u32, card_code: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

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
      new ContractSpec([ "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAABgAAAAAAAAANTWF0Y2hOb3RGb3VuZAAAAAAAAAEAAAAAAAAACU5vdFBsYXllcgAAAAAAAAIAAAAAAAAAEU1hdGNoQWxyZWFkeUVuZGVkAAAAAAAAAwAAAAAAAAASTWF0Y2hOb3RJblByb2dyZXNzAAAAAAAEAAAAAAAAABNJbnN1ZmZpY2llbnRCYWxhbmNlAAAAAAUAAAAAAAAADk5vdGhpbmdUb1N3ZWVwAAAAAAAG",
        "AAAAAQAAAAAAAAAAAAAABU1hdGNoAAAAAAAACAAAAAAAAAAHcGxheWVyMQAAAAATAAAAAAAAAA1wbGF5ZXIxX21vdmVzAAAAAAAABAAAAAAAAAAOcGxheWVyMV9wb2ludHMAAAAAAAsAAAAAAAAAB3BsYXllcjIAAAAAEwAAAAAAAAANcGxheWVyMl9tb3ZlcwAAAAAAAAQAAAAAAAAADnBsYXllcjJfcG9pbnRzAAAAAAALAAAAAAAAABN0b3RhbF94bG1fY29sbGVjdGVkAAAAAAsAAAAAAAAABndpbm5lcgAAAAAD6AAAABM=",
        "AAAAAgAAAAAAAAAAAAAAB0RhdGFLZXkAAAAABQAAAAEAAAAAAAAABU1hdGNoAAAAAAAAAQAAAAQAAAAAAAAAAAAAAA5HYW1lSHViQWRkcmVzcwAAAAAAAAAAAAAAAAAFQWRtaW4AAAAAAAAAAAAAAAAAAA9UcmVhc3VyeUFkZHJlc3MAAAAAAAAAAAAAAAAIWGxtVG9rZW4=",
        "AAAAAwAAAAAAAAAAAAAACE1vdmVUeXBlAAAABAAAAAAAAAAFUHVuY2gAAAAAAAAAAAAAAAAAAARLaWNrAAAAAQAAAAAAAAAFQmxvY2sAAAAAAAACAAAAAAAAAAdTcGVjaWFsAAAAAAM=",
        "AAAAAAAAAAAAAAAHZ2V0X2h1YgAAAAAAAAAAAQAAABM=",
        "AAAAAAAAAAAAAAAHc2V0X2h1YgAAAAABAAAAAAAAAAduZXdfaHViAAAAABMAAAAA",
        "AAAAAAAAAAAAAAAHdXBncmFkZQAAAAABAAAAAAAAAA1uZXdfd2FzbV9oYXNoAAAAAAAD7gAAACAAAAAA",
        "AAAAAAAAAElFbmQgYSBnYW1lIGFuZCByZXBvcnQgdG8gR2FtZSBIdWIuCk9ubHkgYWRtaW4gY2FuIGZpbmFsaXNlIGEgZ2FtZSByZXN1bHQuAAAAAAAACGVuZF9nYW1lAAAAAgAAAAAAAAAKc2Vzc2lvbl9pZAAAAAAABAAAAAAAAAALcGxheWVyMV93b24AAAAAAQAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAAAAAAAJZ2V0X2FkbWluAAAAAAAAAAAAAAEAAAAT",
        "AAAAAAAAABBHZXQgbWF0Y2ggc3RhdGUuAAAACWdldF9tYXRjaAAAAAAAAAEAAAAAAAAACnNlc3Npb25faWQAAAAAAAQAAAABAAAD6QAAB9AAAAAFTWF0Y2gAAAAAAAAD",
        "AAAAAAAAAAAAAAAJc2V0X2FkbWluAAAAAAAAAQAAAAAAAAAJbmV3X2FkbWluAAAAAAAAEwAAAAA=",
        "AAAAAAAAADFTdGFydCBhIG5ldyBnYW1lIOKAkyBjYWxscyBHYW1lIEh1YiBgc3RhcnRfZ2FtZWAuAAAAAAAACnN0YXJ0X2dhbWUAAAAAAAUAAAAAAAAACnNlc3Npb25faWQAAAAAAAQAAAAAAAAAB3BsYXllcjEAAAAAEwAAAAAAAAAHcGxheWVyMgAAAAATAAAAAAAAAA5wbGF5ZXIxX3BvaW50cwAAAAAACwAAAAAAAAAOcGxheWVyMl9wb2ludHMAAAAAAAsAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAEVSZWNvcmQgYSBjb21iYXQgbW92ZSBvbi1jaGFpbiBhbmQgY29sbGVjdCAwLjAwMDEgWExNIGZyb20gdGhlIHBsYXllci4AAAAAAAALc3VibWl0X21vdmUAAAAABAAAAAAAAAAKc2Vzc2lvbl9pZAAAAAAABAAAAAAAAAAGcGxheWVyAAAAAAATAAAAAAAAAAltb3ZlX3R5cGUAAAAAAAfQAAAACE1vdmVUeXBlAAAAAAAAAAR0dXJuAAAABAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAAAAAAAMZ2V0X3RyZWFzdXJ5AAAAAAAAAAEAAAAT",
        "AAAAAAAAAAAAAAAMc2V0X3RyZWFzdXJ5AAAAAQAAAAAAAAAMbmV3X3RyZWFzdXJ5AAAAEwAAAAA=",
        "AAAAAAAAAPJJbml0aWFsaXNlIHRoZSBjb250cmFjdC4KCiMgQXJndW1lbnRzCiogYGFkbWluYCAgICAg4oCTIGFkbWluIHdhbGxldCAoY2FuIHN3ZWVwLCB1cGdyYWRlLCBldGMuKQoqIGBnYW1lX2h1YmAgIOKAkyBHYW1lIEh1YiBjb250cmFjdCBhZGRyZXNzCiogYHRyZWFzdXJ5YCAg4oCTIHdhbGxldCB0aGF0IHJlY2VpdmVzIHN3ZXB0IFhMTQoqIGB4bG1fdG9rZW5gIOKAkyBTQUMgY29udHJhY3QgYWRkcmVzcyBmb3IgbmF0aXZlIFhMTQAAAAAADV9fY29uc3RydWN0b3IAAAAAAAAEAAAAAAAAAAVhZG1pbgAAAAAAABMAAAAAAAAACGdhbWVfaHViAAAAEwAAAAAAAAAIdHJlYXN1cnkAAAATAAAAAAAAAAl4bG1fdG9rZW4AAAAAAAATAAAAAA==",
        "AAAAAAAAAEpUcmFuc2ZlciBhY2N1bXVsYXRlZCBYTE0gdG8gdGhlIHRyZWFzdXJ5IHdhbGxldCwga2VlcGluZyBhIDEwIFhMTSByZXNlcnZlLgAAAAAADnN3ZWVwX3RyZWFzdXJ5AAAAAAAAAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAAEpSZWNvcmQgYSBwb3dlciBzdXJnZSBwaWNrIG9uLWNoYWluIGFuZCBjb2xsZWN0IDAuMDAwMSBYTE0gZnJvbSB0aGUgcGxheWVyLgAAAAAAEnN1Ym1pdF9wb3dlcl9zdXJnZQAAAAAABAAAAAAAAAAKc2Vzc2lvbl9pZAAAAAAABAAAAAAAAAAGcGxheWVyAAAAAAATAAAAAAAAAAVyb3VuZAAAAAAAAAQAAAAAAAAACWNhcmRfY29kZQAAAAAAAAQAAAABAAAD6QAAAAIAAAAD" ]),
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
        get_treasury: this.txFromJSON<string>,
        set_treasury: this.txFromJSON<null>,
        sweep_treasury: this.txFromJSON<Result<i128>>,
        submit_power_surge: this.txFromJSON<Result<void>>
  }
}