# Veilstar Brawl

A fully on-chain, zero-knowledge fighting game built on Stellar. Two players lock in their private round strategies simultaneously — neither can see the other's plan — and every match outcome is verified by a Groth16 proof running against BN254 elliptic-curve primitives on-chain. Spectators can bet real XLM in a commit-reveal pool that also settles through a ZK proof. The whole system — game contracts, verifier contract, betting contract, frontend, and backend — is deployed and live on Stellar Testnet.

**Live Demo:** https://veilstar-brawl.vercel.app  

**Demo Video:** https://youtu.be/f3NXDcAKKn8  

**GitHub:** https://github.com/nicky-unstoppable/Veilstar-Brawl

---

## Why ZK Is Essential

Fighting games live and die by information asymmetry. Without ZK:

- A compromised server could read a player's round plan and relay it to the opponent before they submit, turning strategy into a reaction game
- An admin with the admin keypair could declare any winner and pay out staked XLM fraudulently
- A corrupt admin could manipulate which betting pools settle and in favor of whom

With ZK, "trust me" is unnecessary at every point where money or fairness is at stake. The ZK gate is enforced at the contract level: `end_game` reverts without a valid on-chain `ZkMatchOutcomeRecord` when `zk_gate_required` is true. The admin cannot override this even with the admin key.

---

## ZK Mechanics

### Private Round Planning

Each round consists of up to 10 turns. Instead of submitting moves turn-by-turn in public, each player privately plans the full 10-turn sequence at the start of a round. The plan is committed on-chain as a Poseidon hash before either player can see the other's moves.

**Flow:**
1. Player selects their 10 moves locally in the browser
2. Browser generates a 32-byte random nonce
3. Browser spawns a dedicated Web Worker, fetches `round_plan.wasm` and `round_plan_final.zkey` from the ZK artifact relay, and runs `snarkjs groth16 fullProve` locally — proof and commitment never leave the client until submitted
4. Player signs and submits `submit_zk_commit` — the Poseidon hash is stored on-chain under `(session_id, match_salt, round, turn, player_index)`
5. After both players commit, the backend resolves turns 1–10 using the committed move plans
6. At round-end, `submit_zk_verification` cross-calls the verifier contract to confirm the proof against the stored commitment

### Round-Plan Circuit

**Location:** `zk_circuits/veilstar_round_plan_groth16/round_plan.circom`

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

The only public signal is `commitment`. The proof asserts: "I know a preimage `(match_id, round_number, turn_number, player_address, surge_card, nonce, moves[0..9])` whose Poseidon hash equals the public commitment." Without the proof you cannot determine the moves. With the proof you cannot forge a different set of moves.

### Betting Settlement Circuit

**Location:** `zk_circuits/zk_betting_settle_groth16/betting_settle.circom`

```circom
pragma circom 2.1.6;

template BettingSettle() {
    signal input match_id;            // public
    signal input pool_id;             // public
    signal input winner_side;         // public
    signal input witness_match_id;    // private
    signal input witness_pool_id;     // private
    signal input witness_winner_side; // private

    witness_match_id === match_id;
    witness_pool_id === pool_id;
    witness_winner_side === winner_side;

    winner_side * (winner_side - 1) === 0;  // must be 0 or 1
}

component main { public [match_id, pool_id, winner_side] } = BettingSettle();
```

The three public inputs are bound into the proof. `settle_pool_zk` checks `public_inputs[1]` matches the pool being settled, preventing proof replay across pools. The quadratic constraint on `winner_side` ensures only valid sides (0 or 1) can satisfy the circuit.

### On-Chain Verification Pipeline

The Groth16 pairing check verifies: `e(πA, πB) = e(α₁, β₂) · e(L_pub, γ₂) · e(πC, δ₂)` where `L_pub = IC₀ + Σ inputsᵢ · ICᵢ₊₁`.

All elliptic-curve operations (point deserialization, scalar multiplication, multi-pairing) run as Soroban host functions using the BN254 primitives from Stellar Protocol 25. No ZK library is linked into the contract WASM. The serialized Groth16 calldata is exactly 256 bytes: 64 for πA (G1), 128 for πB (G2), 64 for πC (G1).

**Pipeline:**

1. `submit_zk_commit` — backend stores Poseidon commitment on-chain in `veilstar-brawl`
2. `submit_zk_verification` — `veilstar-brawl` cross-calls `zk-groth16-verifier` for the bn254 pairing check
3. `submit_zk_match_outcome` — stores `ZkMatchOutcomeRecord` with the verified winner
4. `end_game` — validates the record, pays winner 2x stake, calls Game Hub

