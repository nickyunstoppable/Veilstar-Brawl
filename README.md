## ZK Finalization (Option B UX)

To finalize matches with a single end-of-match proof submission:

 - Endpoint: `POST /api/matches/:matchId/zk/finalize`
 - Required body fields: `winnerAddress`, `proof`
 - Optional: `publicInputs`, `transcriptHash`

Server-side Noir verification bridge is controlled by env vars:

 - `ZK_VERIFY_ENABLED` (default: `true`)
 - `ZK_VK_PATH` (required when verification enabled)
 - `ZK_VERIFY_CMD` (optional command template)
 - `ZK_AUTO_PROVE_FINALIZE` (default: `true`, only active when proving is configured)
 - `ZK_PROVE_ENABLED` (default: `true`)
 - `ZK_PROVE_CMD` (required for auto-prove finalize)
 - `ZK_PRIVATE_ROUNDS` (default: `false`, enables hidden per-round commit + proof flow)

Default verifier command template:

```bash
bb verify -k {VK_PATH} -p {PROOF_PATH} -i {PUBLIC_INPUTS_PATH}
```

Supported placeholders in `ZK_VERIFY_CMD`:

 - `{VK_PATH}`
 - `{PROOF_PATH}`
 - `{PUBLIC_INPUTS_PATH}`
 - `{MATCH_ID}`
 - `{WINNER_ADDRESS}`
 - `{TRANSCRIPT_HASH}`

To avoid per-action wallet popups during gameplay, keep:

 - Server: `ZK_OFFCHAIN_ACTIONS=true` (default)
 - Frontend: `VITE_ZK_OFFCHAIN_ACTIONS=true` (default)

Private round strategy flow (full-privacy target backend scaffold):

 - `POST /api/matches/:matchId/zk/round/commit`
 - `POST /api/matches/:matchId/zk/round/resolve`

When `ZK_PRIVATE_ROUNDS=true`, legacy move/surge routes are intentionally blocked to prevent mixed game modes.

### Fly.io deployment (recommended for Windows developers)

You can run the Bun server + ZK verification on Fly Linux VMs to avoid local Windows toolchain issues.

1. Deploy from `server/`:

```bash
cd server
fly launch --config fly.toml --no-deploy
fly deploy
```

2. Set required secrets/env on Fly:

```bash
fly secrets set SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...
fly secrets set CORS_ORIGIN=https://<your-frontend-domain>
fly secrets set ZK_VERIFY_ENABLED=true ZK_PRIVATE_ROUNDS=true
```

3. Provide verification key in one of two ways:

- Preferred: base64-encoded key via secret (auto-materialized to `ZK_VK_PATH` at startup)

```bash
fly secrets set ZK_VK_BASE64=<base64-of-verification-key-file>
```

- Or explicit path if you bake/mount the key in container:

```bash
fly secrets set ZK_VK_PATH=/app/keys/verification.key
```

4. Set verifier command (if different from default):

```bash
fly secrets set ZK_VERIFY_CMD='bb verify -k {VK_PATH} -p {PROOF_PATH} -i {PUBLIC_INPUTS_PATH}'
```

If you are bringing up infrastructure first and want gameplay unblocked temporarily, set:

```bash
fly secrets set ZK_VERIFY_ENABLED=false
```

then re-enable after `bb` + verification key are configured.

### Split deployment: Vercel frontend + Heroku backend + Fly ZK

Use two frontend env vars:

- `VITE_API_BASE_URL=https://<your-heroku-backend>.herokuapp.com`
- `VITE_ZK_API_BASE_URL=https://<your-fly-zk-app>.fly.dev`

`VITE_ZK_API_BASE_URL` is used only for:

- `POST /api/matches/:matchId/zk/round/commit`
- `POST /api/matches/:matchId/zk/round/resolve`

All other gameplay/matchmaking routes continue to use `VITE_API_BASE_URL`.

For a fully separate ZK service, use the dedicated folder:

- ZK service entrypoint: `zk_service/index.ts`
- Fly config: `zk_service/fly.toml`
- Dockerfile: `zk_service/Dockerfile`

Noir circuit workspace for round-plan proofs:

- `zk_circuits/veilstar_round_plan/`

