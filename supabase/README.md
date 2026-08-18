# Supabase back-end

The production catalogue (and, later, checkout/orders) lives in Supabase. The
offline `dev` build never touches it — it seeds the same data from `ui/demo.js`.

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

- **`../db/002_orders.sql`** — the `orders` table (RLS on, no policies).
- **`functions/create-order/`** — re-prices the cart from the catalogue, inserts
  a pending order, returns the signed PayFast fields. Called by the browser.
- **`functions/payfast-notify/`** — PayFast's ITN endpoint; verifies signature,
  validates with PayFast, checks the amount, and marks the order paid. The only
  thing that flips an order to `paid`.
- **`config.toml`** — sets `verify_jwt = false` for both functions.

### Setup

1. **Run the orders migration** — paste `db/002_orders.sql` into the SQL editor.
   One project serves both environments. The edge functions choose PayFast
   **sandbox vs live from the request origin** — `staging.wherethereslight.co.za`
   → sandbox, `wherethereslight.co.za` → live — and tag each order's `env`
   column accordingly, so test and real orders stay distinguishable.

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

- **`../db/003_subscriptions.sql`** — the `subscriptions` table (RLS on, no
  policies; a `CHECK` validates the email; `subscribe_type` is a `SMALLINT`
  checked to `IN (1, 2)`; a unique index on `(lower(email), subscribe_type)`
  de-dupes).
- **`../db/006_subscription_session.sql`** — adds the nullable `session_id`
  reference to `subscriptions` (a later migration because `sessions` only exists
  from `005_metrics.sql`).
- **`functions/subscribe/`** — validates the email, rate-limits by client IP
  **per subscribe type** (default **5 per IP per hour**, counted separately for
  each type so one doesn't lock out the other), resolves the browsing session
  from the token + hashed IP, and inserts the row. A duplicate returns
  `{ ok: true, already: true }`, which the page shows as "already on the list";
  over the limit returns `429`.
- **`../db/004_rate_limits.sql`** — the rate limiter (see below).
- **`ui/shared.js`** (inside the `//online` block) POSTs to
  `functions/v1/subscribe` with the publishable key, including the `wtl_session`
  token so the signup can be attributed to its session.

### Setup

1. Run **`db/003_subscriptions.sql`** and **`db/004_rate_limits.sql`** in the SQL
   editor (or `supabase db push`). Both are idempotent. Run
   **`db/006_subscription_session.sql`** too, after `db/005_metrics.sql` (it adds
   the `session_id` reference and needs the `sessions` table to exist).
2. Deploy the function with JWT verification off:

   ```bash
   supabase functions deploy subscribe --no-verify-jwt
   ```

   It needs no extra secrets (`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are
   provided automatically). The dev build strips the online call, so the offline
   preview just acknowledges the form without sending anything.

## Rate limiting

`db/004_rate_limits.sql` adds a small **fixed-window** rate limiter that any edge
function can use. Edge functions are stateless and may run as several instances,
so the count is kept in the database, where it is incremented atomically:

- **`rate_limits`** table — one row per `(key, window)` bucket; RLS on with no
  policies (service role only).
- **`rate_limit_hit(key, limit, window_seconds)`** — records a hit and returns
  `allowed` / `remaining` / `retry_after` in a single atomic statement, so
  concurrent callers cannot race past the limit.
- The **`rateLimit(...)` helper** the functions call. Each function carries its
  own copy (edge functions are deployed standalone, so the helpers are duplicated
  rather than shared). It **fails open** (returns `null`) if the limiter itself
  errors, so a transient database problem never blocks genuine requests.

Old buckets are harmless but accumulate; a scheduled job (e.g. pg_cron) can
purge them — see the cleanup query at the foot of `db/004_rate_limits.sql`.

## Page-visit metrics

Anonymous page-visit tracking, written only by the **`track` edge function**
(service role) — both tables are RLS on with no policies, so the browser can
neither read nor write them, and the owner reads them via the dashboard.

The raw IP is **never stored**. The function uses it only in-memory — to
geolocate the session and as a rate-limit key — and persists only a salted
SHA-256 hash, so a session can't be tied back to an address.

- **`../db/005_metrics.sql`** — two tables:
  - **`sessions`** — one anonymous browser, unique on `(token, ip_hash)`: a
    random token kept in the visitor's `localStorage` paired with the hashed IP.
    Geolocated **once**, when first recorded — coarse location plus the network
    operator (`isp` / `asn`), all best-effort and nullable.
  - **`page_visits`** — one row per page view, referencing a session.
- **`../db/007_session_isp.sql`** — adds the `isp` / `asn` columns to `sessions`
  (a later migration so a database that already ran `005` picks them up).
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
  `subscribe` (which also hashes the IP in its rate-limit key). Set **`IP_HASH_SALT`**
  as a function secret so hashes can't be brute-forced back across the small IPv4
  space — and use the **same salt** for both functions.
- **`ui/shared.js`** (inside the `//online` block) fires a fire-and-forget
  beacon to `functions/v1/track` on every page load. Metrics never block or
  affect the page; the offline `dev` build strips the call entirely.

### Setup

1. Run **`db/005_metrics.sql`** in the SQL editor (needs `db/004_rate_limits.sql`
   for the limiter). Idempotent.
2. Deploy the function with JWT verification off:

   ```bash
   supabase functions deploy track --no-verify-jwt
   ```

   Set **`IP_HASH_SALT`** to a long random secret (`supabase secrets set
   IP_HASH_SALT=…`) so IP hashes have real pre-image resistance. `GEO_API_URL` /
   `GEO_API_KEY` are optional — only to point at a different geo provider.

Both staging and production share one project, so staging visits are recorded
alongside production ones; the geolocation lets you tell them apart if needed.