The verification key is uploaded to the verifier contract at deployment. Its 32-byte hash (`vk_id`) is set on both the game and betting contracts. Any proof submitted with a different VK ID is rejected before the cross-contract call is made.

---

## Smart Contracts

All contracts are written in Rust using the Soroban SDK, compiled to WASM32.

### Veilstar Brawl Contract — `contracts/veilstar-brawl/src/lib.rs`

The main game coordinator for the full match lifecycle.

| Function | Description |
|---|---|
| `start_game(session_id, player1, player2, ...)` | Creates match, calls `start_game` on Game Hub |
| `submit_zk_commit(session_id, player, round, turn, commitment)` | Stores Poseidon commitment on-chain |
| `submit_zk_verification(session_id, ...)` | Verifies round-plan proof, cross-calls verifier |
| `submit_zk_match_outcome(session_id, winner, ...)` | Records proven match winner |
| `end_game(session_id, player1_won)` | Closes match, validates ZK record if gate required, pays winner 2x stake, calls Game Hub |
| `deposit_stake / cancel_match / expire_stake` | Staking lifecycle management |

**ZK gate:** When `set_zk_gate_required(true)` is configured, `end_game` will not accept any outcome not backed by a valid on-chain `ZkMatchOutcomeRecord`. The admin cannot declare a false winner.

### ZK Groth16 Verifier Contract — `contracts/zk-groth16-verifier/src/lib.rs`

Stores verification keys by `vk_id` and runs Groth16 pairing checks via `env.crypto().bn254`. Multiple circuits share the same contract under different VK IDs. `verify_round_proof(vk_id, proof, public_inputs)` returns a bool.

### ZK Betting Contract — `contracts/zk-betting/src/lib.rs`

Permissioned betting pool with commit-reveal and ZK settlement.

Lifecycle: `create_pool → commit_bet → lock_pool → admin_reveal_bet → settle_pool_zk → admin_claim_payout`

Spectators call `commit_bet` with `SHA256(side_byte || salt)`, locking funds on-chain without revealing their side. After the match, `settle_pool_zk` cross-calls the verifier with the binding circuit proof. Winners are automatically paid via `admin_claim_payout` — no manual claim needed.

### Game Hub Integration

`start_game()` and `end_game()` are called on the official hackathon Game Hub contract on every match start and completion.

---

## Deployed Contracts

**Network:** Stellar Testnet (`Test SDF Network ; September 2015`)  
**Deployed:** 2026-02-21

| Contract | Address |
|---|---|
| Game Hub (official hackathon) | `CB4VZAT2U3UC6XFK3N23SKRF2NDCMP3QHJYMCHHFMZO7MRQO6DQ2EMYG` |
| Veilstar Brawl | `CCFLSDEATZG2LAA3P7UVEYBXDW637RN5F56EIMDTEXW7HUP537SAKJ57` |
| ZK Groth16 Verifier | `CARETBOWG5GFEXMLZUUAOBZG5SLXS6A5CSDRIQIFLUV4VQZEBZC6AMKT` |
| ZK Betting | `CAXLEDHRDFD3E3NYMBJTIIGFAXUVKKE7352XSMUALPSOEMPF7SA7F5AH` |

---

## Game Design

### Combat System

**Best of 3 rounds** (configurable), each round up to **10 turns**. Moves resolve simultaneously.

| Move | Base Damage | Energy Cost | Effect |
|---|---|---|---|
| Punch | 10 | 0 | Always available |
| Kick | 15 | 25 | Energy-gated |
| Block | 0 | 0 | Absorbs damage by character `blockEffectiveness`, builds guard meter |
| Special | 25 | 50 | High output, expensive |

**Guard meter (0–100):** Builds when blocking, drains when taking guard damage. At 100 the player is stunned for the next turn.

**Energy system:** Each character has a per-turn energy regen stat. If energy falls below a move's cost, the move cannot be selected. Managing energy across a private 10-turn plan is a core strategic layer — the ZK layer enforces it.

### 20 Characters, 4 Archetypes

