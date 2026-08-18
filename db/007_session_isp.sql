-- Record the ISP / network behind a session alongside its coarse location.
--
-- The IP-geolocation lookup the `track` function already does (once, on a
-- session's first sight — db/005_metrics.sql) also returns the network operator,
-- so capturing it costs no extra request. `isp` is the organization name (ipapi's
-- `org`, e.g. "Vodacom") and `asn` its autonomous-system number (e.g. "AS36994").
-- Both are best-effort and may be null, exactly like the location columns: a
-- failed or un-geolocatable lookup just leaves them empty.
--
-- Added as its own migration (like the columns themselves in 005) so a database
-- that already ran 005 picks these up; a fresh install gets them here too.

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS isp TEXT,
  ADD COLUMN IF NOT EXISTS asn TEXT;
