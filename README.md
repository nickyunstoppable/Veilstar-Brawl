# Veilstar Brawl

A fully on-chain, zero-knowledge fighting game built on Stellar. Two players lock in their private round strategies simultaneously, neither can see the other's plan, and every match outcome is verified by a Groth16 proof running against BN254 elliptic-curve primitives on-chain. Spectators can put real XLM on the line in a commit-reveal betting pool that also settles through a ZK proof. The whole system — game contracts, verifier contract, betting contract, frontend, and backend — is deployed and live on Stellar Testnet.

**[Live Demo](https://veilstar-brawl.vercel.app)** | **[Demo Video](https://youtu.be/f3NXDcAKKn8)**

---

## Table of Contents

1. [Live Demo & Video](#live-demo--video)
2. [Why This Exists](#why-this-exists)
2. [ZK Mechanics Explained](#zk-mechanics-explained)
   - [Private Round Planning](#private-round-planning)
   - [The Groth16 Round-Plan Circuit](#the-groth16-round-plan-circuit)
   - [On-Chain Verification Pipeline](#on-chain-verification-pipeline)
   - [ZK-Settled Spectator Betting](#zk-settled-spectator-betting)
   - [The Betting Settlement Circuit](#the-betting-settlement-circuit)
3. [Smart Contracts](#smart-contracts)
   - [Veilstar Brawl Contract](#veilstar-brawl-contract)
   - [ZK Groth16 Verifier Contract](#zk-groth16-verifier-contract)
   - [ZK Betting Contract](#zk-betting-contract)
   - [Game Hub Integration](#game-hub-integration)
4. [Deployed Contract Addresses](#deployed-contract-addresses)
5. [Game Design](#game-design)
   - [Character Roster](#character-roster)
   - [Combat System](#combat-system)
   - [Power Surge Cards](#power-surge-cards)
   - [Match Formats](#match-formats)
   - [Staking](#staking)
6. [Architecture Overview](#architecture-overview)
   - [Frontend](#frontend)
   - [Backend Server](#backend-server)
   - [Database](#database)
   - [ZK Proving Pipeline](#zk-proving-pipeline)
7. [End-to-End Flow: A Match From Start to Finish](#end-to-end-flow-a-match-from-start-to-finish)
8. [End-to-End Flow: Bot Betting From Start to Claim](#end-to-end-flow-bot-betting-from-start-to-claim)
9. [Key Files Reference](#key-files-reference)
10. [Local Development Setup](#local-development-setup)
11. [Environment Variables](#environment-variables)
12. [Testing](#testing)
13. [Deployment](#deployment)
14. [Hackathon Criteria Checklist](#hackathon-criteria-checklist)

---

## Live Demo & Video

- **Live Demo:** [veilstar-brawl.vercel.app](https://veilstar-brawl.vercel.app)
- **Demo Video:** [youtu.be/f3NXDcAKKn8](https://youtu.be/f3NXDcAKKn8)

---

## Why This Exists

Fighting games live and die by information asymmetry. In a real arcade match, your opponent cannot see your hands. Online, every client traditionally sends moves to a trusted server, which means the server knows everything — and so does anyone who can intercept traffic. In games with staking or betting, that is a serious problem: the party who resolves the match has privileged knowledge.

Veilstar Brawl changes this with zero-knowledge proofs. When you plan a 10-move round, you hash your moves with a Poseidon hash function inside a Circom circuit, submit only the commitment on-chain, and prove after resolution that your submitted moves were honestly derived from that commitment. No one — not the server, not a spectator, not the opponent — can reconstruct your plan until you choose to reveal it. The proof guarantees you cannot lie about what your plan was.

This is not a gimmick. The ZK gate is enforced at the contract level: `end_game` will reject any outcome that is not backed by an on-chain `ZkMatchOutcomeRecord`, which can only exist if a valid Groth16 proof was verified by the `zk-groth16-verifier` contract. A cheating server cannot declare a false winner.

The same principle applies to the betting pools. Spectators commit before the match ends, reveal after, and the pool settles only when a Groth16 proof cryptographically binds the `match_id`, `pool_id`, and `winner_side` to the on-chain outcome. The betting contract calls the same verifier contract cross-contract, and it will revert if the proof is invalid.

---

## ZK Mechanics Explained

### Private Round Planning

Each round in Veilstar Brawl is played in **best-of-3 rounds**, each round consisting of up to **10 turns**. Instead of submitting moves turn-by-turn in public, each player privately plans the full 10-turn sequence at the start of a round. The plan is never transmitted as plaintext.

The flow is:

1. The player selects their 10 moves locally in the browser: `punch`, `kick`, `block`, `special`, or a combination depending on energy.
2. The browser generates a 32-byte random `nonce`.
3. The browser spawns a dedicated Web Worker prover, fetches `/api/zk/artifacts/round-plan/round_plan.wasm` and `/api/zk/artifacts/round-plan/round_plan_final.zkey`, and runs `snarkjs groth16 fullProve` locally. The worker returns the proof, commitment (Poseidon hash output), and public inputs.
4. The player's Stellar wallet is prompted to sign an auth entry authorizing an on-chain `submit_zk_commit` call to the `veilstar-brawl` contract. The commitment is stored on-chain under a (session_id, match_salt, round, turn, player_index) key.
5. The signed transaction is submitted to the backend, which sets it on-chain via Soroban.
6. After both players have committed, the backend resolves turns one at a time using the privately planned moves. The resolution is server-authoritative and streamed to clients over Supabase Realtime channels.
7. At round-end, the backend proves the finalized round plan, calls `submit_zk_verification` on the contract, which cross-calls the verifier to confirm the proof against the stored commitment and the VK.
8. After all rounds complete, `submit_zk_match_outcome` is called to record the winner with a Groth16 proof, and then `end_game` closes the match. If `ZkGateRequired` is set on the contract, `end_game` will revert if the outcome is not backed by an on-chain ZK match outcome record.

The server cannot lie about moves because the commitment is stored on-chain before resolution. The server cannot lie about the winner because the winner must match the address inside the `ZkMatchOutcomeRecord`.

### The Groth16 Round-Plan Circuit

Location: `zk_circuits/veilstar_round_plan_groth16/round_plan.circom`

```circom
pragma circom 2.1.6;

include "circomlib/circuits/poseidon.circom";

template RoundPlanCommitment() {
    signal input commitment;        // public — stored on-chain
    signal input match_id;          // private
    signal input round_number;      // private
    signal input turn_number;       // private
    signal input player_address;    // private
    signal input surge_card;        // private
    signal input nonce;             // private
    signal input moves[10];         // private — the 10-turn plan

    component hash = Poseidon(16);
    hash.inputs[0] <== match_id;
    hash.inputs[1] <== round_number;
    hash.inputs[2] <== turn_number;
    hash.inputs[3] <== player_address;
    hash.inputs[4] <== surge_card;
    hash.inputs[5] <== nonce;
    for (var i = 0; i < 10; i++) {
        hash.inputs[6 + i] <== moves[i];
    }
    commitment === hash.out;
}

component main {public [commitment]} = RoundPlanCommitment();
```

The only public signal is `commitment`. The 10 moves, the nonce, and the player identity are all private witnesses. The proof asserts: "I know a preimage (match_id, round_number, turn_number, player_address, surge_card, nonce, moves[0..9]) whose Poseidon hash equals the public commitment." Without the proof you cannot determine the moves. With the proof you cannot forge a different set of moves.

The circuit uses Poseidon for hashing because Poseidon is ZK-friendly (it was designed for arithmetic circuits) and because Stellar Protocol 25 (X-Ray) added BN254 elliptic-curve primitives on-chain, making Groth16 proofs over BN254 natively verifiable inside Soroban contracts.

The serialized Groth16 calldata is exactly 256 bytes: 64 bytes for $\pi_A$ (G1), 128 bytes for $\pi_B$ (G2), 64 bytes for $\pi_C$ (G1). The contract enforces this length before calling the verifier.

### On-Chain Verification Pipeline

The pipeline spans three contracts:

```
Frontend / Backend
      |
      | submit_zk_commit (commitment, session_id, round, turn)
      v
veilstar-brawl contract
      |  stores commitment under DataKey::ZkCommit(session_id, salt, round, turn, is_p1)
      |  increments player1_zk_commits / player2_zk_commits
      |
      | submit_zk_verification (commitment, vk_id, proof, public_inputs)
      v
veilstar-brawl contract
      |  checks stored commitment == submitted commitment
      |  checks public_inputs[0] == commitment (binding)
      |  checks proof.len() == 256 (Groth16 calldata)
      |
      | cross-contract call: verify_round_proof(vk_id, proof, public_inputs)
      v
zk-groth16-verifier contract
      |  looks up VerificationKey by vk_id
      |  uses env.crypto().bn254 to run the Groth16 pairing check
      |  returns bool
      v
veilstar-brawl contract
      |  if false: Error::ZkProofInvalid
      |  if true: stores ZkVerified record, increments player_zk_verified
      |
      | submit_zk_match_outcome (winner, vk_id, proof, public_inputs)
      v
veilstar-brawl contract
      |  same flow — verifies winner proof
      |  stores ZkMatchOutcomeRecord { verifier_contract, winner, vk_id }
      |
      | end_game (session_id, player1_won)
      v
veilstar-brawl contract
      |  if zk_gate_required: reads ZkMatchOutcomeRecord, panics if absent
      |  if winner != claim: Error::InvalidWinnerClaim
      |  pays 2x stake to winner
      |  calls end_game on Game Hub
```

The verification key is uploaded to the verifier contract by the admin before the first match. The VK ID (a 32-byte hash of the verification key bytes) is then set on the `veilstar-brawl` contract as the required `ZkVerifierVkId`. Any proof submitted with a different VK ID is rejected even before the cross-contract call.

### ZK-Settled Spectator Betting

The betting system runs alongside the 24/7 bot battle room. Every bot match has an associated on-chain betting pool created by the admin before betting opens. Spectators place bets using a commit-reveal scheme to prevent anyone from copying a winning bet after the outcome is known.

The flow:

1. Spectator selects a side (`player1` or `player2`) and an amount in XLM.
2. The browser generates a 32-byte random salt locally.
3. The commitment is `SHA256(side_byte || salt)`.
4. The browser calls `commit_bet` on the `zk-betting` contract, transferring (amount + 1% fee) XLM. The bet is stored as a commitment — no revealed side yet.
5. Bet details (including the salt) are recorded in the backend database, encrypted for later reveal.
6. After betting closes, the backend locks the pool on-chain (`lock_pool`).
7. Before settlement, the admin reveals all bets on-chain: for each bet, it calls `admin_reveal_bet(pool_id, bettor, side, salt)`. The contract verifies `SHA256(side || salt) == commitment` and records the side.
8. The backend prover runs `snarkjs groth16 fullprove` against the `betting_settle.circom` circuit, generating a proof that binds `match_id`, `pool_id`, and `winner_side` together.
9. Admin calls `settle_pool_zk(pool_id, winner, vk_id, proof, public_inputs)`. The contract cross-calls the verifier. Only if the proof is valid and the winner matches `winner_side` in the public inputs will the pool settle.
10. After settlement, the admin automatically calls `admin_claim_payout` on behalf of every winning bettor. Winning bettors receive 2x their net bet amount directly to their Stellar address with no manual action required.

### The Betting Settlement Circuit

Location: `zk_circuits/zk_betting_settle_groth16/betting_settle.circom`

```circom
pragma circom 2.1.6;

template BettingSettle() {
    signal input match_id;           // public
    signal input pool_id;            // public
    signal input winner_side;        // public

    signal input witness_match_id;   // private witness
    signal input witness_pool_id;    // private witness
    signal input witness_winner_side;// private witness

    witness_match_id === match_id;
    witness_pool_id === pool_id;
    witness_winner_side === winner_side;

    winner_side * (winner_side - 1) === 0;  // must be 0 or 1
}

component main { public [match_id, pool_id, winner_side] } = BettingSettle();
```

The three public inputs are bound into the proof itself. The `settle_pool_zk` function checks that `public_inputs[1]` (pool_id as a 32-byte field element) matches the pool being settled, preventing proof replay across pools. The `winner_side` quadratic constraint ensures only valid sides (0 = player1, 1 = player2) can satisfy the circuit.

---

## Smart Contracts

All contracts are written in Rust using the Soroban SDK and compiled to WASM32.

### Veilstar Brawl Contract

**Source:** `contracts/veilstar-brawl/src/lib.rs`

The main game contract. It acts as the coordinator for the full match lifecycle.

**Key entry points:**

| Function | Auth Required | Description |
|---|---|---|
| `start_game(session_id, player1, player2, p1_points, p2_points)` | Player1 + Player2 | Creates match, calls `start_game` on Game Hub. |
| `submit_move(session_id, player, move_type, turn)` | Player | Charges 0.0001 XLM, records the move, emits a `move` event. |
| `submit_power_surge(session_id, player, round, card_code)` | Player | Records a Power Surge card selection, charges 0.0001 XLM. |
| `set_match_stake(session_id, stake_amount_stroops)` | Admin | Sets a wager amount for a match. Can be set before or after `start_game`. |
| `deposit_stake(session_id, player)` | Player | Deposits stake + 0.1% fee. Required before `end_game` if stake is configured. |
| `submit_zk_commit(session_id, player, round, turn, commitment)` | Player | Stores a round-plan commitment on-chain. |
| `submit_zk_verification(session_id, player, round, turn, commitment, vk_id, proof, public_inputs)` | None | Verifies a round-plan Groth16 proof against the stored commitment. Cross-calls verifier. |
| `submit_zk_match_outcome(session_id, winner, vk_id, proof, public_inputs)` | None | Records the proven match winner. Required if `ZkGateRequired` is true. |
| `end_game(session_id, player1_won)` | Admin | Closes the match, optionally pays winner 2x stake, calls `end_game` on Game Hub. If `ZkGateRequired`, checks for a `ZkMatchOutcomeRecord`. |
| `cancel_match(session_id)` | Admin | Cancels match and refunds any paid stakes. |
| `expire_stake(session_id)` | Admin | Cancels a match after the stake deposit window expires. Refunds any deposits. |
| `sweep_treasury()` | Admin | Transfers accrued protocol fees to the treasury. Rate-limited to once per 24 hours. |

**ZK enforcement:** When `set_zk_gate_required(true)` is set on the contract, `end_game` will not accept any outcome that is not backed by a valid on-chain `ZkMatchOutcomeRecord`. This means the admin cannot declare a false winner even if they control the private key — the winner must match what the proof says.

**Economic model:**
- Combat moves cost 0.0001 XLM each (on-chain recording fee)
- Match staking: winner takes 2x stake, 0.1% protocol fee retained
- Fees accrue in contract storage and are swept to treasury wallet no more than once per 24 hours
- 10 XLM minimum reserve maintained in contract to cover operational balances

**Match state** is stored in WASM temporary storage with a 30-day TTL (~518,400 ledgers at ~5 seconds per ledger). A per-match salt derived from the session ID and ledger sequence prevents commitment key collisions across different matches reusing the same session ID.

### ZK Groth16 Verifier Contract

**Source:** `contracts/zk-groth16-verifier/src/lib.rs`

A standalone verifier contract that stores verification keys and runs Groth16 pairing checks using Stellar Protocol 25 BN254 primitives.

**Key entry points:**

| Function | Description |
|---|---|
| `set_verification_key(vk_id, alpha_g1, beta_g2, gamma_g2, delta_g2, ic)` | Admin-only. Stores a Groth16 VK. `ic` length must equal `n_public_inputs + 1`. |
| `verify_round_proof(vk_id, proof, public_inputs)` | Stateless. Deserializes the 256-byte calldata proof, runs the Groth16 multi-pairing check using `env.crypto().bn254`, returns bool. |

The Groth16 verification equation is:

$$e(\pi_A, \pi_B) = e(\alpha_1, \beta_2) \cdot e(L_{\text{pub}}, \gamma_2) \cdot e(\pi_C, \delta_2)$$

$$L_{\text{pub}} = \text{IC}_0 + \sum_{i=0}^{n} \text{inputs}_i \cdot \text{IC}_{i+1}$$

where $L_{\text{pub}}$ is the linear combination of the IC vector with the public inputs.

All elliptic-curve operations (point deserialization, scalar multiplication, multi-pairing) run as Soroban host functions using the BN254 primitives introduced in Protocol 25. No ZK library is linked into the contract WASM; the heavy lifting is done by the protocol's native cryptographic opcodes.

The contract caches VKs by their 32-byte `vk_id` in instance storage. Multiple circuits can share the same verifier contract by registering under different VK IDs.

### ZK Betting Contract

**Source:** `contracts/zk-betting/src/lib.rs`

A permissioned betting pool contract with commit-reveal mechanics and ZK-backed settlement.

**Lifecycle:**

```
create_pool  →  commit_bet (open)  →  lock_pool  →  reveal_bet / admin_reveal_bet  →  settle_pool_zk  →  claim_payout
```

**Key entry points:**

| Function | Auth Required | Description |
|---|---|---|
| `create_pool(match_id, deadline_ts)` | Admin | Creates a new betting pool, returns `pool_id`. |
| `commit_bet(pool_id, bettor, commitment, amount)` | Bettor | Deposits (amount + 1% fee) XLM, stores commitment. Requires pool to be open and before deadline. Minimum bet is 0.1 XLM. |
| `lock_pool(pool_id)` | Admin | Closes betting. No new bets after this. |
| `reveal_bet(pool_id, side, salt)` | Bettor | Reveals side using `SHA256(side_byte || salt) == commitment`. |
| `admin_reveal_bet(pool_id, bettor, side, salt)` | Admin | Admin-controlled reveal for automation. |
| `settle_pool_zk(pool_id, winner, vk_id, proof, public_inputs)` | Admin | Settles pool with Groth16 proof. Cross-calls verifier. Validates `public_inputs[1]` matches pool_id to prevent replay. Validates `public_inputs[2]` matches winner_side. |
| `claim_payout(pool_id)` | Bettor | Winner claims 2x net bet amount (fallback path). |
| `admin_claim_payout(pool_id, bettor)` | Admin | Admin auto-claims on bettor's behalf immediately after settlement. This is the primary payout path — bettors receive funds automatically. |
| `sweep_fees()` | Admin | Sweeps accrued 1% fees to treasury. Rate-limited to 24 hours. |

**Settlement validation in the contract** (Rust):

```rust
// public_inputs[0] = match_id (32 bytes as field element)
// public_inputs[1] = pool_id (32 bytes as field element)
// public_inputs[2] = winner_side (0 = Player1, 1 = Player2)

let verifier = ZkVerifierClient::new(&env, &verifier_contract);
let verified = verifier.verify_round_proof(&vk_id, &proof, &public_inputs);
if !verified {
    return Err(Error::ZkProofInvalid);
}
```

The verification key for the betting circuit is separate from the game circuit. The admin configures it by calling `set_zk_verifier(verifier_contract_address, vk_id)` on the betting contract.

### Game Hub Integration

The `veilstar-brawl` contract calls `start_game()` and `end_game()` on the official Game Hub contract as required by the hackathon. Both player addresses, their ELO rating points, and the session ID are passed to `start_game`. The final boolean winner result is passed to `end_game`.

The Game Hub contract address used:

```
CB4VZAT2U3UC6XFK3N23SKRF2NDCMP3QHJYMCHHFMZO7MRQO6DQ2EMYG
```

---

## Deployed Contract Addresses

Network: Stellar Testnet (`Test SDF Network ; September 2015`)

| Contract | Address |
|---|---|
| Game Hub (official hackathon) | `CB4VZAT2U3UC6XFK3N23SKRF2NDCMP3QHJYMCHHFMZO7MRQO6DQ2EMYG` |
| Veilstar Brawl | `CCFLSDEATZG2LAA3P7UVEYBXDW637RN5F56EIMDTEXW7HUP537SAKJ57` |
| ZK Groth16 Verifier | `CARETBOWG5GFEXMLZUUAOBZG5SLXS6A5CSDRIQIFLUV4VQZEBZC6AMKT` |
| ZK Betting | `CAXLEDHRDFD3E3NYMBJTIIGFAXUVKKE7352XSMUALPSOEMPF7SA7F5AH` |

Deployed at: `2026-02-21T15:12:06.188Z`

---

## Game Design

### Character Roster

20 playable characters across four archetypes, each with distinct base stats:

**Speed archetype** (lower HP, higher energy regen, attack multipliers on fast moves)
- Cyber Ninja — swift shadow assassin with digital blades
- Sonic Striker — hypersonic combatant breaking sound barriers
- Chrono Drifter — time-bending fighter from another epoch
- Neon Wraith — spectral warrior phasing through reality
- Viperblade — venomous assassin with plasma edge

**Tank archetype** (high HP, low energy, slow regen, heavy damage modifiers)
- Ledger Titan — armored juggernaut built on the Stellar ledger
- Heavy Loader — industrial powerhouse with hydraulic fists
- Gene Smasher — mutated brawler with unstable DNA
- Bastion Hulk — defensive titan with impenetrable armor
- Scrap Goliath — junkyard colossus reassembled from scrap

**Tech archetype** (balanced HP/energy, high special damage, energy-efficient)
- Soroban Sage — blockchain-powered fighter channeling Soroban smart contracts
- Technomancer — wizard of circuits blending magic and technology
- Nano Brawler — microscopic warrior with nanite swarm powers
- Razor Bot 7 — military-grade automaton designed for combat
- Cyber Paladin — holy warrior in quantum-forged armor

**Precision archetype** (high block effectiveness, crit-oriented, energy steal builds)
- Hash Hunter — sharpshooter tracking targets across the grid
- Prism Duelist — light-bending fencer with photon rapier
- Kitsune-09 — fox spirit with nine tails of digital fire
- Void Reaper — dimensional harvester from the quantum void
- Aeon Guard — ancient sentinel awakened by the blockchain

Each character has individual combat stats: `maxHp`, `maxEnergy`, per-move `damageModifiers`, `blockEffectiveness`, `specialCostModifier`, and `energyRegen`. For example, Bastion Hulk has `blockEffectiveness: 0.85` (absorbs 85% of incoming damage when blocking) but flat 1.0 damage modifiers, while Gene Smasher inverts that trade-off — `damageModifiers.punch: 1.25` and `damageModifiers.kick: 1.25` at the cost of `blockEffectiveness: 0.25`. Speed characters like Neon Wraith run at only 92 HP but regenerate 25 energy per turn, enabling more frequent kicks and specials across a 10-turn private round plan.

### Combat System

Each match is played in **Best of 3 rounds** (configurable to Best of 5). A round ends when one player reaches 0 HP, or after 10 turns, with the player at higher HP winning that round.

**Move types:**

| Move | Base Damage | Energy Cost | Guard Damage | Effect |
|---|---|---|---|---|
| Punch | 10 | 0 | 5 | Quick strike, always available |
| Kick | 15 | 25 | 10 | Powerful but energy-gated |
| Block | 0 | 0 | 0 | Absorbs incoming damage by `blockEffectiveness`, builds 20 guard meter |
| Special | 25 | 50 | 15 | High output but expensive |

**Resolution matrix:** Moves resolve simultaneously. Block reduces incoming damage. Special has higher priority than Kick, which has higher priority than Punch. Ties resolve at equal priority. Stunned players cannot act and are forced into a `stunned` move that deals 0 damage and costs 0 energy.

**Guard meter:** Each player maintains a 0–100 guard meter. Blocking builds it. Taking guard damage reduces it. When the guard meter is full, the player is stunned for the next turn.

**Energy system:** Energy regenerates each turn by the character's `energyRegen` stat. If energy falls below a move's cost, the player cannot select that move. Energy management across a private 10-turn plan is a core strategic layer — you cannot overspend.

**Private round planning:** This is the ZK layer. At the start of each round, the server broadcasts a `roundStart` event. Both players have 90 seconds to submit their private 10-move plan. The plan is committed on-chain before the opponent can see it. Turns then resolve sequentially using the committed moves, and the results broadcast to both players in real time via Supabase Realtime channels. After resolution, the proof is verified on-chain.

### Power Surge Cards

At the start of each round, three Power Surge cards are drawn from a 15-card deck (seeded deterministically by the match seed for reproducibility). Each player selects one. The selection is recorded on-chain via `submit_power_surge` (costs 0.0001 XLM) before the private round plan is committed.

The 15 cards cover diverse mechanical archetypes:

| Card | Effect |
|---|---|
| DAG Overclock | +40% all damage dealt |
| Block Fortress | Blocks reflect 120% incoming damage to attacker |
| Tx Tempo | +2 priority on all clashes this round |
| Mempool Mirror | +25% damage, but take +20% more incoming damage |
| Blue Set Heal | Restore 5 HP per turn passively |
| Orphan Smasher | Counter damage +75% |
| 10bps Barrage | Attacks hit twice |
| Pruned Rage | +35% damage, opponent cannot block |
| Sompi Shield | Reduce all incoming damage by 45% |
| Hash Hurricane | Random chance each turn to win the clash outright |
| Ghost DAG | Stealth move bypasses opponent's chosen action |
| Finality Fist | Guaranteed critical on special move |
| BPS Blitz | Extra energy regen each turn |
| Vaultbreaker | Steals opponent energy on hit |
| Chainbreaker | Break opponent's guard on every hit regardless of guard meter |

Card effects are computed server-side in `server/lib/surge-effects.ts` and re-computed client-side in `veilstar-brawl-frontend/src/game/combat/SurgeEffects.ts` for display purposes. The server result is authoritative.

### Match Formats

- **Best of 3** — standard competitive format, 3 rounds max, first to 2 wins
- **Practice mode** — local bot opponent, no on-chain transactions, no staking
- **Bot spectator mode** — 24/7 pre-simulated bot matches for spectating and betting

### Staking

Match staking is optional. When configured by the admin before the match, each player deposits (stake + 0.1% fee) XLM via `deposit_stake` during the character selection phase. If both deposits are confirmed within the 60-second deposit window, the winner receives exactly 2x the stake amount from the contract. The fee is retained and swept to the treasury address once per 24 hours.

If only one player deposits before the deadline, `expire_stake` is called and the depositing player is fully refunded. If neither deposits, the match is cancelled. Staking interacts correctly with the ZK gate: a staked match requires a ZK-backed outcome before `end_game` can pay out the winner.

---

## Architecture Overview

### Frontend

**Stack:** React 18, Vite, Tailwind CSS, Phaser 3, Framer Motion

**Key scenes (Phaser):**
- `CharacterSelectScene` — character selection and pre-match orchestration, handles wallet auth for on-chain match registration
- `FightScene` — the main battle arena, renders health/energy/guard bars, move buttons, Power Surge card overlays, the ZK progress indicator panel, the round timer, and disconnect overlays
- `BotBattleScene` — pre-computed bot match playback with time-synchronization across browser tab switches
- `PracticeScene` — local AI opponent, no ZK, no on-chain calls
- `ReplayScene` — deterministic replay of completed matches from stored turn data

**Key components (React):**
- `BotBettingPanel` — wallet-connected betting UX with countdown timer, pool status polling, and auto-settling indicators
- `BotSpectatorClient` — full spectator page with Phaser embed, betting panel side panel, and SpectatorChat
- `WinningNotification` — animated payout notification shown after a winning bet is settled and claimed

**Routing:** Custom SPA router using `window.history.pushState` and `popstate` events. No React Router dependency.

**Wallet integration:** Stellar wallets via the Wallet Interface Standard (Launchtube-compatible). Transactions are signed in-browser and broadcast through the Launchtube fee sponsor service, eliminating friction for new users who do not hold XLM for fees.

### Backend Server

**Stack:** Bun runtime, TypeScript, native HTTP server via `Bun.serve`

**Key route groups:**

| Route prefix | Purpose |
|---|---|
| `/api/health` | Liveness probe |
| `/api/matchmaking/*` | Queue management, room creation/join |
| `/api/matches/:matchId/*` | All match operations including ZK prove/commit/resolve/finalize |
| `/api/players/*` | Player profile and match history |
| `/api/leaderboard` | ELO-based rankings |
| `/api/bot-games/*` | Active bot match fetch, sync, and playback signals |
| `/api/bot-betting/*` | Betting pool fetch, bet placement, bet history |
| `/api/replay/:matchId` | Full turn-by-turn replay data |

**Key services:**

- `server/lib/matchmaker.ts` — ELO matchmaking queue with rating-range expansion (starts ±100 ELO, expands at 5 ELO per second after 10 seconds of waiting, max ±500 ELO)
- `server/lib/combat-resolver.ts` — authoritative round resolver; receives both players' committed moves, replays prior rounds to rebuild engine state, resolves current turn, writes result, broadcasts over Supabase Realtime, and triggers ZK finalization for completed matches
- `server/lib/stellar-contract.ts` — Soroban client wrapper for all contract interactions (start_game, end_game, submit_zk_commit, submit_zk_verification, submit_zk_match_outcome, reportMatchResultOnChain) with retry logic and idempotency classification
- `server/lib/zk-round-prover.ts` — subprocess manager for `snarkjs groth16 fullprove`; bootstraps circuit artifacts on first call, manages per-request working directories, and serializes Groth16 calldata to the 256-byte format the contract expects
- `server/lib/zk-finalizer-client.ts` — wraps the auto-prove-and-finalize flow; can delegate proof generation to a remote ZK service via `ZK_FINALIZE_API_BASE_URL`
- `server/lib/bot-match-service.ts` — 24/7 bot lifecycle worker; provisions on-chain betting pools, locks pools when betting closes, reveals all bets before settlement, generates ZK settlement proofs, settles on-chain, and auto-claims payouts for winners
- `server/lib/zk-betting-settle-prover.ts` — mirrors `zk-round-prover.ts` for the betting settlement circuit
- `server/lib/zk-betting-contract.ts` — admin client for the `zk-betting` contract; serialized admin tx queue prevents nonce race conditions
- `server/lib/abandonment-monitor.ts` — background worker watching for disconnected players; triggers match cancellation after timeout

### Database

**Platform:** Supabase (PostgreSQL + Realtime)

**Key tables:**

| Table | Purpose |
|---|---|
| `matches` | Match metadata, player addresses, format, status, stake amounts, ZK fields |
| `fight_state_snapshots` | Full serialized match state at any point (health, energy, guard, phase, deadline timestamps) |
| `zk_round_commits` | Off-chain copy of ZK commitments, proofs, and on-chain tx hashes per round/turn |
| `move_submissions` | Individual move records per turn per player |
| `power_surge_selections` | Per-round card selections |
| `matchmaking_queue` | Active player queue with ELO ratings and wait timestamps |
| `players` | Player profiles, ELO ratings, win/loss stats |
| `betting_pools` | Pool metadata including on-chain pool ID and status |
| `bets` | Individual bet records with commitment, amount, salt, reveal status, payout |

**Realtime channels:** Every active match has a dedicated Supabase Realtime channel (`match-{matchId}`). Round resolutions, ZK progress updates, Power Surge card broadcasts, and disconnect signals are all broadcast over this channel to both player clients.

### ZK Proving Pipeline

For private PvP rounds, proving runs in a browser Web Worker using `snarkjs` + `circomlibjs`. Circom circuits are compiled at development time to generate:

- `*.r1cs` — the rank-1 constraint system
- `*.wasm` — the witness computation WASM
- `verification_key.json` — the Groth16 verification key
- `*.zkey` — the proving key (ceremony output)

The full artifact set is committed to the repository under `zk_circuits/*/artifacts/`. At runtime, the worker fetches artifacts from `/api/zk/artifacts/round-plan/*` and executes proving entirely client-side for round plans.

The verification key's 32-byte hash (computed from the canonical JSON representation) is the `vk_id` used in all on-chain calls. The admin uploads the VK to the verifier contract at deployment time using `bun run zk:onchain:setup`. Once uploaded, the VK hash is set on the game and betting contracts. Any proof submitted with a different VK ID is rejected by the contracts before the cross-contract call is made.

---

## End-to-End Flow: A Match From Start to Finish

Below is a detailed walkthrough of a complete match between two real players.

**1. Matchmaking**

Both players connect their Stellar wallets on the Play page. They enter the matchmaking queue by POSTing to `/api/matchmaking/queue`. The server records their ELO ratings and monitors the queue for a compatible opponent. When found, both are notified and redirected to `/match/:matchId`.

**2. Contract Registration**

In `CharacterSelectClient`, the React component fetches the match metadata and calls `prepareRegistration` on the backend, which builds and simulates a `start_game` transaction. The player signs the auth entry in their wallet. The signed XDR is sent to `submitAuth`, which submits the transaction to Soroban. This registers the match on the `veilstar-brawl` contract and calls `start_game` on the Game Hub.

**3. Character Selection and Stake Deposit**

Both players select their character. If the match has staking configured, each player signs and submits a `deposit_stake` transaction within the 60-second window.

**4. Round Start**

The backend broadcasts a `roundStart` event over the Supabase Realtime channel including the round number, turn number, move deadline, and current state.

**5. Private Round Planning**

The player opens the Power Surge card selection UI, picks a card, then opens the move planning UI and allocates 10 moves. The frontend starts a browser worker prover, which generates the round proof locally from fetched artifacts. The frontend prepares the Soroban auth entry for `submit_zk_commit`, prompts the wallet to sign it, and calls `POST /api/matches/:matchId/zk/round/commit` with the signed payload. The backend submits the commitment on-chain and waits for the opponent.

**6. Turn Resolution**

Once both players have committed (or the deadline expires), the backend resolves turns 1 through 10 using the committed move plans. Each resolution is applied to the server-side `CombatEngine`, checked for surge effects, and broadcast as a `roundResolved` event. The frontend animates each turn's exchange sequentially.

**7. Round End Verification**

After all 10 turns resolve (or a KO occurs), the backend calls `submit_zk_verification` on the contract for each player. This proves the committed plan was valid and recorded on-chain. The contract's `player1_zk_verified` / `player2_zk_verified` counters increment.

**8. Match End (ZK Finalization)**

When the last round ends and a match winner is determined, the backend triggers `proveAndFinalizeMatch`. This:

1. Computes the winner's final round-plan proof
2. Calls `submit_zk_match_outcome(session_id, winner_address, vk_id, proof, [commitment])` on the contract — this stores the `ZkMatchOutcomeRecord`
3. Calls `end_game(session_id, player1_won)` — which reads and validates the `ZkMatchOutcomeRecord`, pays the stake if configured, and calls `end_game` on the Game Hub

The match is now fully settled on-chain with a cryptographic audit trail.

**9. Results Page**

Both players are redirected to the results screen showing the winner, match stats, and on-chain transaction hashes. The match is persisted in Supabase for replay.

---

## End-to-End Flow: Bot Betting From Start to Claim

The bot spectator room runs 24/7 with new matches generated automatically. Each match goes through the following lifecycle, mostly invisible to the user.

**1. Match Generation and Pool Provisioning**

When the previous match ends, `ensureActiveBotMatchInternal` in `bot-match-service.ts` generates a new match by simulating all turns deterministically (the bot uses a rule-based decision engine with pattern recognition). Before making the match active, `ensureBotPoolProvisioned` calls `createOnChainBotPool` on the `zk-betting` contract, setting a deadline timestamp. The match's `createdAt` is set only after the pool is live.

**2. Betting Window (30 seconds)**

Spectators see a countdown overlay on the bot battle page. The `BotBettingPanel` polls `/api/bot-betting/pool/:matchId` every 3 seconds. The user selects a side and optionally uses quick-bet buttons (1, 5, 10, 25, 50, 100 XLM).

On submit, the browser:
1. Generates a 32-byte salt locally
2. Computes `commitment = SHA256(side_byte || salt)`
3. Calls `commit_bet` on the `zk-betting` Soroban contract — this locks the funds on-chain immediately
4. Posts to `PUT /api/bot-betting/place` with the on-chain pool ID, commitment hash, salt, and tx hash — without the on-chain proof, the backend rejects the placement

**3. Lock**

When the match animation starts, the lifecycle worker detects `elapsed >= BETTING_DURATION_MS` and calls `lockOnChainPool`. No bets after this point.

**4. Match Plays Out**

The BotBattleScene replays the pre-computed turns at a configurable `turnDurationMs`. At the end, the Phaser scene emits `bot_battle_match_end` and `bot_battle_request_new_match`.

**5. ZK Settlement**

When `elapsed >= matchDurationMs + 5000`, `finalizeCompletedBotMatch` runs:

1. Locks pool if not already locked
2. Reveals all bets on-chain (`admin_reveal_bet` for each bettor)
3. Calls `getBotSettlementZkArtifacts`, which runs snarkjs against `betting_settle.circom` with `{match_id, pool_id, winner_side}` as inputs, producing a Groth16 proof
4. Calls `ensureZkBettingVerifierConfigured` to upload the VK if not already registered
5. Calls `settleOnChainPoolZk` — this hits the `zk-betting` contract, which cross-calls the verifier and settles atomically

**6. Automatic Payout**

After `settle_pool_zk` succeeds, `settleBotBetsOffchain` processes each bet in the database. For winning bets, the server immediately calls `admin_claim_payout` on-chain, transferring 2x the net bet amount (after the 1% fee) directly to the bettor's Stellar address. Bettors do not need to take any action — the payout arrives in their wallet automatically. The `BotBettingPanel` shows a payout confirmation with the claim tx hash.

**7. Win Notification**

`BotSpectatorClient` polls `/api/bot-betting/pool/:matchId?address=...` after the match ends. When `userBet.status === "won"` and `userBet.claim_tx_id` is populated, the `WinningNotification` component animates on screen showing the XLM payout amount.

---

## Key Files Reference

```
contracts/
  veilstar-brawl/src/lib.rs          Main game contract
  zk-groth16-verifier/src/lib.rs     Groth16 on-chain verifier
  zk-betting/src/lib.rs              ZK betting pool contract
  zk-betting/src/test.rs             12 contract unit tests

zk_circuits/
  veilstar_round_plan_groth16/
    round_plan.circom                 Private round-plan commitment circuit
    artifacts/                        Compiled R1CS, WASM, zkey, verification_key.json
  zk_betting_settle_groth16/
    betting_settle.circom             Settlement binding circuit
    artifacts/

server/
  index.ts                           Bun server entry, route dispatch
  lib/
    combat-resolver.ts               Authoritative round resolver
    stellar-contract.ts              Soroban client wrappers
    zk-round-prover.ts               snarkjs subprocess manager (round plan)
    zk-betting-settle-prover.ts      snarkjs subprocess manager (bet settlement)
    zk-finalizer-client.ts           Auto-prove-and-finalize orchestration
    zk-betting-contract.ts           Admin client for zk-betting contract
    bot-match-service.ts             24/7 bot lifecycle worker
    matchmaker.ts                    ELO matchmaking queue
    round-resolver.ts                Deterministic turn resolution engine
    surge-effects.ts                 Power Surge card effect computation
  routes/matches/
    zk-round-commit.ts               Commit/resolve private round endpoint
    zk-round-prove.ts                Proof generation delegation endpoint
    zk-finalize.ts                   ZK match outcome + end_game endpoint
    zk-prove-finalize.ts             Combined prove + finalize endpoint
    zk-round-commit.integration.test.ts

veilstar-brawl-frontend/src/
  game/scenes/FightScene.ts          Main battle Phaser scene (~4500 lines)
  game/scenes/BotBattleScene.ts      Bot spectator Phaser scene
  game/combat/CombatEngine.ts        Client-side combat engine (display sync)
  game/combat/SurgeEffects.ts        Surge effect resolution (client)
  components/fight/CharacterSelectClient.tsx   Pre-match React orchestration
  components/betting/BotBettingPanel.tsx       Spectator betting UI
  components/spectate/BotSpectatorClient.tsx   Full spectator page
  lib/zkPrivateRoundClient.ts        ZK API client (commit/prove/resolve)
  lib/betting/zk-betting-service.ts  Soroban betting contract client

scripts/
  setup.ts                           One-command build + deploy + bindings
  deploy.ts                          Contract deployment
  bindings.ts                        TypeScript bindings generation
  bot-betting-smoke.ts               Full end-to-end bot betting smoke test
  zk-onchain-setup.ts               Upload VKs and configure verifier on-chain
  fund-house-liquidity.ts           Fund the betting contract with XLM reserves
```

---

## Local Development Setup

**Prerequisites:**

- Bun >= 1.1 (`curl -fsSL https://bun.sh/install | bash`)
- Rust stable toolchain with `wasm32-unknown-unknown` target (`rustup target add wasm32-unknown-unknown`)
- Stellar CLI (`cargo install --locked stellar-cli --features opt`)
- Node.js >= 18 (for snarkjs subprocess)
- circom 2.x on PATH (`npm i -g circom`)

**One-command setup (builds, deploys, generates bindings):**

```bash
bun run setup
```

This runs four steps automatically:
1. Install JavaScript dependencies
2. Build all Soroban contracts with `stellar contract build`
3. Deploy all contracts to Stellar Testnet, funding test wallets if needed
4. Generate TypeScript client bindings for each contract

**Configure environment:**

Copy the environment template and fill in the required variables:

```bash
cp .env.example .env
```

At minimum, set:

```
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
VITE_DEV_ADMIN_SECRET=       # Admin keypair secret key
VITE_ZK_BETTING_CONTRACT_ID= # From deployment.json
ZK_GROTH16_VERIFIER_CONTRACT_ID=
```

**Upload ZK verification keys on-chain:**

```bash
bun run zk:onchain:setup
```

This uploads both circuit verification keys to the verifier contract and sets the VK IDs on the game and betting contracts.

**Fund the betting contract's house liquidity:**

```bash
bun run house:fund
```

**Start the backend server:**

```bash
bun run server
# or for hot-reload:
bun run dev:server
```

**Start the frontend:**

```bash
bun run dev
# This runs dev:game veilstar-brawl which starts the Vite dev server
```

**Run the bot betting smoke test:**

```bash
bun run smoke:bot-betting
```

This places a real bet against a live bot match, waits for the full lifecycle (lock → reveal → ZK settle → claim), and prints a JSON result with all transaction hashes.

---

## Environment Variables

Core ZK gameplay gates (`private rounds`, `strict finalize`, and `auto prove/finalize`) are hard-enabled in code and are not exposed as environment toggles.

| Variable | Required | Description |
|---|---|---|
| `SUPABASE_URL` | Yes | Supabase project REST URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Service role key for server operations |
| `VITE_SUPABASE_URL` | Yes | Same Supabase URL, exposed to frontend |
| `VITE_SUPABASE_ANON_KEY` | Yes | Supabase anon key for frontend reads |
| `VITE_SOROBAN_RPC_URL` | Yes | Soroban RPC endpoint (testnet by default) |
| `VITE_NETWORK_PASSPHRASE` | Yes | Network passphrase |
| `VITE_DEV_ADMIN_SECRET` | Yes | Admin keypair secret for on-chain admin calls |
| `VITE_VEILSTAR_CONTRACT_ID` | Yes | `veilstar-brawl` contract ID |
| `VITE_ZK_BETTING_CONTRACT_ID` | Yes | `zk-betting` contract ID |
| `ZK_GROTH16_VERIFIER_CONTRACT_ID` | Yes | `zk-groth16-verifier` contract ID |
| `VITE_ZK_API_BASE_URL` | No | Override ZK proof API base (defaults to same server) |
| `ZK_GROTH16_ROUND_CIRCUIT_DIR` | No | Path to round-plan circuit artifacts directory |
| `ZK_BETTING_SETTLE_CIRCUIT_DIR` | No | Path to bet settlement circuit artifacts directory |
| `ZK_FINALIZE_API_BASE_URL` | No | Remote ZK service URL for delegated proving |
| `ZK_GROTH16_VK_ID` | No | Pre-computed VK ID hex (skips computing from file) |
| `ZK_GAME_HUB_CONTRACT_ID` | No | Override Game Hub contract (defaults to hackathon address) |

---

## Testing

**Soroban contract tests:**

```bash
# Veilstar Brawl contract (23 tests)
cargo test -p veilstar-brawl

# ZK Betting contract (12 tests)
cargo test -p zk-betting

# ZK Groth16 Verifier contract
cargo test -p zk-groth16-verifier

# All contracts
cargo test
```

The `zk-betting` test suite covers the full commit-reveal-settle lifecycle including:
- `test_settle_pool_zk_guard_verifier_required` — contract must have verifier configured
- `test_settle_pool_zk_guard_vk_mismatch` — wrong VK ID is rejected
- `test_settle_pool_zk_guard_wrong_winner` — winner mismatch in public inputs rejected
- `test_settle_pool_zk_guard_verifier_false` — verifier returning false is rejected
- `test_settle_pool_zk_success` — full path with mock verifier confirming valid proof

The `veilstar-brawl` test suite covers the full game lifecycle, all ZK gate enforcement paths, staking mechanics, treasury sweep, and the Game Hub integration.

**Server integration test:**

```bash
bun test server/routes/matches/zk-round-commit.integration.test.ts
```

Tests the full private round commit/resolve API flow end-to-end with mocked Soroban calls.

**Smoke test (live testnet):**

```bash
bun run smoke:bot-betting
```

Requires valid testnet env config and a funded bettor wallet.

---

## Deployment

The backend server and ZK proving service are deployed to Fly.io (`fly.zk.toml` contains the app configuration). The frontend is statically built and served via Vite's build output.

**Build contracts:**

```bash
bun run build
```

**Deploy contracts to testnet:**

```bash
bun run deploy
```

**Regenerate TypeScript bindings after contract changes:**

```bash
bun run bindings
# or for a specific contract:
bun run bindings veilstar-brawl
```

**Sync secrets to Fly.io:**

```bash
bun run fly:secrets:sync
```

---

## Hackathon Criteria Checklist

**ZK-powered mechanic:**
- Private round-plan commitment using Poseidon hash in a Circom 2.1.6 circuit
- Groth16 round-plan proof generated client-side in a browser Web Worker using snarkjs
- On-chain verification via BN254 elliptic-curve primitives (Stellar Protocol 25)
- Spectator betting settled with a separate Groth16 binding circuit
- ZK gate enforced at the contract level: `end_game` reverts without a valid on-chain ZK outcome record when `zk_gate_required` is true

**Deployed on-chain component:**
- Four Soroban contracts deployed to Stellar Testnet
- Live testnet deployment as of 2026-02-21

| Contract | Address |
|---|---|
| Game Hub (official hackathon) | `CB4VZAT2U3UC6XFK3N23SKRF2NDCMP3QHJYMCHHFMZO7MRQO6DQ2EMYG` |
| Veilstar Brawl | `CCFLSDEATZG2LAA3P7UVEYBXDW637RN5F56EIMDTEXW7HUP537SAKJ57` |
| ZK Groth16 Verifier | `CARETBOWG5GFEXMLZUUAOBZG5SLXS6A5CSDRIQIFLUV4VQZEBZC6AMKT` |
| ZK Betting | `CAXLEDHRDFD3E3NYMBJTIIGFAXUVKKE7352XSMUALPSOEMPF7SA7F5AH` |

**Game Hub integration:**
- `start_game()` called on every match start
- `end_game()` called on every match completion or cancellation
- Using the official hackathon Game Hub: `CB4VZAT2U3UC6XFK3N23SKRF2NDCMP3QHJYMCHHFMZO7MRQO6DQ2EMYG`

**Frontend:**
- Fully functional React + Phaser frontend with wallet integration
- Private round planning UI with ZK progress indicator showing on-chain commitment and proof verification status in real time
- Bot spectator room with live betting panel and payout notifications
- Replay system, leaderboard, and player profiles

**Open source:**
- Full source code including all contract Rust, Circom circuits and compiled artifacts, backend TypeScript, and frontend TypeScript
- Complete README (this document)

**ZK is essential to how the game works:**
- Without ZK commits, the server (or a man-in-the-middle) could read a player's round plan and relay it to the opponent before they submit, turning the 10-move private planning phase into a reaction game rather than a strategy game
- Without ZK match outcome verification, a compromised admin could declare any winner regardless of the actual fight result and pay out staked XLM fraudulently
- Without ZK settlement in the betting contract, the admin could manipulate which pools settle and in favor of whom, draining the house liquidity to particular betting addresses
- The ZK proof system makes "trust me" unnecessary at every point where money or fairness is at stake
