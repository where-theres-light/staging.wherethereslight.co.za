-- Monthly aggregations: the month-by-month summary derived from `transactions`.
--
-- The ledger in db/003_transactions.sql answers "what moved". This answers "what
-- do I do with it": for each calendar month, how much came in, how much of that
-- is set aside or free to spend, and how much of the month's spending is a
-- claimable business expense.
--
--   pre_deduction (PD)     10% of income — set aside before anything else
--   expandable_amount (EA) 40% of income
--   business_expenses      the month's claimed business spending
--
-- PD and EA are GENERATED columns, not stored facts: they are by definition
-- functions of `income`, so deriving them in the schema is what stops them ever
-- drifting from it. They deliberately do not add up to `income` — the remaining
-- 50% is simply unallocated here.
--
-- Consequence worth knowing: because the rates live in the column expressions,
-- changing one is an ALTER TABLE that recomputes *every* month, history
-- included. That is the right behaviour for a rule the owner sets, but it is not
-- a per-month rate — a month cannot be pinned to the rate in force at the time.
--
-- Like 002 and 003 this is owner-only: RLS on with NO policies. Nothing in the
-- shipped site reads or writes any of it. The summary is maintained entirely by
-- triggers — there is no import path and nothing to run by hand after an import.
--
-- The two inputs are deliberately asymmetric, because that is how the two
-- questions actually differ:
--
--   • Income is every credit. Money arriving in the business account counts, and
--     nothing has to be said about it for the month to be summarised.
--   • A deduction must be SUBSTANTIATED. Nothing is a business expense until it
--     is claimed as one, with proof, in `business_expenses` below. Nothing is
--     ever inferred from the statement.
--
-- Counting every credit is the deliberate simple case, not an oversight. It does
-- mean a transfer in from savings reads as income and so inflates both the
-- month's income and the 10% set aside against it; if that starts to matter, the
-- place to fix it is the income filter in refresh_monthly_aggregations below,
-- fed by whatever says a credit is not income — a rule per bank category, a
-- column on `transactions`, or both.

