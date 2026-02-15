import { Keypair, hash, authorizeEntry, xdr as xdrLib, rpc } from "@stellar/stellar-sdk";

type AnyObj = Record<string, any>;
const API = "http://127.0.0.1:3001";
const RPC_URL = process.env.VITE_SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = process.env.VITE_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015";
const P1 = process.env.VITE_DEV_PLAYER1_ADDRESS || "GCSWG5OFT6BSZKDLAIBMFLT3BP6MCJBXQPRR33HNW3MSSYI6I2KCMEH5";
const P2 = process.env.VITE_DEV_PLAYER2_ADDRESS || "GD2AMBPLJ6XNGKU7XCXDUB3HFHEJUM6PT5YQIVWXWAEJNGKNMOT4A7UQ";
const P1_SECRET = process.env.VITE_DEV_PLAYER1_SECRET;
const P2_SECRET = process.env.VITE_DEV_PLAYER2_SECRET;

if (!P1_SECRET || !P2_SECRET) throw new Error("Missing player secrets in env");

async function post(path: string, body: unknown) {
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

async function get(path: string) {
  const response = await fetch(`${API}${path}`);
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${path} -> ${response.status} ${JSON.stringify(json)}`);
  return json;
}

function latestRound(rounds: any[]) {
  return [...(rounds || [])].sort((a, b) => (a.round_number - b.round_number) || (a.turn_number - b.turn_number)).at(-1);
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

async function registerViaApi(matchId: string) {
  const prep = await post(`/api/matches/${matchId}/register/prepare`, {});
  if (prep.submitted) return prep;

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

  return { prep, auth1, auth2 };
}

async function run() {
  const summary: AnyObj = { api: API, p1: P1, p2: P2, commitTxs: [], verifyTxs: [], resolvedTurns: 0 };

  const room = await post("/api/matchmaking/rooms", { address: P1 });
  const join = await post("/api/matchmaking/rooms/join", { address: P2, roomCode: room.roomCode });
  const matchId = join.matchId as string;
  summary.matchId = matchId;

  await post(`/api/matches/${matchId}/select`, { address: P1, characterId: "atlas" });
  await post(`/api/matches/${matchId}/select`, { address: P2, characterId: "nova" });

  summary.registration = await registerViaApi(matchId);

  const afterReg = await get(`/api/matches/${matchId}`);
  summary.afterRegistration = {
    onchainSessionId: afterReg.match?.onchain_session_id,
    onchainContractId: afterReg.match?.onchain_contract_id,
    status: afterReg.match?.status,
  };

  for (let i = 0; i < 18; i++) {
    const state = await get(`/api/matches/${matchId}`);
    if (state.match?.status === "completed" && state.match?.winner_address) break;

    const round = latestRound(state.rounds || []);
    if (!round) throw new Error("No round available");

    const roundNumber = Number(round.round_number);
    const turnNumber = Number(round.turn_number);
    const p1Move = i % 2 === 0 ? "special" : "kick";
    const p2Move = i % 2 === 0 ? "punch" : "block";
    const surge = "dag-overclock";

    const p1Proof = await post(`/api/matches/${matchId}/zk/round/prove`, {
      address: P1,
      roundNumber,
      turnNumber,
      move: p1Move,
      surgeCardId: surge,
    });

    const p2Proof = await post(`/api/matches/${matchId}/zk/round/prove`, {
      address: P2,
      roundNumber,
      turnNumber,
      move: p2Move,
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
      encryptedPlan: JSON.stringify({ move: p1Move, surgeCardId: surge }),
    });

    const c2 = await post(`/api/matches/${matchId}/zk/round/commit`, {
      address: P2,
      roundNumber,
      turnNumber,
      commitment: p2Proof.commitment,
      proof: p2Proof.proof,
      publicInputs: p2Proof.publicInputs,
      transcriptHash: p2Proof.nonce,
      encryptedPlan: JSON.stringify({ move: p2Move, surgeCardId: surge }),
    });

    summary.commitTxs.push(c1.onChainCommitTxHash, c2.onChainCommitTxHash);
    summary.verifyTxs.push(c1.onChainVerificationTxHash, c2.onChainVerificationTxHash);

    await post(`/api/matches/${matchId}/zk/round/resolve`, {
      address: P1,
      roundNumber,
      turnNumber,
      move: p1Move,
      surgeCardId: surge,
      proof: p1Proof.proof,
      publicInputs: p1Proof.publicInputs,
      transcriptHash: p1Proof.nonce,
      expectedWinnerAddress: P1,
    });

    summary.resolvedTurns += 1;
  }

  const end = await get(`/api/matches/${matchId}`);
  summary.finalState = {
    status: end.match?.status,
    winnerAddress: end.match?.winner_address,
    onchainSessionId: end.match?.onchain_session_id,
    onchainContractId: end.match?.onchain_contract_id,
  };

  if (!end.match?.winner_address) {
    throw new Error(`Match did not complete. status=${end.match?.status}`);
  }

  summary.finalize = await post(`/api/matches/${matchId}/zk/prove-finalize`, {
    winnerAddress: end.match.winner_address,
  });

  console.log(JSON.stringify(summary, null, 2));
}

run().catch((err) => {
  console.error(err.message || String(err));
  process.exit(1);
});
