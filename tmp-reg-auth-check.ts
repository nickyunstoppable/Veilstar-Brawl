import { Keypair, hash, authorizeEntry, xdr as xdrLib, rpc } from "@stellar/stellar-sdk";

const API = "http://127.0.0.1:3001";
const RPC_URL = process.env.VITE_SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = process.env.VITE_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015";
const P1 = process.env.VITE_DEV_PLAYER1_ADDRESS || "GCSWG5OFT6BSZKDLAIBMFLT3BP6MCJBXQPRR33HNW3MSSYI6I2KCMEH5";
const P2 = process.env.VITE_DEV_PLAYER2_ADDRESS || "GD2AMBPLJ6XNGKU7XCXDUB3HFHEJUM6PT5YQIVWXWAEJNGKNMOT4A7UQ";
const P1_SECRET = process.env.VITE_DEV_PLAYER1_SECRET;
const P2_SECRET = process.env.VITE_DEV_PLAYER2_SECRET;

if (!P1_SECRET || !P2_SECRET) {
  throw new Error("Missing player secrets in env");
}

async function post(path: string, body: unknown) {
  const response = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${path} -> ${response.status} ${JSON.stringify(json)}`);
  }
  return json;
}

async function get(path: string) {
  const response = await fetch(`${API}${path}`);
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${path} -> ${response.status} ${JSON.stringify(json)}`);
  }
  return json;
}

async function signAuthEntryXdr(authEntryXdr: string, secret: string): Promise<string> {
  const keypair = Keypair.fromSecret(secret);
  const entry = xdrLib.SorobanAuthorizationEntry.fromXDR(authEntryXdr, "base64");
  const server = new rpc.Server(RPC_URL);
  const latest = await server.getLatestLedger();

  const signed = await authorizeEntry(
    entry,
    async (preimage) => {
      const payload = hash(Buffer.from(preimage.toXDR("base64"), "base64"));
      return Buffer.from(keypair.sign(payload));
    },
    latest.sequence + 60,
    NETWORK_PASSPHRASE,
  );

  return signed.toXDR("base64");
}

async function main() {
  const room = await post("/api/matchmaking/rooms", { address: P1 });
  const join = await post("/api/matchmaking/rooms/join", { address: P2, roomCode: room.roomCode });
  const matchId = join.matchId as string;

  await post(`/api/matches/${matchId}/select`, { address: P1, characterId: "atlas" });
  await post(`/api/matches/${matchId}/select`, { address: P2, characterId: "nova" });

  const prep = await post(`/api/matches/${matchId}/register/prepare`, {});
  const reqAuth: string[] = prep.requiredAuthAddresses || [];

  let auth1: any = null;
  let auth2: any = null;

  if (reqAuth.includes(P1) && prep.authEntries?.[P1]) {
    const signed = await signAuthEntryXdr(prep.authEntries[P1], P1_SECRET!);
    auth1 = await post(`/api/matches/${matchId}/register/auth`, {
      address: P1,
      signedAuthEntryXdr: signed,
      transactionXdr: prep.transactionXdr,
      requiredAuthAddresses: reqAuth,
    });
  }

  if (reqAuth.includes(P2) && prep.authEntries?.[P2]) {
    const signed = await signAuthEntryXdr(prep.authEntries[P2], P2_SECRET!);
    auth2 = await post(`/api/matches/${matchId}/register/auth`, {
      address: P2,
      signedAuthEntryXdr: signed,
      transactionXdr: prep.transactionXdr,
      requiredAuthAddresses: reqAuth,
    });
  }

  const state = await get(`/api/matches/${matchId}`);

  console.log(JSON.stringify({
    matchId,
    prep,
    auth1,
    auth2,
    onchain_session_id: state.match?.onchain_session_id,
    onchain_contract_id: state.match?.onchain_contract_id,
    status: state.match?.status,
  }, null, 2));
}

main().catch((err) => {
  console.error(err.message || String(err));
  process.exit(1);
});
