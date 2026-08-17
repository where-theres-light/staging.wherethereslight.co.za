-- Email subscriptions: the mailing list behind "Signup for future communication"
-- (footer → subscribe.html) and the Upcoming "Notify me" button.
--
-- Written only by the `subscribe` edge function, which connects as service role.
-- Like orders, RLS is enabled with NO policies, so anon/authenticated cannot
-- read or write it directly. Going through the function (rather than a direct
-- PostgREST insert with the publishable key) is what lets it be rate-limited:
-- the browser has no write path that skips the limiter. The list is read only
-- by the project owner via the dashboard / service role, so addresses can never
-- be harvested from the client.

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
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per (address, subscribe type), case-insensitively — a person can be
-- on the general list and request the Grasse notification independently. A
-- repeat of the same type hits this and the edge function reports it as
-- "already on the list".
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_email_type_key ON subscriptions (lower(email), subscribe_type);

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

-- Deny all direct access; the subscribe edge function connects as service role.
-- (Undo the earlier direct-insert grant/policy if a prior version was applied.)
DROP POLICY IF EXISTS subscriptions_insert ON subscriptions;
REVOKE INSERT ON subscriptions FROM anon, authenticated;
