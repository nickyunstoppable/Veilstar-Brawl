# Veilstar Round Plan Circuit

This is the dedicated Noir circuit project for private turn-commitment checks.

## What this is

- Inputs: match, round, turn, player, surge card, selected move, nonce
- Public output: `commitment`
- Commitment relation uses `Poseidon2` over the per-turn preimage.

## Commitment preimage

`commitment = Poseidon2::hash([match_id, round_number, turn_number, player_address, surge_card, selected_move, nonce])`

## Local files

- `Nargo.toml` — Noir package manifest
- `src/main.nr` — circuit
- `Prover.toml` — sample witness input
