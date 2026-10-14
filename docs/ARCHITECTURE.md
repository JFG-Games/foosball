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
- Clients send **inputs only** (a desired angle + slide per rod, for the four rods they own).
- The server validates (own rods only, finite numbers, rate-limited), advances the
  sim, and broadcasts snapshots at `SNAPSHOT_HZ` (20 Hz).
- Clients draw the ball and the opponent **interpolated** between snapshots (a short
  delay buys perfectly smooth motion), while the player's **own rods are applied
  locally the instant they move**, so controls never wait on the network.

**Hard rule:** `shared/sim.ts` and `shared/match.ts` must be deterministic and free of
wall-clock time, `Math.random()` and I/O. Time only enters through `tick()`.

### Match flow (`shared/match.ts`)

```
countdown ──▶ play ──goal──▶ goal (celebration pause) ──▶ play …
                              └─ winning goal ─▶ over
```

`MatchCore` is transport-independent. The server's `Room` drives one on a real-time
loop with a catch-up accumulator; the browser's solo mode (`LocalSession`) drives
the very same class locally, so "what happens after a goal" cannot differ between modes.
The sim reports **hit events** (ball contacts with speeds) and an **epoch** counter that
bumps whenever the ball is teleported, so clients never interpolate across a serve.

### Solo mode

`LocalSession` = `MatchCore` + `Bot` (`shared/bot.ts`) at 60 Hz in the browser. Zero
latency, works without a server, and because the clock is ours the slow-motion moments
slow the *simulation* too. Online, slow-mo can only affect what is drawn.

### Ready handshake

Once two players are paired the server **holds the match** until both send `ready`
(a first-timer is in the tutorial, for instance). The other player sees
"opponent is getting ready" with no cancel button (it returns after 45 s). If someone
never readies within 2 minutes the room is closed.

## Message protocol

Defined once in [`shared/protocol.ts`](../shared/protocol.ts) and imported by
both sides. Bump `PROTOCOL_VERSION` on any wire change (mismatched clients are told to reload).

- **client → server:** `join` (quick / `create` / `roomCode`, optional `vatarMatchId`),
  `ready`, `input`, `rematch`, `leave`
- **server → client:** `waiting`, `welcome`, `peer`, `opponent`, `start`, `snapshot`,
  `fx` (hit events), `goal`, `serve`, `end`, `rematch`, `error`

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
