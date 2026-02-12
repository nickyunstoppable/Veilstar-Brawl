/**
 * Power Surge (server)
 *
 * Provides deterministic per-round card decks and selection persistence in matches.power_surge_deck.
 *
 * NOTE: This is intentionally minimal vs the full client SurgeEffects system.
 * For now, the server only derives stun flags from the selected cards (mempool-congest).
 */

import crypto from "crypto";

export const POWER_SURGE_CARD_IDS = [
  "dag-overclock",
  "sompi-shield",
  "mempool-burn",
  "bps-syphon",
  "mempool-congest",
  "finality-fist",
  "10bps-barrage",
  "ghostdag",
  "hash-hurricane",
  "pruned-rage",
  "block-fortress",
  "blue-set-heal",
  "tx-storm",
  "orphan-smasher",
  "chainbreaker",
  "vaultbreaker",
] as const;

export type PowerSurgeCardId = (typeof POWER_SURGE_CARD_IDS)[number];

export const SURGE_SELECTION_SECONDS = 10;

export interface StoredSurgeRound {
  roundNumber: number;
  deadlineAt: number; // unix ms
  player1Cards: PowerSurgeCardId[];
  player2Cards: PowerSurgeCardId[];
  player1Selection: PowerSurgeCardId | null;
  player2Selection: PowerSurgeCardId | null;
}

export interface StoredSurgeDeck {
  version: 1;
  rounds: Record<string, StoredSurgeRound>;
}

export function isPowerSurgeCardId(x: unknown): x is PowerSurgeCardId {
  return typeof x === "string" && (POWER_SURGE_CARD_IDS as readonly string[]).includes(x);
}

function hashToBytes(seed: string): Buffer {
  return crypto.createHash("sha256").update(seed).digest();
}

function pickCards(seed: string, count: number): PowerSurgeCardId[] {
  const bytes = hashToBytes(seed);
  const picked: PowerSurgeCardId[] = [];

  // Simple deterministic selection without replacement.
  // Use successive bytes to pick indices from a shrinking pool.
  const pool = [...POWER_SURGE_CARD_IDS] as PowerSurgeCardId[];
  let byteIndex = 0;

  while (picked.length < count && pool.length > 0) {
    const b = bytes[byteIndex % bytes.length];
    byteIndex++;
    const idx = b % pool.length;
    picked.push(pool.splice(idx, 1)[0]);
  }

  return picked;
}

export function normalizeStoredDeck(raw: any): StoredSurgeDeck {
  if (!raw || typeof raw !== "object") return { version: 1, rounds: {} };
  if (raw.version !== 1) return { version: 1, rounds: {} };
  if (!raw.rounds || typeof raw.rounds !== "object") return { version: 1, rounds: {} };
  return raw as StoredSurgeDeck;
}

export function getOrCreateRoundDeck(params: {
  matchId: string;
  player1Address: string;
  player2Address: string;
  roundNumber: number;
  existingDeck: any;
  nowMs?: number;
}): { deck: StoredSurgeDeck; round: StoredSurgeRound } {
  const now = params.nowMs ?? Date.now();
  const deck = normalizeStoredDeck(params.existingDeck);
  const key = String(params.roundNumber);

  const existing = deck.rounds[key];
  if (existing && Array.isArray(existing.player1Cards) && Array.isArray(existing.player2Cards)) {
    return { deck, round: existing };
  }

  const deadlineAt = now + SURGE_SELECTION_SECONDS * 1000;

  const p1Seed = `${params.matchId}|round:${params.roundNumber}|p1:${params.player1Address}`;
  const p2Seed = `${params.matchId}|round:${params.roundNumber}|p2:${params.player2Address}`;

  const round: StoredSurgeRound = {
    roundNumber: params.roundNumber,
    deadlineAt,
    player1Cards: pickCards(p1Seed, 3),
    player2Cards: pickCards(p2Seed, 3),
    player1Selection: null,
    player2Selection: null,
  };

  deck.rounds[key] = round;
  return { deck, round };
}

export function computeStunFlags(p1Selection: PowerSurgeCardId | null, p2Selection: PowerSurgeCardId | null): {
  player1Stunned: boolean;
  player2Stunned: boolean;
} {
  // mempool-congest stuns opponent for 1 turn
  const player1Stunned = p2Selection === "mempool-congest";
  const player2Stunned = p1Selection === "mempool-congest";
  return { player1Stunned, player2Stunned };
}
