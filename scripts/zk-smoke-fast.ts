import { Keypair, hash, authorizeEntry, xdr as xdrLib, rpc } from "@stellar/stellar-sdk";

type Json = Record<string, any>;

const API = process.env.API_BASE_URL?.trim() || "http://127.0.0.1:3001";
const RPC_URL = process.env.VITE_SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = process.env.VITE_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015";

const P1 = process.env.VITE_DEV_PLAYER1_ADDRESS || "";
const P2 = process.env.VITE_DEV_PLAYER2_ADDRESS || "";
const P1_SECRET = process.env.VITE_DEV_PLAYER1_SECRET || "";
const P2_SECRET = process.env.VITE_DEV_PLAYER2_SECRET || "";

if (!P1 || !P2 || !P1_SECRET || !P2_SECRET) {
  throw new Error("Missing dev player addresses/secrets in environment");
}

async function post(path: string, body: unknown): Promise<any> {
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

async function get(path: string): Promise<any> {
  const response = await fetch(`${API}${path}`);
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${path} -> ${response.status} ${JSON.stringify(json)}`);
  }
  return json;
}

function latestRound(rounds: any[]): any {
  if (!Array.isArray(rounds) || rounds.length === 0) {
    throw new Error("No rounds found");
  }
  return [...rounds]
    .sort((a, b) => (a.round_number - b.round_number) || (a.turn_number - b.turn_number))
    .at(-1);
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

async function registerViaApi(matchId: string): Promise<any> {
  const prep = await post(`/api/matches/${matchId}/register/prepare`, {});
  if (prep.submitted) return prep;

  const requiredAuth = prep.requiredAuthAddresses || [];
  let auth1: any = null;
  let auth2: any = null;

  if (requiredAuth.includes(P1) && prep.authEntries?.[P1]) {
    const signed = await signAuthEntryXdr(prep.authEntries[P1], P1_SECRET);
    auth1 = await post(`/api/matches/${matchId}/register/auth`, {
      address: P1,
      signedAuthEntryXdr: signed,
      transactionXdr: prep.transactionXdr,
      requiredAuthAddresses: requiredAuth,
    });
  }

  if (requiredAuth.includes(P2) && prep.authEntries?.[P2]) {
    const signed = await signAuthEntryXdr(prep.authEntries[P2], P2_SECRET);
    auth2 = await post(`/api/matches/${matchId}/register/auth`, {
      address: P2,
      signedAuthEntryXdr: signed,
      transactionXdr: prep.transactionXdr,
      requiredAuthAddresses: requiredAuth,
    });
  }

  return { prep, auth1, auth2 };
}

async function main() {
  const summary: Json = { api: API };

  const room = await post("/api/matchmaking/rooms", { address: P1 });
  const joined = await post("/api/matchmaking/rooms/join", { address: P2, roomCode: room.roomCode });
  const matchId = joined.matchId as string;
  summary.matchId = matchId;

  await post(`/api/matches/${matchId}/select`, { address: P1, characterId: "atlas" });
  await post(`/api/matches/${matchId}/select`, { address: P2, characterId: "nova" });

  summary.registration = await registerViaApi(matchId);

  const before = await get(`/api/matches/${matchId}`);
  const currentRound = latestRound(before.rounds || []);
  const roundNumber = Number(currentRound.round_number);
  const turnNumber = Number(currentRound.turn_number);

  const p1Move = "special";
  const p2Move = "block";
  const surge = "dag-overclock";

  const p1MovePlan = [
    p1Move,
    ...Array(9).fill("block"),
  ];

  const p2MovePlan = [
    p2Move,
    ...Array(9).fill("block"),
  ];

  const p1Proof = await post(`/api/matches/${matchId}/zk/round/prove`, {
    address: P1,
    roundNumber,
    turnNumber,
    move: p1Move,
    movePlan: p1MovePlan,
    surgeCardId: surge,
  });

  const p2Proof = await post(`/api/matches/${matchId}/zk/round/prove`, {
    address: P2,
    roundNumber,
    turnNumber,
    move: p2Move,
    movePlan: p2MovePlan,
    surgeCardId: surge,
  });

  const c1 = await post(`/api/matches/${matchId}/zk/round/commit`, {
    address: P1,
    roundNumber,
    turnNumber,
    commitment: p1Proof.commitment,
    proof: p1Proof.proof,
    publicInputs: p1Proof.publicInputs,
    transcriptHash: p1Proof.nonce,
    encryptedPlan: JSON.stringify({ move: p1Move, movePlan: p1MovePlan, surgeCardId: surge }),
  });

  const c2 = await post(`/api/matches/${matchId}/zk/round/commit`, {
    address: P2,
    roundNumber,
    turnNumber,
    commitment: p2Proof.commitment,
    proof: p2Proof.proof,
    publicInputs: p2Proof.publicInputs,
    transcriptHash: p2Proof.nonce,
    encryptedPlan: JSON.stringify({ move: p2Move, movePlan: p2MovePlan, surgeCardId: surge }),
  });

  const resolve = await post(`/api/matches/${matchId}/zk/round/resolve`, {
    address: P1,
    roundNumber,
    turnNumber,
    move: p1Move,
    movePlan: p1MovePlan,
    surgeCardId: surge,
    proof: p1Proof.proof,
    publicInputs: p1Proof.publicInputs,
    transcriptHash: p1Proof.nonce,
    expectedWinnerAddress: P1,
  });

  const after = await get(`/api/matches/${matchId}`);
  const afterRound = latestRound(after.rounds || []);

  summary.smoke = {
    initialRound: { roundNumber, turnNumber },
    afterRound: {
      roundNumber: Number(afterRound.round_number),
      turnNumber: Number(afterRound.turn_number),
      winnerAddress: afterRound.winner_address || null,
    },
    commit: {
      p1CommitTx: c1.onChainCommitTxHash || null,
      p2CommitTx: c2.onChainCommitTxHash || null,
      p1VerifyTx: c1.onChainVerificationTxHash || null,
      p2VerifyTx: c2.onChainVerificationTxHash || null,
    },
    resolve,
  };

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err.message || String(err));
  process.exit(1);
});
