-- Email signups: "Signup for future communication" (footer → signup.html)
--
-- Written only by the `signup` edge function, which connects as service role.
-- Like orders, RLS is enabled with NO policies, so anon/authenticated cannot
-- read or write it directly. Going through the function (rather than a direct
-- PostgREST insert with the publishable key) is what lets it be rate-limited:
-- the browser has no write path that skips the limiter. The list is read only
-- by the project owner via the dashboard / service role, so addresses can never
-- be harvested from the client.

CREATE TABLE IF NOT EXISTS signups (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT NOT NULL
                CHECK (
                  email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
                  AND char_length(email) <= 254
                ),
  source      TEXT,                    -- where they signed up, e.g. 'footer'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per address, case-insensitively. A repeat signup hits this and the
-- edge function reports it as "already on the list".
CREATE UNIQUE INDEX IF NOT EXISTS signups_email_key ON signups (lower(email));

ALTER TABLE signups ENABLE ROW LEVEL SECURITY;

-- Deny all direct access; the signup edge function connects as service role.
-- (Undo the earlier direct-insert grant/policy if a prior version was applied.)
DROP POLICY IF EXISTS signups_insert ON signups;
REVOKE INSERT ON signups FROM anon, authenticated;
