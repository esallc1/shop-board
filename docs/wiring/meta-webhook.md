# How the Meta / Facebook webhook is wired

> Doc: `/docs/wiring/meta-webhook.md`
> Last updated: 2026-09-12 — created with the receive-and-verify slice.
> Verified vs commit `42a5e94` (the tree this endpoint was written against).
> Status: 🟡 **skeleton on a branch + staging. Not on prod. Nothing is stored yet.**
> Related: [[hosting-domains]] (env vars, domains), [[call-window-desk]] and
> [[call-auto-attach]] (where a future Messenger lead would eventually land).

## 0. In one line
A single serverless endpoint that Meta can call for the shop's Facebook app —
it answers Meta's one-time verification handshake and it **proves that an
incoming delivery really came from Meta** — and, for now, does nothing else
with what arrives except write one line to the log.

## 1. What exists, and what deliberately does not
**Exists:** `api/meta-webhook.js` — `GET` handshake, `POST` signature
verification, one structured log line, `200`.

**Does not exist yet, on purpose:**
- no Supabase client, no read, no write — this file imports `node:crypto` and
  nothing else
- no `calls` row, no lead row, no message storage
- no PSID storage (that's the one real migration, and it isn't designed)
- no Messenger auto-reply
- no UI anywhere — no board touches this endpoint

Turning a payload into rows needs schema decisions we have not made. Receiving
and proving authenticity is the whole slice, and everything later can be built
on top of a request we already know is genuine.

## 2. The Meta app
| | |
|---|---|
| App name | Lee Transmission CrisData |
| App ID | `1075837401512965` |
| Mode | Development |

The app itself is configured by hand in Meta's dashboard — there is no code in
this repo that creates or changes it.

**Unrelated, and easy to confuse:** `advisor-board.html`'s `TRACKING_SOURCE`
maps `'2399320855' → 'Facebook'`. That is a **CallTrackingMetrics tracking
phone number** used to label where a phone call came from. It is not an API, not
a page id, and has nothing to do with this endpoint.

## 3. The GET handshake
Meta calls the Callback URL once, when the URL is saved in the dashboard, with
three query params: `hub.mode`, `hub.verify_token`, `hub.challenge`.

- `hub.mode === 'subscribe'` **and** `hub.verify_token === META_VERIFY_TOKEN`
  → `200` whose body is **exactly** `hub.challenge`, as `text/plain`.
- anything else → `403`, empty body. The challenge is never echoed.

**Why "exactly" is load-bearing:** Meta *string-compares* the response body to
the challenge it sent. JSON, surrounding quotes or a trailing newline all read
as a failed handshake even though the status is 200. That is pinned by a test.

Params are read from Vercel's parsed `req.query` when present, and parsed off
`req.url` otherwise, so the endpoint behaves the same in tests and in prod.

## 4. The POST signature check — and why it is ENFORCED here
Meta sends `X-Hub-Signature-256: sha256=<hex>`, where the hex is
`HMAC-SHA256(raw request body, META_APP_SECRET)`.

The check lives in the exported pure function `verifyMetaSignature(header,
rawBody, appSecret)`, which returns `{ ok, reason }` and **never throws**.
Order matters:

1. no app secret → `no-app-secret`
2. no header → `no-signature-header`
3. header doesn't match `^sha256=<hex>$` → `malformed-signature-header`
4. decoded digest length ≠ 32 bytes → `length-mismatch`
5. `crypto.timingSafeEqual` says no → `signature-mismatch`

Step 4 is not decoration: `timingSafeEqual` **throws** on unequal lengths, so a
short, long or odd-length hex has to be rejected before it reaches the compare.
An odd-length hex is the sneaky one — `Buffer.from` silently truncates it.

Two more properties, both tested: the comparison is over the **raw bytes**
(`bodyParser` is off and the body is read as a `Buffer`, never a utf8
round-trip), and the hex is **case-insensitive**, because hex is.

