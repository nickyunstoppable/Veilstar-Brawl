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
    contractId: "CCCXI2D5DD7F3Q4XUFQIJHMFILUIDSQTHAFLJ3RCXP6CY2P2OP6VSVCY",
  }
} as const

export const Errors = {
  1: {message:"InvalidVk"},
  2: {message:"InvalidProof"},
  3: {message:"InvalidPublicInputs"},
  4: {message:"Unauthorized"}
}

export type DataKey = {tag: "Admin", values: void} | {tag: "VerificationKey", values: readonly [Buffer]};


export interface Groth16VerificationKey {
  alpha_g1: Buffer;
  beta_g2: Buffer;
  delta_g2: Buffer;
  gamma_g2: Buffer;
  ic: Array<Buffer>;
}

export interface Client {
  /**
   * Construct and simulate a get_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_admin: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a verify_round_proof transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  verify_round_proof: ({vk_id, proof, public_inputs}: {vk_id: Buffer, proof: Buffer, public_inputs: Array<Buffer>}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a set_verification_key transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_verification_key: ({vk_id, alpha_g1, beta_g2, gamma_g2, delta_g2, ic}: {vk_id: Buffer, alpha_g1: Buffer, beta_g2: Buffer, gamma_g2: Buffer, delta_g2: Buffer, ic: Array<Buffer>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
        /** Constructor/Initialization Args for the contract's `__constructor` method */
        {admin, game_hub}: {admin: string, game_hub: string},
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
    return ContractClient.deploy({admin, game_hub}, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAABAAAAAAAAAAJSW52YWxpZFZrAAAAAAAAAQAAAAAAAAAMSW52YWxpZFByb29mAAAAAgAAAAAAAAATSW52YWxpZFB1YmxpY0lucHV0cwAAAAADAAAAAAAAAAxVbmF1dGhvcml6ZWQAAAAE",
        "AAAAAgAAAAAAAAAAAAAAB0RhdGFLZXkAAAAAAgAAAAAAAAAAAAAABUFkbWluAAAAAAAAAQAAAAAAAAAPVmVyaWZpY2F0aW9uS2V5AAAAAAEAAAPuAAAAIA==",
        "AAAAAQAAAAAAAAAAAAAAFkdyb3RoMTZWZXJpZmljYXRpb25LZXkAAAAAAAUAAAAAAAAACGFscGhhX2cxAAAD7gAAAEAAAAAAAAAAB2JldGFfZzIAAAAD7gAAAIAAAAAAAAAACGRlbHRhX2cyAAAD7gAAAIAAAAAAAAAACGdhbW1hX2cyAAAD7gAAAIAAAAAAAAAAAmljAAAAAAPqAAAD7gAAAEA=",
        "AAAAAAAAAAAAAAAJZ2V0X2FkbWluAAAAAAAAAAAAAAEAAAAT",
        "AAAAAAAAAAAAAAANX19jb25zdHJ1Y3RvcgAAAAAAAAIAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAAIZ2FtZV9odWIAAAATAAAAAA==",
        "AAAAAAAAAAAAAAASdmVyaWZ5X3JvdW5kX3Byb29mAAAAAAADAAAAAAAAAAV2a19pZAAAAAAAA+4AAAAgAAAAAAAAAAVwcm9vZgAAAAAAAA4AAAAAAAAADXB1YmxpY19pbnB1dHMAAAAAAAPqAAAD7gAAACAAAAABAAAAAQ==",
        "AAAAAAAAAAAAAAAUc2V0X3ZlcmlmaWNhdGlvbl9rZXkAAAAGAAAAAAAAAAV2a19pZAAAAAAAA+4AAAAgAAAAAAAAAAhhbHBoYV9nMQAAA+4AAABAAAAAAAAAAAdiZXRhX2cyAAAAA+4AAACAAAAAAAAAAAhnYW1tYV9nMgAAA+4AAACAAAAAAAAAAAhkZWx0YV9nMgAAA+4AAACAAAAAAAAAAAJpYwAAAAAD6gAAA+4AAABAAAAAAQAAA+kAAAACAAAAAw==" ]),
      options
    )
  }
  public readonly fromJSON = {
    get_admin: this.txFromJSON<string>,
        verify_round_proof: this.txFromJSON<boolean>,
        set_verification_key: this.txFromJSON<Result<void>>
  }
}