Run locally:

```bash
bun run dev:zk
```

Deploy only ZK service to Fly:

```bash
cd <repo-root>
fly launch --config fly.zk.toml --no-deploy
fly deploy --config fly.zk.toml
```

Important: run these from repo root so Docker build context includes `package.json`, `bun.lock`, and `server/`.
# Stellar Game Studio

Development Tools For Web3 Game Builders On Stellar.

Ecosystem ready game templates and examples ready to scaffold into into your development workflow

**Start here:** [Stellar Game Studio](https://jamesbachini.github.io/Stellar-Game-Studio/)


## Why this exists

Stellar Game Studio is a toolkit for shipping web3 games quickly and efficiently. It pairs Stellar smart contract patterns with a ready-made frontend stack and deployment scripts, so you can focus on game design and gameplay mechanics.

## What you get

- Battle-tested Soroban patterns for two-player games
- A ecosystem ready mock game hub contract that standardizes lifecycle and scoring
- Deterministic randomness guidance and reference implementations
- One-command scaffolding for contracts + standalone frontend
- Testnet setup that generates wallets, deploys contracts, and wires bindings
- A production build flow that outputs a deployable frontend

## Quick Start (Dev)

```bash
# Fork the repo, then:
git clone https://github.com/jamesbachini/Stellar-Game-Studio
cd Stellar-Game-Studio
bun install

# Build + deploy contracts to testnet, generate bindings, write .env
bun run setup

# Scaffold a game + dev frontend
bun run create my-game

# Run the standalone dev frontend with testnet wallet switching
bun run dev:game my-game
```

## Publish (Production)

```bash
# Export a production container and build it (uses CreitTech wallet kit v2)
bun run publish my-game --build

# Update runtime config in the output
# dist/my-game-frontend/public/game-studio-config.js
```

## Project Structure

```
├── contracts/               # Soroban contracts for games + mock Game Hub
├── template_frontend/       # Standalone number-guess example frontend used by create
├── <game>-frontend/         # Standalone game frontend (generated by create)
├── sgs_frontend/            # Documentation site (builds to docs/)
├── scripts/                 # Build & deployment automation
└── bindings/                # Generated TypeScript bindings
```

## Commands

```bash
bun run setup                         # Build + deploy testnet contracts, generate bindings
bun run build [game-name]             # Build all or selected contracts
bun run deploy [game-name]            # Deploy all or selected contracts to testnet
bun run bindings [game-name]          # Generate bindings for all or selected contracts
bun run create my-game                # Scaffold contract + standalone frontend
bun run dev:game my-game              # Run a standalone frontend with dev wallet switching
bun run publish my-game --build       # Export + build production frontend
```

## Ecosystem Constraints

- Every game must call `start_game` and `end_game` on the Game Hub contract:
  Testnet: CB4VZAT2U3UC6XFK3N23SKRF2NDCMP3QHJYMCHHFMZO7MRQO6DQ2EMYG
- Game Hub enforces exactly two players per session.
- Keep randomness deterministic between simulation and submission.
- Prefer temporary storage with a 30-day TTL for game state.

## Notes

- Dev wallets are generated during `bun run setup` and stored in the root `.env`.
- Production builds read runtime config from `public/game-studio-config.js`.

Interface for game hub:
```
#[contractclient(name = "GameHubClient")]
pub trait GameHub {
    fn start_game(
        env: Env,
        game_id: Address,
        session_id: u32,
        player1: Address,
        player2: Address,
        player1_points: i128,
        player2_points: i128,
    );

    fn end_game(
      env: Env,
      session_id: u32,
      player1_won: bool
    );
}
```

## Studio Reference

Run the studio frontend locally (from `sgs_frontend/`):
```bash
bun run dev
```

Build docs into `docs/`:
```bash
bun --cwd=sgs_frontend run build:docs
```

## Links
https://developers.stellar.org/
https://risczero.com/
https://jamesbachini.com
https://www.youtube.com/c/JamesBachini
https://bachini.substack.com
https://x.com/james_bachini
https://www.linkedin.com/in/james-bachini/
https://github.com/jamesbachini

## 📄 License

MIT License - see LICENSE file


**Built with ❤️ for Stellar developers**
