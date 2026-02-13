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
    expect(finality.specialEnergyCost).toBe(24);
  });

  it("applies vaultbreaker and mempool-congest energy logic correctly", () => {
    const { player1Modifiers: vault, player2Modifiers: drain } = calculateSurgeEffects(
      "vaultbreaker",
      "mempool-congest"
    );

    const vaultHit = applyEnergyEffects(vault, 40, true);
    expect(vaultHit.energyStolen).toBe(40);
    expect(vaultHit.energyBurned).toBe(0);

    const drainNoHit = applyEnergyEffects(drain, 80, false);
    expect(drainNoHit.energyBurned).toBe(35);
    expect(drainNoHit.energyStolen).toBe(0);
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
