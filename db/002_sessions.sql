-- Sessions and everything tied to them: the one migration for all user /
-- session data. The catalogue (public, read-only product info) lives on its own
-- in db/001_catalog.sql; this file holds the rest.
--
-- `sessions` is the hub. It is the single home for everything that describes the
-- visitor's browser and context — the client token, the salted IP hash, the
-- environment (sandbox vs live), the user agent, the coarse geolocation, and the
-- ISP / network. Nothing that describes the session is duplicated onto the
-- tables below; they reference the session and read those attributes through it.
--
-- Referencing `sessions`:
--   • page_visits   — one row per page view          (NOT NULL, ON DELETE CASCADE)
--   • orders        — a guest checkout                (NOT NULL, ON DELETE RESTRICT)
--   • subscriptions — a mailing-list signup (best-effort link, ON DELETE SET NULL)
--
-- `rate_limits` is the one exception: it is infrastructure, not session data, and
-- is keyed by the transient IP hash (never a stored session column) so a client
-- cannot reset its allowance by rotating its session token. It does not reference
-- `sessions`.
--
-- Everything here is service-role only: RLS is enabled with NO policies, so
-- anon/authenticated can neither read nor write it directly. The edge functions
-- (service role, which bypasses RLS) are the only write path — which is what lets
-- writes be rate-limited and keeps addresses / IPs from being read back from the
-- client.

-- ===========================================================================
-- Rate limiting — a fixed-window request counter shared by the edge functions.
-- ===========================================================================
--
-- Edge functions are stateless and may run as several instances, so an in-memory
-- counter cannot rate-limit reliably. This table plus the `rate_limit_hit`
-- function keep the count in the database, where the increment is atomic.
--
-- Each row is one (key, window) bucket — e.g. key `subscribe:1:<ip_hash>`. The
-- key embeds the salted IP hash transiently; it is never persisted anywhere else
-- and the raw IP is never seen. Keying on the IP (not the session) is deliberate:
-- it stops a browser from bypassing the limit by rotating its session token.
-- Buckets are dead weight once their window passes; a scheduled job can purge
-- them (see the cleanup query at the foot of this file).

CREATE TABLE IF NOT EXISTS rate_limits (
  key           TEXT        NOT NULL,
  window_start  TIMESTAMPTZ NOT NULL,
  count         INT         NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);

CREATE INDEX IF NOT EXISTS rate_limits_window_idx ON rate_limits (window_start);

ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;
-- No policies: only the edge functions (service role, which bypasses RLS) touch it.

-- Atomically record a hit against `p_key` and report whether it is within the
-- limit for the current fixed window of `p_window_seconds`. Returns the verdict,
-- the remaining allowance, and how many seconds until the window resets (0 while
-- still allowed). The increment and the read are one statement, so concurrent
-- callers cannot race past the limit.
CREATE OR REPLACE FUNCTION rate_limit_hit(
  p_key            TEXT,
  p_limit          INT,
  p_window_seconds INT
)
RETURNS TABLE (allowed BOOLEAN, remaining INT, retry_after INT)
LANGUAGE plpgsql
AS $$
DECLARE
  v_bucket TIMESTAMPTZ;
  v_count  INT;
