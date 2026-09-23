# How the Meta / Facebook webhook is wired

> Doc: `/docs/wiring/meta-webhook.md`
> Last updated: 2026-09-23 — **Messenger step 2: the webhook now STORES messages + echoes**
> (§9) into the step-1 tables, which Cris applied and verified on both projects (§9a).
> Verified vs commit `ec5f8e7` + the step-2 change (see the change log for the shipping SHA).
> Status: 🟢 **LIVE ON PROD** (receive + verify proven against real Meta traffic, §8). Storage is
> built and proven on the sandbox with signed fake deliveries (§10); **prod stores nothing yet**
> because no Meta field is subscribed (§2a).
> Related: [[office-auth]] (`is_staff()`), [[staging-db]] (which DB a function writes to),
> [[hosting-domains]] (env vars, domains), [[call-window-desk]] (phone calls — untouched by this).

## 0. In one line
The serverless endpoint Meta calls for the shop's Facebook app: it answers Meta's one-time
handshake, **proves every delivery really came from Meta**, and **saves each Messenger message
and each Page reply it carries** into `social_threads` / `social_messages`, for the Advisor
inbox tray that later steps build.

## 1. What exists, and what deliberately does not
**Exists:** `api/meta-webhook.js` — `GET` handshake (§3), `POST` signature enforcement (§4),
then `parseMessagingEvents` → `storeRows` → `social_record_message` (§9), one structured log
line (§7), `200`.

**Does not exist yet, on purpose (later steps of the Messenger → Advisor tray):**
- no reply sending (`api/messenger.js`, step 3) and no Link / Done
- no UI — no board reads these tables yet (tray = steps 4–5)
- no after-hours auto-reply, no Instagram, no Lead Ads, no push/sound
- no attachment FILES — only their metadata and Meta's (expiring) link
- phone calls are not touched: `calls`, the call card, the Desk are unchanged

## 2. The Meta app
| | |
|---|---|
| App name | Lee Transmission CrisData |
| App ID | `1075837401512965` |
| Mode | Development |
| Page | `821690607890680` (`SHOP_PAGE_ID`; `META_PAGE_ID` env overrides) |
| Business portfolio | `152510169083601` — business verified 2026-09-11, app attached 2026-09-15 |
| Prod callback URL | `https://www.leetransmissionshop.com/api/meta-webhook` |

The app itself is configured by hand in Meta's dashboard — there is no code in
this repo that creates or changes it.

### 2a. Its dashboard state as of 2026-09-23 — what looks like a fault and is not
Read this before concluding the integration is broken:

- **Field subscriptions are deliberately still Unsubscribed.** The callback URL
  is verified and the `messages` field has been test-fired, but no field is
  actually subscribed — so Meta sends **nothing** on its own and prod stores
  nothing, even though the storage code is live. Subscribing `messages` +
  `message_echoes` (and subscribing the **Page** to the app) is a Cris step for
  after the tray exists.
- **The app is UNPUBLISHED.** Only webhook tests fired from the dashboard
  arrive. A real customer messaging the Page produces no delivery at all.
- **Business verification is DONE** (corrected 2026-09-23 — this line used to
  say the portfolio was blocked). EL SHADDAI AUTO LLC was verified by Meta on
  2026-09-11, and the app was attached to that verified business portfolio
  (`152510169083601`) on 2026-09-15. What still gates live customer messages
  is **App Review** for `pages_messaging`, not verification.

Taken together: today this endpoint can only be reached by Meta's own test
button and by anyone who guesses the URL. The second is why §4 enforces — and
since step 2 an unsigned POST would otherwise be a way to write rows.

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
| signature OK, payload understood | `200 EVENT_RECEIVED` (rows stored) |
| signature OK, storing failed (DB down, no service key, RPC error) | **`200`** — counted as `errors` in the log line |
| signature OK, payload is a shape we don't handle (or isn't JSON at all) | **`200`** — logged, not rejected |
| signature failed (any reason) | `403`, empty — body is never parsed |
| raw body couldn't be read | `403` — we never saw the bytes, so we can't authenticate them |
| method other than GET / POST | `405` |

There is no `500` path — not for an unrecognised payload, and not for a database error.
**The cost, stated plainly:** a delivery that fails to store is **lost** — Meta got its `200` and
will not resend. The log line's `errors` count is the only trace (Known gaps). The body is only
`JSON.parse`d **after** the signature passes, and a parse failure is recorded in
the log line rather than raised.

