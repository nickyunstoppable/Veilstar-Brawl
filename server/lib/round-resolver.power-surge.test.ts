import { describe, expect, it } from "bun:test";
import { resolveRound } from "./round-resolver";

describe("round-resolver power surge integration", () => {
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

  it("applies vaultbreaker steal + mempool-congest drain to character energy", () => {
    const result = resolveRound(
      {
        player1Move: "punch",
        player2Move: "special",
        player1Health: 100,
        player2Health: 100,
        player1Energy: 10,
        player2Energy: 40,
        player1Guard: 0,
        player2Guard: 0,
      },
      {
        matchId: "m-energy",
        roundNumber: 1,
        turnNumber: 1,
        player1Surge: "vaultbreaker",
        player2Surge: "mempool-congest",
      }
    );

    expect(result.player1EnergyAfter).toBe(48);
    expect(result.player2EnergyAfter).toBe(0);
    expect(result.player2.energyDrained).toBe(40);
    expect(result.player1.energyDrained).toBe(10);
  });

  it("applies finality-fist extra special energy cost", () => {
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

    expect(result.player1EnergyAfter).toBe(34);
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
});
