# Lagos Foosball

A 3D, real-time **multiplayer foosball** game built with [Three.js](https://threejs.org/),
designed to run **inside the Lagos Life / Vatar Games platform** and plug into its
identity, leaderboard, purchase and match APIs.

> **Status:** playable. The deterministic physics, Three.js table, input,
> matchmaking and the authoritative 60 Hz room loop all work end to end — two
> browsers pair up and play a real match. Vatar identity is faked locally until
> sandbox keys exist. See [docs/ROADMAP.md](docs/ROADMAP.md).

## Design in one line

A **server-authoritative** simulation (Node + `ws`) drives two players who own
opposite sides of a stylised low-poly table; the browser only sends inputs and
renders predicted state; **Vatar's REST API is called server-side only** so no
secret ever reaches the client.

## Quickstart

```bash
npm install          # install deps (root, web and server share one package)
cp .env.example .env # then fill in your Vatar sandbox keys
npm run dev          # web on :5173, game server on :8080
```

Other scripts:

| Script              | What it does                                  |
| ------------------- | --------------------------------------------- |
| `npm run dev:web`   | Vite dev server for the browser client only   |
| `npm run dev:server`| `tsx watch` the authoritative game server     |
| `npm run build`     | Production bundle into `dist/`                |
| `npm test`          | Determinism + physics tests for `shared/sim`  |
| `npm run typecheck` | Type-check client, server and shared code     |

## Repository layout

```
shared/     types, constants and the WebSocket protocol (used by both sides)
server/     authoritative simulation, matchmaking and the Vatar REST client
  vatar/    server-side API client — the only place secrets are used
web/        Three.js client (Vite root)
  scene/    table, rods, men, ball  (rendering)
  net/      WebSocket client
  vatar/    browser SDK wrapper (identity, leaderboard, purchases)
docs/       architecture, API notes and roadmap
```

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the three pieces fit together
- [docs/VATAR-API.md](docs/VATAR-API.md) — what the Lagos Life / Vatar API gives you
- [docs/ROADMAP.md](docs/ROADMAP.md) — milestones from skeleton to shipped game