## 6. Env vars — Vercel only, never in the repo
| Var | Production | Preview, branch `staging` only |
|---|---|---|
| `META_APP_SECRET` | the real Meta App Secret (set 2026-09-12) | a **made-up** staging secret (set 2026-09-23) — Meta can't sign for it; `scripts/meta-sim.mjs` does (§10) |
| `META_VERIFY_TOKEN` | the random handshake token Cris picked | **unset** — staging's GET handshake 403s, on purpose |
| `META_PAGE_ACCESS_TOKEN` | **unset** (step 6) | unset |
| `META_PAGE_ID` | unset → `821690607890680` | unset |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | prod (URL falls back to prod) | the sandbox ([[staging-db]]) |

**Fail closed.** No secret → every POST 403s; no verify token → every GET 403s. No default
value and no "skip verification when unconfigured" path — both pinned by tests. A missing
service-role key does **not** 403 (the delivery is authentic); it is logged and counted, and 200s.
Vercel bakes env vars in at build time: changing one needs a fresh deploy of that branch.

## 7. What gets logged (and what doesn't)
One structured line per authentic delivery: the envelope `object`, entry count, event types
present and page ids (`summarizeMetaPayload`), byte count, any parse error, then the storage
result — `rows`, `inserted`, `duplicate`, `errors`, `named`, `nameErrors` — and `skipped`, a
count per reason (`foreign-page`, `delivery`, `read`, `reaction`, `postback`, `deleted`,
`no-mid`, `standby`, `changes`, …). Failures add a line with the HTTP status only.

**Never logged:** message text, attachment URLs, PSIDs, names, the Page token. A test posts a
delivery carrying a card-number-like text, a PSID, an attachment URL and a Graph name and
asserts none of them reach any log line.

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

