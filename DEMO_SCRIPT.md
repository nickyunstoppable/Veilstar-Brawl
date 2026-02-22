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

> *Show the Power Surge card selection, then the move planning UI. Submit the plan and watch the ZK pipeline indicator at the top of the screen step through COMMIT → VERIFY → LOCK.*

**SPOKEN:**
"Here's where the ZK magic happens. Before the round starts I pick a Power Surge card — 'DAG Overclock' gives me plus 40% damage this round. That selection goes on-chain immediately.

Then I plan my full 10-move sequence privately — punch, kick, block, special, whatever I think will out-read my opponent.

When I submit, watch the pipeline up here at the top — COMMIT, VERIFY, LOCK. The client is running a Groth16 proof using a Circom circuit. It hashes all 10 moves plus a random nonce with the Poseidon hash function and submits only that 32-byte commitment to the Soroban contract.

My opponent cannot see my moves. The server cannot see my moves. If I open Stellar Explorer right now — there's the commitment transaction, on-chain, sealed before resolution ever starts.

When the round finishes, the contract verifies the proof against BN254 elliptic-curve primitives — the cryptographic opcodes Stellar Protocol 25 added natively. The indicator hits LOCK. `end_game` reverts without it."

---

## [1:35 – 2:00] LIVE DEMO — MATCH SUMMARY, REPLAY & EXPORT

> *Match ends. Navigate to the match summary page. Scroll through it: ZK-verified badge, stats grid, blockchain transaction timeline, ZK proof artifacts panel. Then click Watch Full Replay. Then click Export MP4.*

**SPOKEN:**
"Match is over. The summary page shows the result with a ZK-verified badge, total hits, and how many private round commits were verified on-chain.

Below that is the full blockchain transaction timeline — every on-chain move with a direct link to Stellar Explorer.

And here's the ZK proof artifacts panel — the commitment hashes, how many were verified, and the on-chain transaction IDs. Everything judges need to audit the outcome independently.

I can watch the full replay — the entire fight plays back from the stored round data. And I can export it as an MP4 directly from the browser. Takes about 30 seconds."

---

## [2:00 – 2:30] LIVE DEMO — ZK SPECTATOR BETTING

> *Navigate to the Bot Battle spectator room.*

**SPOKEN:**
"This is the bot battle room — a 24/7 live match running on-chain that anyone can watch and bet on.

I place a bet by committing a hash of my chosen side and a random salt. No one can see which side I picked. Once betting closes, bets are revealed, and a second Groth16 proof binds the match ID, pool ID, and winner together before the pool settles.

Watch — the payout lands directly in the bettor's Stellar wallet. Automatically. No claim button. The betting contract called the same ZK verifier contract and confirmed everything cryptographically."

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
- **ZK pipeline indicator** — it appears centered at the top of the fight UI with three steps: COMMIT, VERIFY, LOCK. Zoom or add a callout so it's clearly visible as it steps through.
- **Stellar Explorer tab** — have it preloaded and alt-tab to it immediately after the commitment TX lands. Seeing the on-chain hash live is the single most important moment in the video.
- **Match summary page** — scroll slowly through the blockchain transaction timeline and ZK proof artifacts panel; these are judge-facing evidence, not background flavor.
- **Export MP4** — click the button and let the progress bar fill. You don't need to wait for the full download; cutting away at ~50% progress is fine.
- **Betting payout notification** — let it animate on screen naturally. Don't cut away early.
- Keep commentary conversational, not rehearsed. The live demo should feel like you're genuinely showing the product.