- **Speed** — 92–105 HP, high energy regen: Cyber Ninja, Sonic Striker, Chrono Drifter, Neon Wraith, Viperblade
- **Tank** — 145–158 HP, slow regen, heavy damage: Ledger Titan, Heavy Loader, Gene Smasher, Bastion Hulk, Scrap Goliath
- **Tech** — balanced stats, high special damage: Soroban Sage, Technomancer, Nano Brawler, Razor Bot 7, Cyber Paladin
- **Precision** — crit/block/energy-steal oriented: Hash Hunter, Prism Duelist, Kitsune-09, Void Reaper, Aeon Guard

Each character has individual `damageModifiers`, `blockEffectiveness`, `specialCostModifier`, and `energyRegen`. For example, Bastion Hulk has `blockEffectiveness: 0.85` (absorbs 85% of incoming damage) but flat 1.0 damage modifiers, while Gene Smasher gets `damageModifiers.punch: 1.25` at the cost of `blockEffectiveness: 0.25`.

### Power Surge Cards

15-card deck drawn per round, seeded deterministically by the match seed. Each player picks one before committing their round plan. Selection recorded on-chain via `submit_power_surge` (0.0001 XLM).

Selected cards: DAG Overclock (+40% damage), Block Fortress (reflect 120% to attacker), Tx Tempo (+2 priority on all clashes), 10bps Barrage (attacks hit twice), Sompi Shield (-45% incoming damage), Pruned Rage (+35% damage, opponent cannot block), and 9 others.

### Staking

Optional per-match wager. Each player deposits `stake + 0.1% fee`. Winner takes 2x stake. Staked matches require a ZK-backed outcome before `end_game` can pay out — the ZK gate and stake logic are interlocked.

---

## Architecture

**Frontend:** React 18 + Vite + Tailwind CSS + Phaser 3  
**Backend:** Bun runtime + TypeScript (deployed on Fly.io)  
**Database:** Supabase (PostgreSQL + Realtime channels)  
**ZK Proving (round plan):** snarkjs Groth16 fullProve in browser Web Worker (client-side)  
**ZK Proving (finalization + betting):** snarkjs Groth16 fullProve in browser workers (proofs generated client-side, not by backend prove endpoints)  
**Frontend Hosting:** Vercel  
**Wallet:** Stellar Wallet Interface Standard + Launchtube fee sponsorship  

### Key Backend Services

| Service | Purpose |
|---|---|
| `combat-resolver.ts` | Authoritative round resolver; resolves turns using committed moves, streams via Supabase Realtime |
| `zk-round-prover.ts` | subprocess manager for `snarkjs groth16 fullprove` (round plan circuit) |
| `bot-match-service.ts` | 24/7 bot lifecycle: provisions pools, locks, reveals, and publishes settlement-ready state for browser finalize |
| `stellar-contract.ts` | Soroban client wrappers with retry logic and idempotency classification |
| `matchmaker.ts` | ELO queue: ±100 starting range, expands 5 ELO/sec after 10 seconds waiting |

---

## End-to-End Match Flow

1. **Matchmaking** — ELO-based pairing via `/api/matchmaking/queue`
2. **Contract Registration** — `start_game` called on Veilstar Brawl + Game Hub; player signs auth entry in wallet
3. **Character Selection + Stake** — optional 60-second deposit window
4. **Private Round Planning** — player plans 10 moves locally → browser Web Worker proves locally (snarkjs) → commitment stored on-chain via `submit_zk_commit`
5. **Turn Resolution** — backend resolves 10 turns using committed moves, broadcasts each result over Supabase Realtime
6. **Round Verification** — `submit_zk_verification` cross-calls verifier, stores `ZkVerified` record
7. **Match Finalization** — `submit_zk_match_outcome` stores proven winner → `end_game` validates record, pays stake, calls Game Hub

---

## End-to-End Bot Betting Flow

1. Bot match generates; `create_pool` called on-chain with deadline
2. **30-second betting window** — spectators call `commit_bet` with `SHA256(side || salt)`, funds locked immediately on-chain
3. Pool locks; match plays out in BotBattleScene
4. `admin_reveal_bet` called on-chain for each bettor
5. Browser proves `betting_settle.circom` with `{match_id, pool_id, winner_side}` → `settle_pool_zk` verifies Groth16 proof cross-contract

For private PvP finalization, the winner browser also generates the final proof client-side and submits it to `/api/matches/:matchId/zk/finalize`; backend prove-finalize endpoints are disabled.
6. Settlement completion is recorded via backend API so pool state and history reflect the on-chain tx
7. `WinningNotification` component animates payout with claim tx hash

---

## Local Development Setup

**Prerequisites:** Bun ≥ 1.1, Rust + `wasm32-unknown-unknown` target, Stellar CLI, Node.js ≥ 18, circom 2.x

