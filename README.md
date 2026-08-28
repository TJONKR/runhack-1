# runhack

RoxFit's live clock, leaderboard, and public API for [RUN/HACK](https://www.therunninghackathon.com/)
— the running hackathon. Teams of 3–4 ship an AI product in a day; only the
teammate out running the track can build. **Score = what you built × how far
you ran.** This service is the "how far you ran" half, plus the live board
that fuses both.

Standalone on purpose: nothing here touches the production RoxFit backend,
so event-week deploys carry zero risk to the app.

## How tracking works

People and devices are separate things:

1. Each runner scans the **team QR** → `/{event}/join?team=N` → registers
   **once** (a member).
2. Any phone that will track gets registered as a **device** — linked to a
   person (credits their laps) or to the team (shared phone). The server
   mints an unguessable token and deep-links into
   [Traccar Client](https://www.traccar.org/client/) (free, App Store +
   Play) with the ingest URL and that token as Traccar's device identifier.
3. Traccar streams GPS to `POST /ingest/{token}` (OsmAnd protocol — query,
   form, or JSON). Every ping self-identifies: token → team (+ person).
4. **One scoring device per team.** The first device to ping becomes the
   team's tracker; other devices ping in standby. Handoff on a shared phone
   needs no action at all — just pass it. Multi-phone handoff = tap "Make
   active" on the team page (or admin); if the active device goes silent for
   90s, a standby device auto-takes-over. A team can never record two laps
   closer together than a possible lap time, so switchovers can't
   double-count.
5. All lap logic runs server-side: geofence zone sequence, dwell rules,
   accuracy gating, pace window, leaderboard, GitHub commit polling.

## Lap detection & timing

Zones (fat polygons, drawn on the admin map) enforce the lap **sequence**:
leave start box → hit each checkpoint in order → return. GPS-noise defences:
accuracy gate (drop fixes > 40m), entry/exit dwell counts, strict ordering,
and a min/max lap-time window (too fast = GPS bounce, too slow = walking;
the event's pace rule is 7'00"/km).

**Three timings are recorded on every lap** so they can be compared on real
track GPS, and the official one is a per-event config switch (`officialTiming`):

| method | measures | notes |
|---|---|---|
| `exit_entry` (default) | start-box exit → re-entry (~lap − box) | never misses what the boxes catch; standing at the line never counts |
| `gate` | interpolated crossings of a drawn timing line | true full lap, sub-fix precision; needs the gate drawn on the map |
| `entry_entry` | box entry → entry (full lap) | control comparison; suffers if runners linger in the box |

Calibrate `min/max lap s` to whichever distance the chosen method measures
(e.g. 7'00"/km over 350m segment = 147s, over the full 400m = 168s).

## Idle monitor ("nobody sits down")

Every 5s the server checks each team: is **anyone** on the team moving at
running speed? A device covers its team when its last fix is fresh
(`coverageStaleS`, default 35s) and at running speed (`idleSpeedMs`, default
1.5 m/s; a fix without speed counts while fresh). When no device covers the
team for longer than `idleGraceS` (default 15s) an **infraction** opens —
backdated to the moment the grace ran out — and closes when someone runs
again. Infractions only accrue while the event is `live`.

The board shows per team: infraction count, total idle seconds, and a live
"SITTING" flash while a gap is open. Penalties are the organisers' call —
the raw log (start/end/seconds per infraction) is kept for the final tally.
Admin: `GET /api/admin/events/{slug}/teams/{id}/infractions` to review,
`PATCH /api/admin/infractions/{id}` `{"dismissed":true}` to void one
(GPS dropout, agreed dispute); dismissed infractions leave the board totals.
Set `idleMonitor: false` in event config to turn it off.

## GitHub integration

Each team connects one **public** repo (first runner sets it on the join
page; admins can edit/test/override). The poller pulls, per team, within the
event window: commit count, newest commit (message/author/time — shown live
on the board), and distinct committers (token only). Score formulas
(config): `km × commits`, `km × √commits`, or `km + commits × weight`, with
an optional `commitCap`. Manual per-team commit override and score adjust
exist for disputes.

Polling runs every 5 minutes (teams don't commit faster than that, and it
keeps 30 repos at ~720 req/hr vs the token's 5,000 limit). Set
`GITHUB_TOKEN` (any free personal token, no scopes needed) — without it
GitHub's 60 req/hr IP limit breaks at even a handful of teams. The admin
"test" button on a team's repo refreshes it instantly.

## URLs

| URL | What |
| --- | --- |
| `/admin` | race control (password = `ADMIN_KEY` env var) |
| `/{event}/join?team=N` | runner signup (what team QRs encode) |
| `/{event}/team/N` | public team page: join QR, readiness checklist, live roster |
| `/{event}/board` | venue big-screen board |
| `/api/{event}/board` | public JSON board — poll every 2–5s |
| `/api/{event}/team/N` | public team JSON |
| `/ingest/{userId}` | Traccar ingest |

The board page/API and team pages are public; everything mutating sits
behind `/api/admin/*`.

## Race control (`/admin`)

Events are the top level — dev, London, SF are just rows (Live / Scheduled /
Drafts / Finished, with quick **Start now**). Inside an event:

- **Setup** — start/end times, lifecycle (start/pause/resume/end now), lap +
  scoring config, links, danger zone (reset race data / delete event).
- **Teams** — readiness chip (≥3 runners, ≥1 device pinged, GitHub verified),
  repo test/status, manual laps, per-lap valid↔invalid flips and time edits,
  commit override, score adjust, copy join/QR links.
- **Runners** — live roster: rename, move team, force-activate,
  freeze/unfreeze, reset stuck state, remove; copy any runner's Traccar
  config link to (re)connect a phone.
- **Leaderboard** — the public board embedded live.
- **Map** — draw/edit zones (drag corners, drag whole zone), the optional
  timing gate, live runner markers with a team legend, and the **simulator**
  (fake runners looping the real zones through the real ingest pipeline).

## Deploy (Render)

1. Push to GitHub → Render → **New → Blueprint** → pick the repo
   (`render.yaml` creates the web service + Postgres; schema auto-creates).
2. Set `ADMIN_KEY` (and ideally `GITHUB_TOKEN`) in the service env.
3. Custom domain, e.g. `runhack.roxfit.app` (CNAME per Render's instructions).
4. Open `/admin`, create the event, draw zones on the venue walk, add teams.

Running cost: Render starter web service + Postgres (~$14/mo). Free-tier
instances sleep on idle, which kills live ingest — don't downgrade.

## Local dev

```bash
docker run -d --name runhack-pg -e POSTGRES_PASSWORD=dev -p 5432:5432 postgres:16
DATABASE_URL=postgres://postgres:dev@localhost:5432/postgres ADMIN_KEY=dev npm run dev
```

Fake a runner without a phone (or use the admin simulator):

```bash
curl "http://localhost:3000/ingest/<userId>?lat=51.5388&lon=-0.0175&timestamp=$(date +%s)&accuracy=8"
```

Tests (lap engine + scoring):

```bash
npm test
```

## Before the event

- Walk the venue: pin the two boxes (overshoot 10–15m beyond the track edge,
  keep ≥30m gap between boxes) and draw the timing gate mid-start-box,
  longer than the track is wide.
- Rehearse with 2–3 real phones running laps; compare the three timings in
  the admin laps panel against a stopwatch; pick the winner in Setup and
  calibrate the lap window to it.
- Verify the Traccar deep link on a real iPhone and a real Android (the join
  page has a manual-setup fallback).
- Create the real event fresh (or **Reset race data** after the rehearsal).