-- ===========================================================================
-- Business expenses — a claim, with its proof, against one transaction.
-- ===========================================================================
--
-- A row here is the assertion "this payment was a deductible business expense,
-- and here is what backs it up". Nothing else makes a transaction deductible:
-- the month's total is the sum of these rows, so it is never inferred from a
-- description or a bank category and never has to be guessed at.
--
-- That is also why `purpose` is NOT NULL. What the money was for is the one
-- thing a deduction cannot be defended without, and it is the thing that is
-- impossible to reconstruct a year later — so it is required at the moment the
-- claim is made, while it is still known.
CREATE TABLE IF NOT EXISTS business_expenses (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- One claim per transaction. UNIQUE because a payment is either a business
  -- expense or it is not — two rows would double-count it. CASCADE because a
  -- claim against a transaction that no longer exists is meaningless.
  transaction_id    BIGINT NOT NULL UNIQUE REFERENCES transactions (id) ON DELETE CASCADE,

  -- Apportionment, for a cost that is only partly business — a phone bill, a
  -- home-office share. NULL, the normal case, claims the whole payment. Stored
  -- positive: `transactions.amount` is negative for money out, and this is read
  -- as an amount claimed rather than as a movement.
  deductible_amount NUMERIC(12,2) CHECK (deductible_amount > 0),

  -- What it was for. Required — see above.
  purpose           TEXT NOT NULL,

  -- Kind of expense, for grouping at tax time (materials, packaging, postage,
  -- studio rent, bank charges, …). Free text: the categories that matter are the
  -- ones the accountant asks for, and a CHECK constraint here would just have to
  -- be migrated every time that list changed.
  expense_type      TEXT,

  -- The supporting document. A deduction has to be substantiated on request and
  -- the document kept for five years, so record who issued it, its number and
  -- its own date (an invoice is often dated before the payment clears), and a
  -- link to wherever the scan is filed. `proof_url` NULL means the claim is made
  -- but the paperwork is not filed yet — worth querying for before year end.
  supplier          TEXT,
  invoice_number    TEXT,
  invoice_date      DATE,
  proof_url         TEXT,

  note              TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE business_expenses ENABLE ROW LEVEL SECURITY;
-- No policies: owner-only, like the ledger it references.

-- Two things a CHECK cannot express, because both need the referenced row.
CREATE OR REPLACE FUNCTION business_expenses_validate()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_amount NUMERIC(12,2);
BEGIN
  SELECT amount INTO v_amount FROM transactions WHERE id = NEW.transaction_id;
  -- Missing row: leave it to the foreign key, which rejects it with a better
  -- message than anything raised here.
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- Only money out can be claimed. A refund of a business cost arrives as a
  -- credit, but that reduces an existing claim — it is not a claim of its own.
  IF v_amount >= 0 THEN
    RAISE EXCEPTION
      'transaction % is not money out (amount %), so it cannot be claimed as a business expense',
      NEW.transaction_id, v_amount;
  END IF;

  IF NEW.deductible_amount IS NOT NULL AND NEW.deductible_amount > -v_amount THEN
    RAISE EXCEPTION
      'deductible_amount % exceeds transaction %''s amount of %',
      NEW.deductible_amount, NEW.transaction_id, -v_amount;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS business_expenses_validate ON business_expenses;
CREATE TRIGGER business_expenses_validate
  BEFORE INSERT OR UPDATE ON business_expenses
  FOR EACH ROW EXECUTE FUNCTION business_expenses_validate();

-- ===========================================================================
-- The aggregations.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS monthly_aggregations (
  -- First day of the calendar month the row summarises.
  month             DATE          PRIMARY KEY,

  -- Every credit in the month that resolves to income, summed. Positive.
  income            NUMERIC(12,2) NOT NULL DEFAULT 0,

  pre_deduction     NUMERIC(12,2) GENERATED ALWAYS AS (round(income * 0.10, 2)) STORED,
  expandable_amount NUMERIC(12,2) GENERATED ALWAYS AS (round(income * 0.40, 2)) STORED,

  -- The month's claims in `business_expenses`, summed as a positive total. A
  -- month with no claims reads 0 — which here means "nothing claimed", not
  -- "nothing deductible".
  business_expenses NUMERIC(12,2) NOT NULL DEFAULT 0,

  -- Every transaction in the month, claimed or not. Provenance: it is how you
  -- tell "no income that month" from "that month was never imported".
  transaction_count INTEGER       NOT NULL DEFAULT 0,

  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
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
    -- Every credit. See the header for why this is not qualified any further.
    COALESCE(SUM(t.amount) FILTER (WHERE t.amount > 0), 0),
    -- Claimed rows only, and each for its apportioned amount when one is set.
    COALESCE(SUM(COALESCE(b.deductible_amount, -t.amount)) FILTER (
      WHERE b.transaction_id IS NOT NULL
    ), 0),
    COUNT(*),
    NOW()
  FROM transactions t
  -- At most one claim per transaction — business_expenses.transaction_id is
  -- UNIQUE — so the join cannot fan a row out and inflate transaction_count.
  LEFT JOIN business_expenses b ON b.transaction_id = t.id
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
-- recompute the same month once per row. These recompute each affected month
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

-- Claiming, amending or withdrawing an expense changes its month's total, so it
-- refreshes the same way. The month comes from the referenced transaction — the
-- claim itself carries no date of its own, on purpose: the expense belongs to
-- the month the money moved, like everything else here.
CREATE OR REPLACE FUNCTION business_expenses_refresh_aggregations()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ids    BIGINT[];
  v_months DATE[];
BEGIN
  -- Same branch as above, and for the same reason: a trigger may only reference
  -- the transition tables its operation actually has. An UPDATE needs both,
  -- since re-pointing a claim at another transaction changes two months.
  IF TG_OP = 'INSERT' THEN
    SELECT array_agg(transaction_id) INTO v_ids FROM new_rows;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT array_agg(transaction_id) INTO v_ids FROM old_rows;
  ELSE
    SELECT array_agg(id) INTO v_ids FROM (
      SELECT transaction_id AS id FROM new_rows
      UNION
      SELECT transaction_id      FROM old_rows
    ) s;
  END IF;

  SELECT array_agg(DISTINCT date_trunc('month', t.transaction_date)::date)
    INTO v_months
  FROM transactions t
  WHERE t.id = ANY (v_ids);

  -- NULL when the statement touched nothing, and also on a cascaded delete,
  -- where the transactions are already gone — that case needs no handling here
  -- because the transaction's own AFTER DELETE trigger refreshes those months.
  IF v_months IS NOT NULL THEN
    PERFORM refresh_monthly_aggregations(v_months);
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS business_expenses_aggregate_insert ON business_expenses;
CREATE TRIGGER business_expenses_aggregate_insert
  AFTER INSERT ON business_expenses
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION business_expenses_refresh_aggregations();

DROP TRIGGER IF EXISTS business_expenses_aggregate_update ON business_expenses;
CREATE TRIGGER business_expenses_aggregate_update
  AFTER UPDATE ON business_expenses
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION business_expenses_refresh_aggregations();

DROP TRIGGER IF EXISTS business_expenses_aggregate_delete ON business_expenses;
CREATE TRIGGER business_expenses_aggregate_delete
  AFTER DELETE ON business_expenses
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION business_expenses_refresh_aggregations();

-- Full rebuild, for the cases that cannot name the affected months.
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

-- TRUNCATE does not fire the triggers above and carries no transition tables, so
-- without these an emptied ledger would leave every month behind.
DROP TRIGGER IF EXISTS transactions_aggregate_truncate ON transactions;
CREATE TRIGGER transactions_aggregate_truncate
  AFTER TRUNCATE ON transactions
  FOR EACH STATEMENT EXECUTE FUNCTION refresh_monthly_aggregations_all();

DROP TRIGGER IF EXISTS business_expenses_aggregate_truncate ON business_expenses;
CREATE TRIGGER business_expenses_aggregate_truncate
  AFTER TRUNCATE ON business_expenses
  FOR EACH STATEMENT EXECUTE FUNCTION refresh_monthly_aggregations_all();

-- Backfill for an existing ledger. A no-op on a fresh database, and idempotent,
-- so re-running this migration simply recomputes what is already correct.
SELECT refresh_monthly_aggregations();
