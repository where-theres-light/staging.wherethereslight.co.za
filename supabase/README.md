# Supabase back-end

The production catalogue, checkout/orders, mailing list, and page-visit metrics
live in Supabase. The offline `dev` build never touches it — it seeds the same
catalogue data from `ui/demo.js`.

The schema is **two migrations**: `db/001_catalog.sql` for the public,
read-only product catalogue, and `db/002_sessions.sql` for everything else —
`sessions` (the hub) plus every table that references it (`orders`,
`subscriptions`, `page_visits`) and the shared `rate_limits`.

## Sessions (the hub)

`sessions` is the single home for everything describing a visitor's browser: the
client token, the salted **IP hash**, the **environment** (`sandbox` for the
staging origin, `live` for production), the user agent, the coarse geolocation,
and the ISP / network (`isp` / `asn`). None of that is duplicated onto the other
tables — they carry a `session_id` and read those attributes through it:

- **`orders`** — `NOT NULL`, `ON DELETE RESTRICT` (an order is always tied to a
  session, which cannot be purged while the order exists — so the order's env is
  always reachable).
- **`subscriptions`** — nullable, `ON DELETE SET NULL` (best-effort link).
- **`page_visits`** — `NOT NULL`, `ON DELETE CASCADE` (visits die with their session).

`rate_limits` is the one exception: it is infrastructure keyed by the transient
IP hash (never a stored session column), so a client can't reset its allowance by
rotating its session token — it does **not** reference `sessions`.

A session is written by `track` on every page visit, and resolved-or-created by
`create-order` too, so an order always has one. All of `db/002_sessions.sql` is
service-role only (RLS on, no policies); the edge functions are the only write path.

## Catalogue

The catalogue is **public, read-only** data, served **straight from the Supabase
REST API** (PostgREST) — no edge function.

- **`../db/001_catalog.sql`** — schema + seed for the catalogue
  (`categories`, `category_tiers`, `print_editions`, `products`,
  `product_variants`). Each table has RLS enabled with a permissive `SELECT`
  policy and `SELECT` granted to `anon`/`authenticated`; no write access.
- **`ui/shared.js`** (inside the `//online` block) fetches the tables directly
  with the publishable key and reshapes them into the `demo.js` shape.

### Setup (once the project exists)

1. **Run the schema + seed.** Paste `db/001_catalog.sql` into the Supabase SQL
   editor and run it (or `supabase db push` with the CLI). It is idempotent
   (`CREATE ... IF NOT EXISTS`, `DROP POLICY IF EXISTS` + `CREATE POLICY`,
   `INSERT ... ON CONFLICT DO NOTHING`).
2. **Point the site at the project.** In `ui/shared.js` (`//online` block), set
   `SUPABASE_URL` → `https://<project-ref>.supabase.co` and `SUPABASE_ANON` →
   the project's **publishable** key. These are public and ship in the
   production bundle; until they are set the catalogue fetch is a guarded no-op.

No CORS setup is needed — the Supabase REST API sends permissive CORS headers.
The reshaped payload matches `ui/demo.js` exactly, so the site renders the same
whether the data came from Supabase (prod) or the demo seed (dev).

## Checkout (guest, PayFast)

Orders are **user data** — restrictive RLS, no public policies — written only by
the edge functions (service role). Buyers check out as guests (no login).

- **`../db/002_sessions.sql`** — defines the `orders` table (RLS on, no policies),
  which references `sessions`. There is **no `env` column on orders** — the env
  lives on the order's session (see *Sessions* above).
- **`functions/create-order/`** — re-prices the cart from the catalogue, resolves
  or creates the browsing session (tagging it with the env from the origin),
  inserts a pending order tied to that session, and returns the signed PayFast
  fields. Called by the browser.
- **`functions/payfast-notify/`** — PayFast's ITN endpoint; verifies signature,
  validates with PayFast, checks the amount, and marks the order paid. The only
  thing that flips an order to `paid`. On that first transition it also sends the
  buyer the **notice-of-order email** (see below).
- **`config.toml`** — sets `verify_jwt = false` for both functions.

### Notice-of-order email (Gmail API)

When `payfast-notify` marks an order `paid` for the first time it emails the
buyer an **HTML invoice** (an order confirmation / receipt — the business is not
VAT-registered, so it is not a tax invoice). The send:

- is built from the stored order snapshot (`items`, `subtotal`, `shipping`,
  `amount`, buyer + shipping details), so nothing is recomputed;
- fires **once** — the `already paid` guard short-circuits repeat ITNs;
- is **best-effort** — any mail failure is logged and swallowed, never failing
  the ITN (the order is paid regardless);
- **no-ops silently** unless the `GMAIL_*` secrets below are set, so checkout
  works before email is wired up.

Mail is sent through the **Gmail API** (pure HTTPS, no SMTP) as a Google
Workspace mailbox, using a **service account with domain-wide delegation** —
the reliable transport from the edge runtime. One project serves both
environments, so a paid **sandbox** (staging) test order emails too — test with
an address you control.

