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

  it("applies updated non-energy surge logic correctly", () => {
    const { player1Modifiers: vault, player2Modifiers: mempool } = calculateSurgeEffects(
      "vaultbreaker",
      "mempool-congest",
    );

    expect(vault.guardPressureOnHit).toBe(30);
    expect(vault.energySteal).toBe(0);

    expect(mempool.opponentStun).toBe(false);
    expect(mempool.damageMultiplier).toBe(1.25);
    expect(mempool.incomingDamageReduction).toBe(-0.2);

    const { player1Modifiers: hash } = calculateSurgeEffects("hash-hurricane", null);
    expect(hash.thornsPercent).toBe(0.35);
    const noReflect = applyDefensiveModifiers(20, mempool, true);
    expect(noReflect.actualDamage).toBe(24);
    expect(noReflect.reflectedDamage).toBe(0);

    const thornsReflect = applyDefensiveModifiers(20, hash, false);
    expect(thornsReflect.actualDamage).toBe(20);
    expect(thornsReflect.reflectedDamage).toBe(7);

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
    expect(reduced.actualDamage).toBe(10);
    expect(reduced.reflectedDamage).toBe(0);

    const exactQuarterReduction = applyDefensiveModifiers(20, defender, false);
    expect(exactQuarterReduction.actualDamage).toBe(15);

    const healed = applyHpEffects(calculateSurgeEffects("blue-set-heal", null).player1Modifiers, 70, 100);
    expect(healed).toBe(75);

    const perTurnRegen = applyHpEffects(calculateSurgeEffects("blue-set-heal", null).player1Modifiers, 80, 100);
    expect(perTurnRegen).toBe(85);
  });
});
