-- Page-visit metrics: anonymous session + per-page-view tracking.
--
-- Written only by the `track` edge function (service role). Like orders, RLS is
-- enabled with NO policies, so anon/authenticated cannot read or write these
-- directly — the owner reads them via the dashboard / service role.
--
-- A "session" is one anonymous browser, identified by a random client token
-- (kept in localStorage) plus a hash of the server-seen IP: the same token from
-- a new network is a new session, and a shared IP with different tokens stays
-- distinct. The raw IP is never stored — the edge function hashes it (salted
-- SHA-256) and uses the raw value only in-memory to resolve a coarse location
-- once, when the session is first recorded (never on every visit), via an
-- external IP-geolocation service.

CREATE TABLE IF NOT EXISTS sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token        TEXT NOT NULL,          -- client-generated random session token
  ip_hash      TEXT NOT NULL,          -- salted SHA-256 of the client IP (raw IP never stored)
  user_agent   TEXT,
  -- Coarse geolocation from the IP lookup (any may be null if it fails):
  country      TEXT,
  country_code TEXT,
  region       TEXT,
  city         TEXT,
  latitude     NUMERIC,
  longitude    NUMERIC,
  timezone     TEXT,
  -- db/007_session_isp.sql adds `isp` / `asn` (the network operator behind the
  -- IP), captured from the same geolocation lookup — see there.
  first_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Session uniqueness: one row per (token, ip_hash). The edge function upserts
-- against this — a returning visitor updates last_seen instead of a new row.
CREATE UNIQUE INDEX IF NOT EXISTS sessions_token_iphash_key ON sessions (token, ip_hash);

CREATE TABLE IF NOT EXISTS page_visits (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,           -- page path, e.g. /townscapes.html
  referrer    TEXT,                    -- document.referrer, if any
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS page_visits_session_idx ON page_visits (session_id);
CREATE INDEX IF NOT EXISTS page_visits_created_idx ON page_visits (created_at DESC);

ALTER TABLE sessions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE page_visits ENABLE ROW LEVEL SECURITY;
-- No policies: only the `track` edge function (service role) touches these.
