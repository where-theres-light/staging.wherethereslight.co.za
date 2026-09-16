-- Bank transactions: the running ledger imported from Capitec statements.
--
-- This is the cash-position table — what came in and what went out. What that
-- means for tax is a separate question, answered in db/004_monthly_aggregations.sql,
-- where credits are resolved to income and expenses are claimed with their proof.
-- It is *not* order or catalogue data: an order is what a buyer owes, a
-- transaction is money that actually moved through the bank account, so the two
-- are deliberately separate and unlinked.
--
-- Like everything in db/002_sessions.sql, this is owner-only data: RLS is
-- enabled with NO policies, so anon/authenticated can neither read nor write it.
-- The `import-transactions` edge function (service role, which bypasses RLS) is
-- the only write path; the owner reads it via the dashboard. Nothing in the
-- shipped site touches this table.
--
-- Rows are appended by scripts/import-statement, which parses a statement PDF
-- locally and POSTs the parsed rows to that function. Statements overlap (a
-- September statement repeats late-August rows), so every import is an
-- ON CONFLICT DO NOTHING upsert against the natural key below — re-importing the
-- same statement, or a later one covering the same days, inserts nothing new.

CREATE TABLE IF NOT EXISTS transactions (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_date DATE          NOT NULL,
  description      TEXT          NOT NULL,
  amount           NUMERIC(12,2) NOT NULL,   -- signed: + money in, - money out
  transaction_type TEXT,                     -- 'credit' | 'debit' | 'fee'
  category         TEXT,                     -- the bank's own category, as printed
  source_statement TEXT,                     -- statement filename the row came from
  raw_reference    TEXT,                     -- the statement line, verbatim
  created_at       TIMESTAMPTZ DEFAULT NOW(),

  -- The natural key. `raw_reference` carries the running balance, which is what
  -- makes it a key at all: two genuinely distinct purchases on the same day, for
  -- the same amount, at the same shop are identical in every other column and
  -- would otherwise collapse into one row. It is also why the importer must
  -- always populate it — NULLs are distinct in Postgres, so a NULL
  -- `raw_reference` would silently never conflict and would duplicate on every
  -- re-run. `source_statement` is deliberately NOT part of the key, so the same
  -- transaction arriving in two overlapping statements still de-duplicates.
  UNIQUE (transaction_date, description, amount, raw_reference)
);

-- Reporting is "what moved, and when" — the monthly summary buckets by date, and
-- income is resolved per bank category — so both reads are date-ordered, one of
-- them per category.
CREATE INDEX IF NOT EXISTS transactions_date_idx     ON transactions (transaction_date);
CREATE INDEX IF NOT EXISTS transactions_category_idx ON transactions (category, transaction_date);

ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
-- No policies: only the import-transactions function (service role) writes here,
-- and only the dashboard / service role reads it back.
