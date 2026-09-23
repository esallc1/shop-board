# How the Meta / Facebook webhook is wired

> Doc: `/docs/wiring/meta-webhook.md`
> Last updated: 2026-09-23 — **LIVE END-TO-END TEST PASSED on prod** (§8b): a real Messenger message
> from Cris's personal account was stored, named, answered from the tray and delivered; a Business
> Suite reply came back as an echo. App switched to **Live** mode; Page + fields subscribed (§2a).
> Verified vs commit `0e644cc` (prod build running during the live test, 2026-09-23).
> Status: 🟢 **LIVE ON PROD, receiving and sending real Messenger traffic** — for people with a role on
> the app only, until App Review approves `pages_messaging` (§2a).
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

**Also exists (step 3):** `api/messenger.js` — the tray's server half: reply (Send API),
link / unlink a customer, done (§11). Staff only.

**Does not exist yet, on purpose (later steps of the Messenger → Advisor tray):**
- no UI — no board reads these tables or calls `api/messenger.js` yet (tray = steps 4–5)
- no after-hours auto-reply, no Instagram, no Lead Ads, no push/sound
- no attachment FILES — only their metadata and Meta's (expiring) link
- phone calls are not touched: `calls`, the call card, the Desk are unchanged

## 2. The Meta app
| | |
|---|---|
| App name | Lee Transmission CrisData |
| App ID | `1075837401512965` |
| Mode | **Live** (since 2026-09-23 — Development mode gets no real webhooks at all, §2a) |
| Page | `821690607890680` (`SHOP_PAGE_ID`; `META_PAGE_ID` env overrides) |
| Business portfolio | `152510169083601` — business verified 2026-09-11, app attached 2026-09-15 |
| Prod callback URL | `https://www.leetransmissionshop.com/api/meta-webhook` |

The app itself is configured by hand in Meta's dashboard — there is no code in
this repo that creates or changes it.

### 2a. Its dashboard state as of 2026-09-23 — what is on, and what still gates real customers
Set up by Cris on 2026-09-23, just before the live test (§8b):

- **The Page is subscribed to the app:** `POST /821690607890680/subscribed_apps` with
  `subscribed_fields=messages,message_echoes` → success. Without this, field subscriptions alone
  deliver nothing.
