-- Link mailing-list signups back to the anonymous browsing session they came
-- from. Adds a nullable `session_id` on `subscriptions` referencing the metrics
-- `sessions` row (db/005_metrics.sql), so the owner can see where a signup
-- originated — the coarse geolocation, user agent, and first/last-seen the
-- session already carries — without ever storing a raw IP on the subscription.
--
-- This lives in its own migration (after both 003_subscriptions and
-- 005_metrics) because the foreign key spans the two: `subscriptions` is created
-- in 003 and `sessions` in 005, so the link can only be added once both exist.
--
-- The reference is best-effort: the `subscribe` edge function resolves the
-- session by the same (token, ip_hash) key `track` uses and sets it on insert,
-- but leaves it null if no matching session is on record (e.g. the visit beacon
-- has not landed, or metrics were unavailable). ON DELETE SET NULL keeps a
-- subscription if its session row is ever purged.

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES sessions(id) ON DELETE SET NULL;

-- Look up a session's signups (and skip the many null rows).
CREATE INDEX IF NOT EXISTS subscriptions_session_idx
  ON subscriptions (session_id)
  WHERE session_id IS NOT NULL;
