-- Classifications: what each transaction was, business or personal.
--
-- db/004 could say a payment was a business expense. It had no way to say a
-- payment was personal, and that is not the same as saying nothing: an
-- unclassified row means EITHER personal OR not looked at yet, and those two
-- have to be told apart for a month to be finished rather than merely imported.
--
-- The two facts are one fact with two values — the owner's disposition of one
-- transaction — and they are mutually exclusive: a payment is business or
-- personal, never both. So `business_expenses` becomes
-- `transaction_classifications`, keyed exactly as before (one row per
-- transaction, UNIQUE), with a `kind` saying which it is. One table is what
-- makes the exclusivity free: with two, nothing but a pair of cross-table
-- triggers would stop a transaction being classified twice.
--
-- What differs between the two kinds is evidence. A deduction has to be
-- substantiated, so a business row still requires a `purpose` and may carry the
-- supplier, invoice number, date and proof. Personal requires nothing and may
-- carry none of it — recording an invoice number against a personal payment
-- would assert a document covers it that does not. Those are conditional CHECK
-- constraints below rather than two tables, because the alternative to a
-- nullable column here is a table that cannot enforce the one rule that matters.
--
-- INCOME AND EXPENSES ARE DELIBERATELY UNTOUCHED. They remain the month's two
-- raw sides, every credit and every debit, so `income - expenses` still steps
-- through the same figures as the statement's own balance chain — which is what
-- makes the summary checkable against the PDF, and would be lost if personal
-- movements were filtered out of them. What personal adds is its own totals
-- alongside, and a count of how much of the month has been classified at all.
--
-- Run after db/004_monthly_aggregations.sql. Idempotent, like the rest.

-- ===========================================================================
-- The table.
-- ===========================================================================

-- Renamed rather than rebuilt: the claims already in it are still claims, and
-- its key, its foreign key and its indexes all carry over unchanged.
DO $$
BEGIN
  IF to_regclass('public.business_expenses') IS NOT NULL
     AND to_regclass('public.transaction_classifications') IS NULL THEN
    ALTER TABLE business_expenses RENAME TO transaction_classifications;
  END IF;
END $$;

-- Postgres renames a table without renaming what hangs off it, and a constraint
-- that still says `business_expenses` would put that name in the error message
-- when a personal row is rejected — naming a table that no longer exists.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'transaction_classifications'::regclass
       AND conname LIKE 'business\_expenses\_%'
  LOOP
    EXECUTE format('ALTER TABLE transaction_classifications RENAME CONSTRAINT %I TO %I',
                   r.conname, replace(r.conname, 'business_expenses_', 'transaction_classifications_'));
  END LOOP;

  IF to_regclass('public.business_expenses_id_seq') IS NOT NULL THEN
    ALTER SEQUENCE business_expenses_id_seq RENAME TO transaction_classifications_id_seq;
  END IF;
END $$;

-- Business or personal. Existing rows are all business — before this migration
-- there was nothing else a row could have been — so the default backfills them
-- correctly and is then dropped: a row written from here on has to say which it
-- is, since guessing is the one thing this column exists to stop.
ALTER TABLE transaction_classifications
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'business';
ALTER TABLE transaction_classifications ALTER COLUMN kind DROP DEFAULT;

-- How the classification was made, which is how far it should be trusted and
-- whether it may be revised automatically:
--
--   invoice  a document was matched to the payment (scripts/import-statement)
--   rule     a pattern matched the statement's own description
--   by hand  someone decided, and nothing should overwrite that
--
-- Existing rows all came from the importer, hence the backfill; the default
-- then becomes `by hand`, because a row inserted without saying where it came
-- from was put there by a person.
ALTER TABLE transaction_classifications
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'invoice';
ALTER TABLE transaction_classifications ALTER COLUMN source SET DEFAULT 'by hand';

-- `purpose` is required of a deduction, not of a classification: what a personal
-- payment was for is nobody's business but the owner's, and demanding it would
-- make marking a month's groceries a writing exercise.
ALTER TABLE transaction_classifications ALTER COLUMN purpose DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'classification_kind') THEN
    ALTER TABLE transaction_classifications ADD CONSTRAINT classification_kind
      CHECK (kind IN ('business', 'personal'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'classification_source') THEN
    ALTER TABLE transaction_classifications ADD CONSTRAINT classification_source
      CHECK (source IN ('invoice', 'rule', 'by hand'));
  END IF;

  -- What the money was for is the one thing a deduction cannot be defended
  -- without, so it stays required — for deductions.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_needs_purpose') THEN
    ALTER TABLE transaction_classifications ADD CONSTRAINT business_needs_purpose
      CHECK (kind <> 'business' OR purpose IS NOT NULL);
  END IF;

  -- And personal carries no paperwork, because there is none to carry. A
  -- supplier or an invoice number on a personal row would say a document covers
  -- it; an apportionment would say part of it was claimed. Neither is true.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'personal_claims_nothing') THEN
    ALTER TABLE transaction_classifications ADD CONSTRAINT personal_claims_nothing
      CHECK (kind <> 'personal' OR (
        purpose           IS NULL AND
        deductible_amount IS NULL AND
        expense_type      IS NULL AND
        supplier          IS NULL AND
        invoice_number    IS NULL AND
        invoice_date      IS NULL AND
        proof_url         IS NULL
      ));
  END IF;
END $$;

-- Reading the books by kind — "what did I claim", "what is still unclassified" —
-- is the query this table exists to answer, and it is the one the primary key
-- cannot help with.
CREATE INDEX IF NOT EXISTS transaction_classifications_kind_idx
  ON transaction_classifications (kind);