> ### ⚠ This is a deliberate departure from `api/ctm-webhook.js` — do not "align the two files"
> `ctm-webhook.js` computes a candidate signature and stores `sig_received` /
> `sig_computed` / `sig_match`, but **never rejects on it**. That is correct
> *there*: CTM's exact signing string is still an assumption we are confirming
> against real logged values, and dropping real calls over a guess would lose
> customers. Meta's signing string is documented and fixed, and Meta requires
> enforcement — an unauthenticated endpoint here is an open door for anybody who
> learns the URL. So this file enforces. The permissive behaviour over there is
> a temporary state of a *different vendor's* integration, not a house style.

## 5. Response discipline
Meta retries non-200 deliveries and eventually **unsubscribes the app**. So:

| Situation | Response |
|---|---|
| handshake OK | `200`, body = the challenge |
| handshake failed (any reason) | `403`, empty |
| signature OK, payload understood | `200 EVENT_RECEIVED` |
| signature OK, payload is a shape we don't handle (or isn't JSON at all) | **`200`** — logged, not rejected |
| signature failed (any reason) | `403`, empty — body is never parsed |
| raw body couldn't be read | `403` — we never saw the bytes, so we can't authenticate them |
| method other than GET / POST | `405` |

There is no `500` path for an unrecognised payload. The body is only
`JSON.parse`d **after** the signature passes, and a parse failure is recorded in
the log line rather than raised.

## 6. Env vars — Vercel only, never in the repo
| Var | What it is |
|---|---|
| `META_APP_SECRET` | the Meta App Secret. Treat it as a password. |
| `META_VERIFY_TOKEN` | a random string Cris picks; must match exactly what he pastes into the Meta dashboard. |

**Fail closed.** If either is missing the endpoint returns `403` and logs that
it is missing. There is no default value and no "skip verification when
unconfigured" path — both are pinned by tests, because a fallback here would
silently turn the endpoint into an open one.

## 7. What gets logged (and what doesn't)
One structured line per authentic delivery, from the exported
`summarizeMetaPayload(body)`: the envelope `object`, the entry count, the event
types present (`messaging`, `standby`, … and `changes:<field>` for a `changes`
entry) and any page ids, plus byte count and any parse error.

**Message text is not logged.** The point is to see what Meta actually sends
before designing a schema for it — not to put customer messages into the Vercel
log. A test asserts the summary of a real-shaped Messenger delivery contains
none of the message body.

## Known gaps & open questions (as of 2026-09-12)
- **Nothing is durable.** A delivery is proven authentic, logged, and dropped.
  If Meta sends a lead today, it is gone tomorrow.
- **The next slice needs schema decisions**: does a Messenger conversation
  become a `calls` row, a new table, or a lead on the Desk? Where does a PSID
  live, and what is the retention rule for it?
- **Not deployed to prod.** Staging only, and the Meta app is in Development
  mode, so only app roles can trigger deliveries.
- **No delivery log table.** Unlike CTM (`ctm_webhook_log`) there is no
  persisted record, so a rejected delivery leaves only a Vercel log line. If we
  need to debug a signature mismatch against real traffic, that's the first
  thing to add.
- **Untested against real Meta traffic** — the signature format is implemented
  from Meta's documented rule, not yet confirmed against a live delivery.

## Where it lives in the code
- `api/meta-webhook.js` — the whole endpoint. Exports: `default handler`,
  `verifyMetaSignature`, `verifyHandshake`, `summarizeMetaPayload`, and
  `config = { api: { bodyParser: false } }`.
- `api/meta-webhook.test.js` — 25 tests (`npm test`, i.e.
  `node --test 'api/*.test.js' 'shared/*.test.js'`).
- Route: Vercel maps `api/*.js` by filename, and `vercel.json` has no rewrite
  over `/api/*`, so the endpoint is `/api/meta-webhook`.
- Env: Vercel project `shop-board` → `META_APP_SECRET`, `META_VERIFY_TOKEN`.
- Template it was built from: `api/ctm-webhook.js` (raw-body read + disabled
  body parser) — but see §4 for where it intentionally diverges.

## Session change log
- **2026-09-12** — created. `api/meta-webhook.js` + `api/meta-webhook.test.js`:
  GET handshake, enforced `X-Hub-Signature-256`, structured log line, 200-fast
  discipline. No DB, no UI, no migration. Test suite 490 → 515.
