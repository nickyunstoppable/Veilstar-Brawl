import { describe, expect, it } from "bun:test";
import { resolveRound } from "./round-resolver";

describe("round-resolver power surge integration", () => {
  it("still deals damage when opponent is stunned", () => {
    const result = resolveRound(
      {
        player1Move: "punch",
        player2Move: "stunned",
        player1Health: 100,
        player2Health: 100,
        player1Energy: 100,
        player2Energy: 100,
        player1Guard: 0,
        player2Guard: 0,
      },
      {
        matchId: "m-stunned",
        roundNumber: 1,
        turnNumber: 1,
        player1Surge: null,
        player2Surge: null,
      }
    );

    expect(result.player1.outcome).toBe("hit");
    expect(result.player2.outcome).toBe("stunned");
    expect(result.player1.damageDealt).toBe(10);
    expect(result.player2.damageTaken).toBe(10);
    expect(result.player2HealthAfter).toBe(90);
  });

  it("does not charge energy for unaffordable moves (auto-block)", () => {
    const result = resolveRound(
      {
        // Player 1 tries to kick without enough energy; server should auto-convert to block.
        player1Move: "kick",
        player2Move: "stunned",
        player1Health: 100,
        player2Health: 100,
        player1Energy: 10,
        player2Energy: 100,
        player1Guard: 0,
        player2Guard: 0,
      },
      {
        matchId: "m-energy-auto-block",
        roundNumber: 1,
        turnNumber: 1,
        player1Surge: null,
        player2Surge: null,
      }
    );

    // Move becomes a block (guarding vs stunned) and should gain regen energy without paying kick cost.
    expect(result.player1.move).toBe("block");
    expect(result.player1.outcome).toBe("guarding");
    expect(result.player1EnergyAfter).toBe(18); // 10 + ENERGY_REGEN(8)
    expect(result.player1GuardAfter).toBeGreaterThan(0);
  });

  it("applies tx-storm priority boost to break simultaneous-hit clashes", () => {
    const result = resolveRound(
      {
        player1Move: "punch",
        player2Move: "punch",
        player1Health: 100,
        player2Health: 100,
        player1Energy: 100,
        player2Energy: 100,
        player1Guard: 0,
        player2Guard: 0,
      },
      {
        matchId: "m-priority",
        roundNumber: 1,
        turnNumber: 1,
        player1Surge: "tx-storm",
        player2Surge: null,
      }
    );

    expect(result.player1.outcome).toBe("hit");
    expect(result.player2.outcome).toBe("staggered");
    expect(result.player1.damageDealt).toBe(10);
    expect(result.player2.damageDealt).toBe(0);
    expect(result.player1HealthAfter).toBe(100);
    expect(result.player2HealthAfter).toBe(90);
  });

  it("applies pruned-rage to bypass block and increase punch damage", () => {
    const result = resolveRound(
      {
        player1Move: "punch",
        player2Move: "block",
        player1Health: 100,
        player2Health: 100,
        player1Energy: 50,
        player2Energy: 50,
        player1Guard: 0,
        player2Guard: 0,
      },
      {
        matchId: "m-pruned",
        roundNumber: 1,
        turnNumber: 1,
        player1Surge: "pruned-rage",
        player2Surge: null,
      }
    );

    expect(result.player2.outcome).toBe("stunned");
    expect(result.player1.damageDealt).toBe(13);
    expect(result.player2HealthAfter).toBe(87);
  });

  it("applies bps-blitz lifesteal to attacking character hp", () => {
    const result = resolveRound(
      {
        player1Move: "kick",
        player2Move: "punch",
        player1Health: 80,
        player2Health: 100,
        player1Energy: 100,
        player2Energy: 100,
        player1Guard: 0,
        player2Guard: 0,
      },
      {
        matchId: "m-lifesteal",
        roundNumber: 1,
        turnNumber: 1,
        player1Surge: "bps-blitz",
        player2Surge: null,
      }
    );

    expect(result.player1.damageDealt).toBe(15);
    expect(result.player1.lifesteal).toBe(5);
    expect(result.player1HealthAfter).toBe(85);
  });

  it("applies vaultbreaker guard pressure on landed hit", () => {
    const result = resolveRound(
      {
        player1Move: "kick",
        player2Move: "punch",
        player1Health: 100,
        player2Health: 100,
        player1Energy: 100,
        player2Energy: 100,
        player1Guard: 0,
        player2Guard: 0,
      },
      {
        matchId: "m-energy",
        roundNumber: 1,
        turnNumber: 1,
        player1Surge: "vaultbreaker",
        player2Surge: null,
      }
    );

    expect(result.player1.outcome).toBe("hit");
    expect(result.player2.outcome).toBe("staggered");
    expect(result.player1.damageDealt).toBe(15);
    expect(result.player2HealthAfter).toBe(85);
    expect(result.player2GuardAfter).toBe(30);
  });

  it("applies vaultbreaker guard pressure when attack deals guarded damage", () => {
    const result = resolveRound(
      {
        player1Move: "kick",
        player2Move: "block",
        player1Health: 100,
        player2Health: 100,
        player1Energy: 100,
        player2Energy: 100,
        player1Guard: 0,
        player2Guard: 0,
      },
      {
        matchId: "m-vault-guarded",
        roundNumber: 1,
        turnNumber: 1,
        player1Surge: "vaultbreaker",
        player2Surge: null,
      }
    );

    expect(result.player2.damageTaken).toBeGreaterThan(0);
    expect(result.player2GuardAfter).toBe(70);
  });

  it("applies finality-fist crit without extra special energy cost", () => {
    const result = resolveRound(
      {
        player1Move: "special",
        player2Move: "kick",
        player1Health: 100,
        player2Health: 100,
        player1Energy: 100,
        player2Energy: 100,
        player1Guard: 0,
        player2Guard: 0,
      },
      {
        matchId: "m-finality",
        roundNumber: 1,
        turnNumber: 1,
        player1Surge: "finality-fist",
        player2Surge: null,
      }
    );

    expect(result.player1.damageDealt).toBe(42);
    expect(result.player1EnergyAfter).toBe(58);
  });

  it("ghost-dag prevents special from being counter-missed by punch", () => {
    const result = resolveRound(
      {
        player1Move: "special",
        player2Move: "punch",
        player1Health: 100,
        player2Health: 100,
        player1Energy: 100,
        player2Energy: 100,
        player1Guard: 0,
        player2Guard: 0,
      },
      {
        matchId: "m-ghost-dag",
        roundNumber: 1,
        turnNumber: 1,
        player1Surge: "ghost-dag",
        player2Surge: null,
      }
    );

    expect(result.player1.outcome).toBe("hit");
    expect(result.player1IsStunnedNext).toBe(false);
    expect(result.player2HealthAfter).toBe(75);
  });

  it("both ghost-dag: special vs punch should not stun either player", () => {
    const result = resolveRound(
      {
        player1Move: "special",
        player2Move: "punch",
        player1Health: 100,
        player2Health: 100,
        player1Energy: 100,
        player2Energy: 100,
        player1Guard: 0,
        player2Guard: 0,
      },
      {
        matchId: "m-ghost-both-missed",
        roundNumber: 1,
        turnNumber: 1,
        player1Surge: "ghost-dag",
        player2Surge: "ghost-dag",
      }
    );

    expect(result.player1.outcome).toBe("hit");
    expect(result.player2.outcome).toBe("hit");
    expect(result.player1IsStunnedNext).toBe(false);
    expect(result.player2IsStunnedNext).toBe(false);
  });

  it("ghost-dag prevents punch from being counter-staggered by kick", () => {
    const result = resolveRound(
      {
        player1Move: "punch",
        player2Move: "kick",
        player1Health: 100,
        player2Health: 100,
        player1Energy: 100,
        player2Energy: 100,
        player1Guard: 0,
        player2Guard: 0,
      },
      {
        matchId: "m-ghost-stagger",
        roundNumber: 1,
        turnNumber: 1,
        player1Surge: "ghost-dag",
        player2Surge: null,
      }
    );

    expect(result.player1.outcome).toBe("hit");
    expect(result.player1IsStunnedNext).toBe(false);
    expect(result.player1HealthAfter).toBe(85);
    expect(result.player2HealthAfter).toBe(90);
  });

  it("ghost-dag prevents kick from being reflected by block", () => {
    const result = resolveRound(
      {
        player1Move: "kick",
        player2Move: "block",
        player1Health: 100,
        player2Health: 100,
        player1Energy: 100,
        player2Energy: 100,
        player1Guard: 0,
        player2Guard: 0,
      },
      {
        matchId: "m-ghost-reflect",
        roundNumber: 1,
        turnNumber: 1,
        player1Surge: "ghost-dag",
        player2Surge: null,
      }
    );

    expect(result.player1.outcome).toBe("hit");
    expect(result.player1HealthAfter).toBe(100);
    expect(result.player2HealthAfter).toBe(92);
  });

  it("does not apply next-turn stun when block is shattered by special", () => {
    const result = resolveRound(
      {
        player1Move: "special",
        player2Move: "block",
        player1Health: 100,
        player2Health: 100,
        player1Energy: 100,
        player2Energy: 100,
        player1Guard: 0,
        player2Guard: 0,
      },
      {
        matchId: "m-guard-shattered-stun",
        roundNumber: 1,
        turnNumber: 1,
        player1Surge: null,
        player2Surge: null,
      }
    );

    expect(result.player2.outcome).toBe("shattered");
    expect(result.player2IsStunnedNext).toBe(false);
    expect(result.player1IsStunnedNext).toBe(false);
  });

  it("applies next-turn stun when guard meter overflows to break", () => {
    const result = resolveRound(
      {
        player1Move: "punch",
        player2Move: "block",
        player1Health: 100,
        player2Health: 100,
        player1Energy: 100,
        player2Energy: 100,
        player1Guard: 0,
        player2Guard: 90,
      },
      {
        matchId: "m-guard-meter-break-stun",
        roundNumber: 1,
        turnNumber: 1,
        player1Surge: null,
        player2Surge: null,
      }
    );

    expect(result.player2.outcome).toBe("guarding");
    expect(result.player2GuardAfter).toBe(0);
    expect(result.player2IsStunnedNext).toBe(true);
  });

  it("applies glass_cannon as +damage and +incoming damage", () => {
    const base = resolveRound(
      {
        player1Move: "punch",
        player2Move: "punch",
        player1Health: 100,
        player2Health: 100,
        player1Energy: 100,
        player2Energy: 100,
        player1Guard: 0,
        player2Guard: 0,
      },
      {
        matchId: "m-glass-base",
        roundNumber: 1,
        turnNumber: 1,
        player1Surge: null,
        player2Surge: null,
      }
    );

    const glass = resolveRound(
      {
        player1Move: "punch",
        player2Move: "punch",
        player1Health: 100,
        player2Health: 100,
        player1Energy: 100,
        player2Energy: 100,
        player1Guard: 0,
        player2Guard: 0,
      },
      {
        matchId: "m-glass-active",
        roundNumber: 1,
        turnNumber: 1,
        player1Surge: "mempool-congest",
        player2Surge: null,
      }
    );

    expect(glass.player1.damageDealt).toBeGreaterThan(base.player1.damageDealt);
    expect(glass.player1.damageTaken).toBeGreaterThan(base.player1.damageTaken);
  });

  it("applies thorns_aura reflected damage without blocking", () => {
    const result = resolveRound(
      {
        player1Move: "punch",
        player2Move: "block",
        player1Health: 100,
        player2Health: 100,
        player1Energy: 100,
        player2Energy: 100,
        player1Guard: 0,
        player2Guard: 0,
      },
      {
        matchId: "m-thorns",
        roundNumber: 1,
        turnNumber: 1,
        player1Surge: null,
        player2Surge: "hash-hurricane",
      }
    );

    expect(result.player2.move).toBe("block");
    expect(result.player1.damageTaken).toBeGreaterThan(0);
  });
});