BEGIN
  -- Start of the current fixed window.
  v_bucket := to_timestamp(
    floor(extract(epoch FROM now()) / p_window_seconds) * p_window_seconds
  );

  INSERT INTO rate_limits (key, window_start, count)
    VALUES (p_key, v_bucket, 1)
  ON CONFLICT (key, window_start)
    DO UPDATE SET count = rate_limits.count + 1
  RETURNING count INTO v_count;

  allowed     := v_count <= p_limit;
  remaining   := greatest(0, p_limit - v_count);
  retry_after := CASE
                   WHEN v_count <= p_limit THEN 0
                   ELSE ceil(extract(epoch FROM
                     (v_bucket + make_interval(secs => p_window_seconds)) - now()))::INT
                 END;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION rate_limit_hit(TEXT, INT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rate_limit_hit(TEXT, INT, INT) TO service_role;

-- ===========================================================================
-- sessions — the hub. One anonymous browser, plus everything describing it.
-- ===========================================================================
--
-- Identified by a random client token (kept in the visitor's localStorage) plus
-- a hash of the server-seen IP: the same token from a new network is a new
-- session, and a shared IP with different tokens stays distinct. The raw IP is
-- never stored — the edge functions hash it (salted SHA-256) and use the raw
-- value only in-memory to resolve a coarse location once, when the session is
-- first recorded (never on every visit), via an external IP-geolocation service.
--
-- `env` records which environment the session belongs to — 'sandbox' for the
-- staging origin, 'live' for production — chosen from the request origin when the
-- session is first seen. Because a localStorage token never crosses origins, a
-- session's env is stable. This is the single source of truth for the env: orders
-- read it through their session (there is no env column on orders), so
-- payfast-notify verifies each order against the right PayFast.
--
-- Written by `track` (every page visit) and, so an order / signup can always be
-- attributed, resolved-or-created by `create-order` too. `geo`/`isp` are filled
-- only by `track` (the one place that does the geolocation lookup).

CREATE TABLE IF NOT EXISTS sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token        TEXT NOT NULL,          -- client-generated random session token
  ip_hash      TEXT NOT NULL,          -- salted SHA-256 of the client IP (raw IP never stored)
  env          TEXT NOT NULL           -- which environment the session belongs to
                 CHECK (env IN ('sandbox', 'live')),
  user_agent   TEXT,
  -- Coarse geolocation from the IP lookup (any may be null if it fails):
  country      TEXT,
  country_code TEXT,
  region       TEXT,
  city         TEXT,
  latitude     NUMERIC,
  longitude    NUMERIC,
  timezone     TEXT,
  -- Network operator behind the IP, from the same lookup (either may be null):
  isp          TEXT,                   -- organization name (e.g. "Vodacom")
  asn          TEXT,                   -- autonomous-system number (e.g. "AS36994")
  first_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Session uniqueness: one row per (token, ip_hash). The edge functions upsert
-- against this — a returning visitor updates last_seen instead of a new row.
CREATE UNIQUE INDEX IF NOT EXISTS sessions_token_iphash_key ON sessions (token, ip_hash);

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
-- No policies: only the edge functions (service role) touch it.

-- ===========================================================================
-- orders — guest checkout (no login required).
-- ===========================================================================
--
-- Written only by `create-order` and `payfast-notify` (service role). A buyer
-- views their order through an edge function that takes the unguessable
-- `order_token` (emailed / shown on the success page).
--
-- The `amount` column is authoritative: `create-order` computes it server-side
-- from the catalogue (never from the browser cart) and it is what PayFast is
-- asked to charge and what `payfast-notify` reconciles the ITN against.
--
-- `session_id` is NOT NULL with ON DELETE RESTRICT: every order is tied to the
-- session it was placed from, and that session cannot be purged while the order
-- exists — which also guarantees the order's `env` (read through the session) is
-- always available to payfast-notify. There is deliberately no `env` column here.

CREATE TABLE IF NOT EXISTS orders (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_token   TEXT NOT NULL UNIQUE
                  DEFAULT replace(gen_random_uuid()::text, '-', ''),  -- 32-hex lookup token
  session_id    UUID NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
  buyer_name    TEXT  NOT NULL,
  buyer_email   TEXT  NOT NULL,
  ship_address  JSONB NOT NULL,          -- {line1, line2, city, province, postcode, country, phone}
  items         JSONB NOT NULL,          -- snapshot: [{ref, title, unit_price, qty, line_total}]
  subtotal      NUMERIC(10,2) NOT NULL,
  shipping      NUMERIC(10,2) NOT NULL DEFAULT 0,
  amount        NUMERIC(10,2) NOT NULL,  -- subtotal + shipping; the charged total
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'paid', 'failed', 'cancelled')),
  pf_payment_id TEXT,                     -- PayFast pf_payment_id, from the ITN
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS orders_email_idx   ON orders (buyer_email);
CREATE INDEX IF NOT EXISTS orders_status_idx  ON orders (status);
CREATE INDEX IF NOT EXISTS orders_created_idx ON orders (created_at DESC);
CREATE INDEX IF NOT EXISTS orders_session_idx ON orders (session_id);

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
-- Deny all direct access; the edge functions connect as service role.

-- ===========================================================================
-- subscriptions — the mailing list behind "Signup for future communication"
-- (footer → subscribe.html) and the Upcoming "Notify me" button.
-- ===========================================================================
--
-- Written only by the `subscribe` edge function. Routing it through a function
-- (rather than a direct PostgREST insert) is what lets it be rate-limited: the
-- browser has no write path that skips the limiter, and the list can only be read
-- by the owner via the dashboard / service role, so addresses can't be harvested.
--
-- `session_id` is the best-effort link to the browsing session the signup came
-- from (subscribe resolves it by the same (token, ip_hash) key `track` uses):
-- nullable, and ON DELETE SET NULL keeps the subscription if its session is purged.

CREATE TABLE IF NOT EXISTS subscriptions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email          TEXT NOT NULL
                   CHECK (
                     email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
                     AND char_length(email) <= 254
                   ),
  -- What they subscribed to:
  --   1 = future communication (footer general list)
  --   2 = "Grasse van die Veld" availability notification (Upcoming page)
  subscribe_type SMALLINT NOT NULL DEFAULT 1
                   CHECK (subscribe_type IN (1, 2)),
  session_id     UUID REFERENCES sessions(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per (address, subscribe type), case-insensitively — a person can be on
-- the general list and request the Grasse notification independently. A repeat of
-- the same type hits this and the edge function reports it as "already on the list".
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_email_type_key ON subscriptions (lower(email), subscribe_type);
-- Look up a session's signups (and skip the many null rows).
CREATE INDEX IF NOT EXISTS subscriptions_session_idx ON subscriptions (session_id) WHERE session_id IS NOT NULL;

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
-- No policies: the subscribe edge function connects as service role.

-- ===========================================================================
-- page_visits — one row per page view, referencing a session.
-- ===========================================================================
--
-- Written only by `track` (service role). Meaningless without its session, so
-- ON DELETE CASCADE: purging a session takes its visits with it.

CREATE TABLE IF NOT EXISTS page_visits (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,           -- page path, e.g. /townscapes.html
  referrer    TEXT,                    -- document.referrer, if any
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS page_visits_session_idx ON page_visits (session_id);
CREATE INDEX IF NOT EXISTS page_visits_created_idx ON page_visits (created_at DESC);

ALTER TABLE page_visits ENABLE ROW LEVEL SECURITY;
-- No policies: only the `track` edge function (service role) touches it.

-- Purge stale rate-limit buckets from a scheduled job (e.g. pg_cron):
--   DELETE FROM rate_limits WHERE window_start < now() - interval '1 day';
