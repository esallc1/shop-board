# How the Meta / Facebook webhook is wired

> Doc: `/docs/wiring/meta-webhook.md`
> Last updated: 2026-09-12 — created with the receive-and-verify slice, then
> corrected the same day once it shipped and both paths were proven live.
> Verified vs commit `8e9f250` (the commit that SHIPPED it — not `42a5e94`, the
> tree it was written against; see the change log for why that distinction bit).
> Status: 🟢 **LIVE ON PROD — both paths proven against real Meta traffic (§8).**
> **Nothing is stored yet** — receiving is all this slice does.
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
| Prod callback URL | `https://www.leetransmissionshop.com/api/meta-webhook` |

The app itself is configured by hand in Meta's dashboard — there is no code in
this repo that creates or changes it.

### 2a. Its dashboard state as of 2026-09-12 — three things that look like faults and are not
Read this before concluding the integration is broken:

- **Field subscriptions are deliberately still Unsubscribed.** The callback URL
  is verified and the `messages` field has been test-fired, but no field is
  actually subscribed. So Meta sends **nothing** on its own — not because the
  endpoint is failing, but because we have not asked for traffic we cannot yet
  store (§1). Subscribing is a decision for the slice that adds storage.
- **The app is UNPUBLISHED.** Only webhook tests fired from the dashboard
  arrive. A real customer messaging the Page produces no delivery at all.
- **Business verification is DONE** (corrected 2026-09-23 — this line used to
  say the portfolio was blocked). EL SHADDAI AUTO LLC was verified by Meta on
  2026-09-11, and the app was attached to that verified business portfolio
  (`152510169083601`) on 2026-09-15. What still gates live customer messages
  is **App Review** for `pages_messaging`, not verification.

Taken together: today this endpoint can only be reached by Meta's own test
button and by anyone who guesses the URL. The second is why §4 enforces.

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

Confirmed against real Meta traffic on 2026-09-12 — see **§8**, and §8a for why
that confirmation only counts alongside the unsigned-POST `403`.

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

## 8. What has actually been proven against live Meta traffic
Both halves were exercised from Meta's dashboard on **2026-09-12**, against prod
at `8e9f250`:

| Path | How | Result |
|---|---|---|
| GET handshake | "Verify and save" on the Page object, callback `https://www.leetransmissionshop.com/api/meta-webhook` | **succeeded** — Meta accepted the echoed challenge |
| POST + signature | Webhook fields → `messages` → Test → "Send to server v26.0", 8:00am | **"Successfully tested the messages v26.0 webhook field"** — Meta signed a real sample payload with the live App Secret and got `200` |

### 8a. Why the 200 is only meaningful as one half of a PAIR
**A success message on its own proves nothing here.** An endpoint that returned
`200` to *everything* — no signature check at all, or a check that silently fell
open when the secret was missing — would produce that exact same
"Successfully tested" line. The `200` alone cannot distinguish a working
verifier from no verifier.

What makes it evidence is the **contrasting negative**, measured against the
same URL on the same deployment:

| Request to the prod URL | Status | What it rules out |
|---|---|---|
| Meta's signed sample POST | `200` | the secret is wrong, or the signing rule is misread |
| unsigned POST, no `X-Hub-Signature-256` | `403` | the handler 200s indiscriminately |
| GET with a wrong `hub.verify_token` | `403` | the handshake echoes any challenge |
| a route that does not exist | `404` | the `403`s are a platform artifact rather than this handler's |

Only the **pair** — signed `200` *and* unsigned `403`, on the same live URL —
shows that enforcement is real and that the live `META_APP_SECRET` is the same
secret Meta signs with. Either reading alone is worthless: a `403`-everything
endpoint would also reject Meta, and a `200`-everything endpoint would also
accept it.

