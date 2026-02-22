# Veilstar Brawl — Demo Video Script
**Target runtime: ~2:45 – 3:00**
**Format: Short pitch to camera → live demo with commentary**

---

## [0:00 – 0:25] PITCH — TALKING HEAD / TITLE CARD

> *Screen: game title card or face-to-camera. Keep it tight.*

**SPOKEN:**
"Every online fighting game trusts the server. The server knows your moves, resolves the match, and pays out bets. That's a single point of failure — and a single point of fraud.

Veilstar Brawl removes that trust entirely. It's a fully on-chain fighting game where your move plan is hidden inside a zero-knowledge proof before your opponent ever sees it, and every outcome is cryptographically verified on-chain before the match can close.

Let me show you how it works."

---

## [0:25 – 0:55] LIVE DEMO — MATCHMAKING & CHARACTER SELECT

> *Switch to screen recording. Open the app.*

**SPOKEN:**
"I'm on the live deployment on Stellar Testnet right now. I'll connect my wallet — this is using the Wallet Interface Standard so any Stellar-compatible wallet works — and queue up for a match.

The matchmaker pairs players by ELO rating. Once matched, I pick my character. There are 20 characters across four archetypes: Speed, Tank, Tech, and Precision. I'll go with Soroban Sage — balanced stats, strong specials.

If staking is enabled, both players deposit XLM here. The winner takes 2x. The deposit is on-chain before a single move is played."

---

## [0:55 – 1:35] LIVE DEMO — PRIVATE ROUND PLANNING & ZK COMMIT

> *Show the move planning UI. Click through selecting 10 moves. Watch the ZK indicator.*

**SPOKEN:**
"Here's where the ZK magic happens. Before the round starts I plan my full 10-move sequence privately — punch, kick, block, special, whatever I think will out-read my opponent.

I also pick a Power Surge card — 'DAG Overclock' gives me plus 40% damage this round. That selection goes on-chain immediately.

Now I submit my move plan. Watch this panel in the corner — the client is running a Groth16 proof locally using a Circom circuit. It hashes all 10 moves plus a random nonce with the Poseidon hash function, and submits only that 32-byte commitment to the Soroban contract. 

My opponent cannot see my moves. The server cannot see my moves. If I open Stellar Explorer right now — there's the commitment transaction, on-chain, sealed before resolution.

When the round resolves, the proof is verified on-chain against BN254 elliptic-curve primitives — the cryptographic opcodes Stellar Protocol 25 added natively. The contract will not accept a false winner. `end_game` reverts without a valid ZK proof."

---

## [1:35 – 2:00] LIVE DEMO — MATCH REPLAY & EXPORT

> *Match ends. Navigate to the replay screen.*

**SPOKEN:**
"Match is over. Every completed match is fully replayable. I can scrub through the fight turn by turn — health bars, energy, the Power Surge card effects, everything reconstructed deterministically from the stored move data.

And I can export the full match record — that's a JSON file with every move, every commitment hash, every proof, and the on-chain transaction IDs. Anyone can verify independently that the outcome matches the proofs. The replay isn't just a highlight reel — it's a cryptographic audit trail."

---

## [2:00 – 2:30] LIVE DEMO — ZK SPECTATOR BETTING

> *Navigate to the Bot Battle spectator room.*

**SPOKEN:**
"This is the bot battle room — a 24/7 live match running on-chain that anyone can watch and bet on.

I place a bet by committing a hash of my chosen side and a random salt. No one can see which side I picked. Once betting closes, bets are revealed, and a second Groth16 proof binds the match ID, pool ID, and winner together before the pool settles.

Watch — the payout lands directly in the bettor's Stellar wallet. Automatically. No claim button. The betting contract called the same ZK verifier contract and it confirmed everything cryptographically."

---

## [2:30 – 2:55] CONTRACTS & CLOSE

> *Quick cut to Stellar Explorer showing the three contract addresses, then back to title card.*

**SPOKEN:**
"Three contracts, all live on Stellar Testnet. The Veilstar Brawl game contract, a standalone ZK Groth16 Verifier that any contract can call, and the ZK Betting contract. Both ZK circuits — round planning and betting settlement — are open-source Circom.

This is what ZK as a gameplay primitive actually looks like. Not a buzzword in a README. Cryptographic guarantees that make cheating structurally impossible.

Veilstar Brawl. Built on Stellar."

---

## DIRECTOR NOTES

- **Pitch segment** should feel direct and energetic — 25 seconds, no padding.
- **Stellar Explorer tab** — have it ready to alt-tab to immediately after the commitment TX. The on-chain hash appearing live is the single most important visual in the video.
- **ZK indicator panel** — zoom in or add a callout overlay so judges can clearly see proof generation happening in real time.
- **Replay scrubbing** — show the turn-by-turn scrubber moving; pause on a specific turn to show the move data.
- **Export** — actually click Export and show the JSON file opening. 2 seconds is enough.
- **Betting payout notification** — let it animate on screen naturally. Don't cut away early.
- Keep commentary conversational, not rehearsed. The live demo should feel like you're genuinely showing the product.