**Google setup (once):**

1. In a Google Cloud project, **enable the Gmail API** and create a **service
   account** with a **JSON key**.
2. In **Workspace Admin → Security → API controls → Domain-wide delegation**,
   authorize that service account's client ID for the single scope
   `https://www.googleapis.com/auth/gmail.send`.
3. Choose a real mailbox to send as, e.g. `orders@wherethereslight.co.za`
   (the service account impersonates it).

**Function secrets:**

- `GMAIL_SENDER` — the mailbox to send as (e.g. `orders@wherethereslight.co.za`).
- `GMAIL_SA_EMAIL` — the service account's email address.
- `GMAIL_SA_PRIVATE_KEY` — the service account's PEM private key (`\n` escaped is
  fine; the function un-escapes it).
- `ORDER_EMAIL_BCC` — optional; BCC a copy of every order email here.

### Setup

1. **Run the migration** — paste `db/002_sessions.sql` into the SQL editor (it
   defines `orders` and its `sessions` hub). One project serves both
   environments. The edge functions choose PayFast **sandbox vs live from the
   request origin** — `staging.wherethereslight.co.za` → sandbox,
   `wherethereslight.co.za` → live — and tag the order's **session** with that
   env, so test and real orders stay distinguishable and `payfast-notify`
   verifies each against the right PayFast.

2. **Set function secrets** (Project → Edge Functions → Secrets, or
   `supabase secrets set`):
   - **Sandbox** (staging origin) — optional; defaults to PayFast's public
     sandbox merchant if unset: `PF_SANDBOX_MERCHANT_ID`,
     `PF_SANDBOX_MERCHANT_KEY`, `PF_SANDBOX_PASSPHRASE`.
   - **Live** (prod origin): `PF_MERCHANT_ID`, `PF_MERCHANT_KEY`, `PF_PASSPHRASE`.
     Until these are set, checkout from the production origin returns "Payments
     are not configured" (staging keeps working on the sandbox defaults).
   - `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are provided automatically.
   - Return/cancel URLs are derived from the request origin — no `SITE_URL` needed.
   - **Order email** (optional) — `GMAIL_SENDER`, `GMAIL_SA_EMAIL`,
     `GMAIL_SA_PRIVATE_KEY` (and optional `ORDER_EMAIL_BCC`) to email the buyer a
     notice-of-order invoice on payment. See *Notice-of-order email* above; unset
     means no email is sent.
3. **Deploy the functions with JWT verification off** (or toggle "Verify JWT"
   off for both in the dashboard):

   ```bash
   supabase functions deploy create-order   --no-verify-jwt
   supabase functions deploy payfast-notify  --no-verify-jwt
   ```

4. **Test from staging** end-to-end (add to cart → checkout → PayFast sandbox →
   ITN marks the order `paid`). When ready, set the live credentials and
   production checkout goes live automatically — no flag to flip.

The browser calls these with the publishable key; `create-order` recomputes the
price server-side, so a tampered cart can never change what is charged.

## Mailing-list subscriptions

Two places collect emails into the `subscriptions` table: the footer's **"Signup
for future communication"** link (`subscribe.html`) and the **"Notify me when
available"** button on the Upcoming page. Like orders, the table is **not
writable with the publishable key** (RLS on, no public policies) — every
subscribe goes through the **`subscribe` edge function**, which writes as service
role. Routing it through a function is what makes it **rate-limited**: the
browser has no write path that skips the limiter, and the address list can never
be read back from the client (only via the dashboard / service role).

Each row records **what** was subscribed to via `subscribe_type`:

- **`1`** — future communication (the footer general list).
- **`2`** — "Grasse van die Veld" availability notification (the Upcoming button).

Uniqueness is per `(email, subscribe_type)`, so one person can be on the general
list and request the Grasse notification independently; a repeat of the same
type is reported as "already on the list".

Each signup is also tied back to the **browsing session** it came from (the
metrics `sessions` row — see *Page-visit metrics* below), via a nullable
`session_id` foreign key, so the owner can see where a signup originated (coarse
location, user agent, first/last seen) without any raw IP on the subscription.
The browser sends the same per-browser metrics token, the function resolves the
session by `(token, ip_hash)` — the same key `track` uses — and the link is
best-effort: it stays null if no matching session is on record yet.

- **`../db/002_sessions.sql`** — defines the `subscriptions` table (RLS on, no
  policies; a `CHECK` validates the email; `subscribe_type` is a `SMALLINT`
  checked to `IN (1, 2)`; a unique index on `(lower(email), subscribe_type)`
  de-dupes; a nullable `session_id` references `sessions`).
- **`functions/subscribe/`** — validates the email, rate-limits by client IP
  **per subscribe type** (default **5 per IP per hour**, counted separately for
  each type so one doesn't lock out the other), resolves the browsing session
  from the token + hashed IP, and inserts the row. A duplicate returns
  `{ ok: true, already: true }`, which the page shows as "already on the list";
  over the limit returns `429`.
- **`ui/shared.js`** (inside the `//online` block) POSTs to
  `functions/v1/subscribe` with the publishable key, including the `wtl_session`
  token so the signup can be attributed to its session.