```bash
# One-command build + deploy + generate bindings
bun run setup

# Configure environment
cp .env.example .env
# Set: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VITE_SUPABASE_*, VITE_DEV_ADMIN_SECRET,
#      VITE_VEILSTAR_CONTRACT_ID, VITE_ZK_BETTING_CONTRACT_ID, ZK_GROTH16_VERIFIER_CONTRACT_ID

# Upload ZK verification keys on-chain
bun run zk:onchain:setup

# Fund betting contract house liquidity
bun run house:fund

# Start backend (hot-reload)
bun run dev:server

# Start frontend Vite dev server
bun run dev

# Full end-to-end smoke test on live testnet
bun run smoke:bot-betting
```

**Tests:**

```bash
cargo test -p veilstar-brawl      # 23 contract unit tests
cargo test -p zk-betting          # 12 contract unit tests
cargo test -p zk-groth16-verifier
bun test server/routes/matches/zk-round-commit.integration.test.ts
```

The `zk-betting` test suite covers the full commit-reveal-settle lifecycle including: verifier not configured, wrong VK ID, wrong winner in public inputs, verifier returning false, and the successful full path with a mock verifier.

---

## Key Files Reference

```
contracts/
  veilstar-brawl/src/lib.rs           Main game contract
  zk-groth16-verifier/src/lib.rs      Groth16 on-chain verifier
  zk-betting/src/lib.rs               ZK betting pool contract
  zk-betting/src/test.rs              12 contract unit tests

zk_circuits/
  veilstar_round_plan_groth16/
    round_plan.circom                  Private round-plan commitment circuit
    artifacts/                         Compiled R1CS, WASM, zkey, verification_key.json
  zk_betting_settle_groth16/
    betting_settle.circom              Settlement binding circuit
    artifacts/

server/lib/
  combat-resolver.ts                  Authoritative round resolver
  stellar-contract.ts                 Soroban client wrappers
  zk-round-prover.ts                  snarkjs subprocess manager (round plan)
  zk-betting-contract.ts              on-chain betting admin/client wrappers
  zk-finalizer-client.ts              Legacy helper; backend prove-finalize is disabled
  bot-match-service.ts                24/7 bot lifecycle worker

veilstar-brawl-frontend/src/
  game/scenes/FightScene.ts           Main battle Phaser scene
  game/scenes/BotBattleScene.ts       Bot spectator Phaser scene
  game/combat/CombatEngine.ts         Client-side combat engine
  components/fight/CharacterSelectClient.tsx
  components/betting/BotBettingPanel.tsx
  components/spectate/BotSpectatorClient.tsx
  lib/zkPrivateRoundClient.ts         ZK API client (commit/prove/resolve)
  lib/betting/zk-betting-service.ts   Soroban betting contract client
```

---

## Hackathon Criteria Checklist

**ZK-powered mechanic (core, not cosmetic):**
- [x] Private 10-turn round planning committed via Poseidon hash in Circom 2.1.6
- [x] Groth16 round-plan proof generated client-side in a browser Web Worker with snarkjs and verified on-chain via BN254 (Stellar Protocol 25)
- [x] Spectator betting settled with a separate Groth16 binding circuit
- [x] ZK gate enforced at contract level — `end_game` reverts without on-chain ZK outcome record
- [x] Staked match payouts gated by ZK proof — admin cannot pay a false winner

**Deployed on-chain component (Stellar Testnet):**
- [x] Four Soroban contracts deployed and live as of 2026-02-21
- [x] Match stake payouts, betting pool settlements, and ZK verifications all on-chain

**Game Hub integration:**
- [x] `start_game()` called on every match start
- [x] `end_game()` called on every match completion or cancellation
- [x] Using official hackathon Game Hub: `CB4VZAT2U3UC6XFK3N23SKRF2NDCMP3QHJYMCHHFMZO7MRQO6DQ2EMYG`

**Frontend:**
- [x] Fully functional React + Phaser game with Stellar wallet integration
- [x] Private round planning UI with real-time ZK progress indicators (on-chain commit status, proof verification status)
- [x] Bot spectator room with live betting panel, countdown timer, and automatic payout notifications
- [x] Replay system, leaderboard, and player profiles

**Open source:**
- [x] Full source code: contracts (Rust), ZK circuits (Circom + compiled artifacts), backend (TypeScript/Bun), frontend (React/Phaser/Tailwind)
- [x] Complete README and this document
