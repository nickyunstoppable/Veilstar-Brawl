import { beforeEach, describe, expect, it, mock } from "bun:test";
import { createHash } from "node:crypto";
import { buildPoseidon } from "circomlibjs";

type TableRow = Record<string, any>;

interface InMemoryDb {
  matches: TableRow[];
  fight_state_snapshots: TableRow[];
  round_private_commits: TableRow[];
  rounds: TableRow[];
  power_surges: TableRow[];
}

type QueryFilter =
  | { kind: "eq"; column: string; value: any }
  | { kind: "is"; column: string; value: any }
  | { kind: "not"; column: string; operator: string; value: any }
  | { kind: "lt"; column: string; value: any };

class FakeQueryBuilder {
  private readonly db: InMemoryDb;
  private readonly table: keyof InMemoryDb;
  private action: "select" | "insert" | "update" | "upsert" = "select";
  private updatePayload: any = null;
  private insertPayload: any = null;
  private upsertPayload: any = null;
  private upsertOnConflict: string | undefined;
  private filters: QueryFilter[] = [];
  private forceSingle = false;
  private forceMaybeSingle = false;
  private static idCounter = 1;

  constructor(db: InMemoryDb, table: keyof InMemoryDb) {
    this.db = db;
    this.table = table;
  }

  select(_columns?: string): this {
    return this;
  }

  update(payload: any): this {
    this.action = "update";
    this.updatePayload = payload;
    return this;
  }

  insert(payload: any): this {
    this.action = "insert";
    this.insertPayload = payload;
    return this;
  }

  upsert(payload: any, options?: { onConflict?: string }): this {
    this.action = "upsert";
    this.upsertPayload = payload;
    this.upsertOnConflict = options?.onConflict;
    return this;
  }

  eq(column: string, value: any): this {
    this.filters.push({ kind: "eq", column, value });
    return this;
  }

  is(column: string, value: any): this {
    this.filters.push({ kind: "is", column, value });
    return this;
  }

  not(column: string, operator: string, value: any): this {
    this.filters.push({ kind: "not", column, operator, value });
    return this;
  }

  lt(column: string, value: any): this {
    this.filters.push({ kind: "lt", column, value });
    return this;
  }

  order(_column: string, _opts?: { ascending?: boolean }): this {
    return this;
  }

  limit(_count: number): this {
    return this;
  }

  maybeSingle(): Promise<{ data: any; error: any }> {
    this.forceMaybeSingle = true;
    return this.execute();
  }

  single(): Promise<{ data: any; error: any }> {
    this.forceSingle = true;
    return this.execute();
  }