## 9. Storing a delivery (step 2, 2026-09-23)
### 9a. The tables — applied and verified on BOTH projects 2026-09-23
`migrations/20260923_social_messaging_{SANDBOX,PROD}.sql`, hand-run by Cris on 2026-09-23:
SANDBOX (`app_env` = "SANDBOX — efhmefpaijjncwgbvwki") then PROD ("PROD — KiKi
hygemiszxwmyrkmhbjub"), each followed by the 8 checks, **all PASS on both**: RLS on both tables;
exactly 2 policies, SELECT-only, `to authenticated using (is_staff())`; anon has no
select/insert on either; authenticated select yes, insert/update/delete no; `is_staff()` anon
no / authenticated yes; `social_record_message` anon no / authenticated no / service_role yes;
both tables in `supabase_realtime`; both empty.

- `social_threads` — one row per `(channel, page_id, psid)`. `channel` allows `instagram`
  (unused). Human fields: `customer_id`, `linked_*`, `done_*`. Clocks: `last_inbound_at`
  (customer messages only — the 24h window), `last_message_at`.
- `social_messages` — one row per unique `mid`; `direction` in/out, `is_echo`, `source`
  (`customer` / `crisdata` / `page_inbox`), `app_id`, `text`, `attachments` (jsonb metadata),
  `sent_at`, and send fields for step 3. Deleting a thread cascades to its messages.
- `social_record_message(...)` — the only writer, service role only: create-thread-if-missing,
  insert-message ON CONFLICT (mid) DO NOTHING, clocks only move forward, fills
  `sent_by`/`send_status`/`display_name` only when empty, never writes `done_*`/`customer_id`.
  Locked by `shared/social-messaging-migration.test.js`.

### 9b. What becomes a row — `parseMessagingEvents(body, pageId)`
Pure; returns `{ rows, skipped }` in delivery order. Requires `object === 'page'`.
- an entry whose `id` isn't our Page → `foreign-page`, whole entry skipped.
- `message` with a `mid`, addressed **to** our Page → `in` / `customer`, PSID = sender.
- `message.is_echo` sent **by** our Page → `out`, PSID = recipient. Source by `app_id`:
  **`1075837401512965` (CrisData) → `crisdata`**; anything else or none → **`page_inbox`**
  (Business Suite / Pages app — e.g. Daiana on her phone).
- Page on the wrong side of the event → `foreign-page`. `is_deleted` → `deleted`; no `mid` →
  `no-mid`; `delivery` / `read` / `reaction` / `postback` / other → counted by name;
  `standby` / `changes` arrays → counted.
- `sent_at` = the event `timestamp` (ms) → ISO, else the entry `time`, else now.
- Attachments → `[{type, url?, sticker_id?, title?}]`. No file is fetched.

### 9c. Writing — `storeRows(rows)`
One `POST /rest/v1/rpc/social_record_message` per row, in order, with the service-role key
against `SUPABASE_URL` (Preview = sandbox, Production = prod). `inserted: false` = a
re-delivery (or the echo/send race) and is counted as `duplicate`. Never throws.

### 9d. The name — once, only with a token
After a **new inbound** row, if `META_PAGE_ACCESS_TOKEN` is set: read the thread's
`display_name`; if empty, `GET graph.facebook.com/v26.0/<psid>?fields=first_name,last_name`
with the token in the **Authorization header** (never the URL), 4 s timeout; then
`PATCH social_threads?id=eq.<id>&display_name=is.null` — fill-if-empty, never replace. No token
(today, everywhere) → skipped quietly, no name; the tray will show "Facebook user" until linked.
A Graph refusal is counted (`nameErrors`) and simply retried on the thread's next new message.

## 10. Testing it on staging — `scripts/meta-sim.mjs`
Staging can't be reached by real Meta traffic usefully (Meta signs with the real secret, which
staging doesn't have — by design). So staging's `META_APP_SECRET` is a made-up value (§6), and
the sim plays Meta with it:

```
META_SIM_SECRET=<staging secret> node scripts/meta-sim.mjs https://test.leetransmissionshop.com/api/meta-webhook
```

It sends, with a fresh `SIM_<time>` PSID: a first message, a second message, a Business Suite
echo, delivery #1 **again byte for byte**, and an **unsigned** copy (expect `403`), then prints
the SQL to look the rows up in the sandbox. It refuses to run against the prod hostnames. The
staging secret lives only in Vercel (Preview · `staging`) and in the operator's shell — never
in the repo.

## Known gaps & open questions (as of 2026-09-23)
- **A delivery that fails to store is lost.** We 200 to keep the subscription alive, so Meta
  won't resend; only the log line's `errors` count shows it. A `meta_webhook_log` table (like
  CTM's) is the fix if this ever bites.
- **No real end-user delivery has ever reached this endpoint.** §8 proves the signing rule
  with Meta's dashboard sample; §10 proves storage with our own fakes. The first real message
  arrives only after Cris subscribes the fields and the Page (step 6).
- **Attachment links expire** (Meta CDN). Only metadata is kept; copying files is a later slice.
- **`META_PAGE_ACCESS_TOKEN` is unset**, so no names are looked up yet (§9d).
- **Test files under `api/` deploy as functions** (`/api/meta-webhook.test` answers 500 on prod)
  — pre-existing for all `api/*.test.js`, flagged separately; not specific to this endpoint.

## Where it lives in the code
- `api/meta-webhook.js` — the endpoint. Exports: `default handler`, `verifyMetaSignature`,
  `verifyHandshake`, `summarizeMetaPayload`, `parseMessagingEvents`, `storeRows`,
  `SHOP_PAGE_ID`, `CRISDATA_APP_ID`, and `config = { api: { bodyParser: false } }`.
- `api/meta-webhook.test.js` (25 tests — handshake + signature) and
  `api/meta-webhook-store.test.js` (19 tests — parse, store, name, handler end to end). Run with
  `npm test`, i.e. `node --test 'api/*.test.js' 'api/_lib/*.test.js' 'shared/*.test.js'`.
- `migrations/20260923_social_messaging_{SANDBOX,PROD}.sql` (+ `shared/social-messaging-migration.test.js`).
- `scripts/meta-sim.mjs` — the signed-delivery simulator (§10). `scripts/` is in `.vercelignore`.
- Route: Vercel maps `api/*.js` by filename; `vercel.json` has no rewrite over `/api/*`.
- Template it was built from: `api/ctm-webhook.js` (raw body + disabled body parser) — but see
  §4 for where it intentionally diverges.

## Session change log
- **2026-09-23** — **Messenger step 2: storage.** Step-1 tables applied + verified by Cris on SANDBOX then PROD (all 8 checks PASS, §9a). `parseMessagingEvents` + `storeRows` + one-time Graph name (token-gated, unset today) added; 200 on every signed delivery incl. DB errors; log carries counts only. `scripts/meta-sim.mjs` + a made-up staging-only `META_APP_SECRET` (Preview · `staging`) make storage testable on test.* (§10). Header, §0, §1, §2, §2a, §5, §6, §7, gaps and "where it lives" rewritten; 25 → 44 webhook tests.
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
