# Supabase back-end

The production catalogue, checkout/orders, mailing list, and page-visit metrics
live in Supabase. The offline `dev` build never touches it — it seeds the same
catalogue data from `ui/demo.js`.

The schema is **four migrations**: `db/001_catalog.sql` for the public,
read-only product catalogue, `db/002_sessions.sql` for everything the site
writes — `sessions` (the hub) plus every table that references it (`orders`,
`subscriptions`, `page_visits`) and the shared `rate_limits` — and, for the
books, which the site never touches at all, `db/003_transactions.sql` (the bank
ledger) and `db/004_monthly_aggregations.sql` (the month-by-month summary
derived from it). See *Bank transactions* and *Monthly aggregations* below.

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
Workspace mailbox, authenticated with an **OAuth 2.0 client + refresh token**
that the mailbox owner consented once (scope `gmail.send`) — the reliable
transport from the edge runtime. A refresh token is used **instead of a
service-account key** so this works under orgs that disable service-account key
creation (`iam.managed.disableServiceAccountKeyCreation`). One project serves
both environments, so a paid **sandbox** (staging) test order emails too — test
with an address you control.

**Google setup (once):**

1. In a Google Cloud project, **enable the Gmail API**.
2. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   (configure the consent screen as **Internal** if prompted, so the refresh
   token doesn't expire on the 7-day "testing" clock). Note the **client ID**
   and **client secret**.
3. **Consent once** as the sending mailbox (e.g. `orders@wherethereslight.co.za`)
   for the single scope `https://www.googleapis.com/auth/gmail.send`, requesting
   **offline access**, and capture the **refresh token** it returns. (The
   [OAuth 2.0 Playground](https://developers.google.com/oauthplayground/) with
   "Use your own OAuth credentials" is the quickest way; make sure the
   client's authorized redirect URI includes the Playground.)

**Function secrets:**

- `GMAIL_SENDER` — the mailbox that consented / sends (e.g. `orders@wherethereslight.co.za`).
- `GMAIL_CLIENT_ID` — the OAuth 2.0 client ID.
- `GMAIL_CLIENT_SECRET` — the OAuth 2.0 client secret.
- `GMAIL_REFRESH_TOKEN` — the refresh token from the one-time consent.
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
   - **Order email** (optional) — `GMAIL_SENDER`, `GMAIL_CLIENT_ID`,
     `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` (and optional `ORDER_EMAIL_BCC`)
     to email the buyer a notice-of-order invoice on payment. See *Notice-of-order
     email* above; unset means no email is sent.
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

## Bank transactions

The **`transactions`** table is the running bank ledger — what actually moved
through the Capitec business account, which is how much cash is really available
and how much of it is owed as tax. It is imported from the statement PDFs, not
derived from `orders`: an order is what a buyer *owes*, a transaction is money
that *arrived*, and the two do not line up (fees, transfers, refunds, cash).
Nothing in the shipped site reads or writes this table.

- **`../db/003_transactions.sql`** — the schema. RLS on with no policies, like
  everything in `002`, so only the service role touches it.
- **`functions/import-transactions/`** — the only write path. Validates every
  row and upserts with `ON CONFLICT DO NOTHING`, returning how many rows were
  actually new.
- **`../scripts/import-statement/`** — a Go program that parses a statement PDF
  locally and POSTs the parsed rows to that function.

### Why the import is idempotent

Statements overlap — a September statement repeats the last days of August — and
the same PDF gets re-downloaded. Every import is therefore an upsert against the
natural key `(transaction_date, description, amount, raw_reference)`, and the
importer reports inserted-vs-skipped so a re-run is visibly a no-op.

`raw_reference` is the statement line verbatim, **including the running
balance**, and that is what makes the key work: two genuine purchases on the same
day, for the same amount, at the same shop are identical in every other column,
and the balance is the only thing that separates them. `source_statement` is
deliberately *not* in the key, so the same transaction arriving in two different
statements still de-duplicates.

### What the parser does

The table is read by **column position**, not by splitting text. The PDF gives
every fragment an x coordinate, and the table's header row

```
Date  Description  Category  Money In  Money Out  Fee*  Balance
```

supplies an anchor for each column, so each fragment is assigned to whichever
column it sits under. The anchors are read off the header on every page rather
than hard-coded, so a layout shift moves them with it.

Positions matter because the columns cannot be told apart from the text alone:
Money In and Money Out are both plain signed amounts, and a row may carry any
combination of amount, fee and balance. It is also how a long description that
wraps onto its own line is rejoined rather than mistaken for a new row — the
wrapped fragment carries the description column's x, so it appends to the
description (and a wrapped *category* appends to the category).

Three things are worth knowing about the output:

- **Fees become their own rows.** The schema has a single `amount`, and the
  statement's `Fee*` column is a real separate debit, so a row carrying both
  yields a second transaction (`<description> (fee)`, `transaction_type` `fee`).
  That is what keeps the amounts summing back to the closing balance. A row that
  is *only* a fee — a card-issue fee, say, which posts into `Fee*` with no Money
  In or Money Out — stays one transaction, typed `fee`.
- **The rightmost number is always the balance.** Amounts are right-aligned, so a
  large enough balance starts under the `Fee*` anchor; taking the rightmost
  removes that ambiguity regardless of width.
- **The balance chain is checked.** Every row's amount plus its fee must be
  exactly the step from the previous printed balance to this one. A row that
  does not reconcile is reported as a warning rather than silently imported
  wrong — which is also the proof that the columns were assigned correctly, so a
  layout change surfaces as a warning instead of a wrong number.

**Pending card transactions are skipped**: they have not been posted to the
balance yet, and they arrive again as real rows on the next statement.

`go test ./scripts/import-statement/` covers the column logic with synthetic
rows — no statement fixture, so the tests carry no real data.

### Using it

Statements go in `data/statements/`, which is **git-ignored** — a bank statement
must never be committed. The password (Capitec uses the last four digits of the
registered mobile number) is read from an environment variable, never an
argument, so it stays out of shell history; leave it unset for an unencrypted
statement.

```bash
cd scripts/import-statement

# Parse and check, writing nothing. Do this first.
go run . --dry-run ../../data/statements/account_statement.pdf

# Import.
export IMPORT_TOKEN=…            # the function secret, below
export STATEMENT_PASSWORD=…      # only if the PDF is encrypted
go run . ../../data/statements/account_statement.pdf
```

`go build -o import-statement .` gives a standalone binary instead, which needs
no Go on the machine that runs it.

It prints the statement's totals (money in, money out, net), which should match
the summary boxes printed on page 1 — the quickest way to confirm a clean parse
— and then `inserted` / `skipped`.

`--source NAME` overrides the `source_statement` label (it defaults to the
filename); `--password-env VAR` reads the password from a different variable.
The only dependency is `github.com/ledongthuc/pdf` (BSD, no transitive deps),
which reads both AES- and RC4-encrypted statements.

### Setup

1. **Run the migration** — paste `db/003_transactions.sql` into the SQL editor
   (or `supabase db push`). Idempotent.
2. **Set the import secret.** This function is not called by the browser, so it
   has no origin allowlist; the shared secret is its only authentication, and
   while it is unset the endpoint refuses everything (`503`) — it fails closed,
   so deploying before setting the secret cannot open a write path.

   ```bash
   supabase secrets set IMPORT_TOKEN="$(openssl rand -hex 32)"
   ```

3. **Deploy with JWT verification off** (the importer holds no Supabase key):

   ```bash
   supabase functions deploy import-transactions --no-verify-jwt
   ```

Nothing here is given a service-role key: the machine running the import holds
only `IMPORT_TOKEN`, which can do exactly one thing — append statement rows.

## Monthly aggregations

`transactions` answers *what moved*. **`monthly_aggregations`** answers *what to
do with it*: one row per calendar month.

| column | meaning |
| --- | --- |
| `month` | first day of the month (the primary key) |
| `income` | the month's credits that count as income |
| `pre_deduction` | **PD** — 10% of `income`, set aside before anything else |
| `expandable_amount` | **EA** — 40% of `income` |
| `business_expenses` | the month's claimed business spending |
| `transaction_count` | every transaction in the month, claimed or not — how you tell "no income" from "never imported" |

PD and EA are **generated columns**, not stored numbers: they are by definition
functions of `income`, so deriving them in the schema is what stops them drifting
from it, and they cannot be written to. They deliberately do not add up to
`income` — the remaining 50% is simply unallocated here.

Because the rates live in the column expressions, changing one is an
`ALTER TABLE` that recomputes **every** month, history included. That is right
for a rule the owner sets, but it does mean a month cannot be pinned to the rate
that was in force at the time.

The two inputs are deliberately **asymmetric**, because the two questions differ:
income is *presumed*, a deduction must be *substantiated*.

### Income — which credits count

The statement cannot tell you: a transfer in from savings is a credit, and
counting it would inflate both the month's income and the tax set aside against
it. Each credit resolves three ways, most specific first:

1. the transaction's own **override** — `transactions.counts_as_income`, nullable
   and normally `NULL`;
2. the rule for its **bank category** in **`transaction_categories`**, matched
   case-insensitively against `transactions.category`;
3. the **default** — a credit *is* income.

Default-in with named exceptions is what keeps this from being busywork: on a
small business account the exceptions are one or two categories, named once,
rather than a decision on every deposit.

```sql
INSERT INTO transaction_categories (category, counts_as_income, note)
VALUES ('Transfer', FALSE, 'own-account movement / owner draw');
```

The override is for where a category is too blunt, since the category comes from
the bank and cannot be edited to carve one row out:

```sql
UPDATE transactions SET counts_as_income = FALSE WHERE id = 123;
```

### Business expenses — a claim, with its proof

Nothing is deductible until it is **claimed**. A row in **`business_expenses`**
is the assertion "this payment was a business expense, and here is what backs it
up", and the month's total is the sum of those rows — never inferred from a
description or a bank category, so it never has to be guessed at.

```sql
INSERT INTO business_expenses
  (transaction_id, purpose, expense_type, supplier, invoice_number, invoice_date, proof_url)
VALUES
  (412, 'Mountboard and glass for the January print run', 'materials',
   'Art Supplies CC', 'INV-2026-0041', '2026-01-11', 'https://…/inv-41.pdf');
```

| column | meaning |
| --- | --- |
| `transaction_id` | the payment claimed — `UNIQUE`, so nothing is claimed twice, and `ON DELETE CASCADE`, since a claim against a deleted transaction is meaningless |
| `purpose` | what the money was for — **required** |
| `deductible_amount` | apportionment for a partly-business cost; `NULL` (the normal case) claims the whole payment |
| `expense_type` | kind of expense, for grouping at tax time — free text |
| `supplier`, `invoice_number`, `invoice_date`, `proof_url` | the supporting document; `invoice_date` is separate because an invoice is often dated before the payment clears |
| `note` | anything else worth recording |

`purpose` is `NOT NULL` on purpose: what the money was for is the one thing a
deduction cannot be defended without, and the thing that is impossible to
reconstruct a year later — so it is required while it is still known.
`proof_url` left `NULL` means the claim is made but the paperwork is not filed
yet, which is worth querying for before year end:

```sql
SELECT t.transaction_date, t.description, b.purpose
  FROM business_expenses b JOIN transactions t ON t.id = b.transaction_id
 WHERE b.proof_url IS NULL ORDER BY t.transaction_date;
```

Two rules a `CHECK` cannot express are enforced by a row trigger, because both
need the referenced transaction: only **money out** can be claimed (a refund
arrives as a credit, but that reduces an existing claim rather than being one),
and `deductible_amount` can never exceed the payment.

The claim carries no date of its own — the expense belongs to the month the money
moved, like everything else here.

### How it stays current

Nothing has to be run after an import. **`db/004_monthly_aggregations.sql`** puts
statement-level triggers on `transactions` and on `business_expenses`
(insert / update / delete / truncate) that recompute exactly the months affected
— including *both* months when a transaction's date moves across a boundary, or
when a claim is re-pointed at a transaction in another month — plus a trigger on
`transaction_categories` that rebuilds everything, since reclassifying a category
rewrites history.

They are **statement**-level rather than row-level on purpose: an import writes a
whole statement in one `INSERT`, and a row-level trigger would recompute the same
month once per row. A re-imported statement where every row already exists
inserts nothing and therefore refreshes nothing.

The whole maintenance path is one idempotent function, so a rebuild by hand is
the same code the triggers run:

```sql
SELECT refresh_monthly_aggregations();                           -- every month
SELECT refresh_monthly_aggregations(ARRAY['2026-01-01'::date]);  -- just January
```

It both upserts months that have transactions and deletes months that no longer
do, so removing the last transaction in a month removes its row rather than
leaving a stale one behind.

### Setup

1. **Run the migration** — paste `db/004_monthly_aggregations.sql` into the SQL
   editor (or `supabase db push`), after `db/003_transactions.sql`. Idempotent,
   and it ends by backfilling every month already in the ledger, so an existing
   ledger is summarised the moment it runs.
2. **Classify and claim as you go** — nothing is required up front. Add
   `transaction_categories` rows as you meet credits that are not income, and a
   `business_expenses` row for each payment you intend to deduct.

All three tables are RLS on with no policies, like the ledger they derive from.
There is no edge function and no import path: the site never touches them, and
the owner reads and writes them from the dashboard.

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
