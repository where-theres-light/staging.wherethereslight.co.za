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

## Mailing-list signups

The footer's **"Signup for future communication"** link (`signup.html`) writes an
email into a **write-only** table — RLS on, an INSERT-only policy, no SELECT
policy — filled straight from the browser with the publishable key (no edge
function). Anyone may add their own address, but the list can never be read back
from the client, only via the dashboard / service role.

- **`../db/003_signups.sql`** — the `signups` table (RLS on; `INSERT` granted to
  `anon`/`authenticated` with a policy that validates the email; no read policy).
  A unique index on `lower(email)` de-dupes; a repeat signup returns 409, which
  the page shows as "already on the list".
- **`ui/shared.js`** (inside the `//online` block) inserts with
  `Prefer: return=minimal`, so the write needs no SELECT grant.

### Setup

Run the migration — paste `db/003_signups.sql` into the SQL editor (or
`supabase db push`). It is idempotent (`CREATE ... IF NOT EXISTS`,
`DROP POLICY IF EXISTS` + `CREATE POLICY`). No secrets and no function to deploy;
it uses the same public `SUPABASE_URL` / publishable key already in `shared.js`.
The dev build strips the insert, so the offline preview just acknowledges the
form without sending anything.
