-- Page-visit metrics: anonymous session + per-page-view tracking.
--
-- Written only by the `track` edge function (service role). Like orders, RLS is
-- enabled with NO policies, so anon/authenticated cannot read or write these
-- directly — the owner reads them via the dashboard / service role.
--
-- A "session" is one anonymous browser, identified by a random client token
-- (kept in localStorage) plus the server-seen IP: the same token from a new
-- network is a new session, and a shared IP with different tokens stays
-- distinct. The IP is resolved to a coarse location once, when the session is
-- first recorded (never on every visit), by an external IP-geolocation service
-- called from the edge function.

CREATE TABLE IF NOT EXISTS sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token        TEXT NOT NULL,          -- client-generated random session token
  ip           TEXT NOT NULL,          -- server-seen client IP
  user_agent   TEXT,
  -- Coarse geolocation from the IP lookup (any may be null if it fails):
  country      TEXT,
  country_code TEXT,
  region       TEXT,
  city         TEXT,
  latitude     NUMERIC,
  longitude    NUMERIC,
  timezone     TEXT,
  first_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Session uniqueness: one row per (token, ip). The edge function upserts against
-- this — a returning visitor updates last_seen instead of creating a new row.
CREATE UNIQUE INDEX IF NOT EXISTS sessions_token_ip_key ON sessions (token, ip);

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