-- ===========================================================================
-- The two rules a CHECK cannot express, because both need the transaction.
-- ===========================================================================
--
-- Both are about deductions, so both now apply to business rows only. Money in
-- can be personal — a private transfer into the account is money that arrived
-- and is not the business's — but it can never be claimed.
CREATE OR REPLACE FUNCTION classification_validate()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_amount NUMERIC(12,2);
BEGIN
  IF NEW.kind <> 'business' THEN
    RETURN NEW;
  END IF;

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

DROP TRIGGER IF EXISTS business_expenses_validate ON transaction_classifications;
DROP TRIGGER IF EXISTS classification_validate ON transaction_classifications;
CREATE TRIGGER classification_validate
  BEFORE INSERT OR UPDATE ON transaction_classifications
  FOR EACH ROW EXECUTE FUNCTION classification_validate();

DROP FUNCTION IF EXISTS business_expenses_validate();

-- ===========================================================================
-- The aggregations.
-- ===========================================================================

-- `income` and `expenses` keep their meaning exactly (see the header). What is
-- added is the other side of the triage:
--
--   personal_expenses  the month's debits marked personal, as a positive total
--   personal_income    the month's credits marked personal
--   classified_count   transactions carrying a classification of either kind
--
-- classified_count is deliberately a COUNT and not a total: once
-- `deductible_amount` apportions a payment, no arithmetic on the money columns
-- can say what is left to look at, because the unclaimed part of an apportioned
-- payment is neither claimed nor personal. Counts answer "have I been through
-- September?" exactly; money cannot.
ALTER TABLE monthly_aggregations
  ADD COLUMN IF NOT EXISTS personal_expenses NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS personal_income   NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS classified_count  INTEGER       NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION refresh_monthly_aggregations(p_months DATE[] DEFAULT NULL)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_written INTEGER;
BEGIN
  INSERT INTO monthly_aggregations (
    month, income, expenses, business_expenses,
    personal_expenses, personal_income, transaction_count, classified_count, updated_at
  )
  SELECT
    date_trunc('month', t.transaction_date)::date,
    -- Every credit, and every debit. Unqualified on purpose — see the header.
    COALESCE(SUM(t.amount) FILTER (WHERE t.amount > 0), 0),
    COALESCE(SUM(-t.amount) FILTER (WHERE t.amount < 0), 0),
    -- Claimed rows only, and each for its apportioned amount when one is set.
    COALESCE(SUM(COALESCE(c.deductible_amount, -t.amount)) FILTER (
      WHERE c.kind = 'business'
    ), 0),
    COALESCE(SUM(-t.amount) FILTER (WHERE c.kind = 'personal' AND t.amount < 0), 0),
    COALESCE(SUM(t.amount)  FILTER (WHERE c.kind = 'personal' AND t.amount > 0), 0),
    COUNT(*),
    COUNT(*) FILTER (WHERE c.transaction_id IS NOT NULL),
    NOW()
  FROM transactions t
  -- At most one classification per transaction — transaction_id is UNIQUE — so
  -- the join cannot fan a row out and inflate either count.
  LEFT JOIN transaction_classifications c ON c.transaction_id = t.id
  WHERE p_months IS NULL
     OR date_trunc('month', t.transaction_date)::date = ANY (p_months)
  GROUP BY 1
  ON CONFLICT (month) DO UPDATE SET
    income            = EXCLUDED.income,
    expenses          = EXCLUDED.expenses,
    business_expenses = EXCLUDED.business_expenses,
    personal_expenses = EXCLUDED.personal_expenses,
    personal_income   = EXCLUDED.personal_income,
    transaction_count = EXCLUDED.transaction_count,
    classified_count  = EXCLUDED.classified_count,
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
-- Same statement-level triggers as db/004, renamed with the table they are on.
-- Classifying, reclassifying or withdrawing changes its month's total exactly
-- as claiming did.
CREATE OR REPLACE FUNCTION classifications_refresh_aggregations()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ids    BIGINT[];
  v_months DATE[];
BEGIN
  -- A trigger may only reference the transition tables its operation has. An
  -- UPDATE needs both, since re-pointing a classification at another
  -- transaction changes two months.
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

DROP TRIGGER IF EXISTS business_expenses_aggregate_insert ON transaction_classifications;
DROP TRIGGER IF EXISTS classifications_aggregate_insert ON transaction_classifications;
CREATE TRIGGER classifications_aggregate_insert
  AFTER INSERT ON transaction_classifications
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION classifications_refresh_aggregations();

DROP TRIGGER IF EXISTS business_expenses_aggregate_update ON transaction_classifications;
DROP TRIGGER IF EXISTS classifications_aggregate_update ON transaction_classifications;
CREATE TRIGGER classifications_aggregate_update
  AFTER UPDATE ON transaction_classifications
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION classifications_refresh_aggregations();

DROP TRIGGER IF EXISTS business_expenses_aggregate_delete ON transaction_classifications;
DROP TRIGGER IF EXISTS classifications_aggregate_delete ON transaction_classifications;
CREATE TRIGGER classifications_aggregate_delete
  AFTER DELETE ON transaction_classifications
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION classifications_refresh_aggregations();

DROP TRIGGER IF EXISTS business_expenses_aggregate_truncate ON transaction_classifications;
DROP TRIGGER IF EXISTS classifications_aggregate_truncate ON transaction_classifications;
CREATE TRIGGER classifications_aggregate_truncate
  AFTER TRUNCATE ON transaction_classifications
  FOR EACH STATEMENT EXECUTE FUNCTION refresh_monthly_aggregations_all();

DROP FUNCTION IF EXISTS business_expenses_refresh_aggregations();

-- Recompute every month, so the new columns are filled for the ledger that is
-- already on record. A no-op on a fresh database, and idempotent.
SELECT refresh_monthly_aggregations();
