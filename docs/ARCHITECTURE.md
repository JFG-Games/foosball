# Architecture

## Components

```
        ┌─────────────────────────── Lagos Life shell (iframe) ───────────────────────────┐
        │                                                                                 │
        │   ┌─────────────────────────────┐        input commands                       │
        │   │        Browser client       │ ───────────────────────────┐                │
        │   │  Three.js render + predict  │                            │                │
        │   │  shared/sim.ts (predict)    │ ◀──────────────────────────┼─── snapshots   │
        │   └──────────────┬──────────────┘                            │                │
        └──────────────────┼───────────────────────────────────────────┼────────────────┘
                           │  Vatar.init()  (identity + sessionToken)  │
                           │                                           │
                           │                        ┌──────────────────▼───────────────┐
                           │                        │      Authoritative server        │
                           │                        │  server/index.ts  (ws)           │
                           │                        │   ├─ Lobby   matchmaking         │
                           │                        │   ├─ Room    fixed-timestep loop │
                           │                        │   └─ shared/sim.ts (truth)       │
                           │                        └──────────────────┬───────────────┘
                           │                                           │
                           │  HTTPS + Bearer secret (server only)      │
                           ▼                                           ▼
                 ┌─────────────────────────────────────────────────────────────┐
                 │            Vatar Games REST  (lagoslife.app/api/games/v1)   │
                 │  /session/verify   /purchases/*   /matches/*                 │
                 └─────────────────────────────────────────────────────────────┘
```

## Why three pieces

1. **The Vatar SDK runs in the browser** and hands you the player's pseudonymous
   id and a short-lived session token. It cannot be trusted on its own.
2. **The Vatar REST API needs a secret**, so all identity verification,
   purchase settlement and match reporting must happen **server-side**.
3. **Real-time foosball needs sub-frame state sync**, which Vatar's match
   endpoints do not provide (they cover matchmaking + result submission only).
   So we run our own WebSocket channel for the ball and rods.

## Authority model: server-authoritative

- The server owns the truth and steps the simulation at `SIM_HZ` (60 Hz).
- Clients send **inputs only** (`PlayerInput`: a desired angle + slide per rod).
- The server applies inputs, advances the sim, and broadcasts snapshots at
  `SNAPSHOT_HZ` (20 Hz).
- Clients **predict** locally using the *same* `shared/sim.ts` and reconcile
  when a snapshot arrives, so input feels instant without trusting the client.

**Hard rule:** `shared/sim.ts` must be deterministic and free of wall-clock
time, `Math.random()` and I/O. If it isn't, prediction and the authoritative
state will drift.

### Tick loop

```
every 1000 / SIM_HZ ms:
  drain buffered inputs (reject any beyond MAX_INPUTS_PER_SEC)
  for each tick:
    apply inputs -> step(state, inputs, dtMs)
  every (SIM_HZ / SNAPSHOT_HZ) ticks:
    broadcastSnapshot(state)          # { t: "snapshot", snapshot }
  on goal / match end:                # { t: "goal" } / { t: "end" }
    update score, reset ball, report result to Vatar
```

Use an **accumulator** so a slow frame runs several catch-up steps rather than
losing time or spiralling.

## Message protocol

Defined once in [`shared/protocol.ts`](../shared/protocol.ts) and imported by
both sides. Bump `PROTOCOL_VERSION` on any wire change.

- **client → server:** `join`, `ready`, `input`, `leave`
- **server → client:** `welcome`, `peer`, `start`, `snapshot`, `goal`, `end`, `error`

## Table model

`shared/constants.ts` defines the stylised table (`TABLE`) and the eight rods
(`RODS`). A standard single-goalie table carries 11 men per team and the man
counts read **1 · 3 · 2 · 5 · 5 · 2 · 3 · 1** from goal to goal, with rod
ownership alternating. `TEAM_RODS` lists which rods each side controls.

## Hosting & framing

The Lagos Life shell frames your game, so your HTTPS host must permit it:

```
Content-Security-Policy: frame-ancestors https://lagoslife.app https://*.lagoslife.app
```

The client must be served over HTTPS and the game server needs a WebSocket
endpoint (`wss://`). The two can live on separate hosts.
