import { describe, expect, it } from "bun:test";
import {
  applyDamageModifiers,
  applyDefensiveModifiers,
  applyEnergyEffects,
  applyHpEffects,
  calculateSurgeEffects,
} from "./surge-effects";

describe("surge-effects", () => {
  it("maps card ids to expected offensive/utility modifiers", () => {
    const { player1Modifiers: pruned, player2Modifiers: finality } = calculateSurgeEffects(
      "pruned-rage",
      "finality-fist"
    );

    expect(pruned.damageMultiplier).toBe(1.3);
    expect(pruned.opponentBlockDisabled).toBe(true);

    expect(finality.criticalHit).toBe(true);
    expect(finality.damageMultiplier).toBe(1.7);
    expect(finality.specialEnergyCost).toBe(0);
  });

  it("applies converted non-energy card logic correctly", () => {
    const { player1Modifiers: vault, player2Modifiers: mempool } = calculateSurgeEffects(
      "vaultbreaker",
      "mempool-congest",
    );

    expect(vault.doubleHit).toBe(true);
    expect(vault.doubleHitMoves).toEqual(["kick"]);

    const reflected = applyDefensiveModifiers(20, mempool, true);
    expect(reflected.actualDamage).toBe(20);
    expect(reflected.reflectedDamage).toBe(15);

    const noEnergySideEffect = applyEnergyEffects(vault, 80, true);
    expect(noEnergySideEffect.energyBurned).toBe(0);
    expect(noEnergySideEffect.energyStolen).toBe(0);
  });

  it("applies damage, defense, and hp effects in isolation", () => {
    const { player1Modifiers: attacker, player2Modifiers: defender } = calculateSurgeEffects(
      "dag-overclock",
      "sompi-shield"
    );

    const boosted = applyDamageModifiers(10, attacker, "punch", false);
    expect(boosted).toBe(14);

    const reduced = applyDefensiveModifiers(boosted, defender, false);
    expect(reduced.actualDamage).toBe(7);
    expect(reduced.reflectedDamage).toBe(0);

    const healed = applyHpEffects(calculateSurgeEffects("blue-set-heal", null).player1Modifiers, 70, 100);
    expect(healed).toBe(80);
  });
});
