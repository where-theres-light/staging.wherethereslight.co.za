-- Email signups: "Signup for future communication" (footer → signup.html)
--
-- A write-only mailing list. Unlike the catalogue (public read) and orders
-- (no public access at all), this table is filled straight from the browser
-- with the publishable key, so RLS is enabled with a single INSERT policy and
-- NO SELECT policy: anon/authenticated may add their own email but can never
-- read the list back (so the address list cannot be harvested). The list is
-- read only by the project owner via the dashboard / service role.
--
-- The browser inserts with `Prefer: return=minimal`, so no SELECT grant is
-- needed for the insert to succeed.

CREATE TABLE IF NOT EXISTS signups (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT NOT NULL,
  source      TEXT,                    -- where they signed up, e.g. 'footer'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per address, case-insensitively. A repeat signup hits this and
-- PostgREST returns 409, which the page treats as "already on the list".
CREATE UNIQUE INDEX IF NOT EXISTS signups_email_key ON signups (lower(email));

ALTER TABLE signups ENABLE ROW LEVEL SECURITY;

-- INSERT-only for the public roles: they may add a row whose email looks valid,
-- but there is no SELECT/UPDATE/DELETE policy, so the list stays write-only.
DROP POLICY IF EXISTS signups_insert ON signups;
CREATE POLICY signups_insert ON signups
  FOR INSERT TO anon, authenticated
  WITH CHECK (
    email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
    AND char_length(email) <= 254
  );

GRANT INSERT ON signups TO anon, authenticated;
