# Veilstar Round Plan Circuit

This is the dedicated Noir circuit project for private round-plan commitment checks.

## What this is

- Inputs: match, round, player, surge card, 10 planned moves, nonce
- Public output: `commitment`
- Commitment relation uses `Poseidon2` over the full round preimage.

## Commitment preimage

`commitment = Poseidon2::hash([match_id, round_number, player_address, surge_card, move_0..move_9, nonce])`

## Local files

- `Nargo.toml` — Noir package manifest
- `src/main.nr` — circuit
- `Prover.toml` — sample witness input