- **Webhook fields `messages` + `message_echoes` are Subscribed** on the Page object.
- **App Mode = Live.** ⚠ Correction of an earlier assumption (in this doc's plan and in chat): a
  **Development-mode app gets NO production webhooks — not even for admins or testers.** Meta's
  dashboard says so, and it held in practice. Live mode was required for the first real message.
- **Live mode with unapproved permissions = role-holders only.** `pages_messaging` has not been
  through App Review, so Meta delivers (and lets us reply to) only people with a role on the app
  (Cris). **A real customer messaging the Page still produces no delivery** until App Review
  approves `pages_messaging` (Advanced Access). That, not our code, is the remaining gate.
- **Business verification is DONE** (corrected 2026-09-23 — this line used to
  say the portfolio was blocked). EL SHADDAI AUTO LLC was verified by Meta on
  2026-09-11, and the app was attached to that verified business portfolio
  (`152510169083601`) on 2026-09-15.

Taken together: today this endpoint receives real Messenger traffic from role-holders, Meta's
dashboard tests, and anyone who guesses the URL. The last is why §4 enforces — an unsigned POST
would otherwise be a way to write rows.

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
| `META_PAGE_ACCESS_TOKEN` | **set 2026-09-23** by Cris — **proven live** the same day (§8b: name lookup + a delivered reply) — type Secret, Production only; a never-expiring **Page** token for Page `821690607890680` (Meta Access Token Debugger: Type = Page, Expires = Never). Used by the Send API (§11b) and the name lookup (§9d). ⚠ **Corrected the same day:** the first value saved was Cris's personal **user** token by mistake (baked into build `84c3710`); he edited it to the Page token and the next Production build replaced it. If replies ever fail with code 190 or "(#200)"-type permission errors, first check the token's **Type** in the Access Token Debugger. | **unset** — staging stays `dry-run` and never looks up names |
| `META_SEND_MODE` | **must stay unset** (a `dry-run` here is refused, §11c) | `dry-run` (set 2026-09-23) — replies are stored, never sent |
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

### 8b. The live end-to-end test — 2026-09-23, ~8:03–8:10am, prod build `0e644cc`
Cris's **personal Facebook account** (a role-holder) → Page `821690607890680`, app in **Live** mode,
Page + `messages` / `message_echoes` subscribed (§2a). All three **PASS**:

| # | What Cris did | What CrisData did | Proves |
|---|---|---|---|
| 1 | Sent "Test 1 from Cris" in Messenger | The advisor tray **auto-opened**; the thread was named **"Cristian Mendez"**; the chip read "23h left to reply" | a real signed delivery is accepted and stored (§4, §9); the one-time Graph name lookup works — i.e. the **Page token works** (§9d); realtime auto-open (tray) |
| 2 | Replied from the tray: "Hi Cris, this is CrisData replying" | It **arrived in his Messenger from the Page**; the tray shows it as **"CrisData · Cristian"** | `api/messenger.js` → Send API with the Page token, `messaging_type RESPONSE` inside the 24 h window (§11b) |
| 3 | Replied in **Business Suite**: "Reply from Business Suite" | It appeared in the tray marked **"via Facebook app"** | `message_echoes` delivery → `source page_inbox` (§9b) |

No token value or message text was logged or recorded. The earlier user-token mix-up (§6) was
already corrected by then (build `0e644cc`).

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
- **`last_inbound_received_at`** (added by `migrations/20260923_social_inbound_received_*.sql`):
  `social_record_message` stamps it `= greatest(it, now())` for every NEW inbound message — even a
  late delivery whose Meta timestamp is older — and never for a re-delivery, an echo or our send.
  Backfilled from `last_inbound_at`. **Applied + verified 9/9 on SANDBOX and PROD (Cris, 2026-09-23).**
  The tray's waiting rule uses it ([[messenger-tray]] §2);
  `last_inbound_at` still drives the 24 h window. Locked by
  `shared/social-inbound-received-migration.test.js`.

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
(staging) → skipped quietly, no name; the tray shows "Facebook user" until linked. **Proven on prod
2026-09-23 (§8b):** Cris's first real message named the thread "Cristian Mendez".
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

### 10a. Proven on the sandbox — 2026-09-23 (Cris, by SQL)
Sim run PSID `SIM_1790157796920` against test.* at `cf12564` → **1 thread, 3 rows**:
`m_sim_…_1` in/customer, `m_sim_…_2` in/customer, `m_sim_…_3` out / `is_echo` / **page_inbox**
(`app_id` `263902037430900`). `last_inbound_at` = message 2's time (**the echo did not move it**),
`last_message_at` = the echo's time; `display_name`, `done_at`, `customer_id` all null. The
re-delivery of #1 added nothing (function log: `inserted:0, duplicate:1`); the unsigned copy 403'd.

## 11. The tray's actions — `api/messenger.js` (step 3)
`POST { action, thread_id, … }`, one endpoint. **No board calls it yet** (steps 4–5).

### 11a. Who — `requireUser(req)` first
The bearer token is checked by Supabase (`GET /auth/v1/user`, never parsed here), then must map to
**exactly one ACTIVE `employees` row** (`api/_lib/require-user.js`). No token, junk, a KiKi login
(valid session, no employees row), an inactive employee → flat `401`, before the body is read and
before any `social_*` / `customers` read. Any active office role passes (Cris, 2026-09-23). Then
every read and write uses the service-role key.

### 11b. `reply` — `{ text }` (trimmed, 1–2000 chars)
1. Load the thread; `404` if missing.
2. **Window** (`replyWindow`): open only if `now < last_inbound_at + 24h`. Closed (or no customer
   message at all) → `409 window_closed` with a plain-English reason — **before Meta is called,
   nothing stored**.
3. Send: `POST graph.facebook.com/v26.0/<page_id>/messages`, `{recipient:{id:psid},
   messaging_type:'RESPONSE', message:{text}}`, Page token in the **Authorization header**, 8 s
   timeout. No token → `503 not_connected` ("Facebook isn't connected to CrisData yet … Nothing
   was sent"), nothing stored.
4. Sent → stored via `social_record_message` with Meta's `message_id` as the mid, `source
   crisdata`, `app_id` CrisData, `sent_by` = the employee, `send_status sent`. If Meta's echo
   landed first, the writer only fills `sent_by`/`send_status` (§9a). If the store fails after a
   good send → `200` + a warning; the echo will add the row (without `sent_by`).
5. Refused → stored as **`send_status failed`** + the advisor-facing message in `send_error`,
   under a **`local:<uuid>`** mid; `502 send_failed` (or `token_expired` for **code 190**:
   "Facebook connection expired … Tell Cris to reconnect Facebook"). Code 10/2018278 (outside the
   window) and 551 (person unavailable) get their own wording (`metaErrorMessage`). Network
   failure → failed, worded "may not have been sent — check Messenger". **No automatic retry.**
6. The thread row is never touched by a reply.

### 11c. Dry run — staging only
`META_SEND_MODE=dry-run` (Preview · `staging`): steps 1–2 and the write run for real, with a fake
`dryrun:<uuid>` mid and `send_status sent`; **Meta is never called, even if a token is set**.
On a Production deployment (`VERCEL_ENV=production`) a dry-run setting is refused with `500
misconfigured` and nothing is stored — a stray env var can't make prod pretend to send.

### 11d. `link` — `{ customer_id }` (uuid, or `null` to unlink)
The customer must exist (`404`) and must not be archived / merged (`409 customer_archived` with
`merged_into` = the survivor) — `isArchived` / `mergedIntoId` from `shared/customer-archive.js`,
the same rule the board's pickers use; a project without the merge columns (42703) falls back to
`id,name`. Then `PATCH social_threads` with **exactly** `customer_id`, `linked_at`, `linked_by`.
Unlink sets those three to null. No other column.

### 11e. `done`
`PATCH` **exactly** `done_at = now`, `done_by = the employee`. A newer customer message brings
the thread back by being newer (`last_inbound_at > done_at`) — nothing clears `done_at`.

### 11f. Proven signed-in on staging — 2026-09-23
Cris signed in on test.* as **ZZ Test Advisor** in Claude's browser pane; Claude ran the actions
from the advisor board's console with `cdAuthFetch` against thread `SIM_1790158332828`. All
**PASS**: staff read of the thread (1 row — proves `staff_read` works for a real session); dry-run
reply `200` (`dryrun:` mid, `send_status sent`, `sent_by` = the ZZ employee, source `crisdata`);
link to JDPR Construction `200` (only `customer_id`/`linked_at`/`linked_by` changed); done `200`
(only `done_at`/`done_by`). Afterwards: 4 messages on the thread, `last_inbound_at` unchanged
(message 2), `last_message_at` moved to the reply.

## Known gaps & open questions (as of 2026-09-23)
- **A delivery that fails to store is lost.** We 200 to keep the subscription alive, so Meta
  won't resend; only the log line's `errors` count shows it. A `meta_webhook_log` table (like
  CTM's) is the fix if this ever bites.
- **Real customers can't reach it yet — App Review.** Live mode + unapproved `pages_messaging` =
  role-holders only (§2a). Until App Review approves it, a customer's message to the Page is never
  delivered, and we can't reply to them. The recording for App Review can be made now (§8b is that
  flow).
- **Attachment links expire** (Meta CDN). Only metadata is kept; copying files is a later slice.
- **If the Page token ever dies** (password change, permission removed), replies fail with code
  190 → "Facebook connection expired — tell Cris", and new threads stop getting names. Check the
  token's Type/Expiry in Meta's Access Token Debugger first (§6).
- **Prod now holds real rows** — Cris's own test conversation. Delete it by hand if it shouldn't
  stay (deleting the `social_threads` row cascades to its messages).
- **No "un-done".** Done can only be undone by a new customer message. Add an action if the tray
  needs one.
- **A failed send stays in the thread** (as failed) and moves `last_message_at`. No retry
  button yet — the advisor retypes.
- **Test files under `api/` deploy as functions** (`/api/meta-webhook.test` answers 500 on prod)
  — pre-existing for all `api/*.test.js`, flagged separately; not specific to this endpoint.

## Where it lives in the code
- `api/meta-webhook.js` — the endpoint. Exports: `default handler`, `verifyMetaSignature`,
  `verifyHandshake`, `summarizeMetaPayload`, `parseMessagingEvents`, `storeRows`,
  `SHOP_PAGE_ID`, `CRISDATA_APP_ID`, and `config = { api: { bodyParser: false } }`.
- `api/meta-webhook.test.js` (25 tests — handshake + signature) and
  `api/meta-webhook-store.test.js` (19 tests — parse, store, name, handler end to end). Run with
  `npm test`, i.e. `node --test 'api/*.test.js' 'api/_lib/*.test.js' 'shared/*.test.js'`.
- `api/messenger.js` (+ `api/messenger.test.js`, 22 tests) — reply / link / done (§11). Exports
  `default handler`, `replyWindow`, `parseBody`, `metaErrorMessage`, `WINDOW_MS`, `MAX_TEXT`.
- `migrations/20260923_social_messaging_{SANDBOX,PROD}.sql` (+ `shared/social-messaging-migration.test.js`).
- `scripts/meta-sim.mjs` — the signed-delivery simulator (§10). `scripts/` is in `.vercelignore`.
- Route: Vercel maps `api/*.js` by filename; `vercel.json` has no rewrite over `/api/*`.
- Template it was built from: `api/ctm-webhook.js` (raw body + disabled body parser) — but see
  §4 for where it intentionally diverges.

## Session change log
- **2026-09-23** — **§8b LIVE END-TO-END TEST PASSED** (~8:03–8:10am, prod `0e644cc`, Cris's personal account): inbound stored + auto-open + named "Cristian Mendez" (Page token works); tray reply delivered to his Messenger ("CrisData · Cristian"); Business Suite reply → "via Facebook app" (echoes work). §2/§2a: Page subscribed (`subscribed_apps` messages,message_echoes), fields Subscribed, **App Mode Live**; corrected the assumption that dev mode delivers to role-holders — it delivers nothing. Remaining gate: App Review for `pages_messaging`. §6 token proven; gaps updated.
- **2026-09-23** — §6 correction: the first `META_PAGE_ACCESS_TOKEN` value was a personal **user** token (in build `84c3710`); Cris edited it to the verified **Page** token (Production only). This docs commit is the fresh Production build that bakes in the corrected value. No value recorded anywhere.
- **2026-09-23** — §6: `META_PAGE_ACCESS_TOKEN` set by Cris on Production only (Secret; never-expiring Page token for `821690607890680`, verified in Meta's Access Token Debugger). This docs commit is the fresh Production build that bakes it in. Not yet exercised (fields unsubscribed; no real reply).
- **2026-09-23** — `20260923_social_inbound_received_*` applied + verified 9/9 on SANDBOX then PROD (Cris). Prod code `bc52dd2`.
- **2026-09-23** — §9a: `last_inbound_received_at` (arrival time) added to the writer via `20260923_social_inbound_received_*` — the sent-before-Done fix. Webhook code unchanged.
- **2026-09-23** — §11f: step 3 verified signed-in on test.* (read / dry-run reply / link / done all PASS, only-own-columns confirmed). The tray that consumes these tables now has its own doc: [[messenger-tray]].
- **2026-09-23** — **Messenger step 3: `api/messenger.js`** (§11): staff-only reply (24h window checked server-side before Meta; Send API RESPONSE; failed sends stored as failed under `local:`; 190 → "connection expired"; no token → 503), link/unlink (archive rule), done — each writes only its own columns. `META_SEND_MODE=dry-run` set on Preview · `staging` only; refused on Production. §10a records Cris's sandbox verification of step 2.
- **2026-09-23** — shipped as `49cd111` (staging, then fast-forward `main`). Live checks on test.*, www, board., apex: `/api/messenger` no-token/junk-token POST `401`, GET `405`; `/CLAUDE.md` `404` everywhere; `meta-webhook.md` byte-identical; unsigned webhook POST still `403`. A signed-in reply/link/done on test.* is Cris's check (no ZZ session available to Claude).
- **2026-09-23** — **Messenger step 2: storage.** Step-1 tables applied + verified by Cris on SANDBOX then PROD (all 8 checks PASS, §9a). `parseMessagingEvents` + `storeRows` + one-time Graph name (token-gated, unset today) added; 200 on every signed delivery incl. DB errors; log carries counts only. `scripts/meta-sim.mjs` + a made-up staging-only `META_APP_SECRET` (Preview · `staging`) make storage testable on test.* (§10). Header, §0, §1, §2, §2a, §5, §6, §7, gaps and "where it lives" rewritten; 25 → 44 webhook tests.
- **2026-09-23** — shipped as `cf12564` (staging, then fast-forward `main`). Sim on test.*: 5/5 PASS; the staging function log shows `inserted:1` ×3 then the re-delivery `inserted:0, duplicate:1`, unsigned `403`. Prod probes: unsigned POST `403`, POST signed with the STAGING secret `403`, wrong verify token `403`, unknown route `404`; zero prod webhook log lines in the prior 48h (fields unsubscribed).
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
