# Roadmap

From this skeleton to a shipped game. Each milestone should be independently
demoable before moving on.

## M0 — Skeleton ✅

- [x] Repo layout: `shared/`, `server/`, `web/`, `docs/`
- [x] Shared constants (table + rods), types and wire protocol
- [x] Authoritative server entry, lobby/room/sim stubs
- [x] Server-side Vatar REST client
- [x] Browser boot: Vatar session, WebSocket join, scene group

## M1 — Offline table (rendering) ✅

- [x] Three.js renderer, camera, lights, resize handling (`web/scene/stage.ts`)
- [x] Build the table, rails, 8 rods and men from `RODS`
- [x] Ball mesh + goal geometry
- [x] Stylised flat/low-poly materials (Lagos Life look)

## M2 — Local physics ✅

- [x] Implement `shared/sim.ts`: rod kinematics, ball/rod collision, walls,
      goal detection
- [x] Blocking-collision (no pass-through) for men — swept, substepped
- [x] Fixed-timestep loop on both sides; unit tests on the pure `step()`

## M3 — Input, prediction & smoothing ✅

- [x] Mouse control: slide + rotate rods (`web/game/input.ts`)
- [x] Input sequence numbering (`seq` / `tick` on every packet)
- [x] Local prediction of your own rods — applied the instant you move,
      before the round trip completes
- [x] Interpolation of the ball and the opponent between snapshots
      (`web/game/interpolate.ts`)
- [ ] Full reconciliation: replay still-unacknowledged inputs against a
      server correction (today we snap-then-interpolate instead)

## M4 — Multiplayer ✅

- [x] `Lobby`: queue two players, seat them, hand off to a `Room`
- [x] `Room` tick loop: buffer inputs at 60 Hz, broadcast snapshots at 20 Hz
- [x] Server-side input validation: only your own four rods, rate-limited
- [x] Interpolation of remote state; opponent leaving ends the match
- [x] Goal + match-end flow (`MATCH_SCORE_TO_WIN`), with re-serve after a goal
- [x] Reconnect: rejoin an in-progress match after a dropped socket (seat held 20 s, play paused)

## M5 — Vatar integration

- [x] Load the browser SDK and complete `Vatar.init()`; local fallback outside the shell
- [x] Server `POST /session/verify` (`{ session }`) on join; reject unverified sockets
- [x] Fresh session token (`Vatar.session()`) on every join — tokens expire after 15 min
- [x] Leaderboard UI + score submitted after each match (respects the 20 s rate limit)
- [x] `Vatar.onPause` / `onResume` pause the game and mute audio
- [x] Report results for platform matches: `POST /matches/{id}/result` with the documented
      HMAC (needs `VATAR_RESULTS_SECRET`); verified against `GET /matches/{id}` first
- [ ] **Test the above against the sandbox** (signing and match reporting are implemented
      from the docs but not yet exercised with real keys)
- [x] In-game purchase flow (verify + deliver server-side): `gold_kit`, webhook, restore on load
- [x] Quick match is paired through `Vatar.match.quick`, so results are posted to a platform match

## M6 — Polish & ship

- [x] HUD: scoreboard with team plates, timer, rod chips, kick button
- [x] Audio (synthesised), haptics, goal effects, comic words, camera juice
- [x] Mobile controls: row-grab, flick-to-kick, auto rod-select; adaptive quality
- [x] Single player vs bot (rookie / pro / legend)
- [x] Private rooms with code / invite link; rematch
- [x] First-time tutorial; the opponent is held while it runs
- [x] Reconnect: rejoin an in-progress match after a dropped socket (seat held 20 s, play paused)
- [x] `frame-ancestors` header (`vercel.json`), HTTPS hosting, `wss://` server
- [ ] Sandbox test pass → submit for review → live keys

## Open questions

- ~~Singles (one player, four rods) or doubles?~~ Settled: singles — one
  player holds all four rods.
- Matchmaking by skill? (Quick match and private codes exist; skill matching does not.)
- Any naira-staked matches, or leaderboard-only?