  then<TResult1 = { data: any; error: any }, TResult2 = never>(
    onfulfilled?: ((value: { data: any; error: any }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled as any, onrejected as any);
  }

  private async execute(): Promise<{ data: any; error: any }> {
    if (this.table === "round_resolution_locks" as any) {
      return { data: null, error: { code: "42P01", message: "relation does not exist" } };
    }

    const tableRows = this.db[this.table] as TableRow[];

    if (this.action === "select") {
      const rows = tableRows.filter((row) => this.matchesFilters(row));
      if (this.forceSingle) {
        return { data: rows[0] ?? null, error: rows.length ? null : { message: "not found" } };
      }
      if (this.forceMaybeSingle) {
        return { data: rows[0] ?? null, error: null };
      }
      return { data: rows, error: null };
    }

    if (this.action === "insert") {
      const payloads = Array.isArray(this.insertPayload) ? this.insertPayload : [this.insertPayload];
      for (const payload of payloads) {
        const row = { ...payload };
        if (this.table === "rounds" && (row.id === undefined || row.id === null)) {
          row.id = `round-${FakeQueryBuilder.idCounter++}`;
        }
        tableRows.push(row);
      }
      const data = this.forceSingle || this.forceMaybeSingle ? tableRows[tableRows.length - 1] ?? null : payloads;
      return { data, error: null };
    }

    if (this.action === "update") {
      const rows = tableRows.filter((row) => this.matchesFilters(row));
      for (const row of rows) {
        Object.assign(row, this.updatePayload);
      }
      const data = this.forceSingle || this.forceMaybeSingle ? rows[0] ?? null : rows;
      return { data, error: null };
    }

    if (this.action === "upsert") {
      const payloads = Array.isArray(this.upsertPayload) ? this.upsertPayload : [this.upsertPayload];
      const conflictColumns = (this.upsertOnConflict || "").split(",").map((value) => value.trim()).filter(Boolean);

      for (const payload of payloads) {
        let target = conflictColumns.length
          ? tableRows.find((row) => conflictColumns.every((column) => row[column] === payload[column]))
          : undefined;

        if (target) {
          Object.assign(target, payload);
        } else {
          const newRow: TableRow = { ...payload };
          tableRows.push(newRow);
        }
      }

      const data = this.forceSingle || this.forceMaybeSingle ? payloads[0] ?? null : payloads;
      return { data, error: null };
    }

    return { data: null, error: null };
  }

  private matchesFilters(row: TableRow): boolean {
    for (const filter of this.filters) {
      if (filter.kind === "eq") {
        if (row[filter.column] !== filter.value) return false;
      } else if (filter.kind === "is") {
        if (filter.value === null) {
          if (row[filter.column] !== null && row[filter.column] !== undefined) return false;
        } else if (row[filter.column] !== filter.value) {
          return false;
        }
      } else if (filter.kind === "not") {
        if (filter.operator === "is" && filter.value === null) {
          if (row[filter.column] === null || row[filter.column] === undefined) return false;
        }
      } else if (filter.kind === "lt") {
        if (!(row[filter.column] < filter.value)) return false;
      }
    }

    return true;
  }
}

function createSupabaseMock(db: InMemoryDb) {
  return {
    from(table: string) {
      return new FakeQueryBuilder(db, table as keyof InMemoryDb);
    },
  };
}

const BN254_FIELD_PRIME = BigInt("21888242871839275222246405745257275088548364400416034343698204186575808495617");

function toFieldBigint(text: string): bigint {
  const digestHex = createHash("sha256").update(text).digest("hex");
  return BigInt(`0x${digestHex}`) % BN254_FIELD_PRIME;
}

function normalizeHex32(input: string): string {
  const trimmed = input.trim().toLowerCase();
  if (!/^0x[0-9a-f]+$/.test(trimmed)) throw new Error("Invalid 0x hex string");
  const raw = trimmed.slice(2);
  if (raw.length === 0 || raw.length > 64) throw new Error("Hex value exceeds 32 bytes");
  return `0x${raw.padStart(64, "0")}`;
}

const MOVE_TO_CODE: Record<string, number> = {
  stunned: 0,
  punch: 1,
  kick: 2,
  block: 3,
  special: 4,
};

let poseidonPromise: Promise<any> | null = null;
async function getPoseidon(): Promise<any> {
  if (!poseidonPromise) poseidonPromise = buildPoseidon();
  return poseidonPromise;
}

async function computeExpectedCommitmentHex(params: {
  matchId: string;
  roundNumber: number;
  turnNumber: number;
  playerAddress: string;
  surgeCardId?: string | null;
  nonceDecimal: string;
  movePlan: string[];
}): Promise<string> {
  const poseidon = await getPoseidon();
  const matchIdField = toFieldBigint(params.matchId);
  const playerField = toFieldBigint(params.playerAddress);
  const surgeCode = 0n; // tests use null surge
  const nonce = BigInt(params.nonceDecimal);

  const moveCodes = params.movePlan.map((move) => BigInt(MOVE_TO_CODE[String(move)] ?? MOVE_TO_CODE.block));
  const preimage: bigint[] = [
    matchIdField,
    BigInt(params.roundNumber),
    BigInt(params.turnNumber),
    playerField,
    surgeCode,
    nonce,
    ...moveCodes,
  ];

  const out = poseidon(preimage);
  const asBigint: bigint = poseidon.F.toObject(out);
  return normalizeHex32(`0x${asBigint.toString(16)}`);
}

describe("zk-round-commit private round auto-resolution integration", () => {
  beforeEach(() => {
    process.env.ZK_PRIVATE_ROUNDS = "true";
    process.env.ZK_STRICT_FINALIZE = "false";
  });

  it("overrides planned moves with stunned across auto turns (carry stun + guard-break stun)", async () => {
    const matchId = "match-1";
    const roundNumber = 1;
    const player1 = "p1-address";
    const player2 = "p2-address";

    const player1Plan = Array(10).fill("special");
    const player2Plan = Array(10).fill("punch");

    const nonceDecimal = "1";
    const p1Commitment = await computeExpectedCommitmentHex({
      matchId,
      roundNumber,
      turnNumber: 1,
      playerAddress: player1,
      surgeCardId: null,
      nonceDecimal,
      movePlan: player1Plan,
    });
    const p2Commitment = await computeExpectedCommitmentHex({
      matchId,
      roundNumber,
      turnNumber: 1,
      playerAddress: player2,
      surgeCardId: null,
      nonceDecimal,
      movePlan: player2Plan,
    });

    const db: InMemoryDb = {
      matches: [
        {
          id: matchId,
          status: "in_progress",
          player1_address: player1,
          player2_address: player2,
        },
      ],
      fight_state_snapshots: [
        {
          match_id: matchId,
          player1_is_stunned: true,
          player2_is_stunned: false,
          player1_has_submitted_move: false,
          player2_has_submitted_move: false,
        },
      ],
      round_private_commits: [
        {
          match_id: matchId,
          round_number: roundNumber,
          player_address: player1,
          commitment: p1Commitment,
          encrypted_plan: JSON.stringify({
            move: "special",
            movePlan: player1Plan,
            surgeCardId: null,
          }),
          proof_public_inputs: [p1Commitment],
          transcript_hash: nonceDecimal,
          resolved_round_id: null,
          resolved_at: null,
          updated_at: new Date().toISOString(),
        },
        {
          match_id: matchId,
          round_number: roundNumber,
          player_address: player2,
          commitment: p2Commitment,
          encrypted_plan: JSON.stringify({
            move: "punch",
            movePlan: player2Plan,
            surgeCardId: null,
          }),
          proof_public_inputs: [p2Commitment],
          transcript_hash: nonceDecimal,
          resolved_round_id: null,
          resolved_at: null,
          updated_at: new Date().toISOString(),
        },
      ],
      rounds: [],
      power_surges: [],
    };

    const supabase = createSupabaseMock(db);
    const emittedEvents: Array<{ event: string; payload: any }> = [];
    const resolvedMoves: Array<{ roundId: string; turn: number; p1: string; p2: string }> = [];

    const originalSetTimeout = globalThis.setTimeout;
    (globalThis as any).setTimeout = (fn: (...args: any[]) => any, _ms?: number, ...args: any[]) => {
      fn(...args);
      return 0 as any;
    };

    try {
      mock.module("../../lib/supabase", () => ({
        getSupabase: () => supabase,
      }));

      mock.module("../../lib/matchmaker", () => ({
        broadcastGameEvent: async (_matchId: string, event: string, payload: any) => {
          emittedEvents.push({ event, payload });
        },
      }));

      mock.module("../../lib/zk-proof", () => ({
        verifyNoirProof: async () => ({ ok: true, backend: "mock", command: "none" }),
      }));

      mock.module("../../lib/round-resolver", () => ({
        isValidMove: (move: string) => ["punch", "kick", "block", "special", "stunned"].includes(move),
      }));

      mock.module("../../lib/power-surge", () => ({
        isPowerSurgeCardId: (_value: unknown) => false,
        POWER_SURGE_CARD_IDS: [] as any,
      }));

      mock.module("../../lib/stellar-contract", () => ({
        isOnChainRegistrationConfigured: () => false,
        prepareZkCommitOnChain: async () => ({ success: true }),
        setGroth16VerificationKeyOnChain: async () => ({ success: true }),
        setZkGateRequiredOnChain: async () => ({ success: true }),
        setZkVerifierContractOnChain: async () => ({ success: true }),
        setZkVerifierVkIdOnChain: async () => ({ success: true }),
        submitSignedZkCommitOnChain: async () => ({ success: true }),
        submitZkCommitOnChain: async () => ({ success: true }),
        submitZkVerificationOnChain: async () => ({ success: true }),
      }));

      mock.module("../../lib/combat-resolver", () => ({
        resolveTurn: async (_matchId: string, roundId: string) => {
          const round = db.rounds.find((row) => row.id === roundId);
          if (!round) {
            throw new Error(`Round ${roundId} not found`);
          }

          resolvedMoves.push({
            roundId,
            turn: Number(round.turn_number),
            p1: String(round.player1_move),
            p2: String(round.player2_move),
          });

          if (Number(round.turn_number) === 1) {
            // Intentionally stale snapshot (both false) to ensure carry uses
            // resolver-returned stun flags, not snapshot reads.
            db.fight_state_snapshots[0].player1_is_stunned = false;
            db.fight_state_snapshots[0].player2_is_stunned = false;
            return {
              isRoundOver: false,
              isMatchOver: false,
              matchWinner: null,
              player1IsStunnedNext: false,
              player2IsStunnedNext: true,
            };
          }

          db.fight_state_snapshots[0].player1_is_stunned = false;
          db.fight_state_snapshots[0].player2_is_stunned = false;
          return {
            isRoundOver: true,
            isMatchOver: false,
            matchWinner: null,
            player1IsStunnedNext: false,
            player2IsStunnedNext: false,
          };
        },
      }));

      const { handleResolvePrivateRound } = await import("./zk-round-commit");

      const response = await handleResolvePrivateRound(
        matchId,
        new Request("http://localhost/resolve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            address: player1,
            roundNumber,
            turnNumber: 1,
            move: "special",
            movePlan: player1Plan,
            proof: "proof-1",
            publicInputs: [p1Commitment],
            transcriptHash: nonceDecimal,
          }),
        }),
      );

      const payload = await response.json();
      expect(response.status).toBe(200);
      expect(payload.success).toBe(true);

      expect(resolvedMoves.length).toBe(2);

      // Turn 1: player1 was stunned from previous turn => planned special overridden to stunned.
      expect(resolvedMoves[0]).toEqual({
        roundId: resolvedMoves[0].roundId,
        turn: 1,
        p1: "stunned",
        p2: "punch",
      });

      // Turn 2: carry stun from turn 1 (guard break path) => player2 overridden to stunned.
      expect(resolvedMoves[1]).toEqual({
        roundId: resolvedMoves[1].roundId,
        turn: 2,
        p1: "special",
        p2: "stunned",
      });

      const revealEvent = emittedEvents.find((entry) => entry.event === "round_plan_revealed");
      expect(Boolean(revealEvent)).toBe(true);

      const resolvedRoundId = db.round_private_commits[0].resolved_round_id;
      expect(typeof resolvedRoundId).toBe("string");
      expect(resolvedRoundId).toBe(resolvedMoves[1].roundId);
    } finally {
      (globalThis as any).setTimeout = originalSetTimeout;
      mock.restore();
    }
  });
});
