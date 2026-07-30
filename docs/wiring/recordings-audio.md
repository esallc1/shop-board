# How recordings & audio is wired

> Doc: `/docs/wiring/recordings-audio.md`
> Last updated: 2026-07-30 — verified vs commit `bea25cf`
> Status: ✅ verified vs commit `bea25cf` — security model, precedence, and endpoints re-checked against `api/recording-links.js`, `api/recording-assign.js`, `shared/recording-player.js`, `shared/customer-record.js`, and the migrations.

## 0. In one line
All audio is served through server endpoints with short-lived signed URLs; the
`recordings` table is locked down and never touched directly by the client.

## 1. Security model
- Postgres RLS is row-level and **cannot hide a column** — so `recordings` is
  default-deny with **zero policies**; all audio goes through server endpoints.
- `remote_url`, `storage_path`, `last_error` **never leave the server**. `vehicle_id`
  is an internal shop id and *is* returned (not in the secret class).
- Signed URLs: service-role, ids only, ready-only, expire in **5 minutes**.

## 2. Which vehicle a recording belongs to (precedence, highest first)
- Session assignment
- Persisted `vehicle_id` &nbsp;**← a human said it, so it beats derivation**
- `calls.ro_id` derivation
- "vehicle unknown" (null = nobody has said, **never "no"**)

Notes:
- **Unassigned recordings show under every vehicle chip** — the original-complaint call
  predates its RO, so hiding it defeats the oldest-first section.
- Assigning a vehicle is **blocked on unconfirmed rows** (phone-matched, nobody
  attached). The person link comes before the vehicle link. Enforced server-side.
- Assignments **must survive reload** — `recording-links` returns `vehicle_id` so a
  persisted assignment re-displays. ("Durable but not re-displayed" was the bug that bit
  us — a stale read must never authorize a write.)

## Known gaps & open questions (as of 2026-07-30)
- _(fill in as they arise)_

## Where it lives in the code
- `api/recording-links.js` — service-role reader; signs only `'ready'` rows, TTL `SIGNED_URL_TTL_SECONDS`=300s;
  `publicRow` whitelists `call_id, status, duration_seconds, playback_url, vehicle_id` (locked by `recording-links.test.js`)
- `api/recording-assign.js` — assign/clear a vehicle; server-side ownership gate rejects a call with no
  confirmed `customer_id` (409) and a vehicle not owned by that customer (403)
- `shared/recording-player.js` — pure render-state (ready / pending / failed)
- The **precedence resolver** (`custRecVehId`) lives in `advisor-board.html:5800`; the
  "unassigned shows under every chip" filter is `filterRecordingsByVehicle` in `shared/customer-record.js`
- Schema: `20260729_recordings.sql` (table, RLS on + zero policies, private bucket),
  `20260729_recordings_links.sql` (`vehicle_id`, `ro_id` columns)

## Session change log
- 2026-07-29 — Slice B play button (`4f76540`); Slice C RO Call History play buttons
  (`fe2b9c3`); customer-record oldest-first recordings (`4ef6544`); unknown-vehicle under
  every chip + assign endpoint (`966d033`); assignments survive reload (`bea25cf`).
- 2026-07-30 — Verified vs `bea25cf`: security model, the four-level precedence, the server-side
  assign gate, and the 5-min ready-only signed URLs all confirmed against code. No claims changed;
  added precise code locations. All five changelog commit hashes confirmed to exist.