**Same discipline as `send-push`'s gate order** ([[hosting-domains]] §2a, gates
`405→403→401→500→400`): there, `403` means *origin rejected* and `401` means
*secret rejected*, and that distinction is the only thing that separates the two
failures — which is exactly why the front-desk outage stayed invisible for weeks
when `firePush` discarded the response and never read the code at all
(`1fc57fa`). A single outcome is not a diagnosis; the status code is.

Inherit it: when you next change anything in §4, re-run **both** probes, not the
happy path. A regression that turns this endpoint permissive would keep Meta's
test green and would be invisible from the success message alone.

## Known gaps & open questions (as of 2026-09-12)
- **Nothing is durable.** A delivery is proven authentic, logged, and dropped.
  If Meta sends a lead today, it is gone tomorrow.
- **Storage is designed, written, NOT applied** (2026-09-23). Messenger gets its
  own tables, not `calls`: `social_threads` (one row per channel + Page + PSID)
  and `social_messages` (unique `mid`), written only by the service-role function
  `social_record_message`, read only by `is_staff()` sessions. Files:
  `migrations/20260923_social_messaging_{SANDBOX,PROD}.sql`, locked by
  `shared/social-messaging-migration.test.js`. This endpoint does not call it yet
  — that is step 2, which rewrites §1 and this doc's header.
- **No delivery log table.** Unlike CTM (`ctm_webhook_log`) there is no
  persisted record, so a rejected delivery leaves only a Vercel log line. If we
  need to debug a signature mismatch against real traffic, that's the first
  thing to add.
- **What §8 proves, and what it does not.** The signing rule and the live
  secret are confirmed (§8), but only against **Meta's dashboard test payload**
  for the `messages` field. No real end-user delivery has ever reached this
  endpoint — the app is unpublished and no field is subscribed (§2a). A genuine
  customer message may carry a shape the sample does not; §5 is why that would
  be logged and `200`d rather than error out, but it is untested in the wild.
- **`test.*` cannot do the handshake.** The env vars are set on Vercel's
  **Production** scope only, so staging 403s everything. That is fine while
  nothing is stored, but a future slice testing real payloads on staging needs
  its own `META_VERIFY_TOKEN` and a second callback registered with Meta.

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
- **2026-09-23** — §2a corrected: business verification is done (2026-09-11), app attached to portfolio `152510169083601` (2026-09-15). Gaps: Messenger storage migration written (step 1), not applied; this endpoint unchanged.
- **2026-09-12** — created. `api/meta-webhook.js` + `api/meta-webhook.test.js`:
  GET handshake, enforced `X-Hub-Signature-256`, structured log line, 200-fast
  discipline. No DB, no UI, no migration. Test suite 490 → 515.
- **2026-09-12** — shipped to prod as `8e9f250` (fast-forward of `main`, branch
  push). Verified live: `/api/version` on `www` + `board`, `advisor-board.html`
  byte-identical to the commit, unsigned POST `403` (not `404`), and the owner
  board's File Cabinet still rendering all 27 rows.
- **2026-09-12** — **both paths proven with real Meta traffic** (§8). GET:
  "Verify and save" on the Page object succeeded. POST: Webhook fields →
  `messages` → "Send to server v26.0" returned "Successfully tested the
  messages v26.0 webhook field" at 8:00am — Meta signed a sample with the live
  App Secret and got `200`. §8a records **why that `200` only counts paired with
  the unsigned-POST `403`**, since a permissive endpoint would report the same
  success. Also documented the dashboard state (§2a): fields still
  Unsubscribed, app unpublished, no business portfolio (since resolved — see the 2026-09-23 entry).
- **2026-09-12** — doc corrected. It had shipped saying "🟡 skeleton on a branch
  + staging. Not on prod" while running on prod, and carried
  `Verified vs 42a5e94` — the tree the code was *written against*, not the
  commit that *shipped* it. The File Cabinet's chip derives from that line, so
  it rendered a confident green "verified vs 42a5e94" on a doc whose own status
  line said the opposite. **Stamp the shipping commit, not the writing commit.**
