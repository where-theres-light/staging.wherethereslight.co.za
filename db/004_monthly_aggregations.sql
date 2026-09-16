-- Monthly aggregations: the month-by-month summary derived from `transactions`.
--
-- The ledger in db/003_transactions.sql answers "what moved". This answers "what
-- do I do with it": for each calendar month, how much came in, how that income
-- splits into the three buckets the money is run on, and how much of the month's
-- spending is a deductible business expense.
--
--   pre_deduction (PD)          10% of income  — set aside before anything else
--   expendable_income (EI)      40% of income
--   non_expendable_income (NEI) 50% of income
--   business_expenses           the month's tax-deductible spending
--
-- The three splits are GENERATED columns, not stored facts: they are by
-- definition functions of `income`, so deriving them in the schema is what stops
-- them ever drifting from it. NEI is written as the remainder
-- (income - PD - EI) rather than a second round(): at 10/40/50 the three shares
-- must add back to `income` exactly, and rounding each independently can leave a
-- stray cent (income 100.05 -> 10.01 + 40.02 + 50.03 = 100.06). The remainder
-- absorbs it into the largest share, where it distorts least.
--
-- Consequence worth knowing: because the rates live in the column expressions,
-- changing one is an ALTER TABLE that recomputes *every* month, history
-- included. That is the right behaviour for a rule the owner sets, but it is not
-- a per-month rate — a month cannot be pinned to the rate in force at the time.
--
-- Like 002 and 003 this is owner-only: RLS on with NO policies. Nothing in the
-- shipped site reads or writes it. It is maintained entirely by triggers — there
-- is no import path and nothing to call by hand after a statement import.

