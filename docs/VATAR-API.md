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
app** and borrowing its services. Every browser method returns a Promise.

| Service          | Browser SDK                                                                         | Server (REST)                                          |
| ---------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Player identity  | `Vatar.init()` → `{ player: { id, name, avatar }, session, mode }`                  | `POST /session/verify` `{ session }` → `{ playerId, name, gameId, exp, mode }` |
| Fresh token      | `Vatar.session()` → `{ session, exp }`                                              | —                                                      |
| Leaderboard      | `Vatar.submitScore(n)` → `{ best, accepted }`; `Vatar.leaderboard()` → `{ top, me }` | —                                                      |
| Purchases        | `Vatar.purchase(id)`, `onPurchase`, `purchases()`                                    | `GET /purchases/{id}`, `POST /purchases/{id}/deliver`  |
| Pause / resume   | `Vatar.onPause(fn)`, `Vatar.onResume(fn)`                                            | —                                                      |
| Platform matches | `Vatar.match.create/join/quick/current/leave/onUpdate`                              | `GET /matches/{id}`, `POST /matches/{id}/result`       |

Limits: `submitScore` accepts **one score per player every 20 s**; session tokens
expire **15 minutes** after issue.

### Identity

Always re-verify the token server-side with `POST /session/verify` before seating a
player. You get a **pseudonymous** id, a display name and optional avatar — no email,
phone, location or money. This game fetches a fresh token (`Vatar.session()`) each time it joins.

### Purchases

`Vatar.purchase(productId)` opens Lagos Life's checkout and returns a purchase id. Your
**server** then calls `GET /purchases/{id}` to confirm (`status` is `paid`, `delivered` or
`refunded`; amounts in naira) and `POST /purchases/{id}/deliver`. Never grant an item
from a client-reported purchase.

**Wired in:** one product, `gold_kit` (create it in the dashboard with that exact id; it is a
one-off). The browser calls `Vatar.purchase`, then `POST /claim` on the game server, which
verifies the session and the purchase, grants the item once (`server/store.ts`) and marks it
delivered. `POST /entitlements` returns what a player owns, `Vatar.purchases()` restores
interrupted purchases, and `POST /vatar-webhook` (signed `sha256=` HMAC) does the same from
Vatar's `purchase.paid` nudge. Code: `server/http.ts`, `server/purchases.ts`.

### Matches and signed results

The match endpoints cover **matchmaking and result submission**, not per-frame state.
For real-time play this game runs its own WebSocket channel.

To report a result: `POST /matches/{id}/result` with body `{ "winner": "<playerId>" | "draw" }`
and headers `Authorization: Bearer <secret>`, `X-Vatar-Timestamp` (whole seconds, within
5 min) and `X-Vatar-Signature: v1=<hex>`. The signature is an **HMAC-SHA256** keyed with
`VATAR_RESULTS_SECRET` over five newline-joined lines: `POST`, the full path
(`/api/games/v1/matches/{id}/result`), the timestamp, the match's `nonce` (from
`GET /matches/{id}`) and the hex SHA-256 of the exact body. A result can only be posted
while the match is `playing` and settles once (`409 already_settled` otherwise).
Implemented in [`server/vatar/client.ts`](../server/vatar/client.ts).

The game only reports when **both** players name the same `vatarMatchId` *and* the
platform's `GET /matches/{id}` lists both of them as players.

**Quick match** is paired by the platform: the client calls `Vatar.match.quick({ stake: 0 })`,
waits for `status: "playing"`, then joins our server with that match id (so the match exists on
Lagos Life and our server posts its result). Private rooms use our own codes and are not
platform matches. Stakes are not used.

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

The signing and match-reporting paths follow the published docs but have not yet
been exercised against the sandbox — do that before going live.
