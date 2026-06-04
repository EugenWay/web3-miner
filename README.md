# Robo Miner

A side-scrolling mining roguelike for Vara. Dig deeper, collect ore, dodge
lava and rocks, and submit your best run on-chain.

## Layout

- `contract/` — Sails program (`RoboMinerProfile`) that stores per-player
  high-score and run count, and emits a `NewHighScore` event.
- `frontend/` — Phaser 3 + Vite browser game. Connects to the player's
  Substrate wallet, fetches a gas voucher from the Vara Arcade voucher
  backend, and signs `submit_run` from the wallet on game over.

## Mainnet Deployment

| Field          | Value |
| -------------- | --- |
| Network        | `vara-mainnet` |
| RPC            | `wss://rpc.vara.network` |
| Program ID     | `0x59b572ac6135fef6fa5d1bdb2b365f1ad7b721bc7a620122065968a78c4fa1f1` |
| Voucher backend| `https://arcade-vara-production.up.railway.app` |

## Quick Start

### Contract

```bash
cd contract
cargo build --release
```

The IDL is regenerated automatically by `build.rs`.

### Frontend

```bash
cd frontend
cp .env.example .env
npm install
npm run dev
```

Then open the dev server URL printed by Vite.

## On-Chain Flow

1. Player connects a Substrate wallet (Polkadot.js, Talisman, SubWallet,
   Enkrypt). Addresses are normalised to Vara prefix 137.
2. The frontend asks the Vara Arcade voucher backend for a gas voucher
   for `(player, programId)`. One funded voucher per UTC day per player.
3. On game over, the player signs `submit_run(score)` from their wallet.
   Gas is paid by the voucher; the player pays no VARA value.
4. The contract updates `high_score` if it improved and bumps
   `runs_completed`.