-- ===========================================================================
-- Classification — which transactions count as income, and which as deductible.
-- ===========================================================================
--
-- `transactions` records what the bank printed; it carries no notion of whether
-- a credit is really income or whether a debit is really a business expense. The
-- statement cannot know: a transfer in from savings is a credit but not income,
-- and an owner draw is a debit but not deductible.
--
-- Resolution is three levels, most specific first:
--
--   1. the transaction's own override column, when set;
--   2. the rule for its bank category, when one exists here;
--   3. the default — a credit IS income, a debit IS deductible.
--
-- The default is "in, unless excluded" in both directions, which suits a
-- business account: money arriving is income and money leaving is a business
-- cost, with a short, nameable list of exceptions (own transfers, owner draws,
-- SARS payments, personal spend). It also means the aggregations are complete
-- from the first import rather than reading zero until everything is classified
-- — they start broad and tighten as exceptions get named.
CREATE TABLE IF NOT EXISTS transaction_categories (
  -- The bank's own category, exactly as printed on the statement and stored in
  -- transactions.category. Matched case-insensitively, so casing drift between
  -- statements cannot silently orphan a rule.
  category         TEXT PRIMARY KEY,
  counts_as_income BOOLEAN NOT NULL DEFAULT TRUE,  -- applies to credits
  tax_deductible   BOOLEAN NOT NULL DEFAULT TRUE,  -- applies to debits
  note             TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS transaction_categories_lower_idx
  ON transaction_categories (lower(category));

ALTER TABLE transaction_categories ENABLE ROW LEVEL SECURITY;
-- No policies: owner-only, edited from the dashboard.

-- Per-transaction overrides. NULL — the normal case — means "no opinion, use the
-- category rule". They exist because a category is a blunt instrument: one
-- personal purchase from a shop you otherwise buy supplies at cannot be
-- expressed as a category, and the category comes from the bank so it cannot be
-- edited to carve the row out.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS counts_as_income BOOLEAN;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS tax_deductible   BOOLEAN;

-- ===========================================================================
-- The aggregations.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS monthly_aggregations (
  -- First day of the calendar month the row summarises.
  month                 DATE          PRIMARY KEY,

  -- Every credit in the month that resolves to income, summed. Positive.
  income                NUMERIC(12,2) NOT NULL DEFAULT 0,

  pre_deduction         NUMERIC(12,2)
    GENERATED ALWAYS AS (round(income * 0.10, 2)) STORED,
  expendable_income     NUMERIC(12,2)
    GENERATED ALWAYS AS (round(income * 0.40, 2)) STORED,
  non_expendable_income NUMERIC(12,2)
    GENERATED ALWAYS AS (income - round(income * 0.10, 2) - round(income * 0.40, 2)) STORED,

  -- Every debit in the month that resolves to deductible, summed as a positive
  -- magnitude. Stored positive because it is read as a total spent, not as a
  -- movement — the signed amounts stay in `transactions`.
  business_expenses     NUMERIC(12,2) NOT NULL DEFAULT 0,

  -- Every transaction in the month, classified or not. Provenance: it is how you
  -- tell "no income that month" from "that month was never imported".
  transaction_count     INTEGER       NOT NULL DEFAULT 0,

  updated_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

ALTER TABLE monthly_aggregations ENABLE ROW LEVEL SECURITY;
-- No policies: derived from owner-only data, so it is owner-only too.

-- Recompute the aggregations for `p_months` (each the first of a month), or for
-- every month on record when NULL. Returns the number of month rows written.
--
-- This is the whole maintenance path: it is idempotent, so a targeted refresh
-- from a trigger and a full rebuild by hand are the same code. It both upserts
-- months that have transactions and deletes months that no longer do, so it can
-- never leave a stale row behind after the last transaction in a month is
-- removed.
CREATE OR REPLACE FUNCTION refresh_monthly_aggregations(p_months DATE[] DEFAULT NULL)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_written INTEGER;
BEGIN
  INSERT INTO monthly_aggregations (month, income, business_expenses, transaction_count, updated_at)
  SELECT
    date_trunc('month', t.transaction_date)::date,
    COALESCE(SUM(t.amount) FILTER (
      WHERE t.amount > 0 AND COALESCE(t.counts_as_income, c.counts_as_income, TRUE)
    ), 0),
    COALESCE(SUM(-t.amount) FILTER (
      WHERE t.amount < 0 AND COALESCE(t.tax_deductible, c.tax_deductible, TRUE)
    ), 0),
    COUNT(*),
    NOW()
  FROM transactions t
  -- LEFT JOIN, so an unclassified category leaves both rule columns NULL and the
  -- COALESCEs above fall through to the default.
  LEFT JOIN transaction_categories c ON lower(c.category) = lower(t.category)
  WHERE p_months IS NULL
     OR date_trunc('month', t.transaction_date)::date = ANY (p_months)
  GROUP BY 1
  ON CONFLICT (month) DO UPDATE SET
    income            = EXCLUDED.income,
    business_expenses = EXCLUDED.business_expenses,
    transaction_count = EXCLUDED.transaction_count,
    updated_at        = NOW();

  GET DIAGNOSTICS v_written = ROW_COUNT;

  DELETE FROM monthly_aggregations m
  WHERE (p_months IS NULL OR m.month = ANY (p_months))
    AND NOT EXISTS (
      SELECT 1 FROM transactions t
      WHERE date_trunc('month', t.transaction_date)::date = m.month
    );

  RETURN v_written;
END;
$$;

-- ===========================================================================
-- Keeping it current.
-- ===========================================================================
--
-- Statement-level triggers with transition tables, not row-level ones: an import
-- writes a whole statement in a single INSERT, and a row-level trigger would
-- recompute the same month once per row. This recomputes each affected month
-- once per statement however many rows it carried.
CREATE OR REPLACE FUNCTION transactions_refresh_aggregations()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_months DATE[];
BEGIN
  -- Only the transition tables declared for this operation exist, hence the
  -- branch: an AFTER INSERT trigger has no OLD TABLE to read. An UPDATE has to
  -- take both, since moving a transaction's date changes two months' totals.
  IF TG_OP = 'INSERT' THEN
    SELECT array_agg(DISTINCT date_trunc('month', transaction_date)::date)
      INTO v_months FROM new_rows;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT array_agg(DISTINCT date_trunc('month', transaction_date)::date)
      INTO v_months FROM old_rows;
  ELSE
    SELECT array_agg(DISTINCT m) INTO v_months FROM (
      SELECT date_trunc('month', transaction_date)::date AS m FROM new_rows
      UNION
      SELECT date_trunc('month', transaction_date)::date      FROM old_rows
    ) s;
  END IF;

  -- NULL when the statement touched no rows — an ON CONFLICT DO NOTHING import
  -- where every row was already on record, which is the common case on a re-run.
  IF v_months IS NOT NULL THEN
    PERFORM refresh_monthly_aggregations(v_months);
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS transactions_aggregate_insert ON transactions;
CREATE TRIGGER transactions_aggregate_insert
  AFTER INSERT ON transactions
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION transactions_refresh_aggregations();

DROP TRIGGER IF EXISTS transactions_aggregate_update ON transactions;
CREATE TRIGGER transactions_aggregate_update
  AFTER UPDATE ON transactions
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION transactions_refresh_aggregations();

DROP TRIGGER IF EXISTS transactions_aggregate_delete ON transactions;
CREATE TRIGGER transactions_aggregate_delete
  AFTER DELETE ON transactions
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION transactions_refresh_aggregations();

-- Full rebuild, used by the two cases that cannot name the affected months.
CREATE OR REPLACE FUNCTION refresh_monthly_aggregations_all()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM refresh_monthly_aggregations();
  RETURN NULL;
END;
$$;

-- TRUNCATE does not fire the row triggers above and carries no transition
-- tables, so without this an emptied ledger would leave every month behind.
DROP TRIGGER IF EXISTS transactions_aggregate_truncate ON transactions;
CREATE TRIGGER transactions_aggregate_truncate
  AFTER TRUNCATE ON transactions
  FOR EACH STATEMENT EXECUTE FUNCTION refresh_monthly_aggregations_all();

-- Reclassifying a category rewrites history — it changes what past months
-- counted as income or as deductible — so it rebuilds everything. The ledger is
-- one small business account's statements, so a full pass is cheap, and rules
-- are edited by hand a few times a year.
DROP TRIGGER IF EXISTS transaction_categories_aggregate ON transaction_categories;
CREATE TRIGGER transaction_categories_aggregate
  AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON transaction_categories
  FOR EACH STATEMENT EXECUTE FUNCTION refresh_monthly_aggregations_all();

-- Backfill for an existing ledger. A no-op on a fresh database, and idempotent,
-- so re-running this migration simply recomputes what is already correct.
SELECT refresh_monthly_aggregations();