### Setup

1. Run **`db/002_sessions.sql`** in the SQL editor (or `supabase db push`) if you
   have not already — it defines `subscriptions`, its `sessions` hub, and the
   `rate_limits` limiter. Idempotent.
2. Deploy the function with JWT verification off:

   ```bash
   supabase functions deploy subscribe --no-verify-jwt
   ```

   It needs no extra secrets (`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are
   provided automatically). The dev build strips the online call, so the offline
   preview just acknowledges the form without sending anything.

## Rate limiting

`db/002_sessions.sql` includes a small **fixed-window** rate limiter that any edge
function can use. Edge functions are stateless and may run as several instances,
so the count is kept in the database, where it is incremented atomically:

- **`rate_limits`** table — one row per `(key, window)` bucket, keyed by the
  transient IP hash (**not** the session, so a rotated token can't reset the
  limit); RLS on with no policies (service role only).
- **`rate_limit_hit(key, limit, window_seconds)`** — records a hit and returns
  `allowed` / `remaining` / `retry_after` in a single atomic statement, so
  concurrent callers cannot race past the limit.
- The **`rateLimit(...)` helper** the functions call. Each function carries its
  own copy (edge functions are deployed standalone, so the helpers are duplicated
  rather than shared). It **fails open** (returns `null`) if the limiter itself
  errors, so a transient database problem never blocks genuine requests.

Old buckets are harmless but accumulate; a scheduled job (e.g. pg_cron) can
purge them — see the cleanup query at the foot of `db/002_sessions.sql`.

## Page-visit metrics

Anonymous page-visit tracking, written only by the **`track` edge function**
(service role) — both tables are RLS on with no policies, so the browser can
neither read nor write them, and the owner reads them via the dashboard.

The raw IP is **never stored**. The function uses it only in-memory — to
geolocate the session and as a rate-limit key — and persists only a salted
SHA-256 hash, so a session can't be tied back to an address.

- **`../db/002_sessions.sql`** — defines both:
  - **`sessions`** — one anonymous browser, unique on `(token, ip_hash)`: a
    random token kept in the visitor's `localStorage` paired with the hashed IP,
    tagged with its `env`. Geolocated **once**, when first recorded — coarse
    location plus the network operator (`isp` / `asn`), all best-effort and nullable.
  - **`page_visits`** — one row per page view, referencing a session.
- **`functions/track/`** — pairs the token with the client IP, rate-limits by
  (hashed) IP (**100 visits per IP per 10 min**), geolocates the IP on the
  session's first sight, and appends the visit storing only `ip_hash`. A
  returning session just bumps `last_seen`. Requests whose **User-Agent** looks
  like a bot/crawler (search engines, link-preview unfurlers, uptime monitors,
  headless automation — the `BOT_UA_RE` denylist) are dropped up front with a
  `200 { ok: true, bot: true }` and never recorded, so the metrics count real
  human visits. This is metrics-only filtering: the site is static Pages, so
  crawlers still load every page and **SEO is unaffected**.
- The **`geolocate(...)` helper** inside `functions/track/index.ts` — the IP →
  location lookup. Uses **ipapi.co** (free, no key) by default; override with the
  `GEO_API_URL` / `GEO_API_KEY` function secrets. It is best-effort — any failure
  or a private/unknown IP just stores the session without a location.
- The **`hashIp(...)` helper** — the salted-SHA-256 IP hash, duplicated in
  `subscribe` and `create-order` (both resolve the session by `(token, ip_hash)`,
  and `subscribe` also hashes the IP in its rate-limit key). Set **`IP_HASH_SALT`**
  as a function secret so hashes can't be brute-forced back across the small IPv4
  space — and use the **same salt** for all three functions, or the hashes won't
  match and sessions won't resolve.
- **`ui/shared.js`** (inside the `//online` block) fires a fire-and-forget
  beacon to `functions/v1/track` on every page load. Metrics never block or
  affect the page; the offline `dev` build strips the call entirely.

### Setup

1. Run **`db/002_sessions.sql`** in the SQL editor if you have not already — it
   defines `sessions`, `page_visits`, and the limiter. Idempotent.
2. Deploy the function with JWT verification off:

   ```bash
   supabase functions deploy track --no-verify-jwt
   ```

   Set **`IP_HASH_SALT`** to a long random secret (`supabase secrets set
   IP_HASH_SALT=…`) so IP hashes have real pre-image resistance — the **same**
   salt across `track`, `subscribe`, and `create-order` so sessions resolve.
   `GEO_API_URL` / `GEO_API_KEY` are optional — only to point at a different geo provider.

Both staging and production share one project, so staging visits are recorded
alongside production ones; the geolocation lets you tell them apart if needed.
