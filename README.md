# Lagos Foosball

A 3D, real-time **multiplayer foosball** game built with [Three.js](https://threejs.org/),
designed to run **inside the Lagos Life / Vatar Games platform** and plug into its
identity, leaderboard and match APIs.

> **Status:** playable and polished. Solo vs a bot (three difficulties), online quick
> match, private rooms with a share code, a first-time tutorial, sound, haptics and a
> lot of game feel. Built mobile-first; works with mouse and keyboard too.

## What's in it

- **A real foosball table** — green rim over dark inner walls, navy cabinet, team-coloured
  grips, bead scoreboard and goal pockets. The 22 men are one instanced draw call using
  `foosball_player.glb`; a small shader swaps its blue kit for each team's colour.
- **Game feel** — camera shake, FOV punches, a small zoom on every kick, a restrained goal
  cam with slow motion, hit-stop on the hardest shots, a cinematic fly-down at kick-off,
  confetti, sparks, ball trail, comic-book words ("WHAM!", "SAVED!", "GOAL!") that bounce
  in together or word by word, and synthesised sound effects (no audio files).
- **Modes** — *Vs Bot* (rookie / pro / legend, runs locally with zero latency and real
  slow-mo), *Play Online* (quick match), *Play a Friend* (private room code / invite link).
- **Touch controls** — touch a row to grab that rod, drag to slide, flick up (or tap) to
  kick, optional auto rod-select. Mouse: move to slide + tilt, click/Space to kick, 1–4 to
  pick a rod, A for auto.
- **Lagos Life integration** — identity on the menu, leaderboard + score submission,
  platform pause/resume, and signed result reporting for platform matches.
- **Efficient** — one instanced mesh for all the men, a merged static cabinet, pooled
  particles (two draw calls), and an adaptive-quality governor that lowers pixel ratio and
  shadows if frames run long.

## Design in one line

A **server-authoritative** simulation (Node + `ws`) drives two players who own opposite
ends of the table; the browser only sends inputs and renders; **Vatar's REST API is called
server-side only** so no secret ever reaches the client. Solo mode runs the *same*
simulation locally.

## Quickstart

```bash
npm install          # install deps (root, web and server share one package)
cp .env.example .env # then fill in your Vatar sandbox keys (optional for local play)
npm run dev          # web on :5173, game server on :8080
```

Handy URLs while developing:

| URL                       | What it does                                   |
| ------------------------- | ---------------------------------------------- |
| `/?solo=pro`              | jump straight into a bot match                 |
| `/?room=K4Q7Z`            | open the join screen for a friend's room       |
| `/?tutorial`              | replay the first-time walkthrough              |
| `/?server=ws://host:port` | (dev builds only) use a different game server  |

Scripts:

| Script               | What it does                                    |
| -------------------- | ----------------------------------------------- |
| `npm run dev:web`    | Vite dev server for the browser client only     |
| `npm run dev:server` | `tsx watch` the authoritative game server       |
| `npm run build`      | Production bundle into `dist/` (relative URLs)  |
| `npm test`           | Simulation, match-flow, bot and server tests    |
| `npm run typecheck`  | Type-check client, server and shared code       |

## Repository layout

```
shared/     types, constants, wire protocol, and the deterministic game core
  sim.ts      physics (ball, rods, collisions, goals, hit events)
  match.ts    match flow: countdown, goal pauses, serving, winning, stats
  bot.ts      the computer opponent
server/     authoritative rooms, matchmaking, and the Vatar REST client
  vatar/      server-side API client — the only place secrets are used
web/        Three.js client (Vite root)
  scene/      table, figures (GLB → instanced mesh), ball, stage + quality governor
  fx/         camera director, particles, juice (sound/shake/words/slow-mo)
  game/       game controller, sessions (solo / online), input, interpolation
  ui/         HUD, screens, comic words, tutorial
  vatar/      browser SDK wrapper (identity, leaderboard, pause/resume)
  public/     foosball_player.glb, soccer_ball.glb, fonts
docs/       architecture, API notes and roadmap
```

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the pieces fit together
- [docs/VATAR-API.md](docs/VATAR-API.md) — what the Lagos Life / Vatar API gives you
- [docs/ROADMAP.md](docs/ROADMAP.md) — what's done and what's next

## Credits

`LuckiestGuy.ttf` (Apache 2.0, see `web/public/LICENSE.txt`) for the menus and comic words;
`VarsityTeam-Bold.otf` for scoreboard numbers.
