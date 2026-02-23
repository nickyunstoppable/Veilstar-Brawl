declare module "circomlibjs" {
  export function buildPoseidon(): Promise<any>;
}

declare module "snarkjs" {
  export const groth16: {
    fullProve: (input: any, wasmPath: string, zkeyPath: string) => Promise<{
      proof: any;
      publicSignals: unknown[];
    }>;
  };
}
