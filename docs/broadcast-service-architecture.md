# Broadcast Service — Architecture & Migration Plan

**Status:** approved direction, not yet built · **Date:** 2026-08-16
**Supersedes:** parts of `cloud-backend-contract.md` (§4–§5 deployment assumptions). Auth endpoints (§3) are unchanged and stay where they are.
**Context:** [Sixty Centers, One Org](https://claude.ai/code/artifact/2200e284-6dc6-4180-a4e8-b0a35a6c737d) — the scalability audit this plan answers.

---

## 1. The decision

Carve the desktop-facing broadcast backend out of the consumer website into its own
persistent-process service. The website keeps identity, licensing and billing. The new
service owns everything that happens during a show.

Three things drove it:

**The polling model is pathological on serverless.** Sixty desks generate ~2,940 requests a
minute and roughly 28M function invocations a month, each one a cold-ish Node function plus
a Prisma round trip — to move a few kilobytes of scores and slot claims. The same job is
sixty persistent WebSocket connections.

**Blast radius.** The Upstash quota exhaustion took the whole site down with a middleware
500, and broadcast auth went with it. A venue mid-show should not care that the consumer
site is having an incident.

**Nothing else has a home.** Media-server control, per-feed telemetry, and the seat-state
cache that makes immediate revocation possible all need a process that stays running.

This is a **move, not a rewrite**. The Prisma models, the capability-link design, the
dual-auth resolver and the seat licensing are sound — the audit's findings are about
scoping and sync volume, not about the domain model.

---

## 2. What moves, what stays

The line is **frequency and blast radius**: identity and money are low-frequency and belong
with the user database; show operations are high-frequency and must survive the website.

### Moves to the broadcast service

| Surface | Why |
|---|---|
| `/api/orgs/[id]/stations/**` | Rooms, slots, claims — the show's live state |
| `/api/orgs/[id]/station-feeds` | 20s poll today; becomes a subscription |
| `/api/orgs/[id]/camera-sessions/**` | Same shape, same cadence |
| `/api/orgs/[id]/multiview`, `/observed-games` | 3s publish + 4s read, the heaviest loop |
| `/api/orgs/[id]/show-state` | 12s heartbeat |
| `/api/orgs/[id]/crew-roster` | Rewritten per-site as part of the move |
| `/api/matches/**`, `/api/talent-invites` | Capability-link minting for talent |
| `/api/profiles/**` | Library sync — the largest payloads in the system |
| `/api/telemetry/batch` | Bulk ingest, no reason to sit next to the storefront |
| `/api/stations/by-token/**`, `/api/cameras/[token]/**` | Public join pages read live show state |

### Stays on the website

NextAuth and the `User`/`Organization` tables · Stripe and subscription state ·
`StudioAccessRequest`, the licence contract flow, `BroadcastSeat` admin UI ·
`/api/auth/_broadcast/*` **token issuance** · studio marketing, downloads, bug reports.

Token issuance stays because it is coupled to NextAuth and the user table, and it happens
once an hour per producer. The broadcast service **verifies** the same HMAC token with the
same shared secret — no cross-service call on the hot path.

---

## 3. Where it runs

The website repo is already a Turborepo with `apps/*` and `packages/*` workspaces, and
`@ne/db` is a shared Prisma package. The service is therefore `apps/broadcast` — a second
app in the existing monorepo, importing the same schema. No schema duplication, no second
source of truth, and Turbo already builds it.

Deployment target must hold WebSockets, which rules out Vercel functions. A small persistent
Node process (Fly.io, Railway, or a VPS) sharing the same Postgres is enough: sixty
connections and a few hundred writes a minute is a modest workload. Multi-region matters
less than it looks — the service carries **signalling and state, never media**.

> **Ably is already wired** in the website (`lib/ably-server.ts`, `/api/ably/*`) and is a
> viable alternative for the realtime leg. It was not chosen because it fixes only the push
> direction — the request paths and their invocation cost stay on Vercel, and per-message
> pricing at sixty venues is harder to predict than a fixed process.

---

## 4. Transport: polling becomes one connection

This is the change that makes the rest worth doing.

Each desktop opens **one** authenticated WebSocket, subscribes to its site and station
scope, and then:

**Receives** — slot claimed or released · camera connected · peer multiview updates ·
"library changed, pull it" notifications · seat/permission changes (immediate revocation).

**Sends** — show-state changes · observed-game heartbeats · slot assignments.

Everything becomes event-driven instead of interval-driven. Library sync in particular stops
being a poll entirely: the service tells a desk when a mate's profile revision changed, and
the desk pulls only that one.

| | Today | After |
|---|---|---|
| Requests/min per desk | ~49 + 59 bundle fetches | ~0 steady state |
| Function invocations/month | ~28M | n/a — one process |
| Org-library egress | 3,540 full bundles/min | changed profiles only |
| Feed-change latency | up to 20s | sub-second |

The REST surface does not disappear — it stays for everything transactional (minting rooms,
CRUD, joins from the public capability pages). Only the *polling* goes.

---

## 5. Auth

The service verifies the existing HMAC session token — same `BROADCAST_SESSION_SECRET`, same
`resolveApiActor` logic, lifted into a shared module. Two changes land with the move:

- **Seat-version claim.** The token carries a version that the service checks against cached
  seat state, so revoking a seat cuts access immediately rather than at the next refresh
  (audit SCALE-10). A persistent process makes this cheap; on serverless it was another DB
  round trip per request.
- **Actor-keyed rate limiting**, in-process. A LAN centre is one NAT address, so the current
  per-IP limit throttles a venue's fourth desk (SCALE-07). Keying on the authenticated actor
  fixes it and removes an Upstash round trip from the hot path.

---

## 6. Data model changes

These are the audit's structural fixes. All are additive and nullable, so existing
single-venue orgs migrate as one implicit site and nothing changes for current producers.

```
Organization
  └── Site                    ← NEW. The LAN centre. The scope boundary for
        └── BroadcastStation     feeds, multiview, crew and library sharing.
              └── StationRoom → StationRoomSlot
```

- `Site` model; nullable `siteId` on `BroadcastStation`, `CameraSession`, `ObservedGame`,
  `BroadcastShowState`, `MatchSession`.
- `stationId` promoted to a real indexed **column** on `BroadcastShowState` — today it lives
  inside the JSON blob and is filtered in JavaScript after a `take: 8`, which serves the
  wrong venue's show bar once more than eight producers are live (SCALE-05).
- `transport` column on the room-bearing models (`CameraSlot`, `StationRoom`, `MatchSession`)
  so a media-provider switch doesn't break rooms minted under the old one. See §8.
- Crew roster moves off the single `Organization.broadcastCrewRoster` field onto per-site
  rows — sixty desktops currently full-replace one another (SCALE-02).

> **Do this before the enterprise onboards.** Retrofitting a scope tier across sixty venues
> of live rooms, cameras and observed games is materially harder than adding it now.

---

## 7. Migration: strangler, because sixty sites can't update at once

The fleet updates on its own schedule, so both backends must serve simultaneously for a
while. They share one database, so there is no data split to coordinate.

1. **Stand up `apps/broadcast`** against the same Postgres and the same token secret. No
   traffic yet.
2. **Desktop learns `BROADCAST_SERVICE_URL`**, falling back to `BROADCAST_REMOTE_URL` when
   unset. Old builds keep hitting Vercel; new builds hit the service. Both read and write the
   same rows, so a venue running mixed versions still works.
3. **Move one route family at a time**, newest-first by cost: multiview and observed-games,
   then station-feeds, then show-state, then profiles. The Vercel copies become thin proxies
   during overlap so a stale client is never broken.
4. **Cut over the realtime leg** once a route family is stable on the service.
5. **Delete the Vercel copies** when telemetry shows no old clients left. `StudioAppEvent`
   already records app version per sign-in, so this is measurable rather than guessed.

---

## 8. Media transport

**Decision: stay on VDO.Ninja, keep the options open.** No media infrastructure is being
built now.

The abstraction has landed (`lib/media-transport.ts`, 2026-08-16). Every camera slot, station
room and team match reduces to three strings — room, password, stream id — and two URLs built
from them. That is the whole contract with the media layer, and it now sits behind a
`MediaTransport` interface with two registered providers:

- `vdo-ninja` — hosted, the default, unchanged behaviour.
- `vdo-selfhost` — same URL scheme against your own origin (`VDO_SELFHOST_URL`), which is what
  the desktop app has always supported via `state.vdo.base`. This brings the website to parity.

`lib/vdo.ts` keeps its original exports and delegates, so all eleven call sites are untouched.

### If you do go further later

The ladder, in increasing order of what it buys and what it costs to run:

| Option | Buys | Costs |
|---|---|---|
| Self-hosted VDO.Ninja + coturn | Own origin, own TURN, own branding | A TURN server to run. Still P2P — no recording, no per-feed metrics |
| WHIP/WHEP SFU (MediaMTX, LiveKit, OvenMediaEngine) | Recording, ISO feeds, per-publisher telemetry, RTMP/SRT egress | Real media-server ops |
| **The same SFU deployed per venue** | All of the above **plus** camera-to-OBS traffic never leaves the building | Sixty deployments to manage |

**On RTMP specifically:** a browser cannot publish RTMP — it is push-from-encoder only, and
2–5s latency makes caster talkback impossible. The shape that does the job is **WHIP in, WHEP
out** (WHIP became a Standards Track RFC in March 2025; OBS 30+ publishes WHIP natively). RTMP
and SRT stay valuable as *outputs*, for restreaming a finished program feed.

**Why edge-local is the interesting one at sixty venues:** a venue's player cameras and that
venue's OBS machine are in the same building. Relaying ~15 feeds per venue through a cloud SFU
is roughly 594 GB/hour across sixty sites — about **$71/hour, or $570 per event day**, at
LiveKit Cloud's $0.12/GB downstream rate, to move video across a room. A media server inside
the venue makes that traffic free and sends only remote talent over the internet. It is the
same local-first principle the desktop already runs on.

**Before enabling a second provider in production:** add the `transport` column (§6) and pass
it to `getTransport()`. Rooms already in the database were minted under whichever provider was
active at the time, and a live camera link must keep resolving after a switch.

---

## 9. Risks and open items

**`prisma db push --accept-data-loss` runs on every production build.** The root `build`
script does `prisma generate && prisma db push --accept-data-loss && next build`. On a schema
edit that Prisma reads as destructive, this drops columns and their data during a routine
deploy, with no migration history to roll back to. This needs to become
`prisma migrate deploy` against a committed migration set **before** the Site-tier migration
lands, and arguably before anything else in this document. It is the single most dangerous
thing in the current setup.

**Sequencing risk.** The Site tier gates most of §6. Do it first or the scoping fixes have
nowhere to hang.

**Shared secret.** Two services now verify the same HMAC. Rotation needs to be coordinated, or
the token format needs a key id.

**Cost model unproven.** The invocation and egress figures are computed from shipped polling
intervals, not measured under load. Worth instrumenting the current fleet before committing to
a host size.

**Open:** whether public capability pages (`/station/<token>`, `/cameras/<token>`) stay
server-rendered on the website and call the service, or move wholesale. Leaning toward staying
— they benefit from the website's CDN and are not on the hot path.

---

## 10. Order of work

Sequenced for a **prospective** enterprise deal: fix what a technical evaluator would find,
then build the thing that makes sixty venues comfortable.

**Wave 0 — safety.** Replace `db push --accept-data-loss` with `migrate deploy`. Nothing else
should land before this.

**Wave 1 — what an evaluator finds.** Crew-roster clobber (SCALE-02) · cross-venue VDO
credential exposure in station-feeds (SCALE-04) · wrong-show-bar (SCALE-05) · incremental
`rev`-based library pull (SCALE-01). All four are contained fixes on the current backend and
do not need the service to exist.

**Wave 2 — the tier.** `Site` model and `siteId` migration, scope every org-wide read.

**Wave 3 — the service.** `apps/broadcast` scaffold, shared auth module, one route family
moved end to end as a proving run, then the rest.

**Wave 4 — realtime.** WebSocket subscription replaces the poll loops. Desktop backoff and
jitter (SCALE-08) land here, since the loops are being rewritten anyway.

**Wave 5 — enterprise polish.** Immediate revocation · workspace switcher (SCALE-09) · bundle
size cap and images to S3 (SCALE-11) · desk concurrency split from seat count (SCALE-12) ·
staged release channels (SCALE-13).
