# Lagos Life / Vatar Games API

> Notes compiled from the official developer docs. Base URL and payload shapes
> may change — verify everything in the sandbox before going live.

- **Developer portal:** https://lagoslife.app/developers
- **Docs:** https://lagoslife.app/developers/docs
- **Browser SDK:** https://lagoslife.app/sdk/vatar-games-v1.js
- **REST base:** https://lagoslife.app/api/games/v1
- **Agreement:** https://lagoslife.app/developers/agreement

## What the API actually is

It is **not** an API for reading or editing the main Lagos Life simulation
(no access to a player's character, job, property or general naira balance).
It is a platform SDK for **embedding your own web game inside the Lagos Life
app** and borrowing its services:

| Service            | Browser SDK                          | Server (REST)                        |
| ------------------ | ------------------------------------ | ------------------------------------ |
| Player identity    | `Vatar.init()`                       | `POST /session/verify`               |
| Leaderboard        | `Vatar.submitScore`, `Vatar.leaderboard` | —                                |
| Purchases          | `Vatar.purchase(productId)`          | `GET /purchases/{id}`, `POST /purchases/{id}/deliver` |
| Multiplayer match  | (SDK match methods)                  | `GET /matches/{id}`, `POST /matches/{id}/result` |
| Webhooks           | —                                    | e.g. `purchase.paid` (signed)        |

### Identity

`Vatar.init()` returns a **pseudonymous** `playerId`, `displayName`, optional
`avatarUrl` and a short-lived `sessionToken`. You do **not** get email, phone,
location or money. Always re-verify the token server-side with
`POST /session/verify` before seating a player.

### Purchases

`Vatar.purchase(productId)` opens Lagos Life's checkout and returns a purchase
id. Your **server** then calls `GET /purchases/{id}` to confirm, and
`POST /purchases/{id}/deliver` to mark it delivered. Amounts are in naira.
Never grant an in-game item from a client-reported purchase.

### Matches

The match endpoints cover **matchmaking and result submission**, not per-frame
state sync. Use them to create/join/find matches and to report the final score
(`POST /matches/{id}/result`, which requires an **HMAC signature**). For
real-time play, run your own WebSocket channel on top.

## Setup flow

1. Sign in to the developer portal and create a **draft** game.
2. Get **test keys** (game id + server secret) for the sandbox.
3. Host the client on HTTPS; set the `frame-ancestors` policy so Lagos Life
   may frame it.
4. Test end-to-end in the sandbox.
5. Submit for **review**; **live keys** are issued only after approval.

## Security rules (non-negotiable)

- `VATAR_SECRET` stays **server-side** — never in the bundle, DOM, logs or repo.
- Verify every session token before accepting player input.
- Verify every purchase server-side before delivering.
- Do not transmit persons' real data; work only with the pseudonymous id.
- Scores and currency are **not redeemable for cash**; any naira-staked match
  needs platform approval and limits.

## Where this lives in the repo

- Browser SDK wrapper: [`web/vatar/client.ts`](../web/vatar/client.ts)
- Server REST client: [`server/vatar/client.ts`](../server/vatar/client.ts)

`server/vatar/client.ts` contains `TODO`s for the two things to confirm first:
exact request/response field names, and the HMAC signing scheme for match
results.
