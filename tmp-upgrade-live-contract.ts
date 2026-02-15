import { Keypair, TransactionBuilder, hash, rpc, contract } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";

const RPC_URL = process.env.VITE_SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = process.env.VITE_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015";
const ADMIN_SECRET = process.env.VITE_DEV_ADMIN_SECRET || process.env.VITE_DEV_PLAYER1_SECRET || "";

const LIVE_CONTRACT_ID = "CC3O2IZME4PBASWAK3Z7HRMRPXJRMCI5AWF5YVL7GXHLV25OJMYP6AYX";
const NEW_WASM_HASH_HEX = "d2ec26ff08ecff4688961320676c076a6984be3c1585f019839b2d26ccadc05d";

if (!ADMIN_SECRET) {
  throw new Error("Missing admin secret in environment");
}

async function main() {
  const admin = Keypair.fromSecret(ADMIN_SECRET);
  const server = new rpc.Server(RPC_URL);

  const wasm = await server.getContractWasmByContractId(LIVE_CONTRACT_ID);
  const spec = contract.Spec.fromWasm(wasm);

  const client = new contract.Client(spec, {
    contractId: LIVE_CONTRACT_ID,
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcUrl: RPC_URL,
    publicKey: admin.publicKey(),
    signTransaction: async (txXdr: string, opts?: any) => {
      const tx = TransactionBuilder.fromXDR(txXdr, opts?.networkPassphrase || NETWORK_PASSPHRASE);
      tx.sign(admin);
      return { signedTxXdr: tx.toXDR(), signerAddress: admin.publicKey() };
    },
    signAuthEntry: async (preimageXdr: string) => {
      const payload = hash(Buffer.from(preimageXdr, "base64"));
      const signatureBytes = admin.sign(payload);
      return {
        signedAuthEntry: Buffer.from(signatureBytes).toString("base64"),
        signerAddress: admin.publicKey(),
      };
    },
  });

  const tx = await (client as any).upgrade({
    new_wasm_hash: Buffer.from(NEW_WASM_HASH_HEX, "hex"),
  });

  const sent = await tx.signAndSend();
  const txHash = sent?.hash || sent?.txHash || sent?.sendTransactionResponse?.hash || null;

  console.log(JSON.stringify({
    success: true,
    liveContractId: LIVE_CONTRACT_ID,
    upgradedToWasmHash: NEW_WASM_HASH_HEX,
    txHash,
  }, null, 2));
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
