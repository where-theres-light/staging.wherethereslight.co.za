-- The books: the bank ledger, what each transaction was, and the monthly summary.
--
-- Four tables and the machinery that keeps them in step. They are one file
-- because they are one subject — every one of them hangs off `transactions`,
-- and splitting them meant a reader had to hold three files open to follow a
-- single number from the statement to the summary:
--
--   transactions                the running ledger, imported from statement PDFs
--   transaction_classifications what each one was — business or personal
--   personal_rules              the patterns that recognise the personal ones
--   monthly_aggregations        the month-by-month summary, derived from the rest
--
-- It is *not* order or catalogue data: an order is what a buyer owes, a
-- transaction is money that actually moved through the bank account, so the two
-- are deliberately separate and unlinked.
--
-- Like everything in db/002_sessions.sql, all of it is owner-only: RLS enabled
-- with NO policies, so anon/authenticated can neither read nor write. The
-- `import-transactions` edge function (service role, which bypasses RLS) is the
-- only write path from outside; the owner reads and writes the rest via the
-- dashboard. Nothing in the shipped site touches any of it.
--
-- Idempotent: safe to run again over a database that already has it.

-- ===========================================================================
-- The ledger.
-- ===========================================================================
--
-- What came in and what went out. What that means for tax is a separate
-- question, answered by the classifications below.
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
-- the bank's own categories are how spending is browsed — so both reads are
-- date-ordered, one of them per category.
CREATE INDEX IF NOT EXISTS transactions_date_idx     ON transactions (transaction_date);
CREATE INDEX IF NOT EXISTS transactions_category_idx ON transactions (category, transaction_date);

ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;

-- ===========================================================================
-- What each transaction was.
-- ===========================================================================
--
-- An unclassified row means EITHER personal OR not looked at yet, and those two
-- have to be told apart for a month to be finished rather than merely imported.
-- So every transaction gets a row here saying which it was.
--
-- Business and personal are one fact with two values — the owner's disposition
-- of one transaction — and they are mutually exclusive: a payment is one or the
-- other, never both. One table is what makes that exclusivity free, since
-- `transaction_id` is UNIQUE; two tables would need a pair of cross-table
-- triggers to say the same thing.
--
-- What differs between them is EVIDENCE. Nothing is deductible until it is
-- claimed: a business row is the assertion "this payment was a business expense,
-- and here is what backs it up", so it requires a `purpose` and may carry the
-- supplier, invoice number, date and proof. A personal row asserts only "this
-- was not the business's", which needs no proof and offers none — recording an
-- invoice number against a private payment would say a document covers it that
-- does not. Both are conditional CHECKs below rather than two tables, because
-- the alternative to a nullable column here is a schema that cannot enforce the
-- one rule that actually matters.
CREATE TABLE IF NOT EXISTS transaction_classifications (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- One classification per transaction. UNIQUE because a payment is either a
  -- business expense or it is not — two rows would double-count it. CASCADE
  -- because a classification of a transaction that no longer exists is
  -- meaningless.
  transaction_id BIGINT NOT NULL UNIQUE REFERENCES transactions (id) ON DELETE CASCADE,

  kind           TEXT NOT NULL CHECK (kind IN ('business', 'personal')),

  -- How it was decided, which is how far it should be trusted:
  --
  --   invoice  a document was matched to the payment (scripts/import-statement)
  --   rule     a pattern in `personal_rules` matched the statement's description
  --   by hand  someone decided, and nothing may overwrite that
  --
  -- The default is `by hand`, because a row inserted without saying where it
  -- came from was put there by a person.
  source         TEXT NOT NULL DEFAULT 'by hand'
                 CHECK (source IN ('invoice', 'rule', 'by hand')),

  -- Apportionment, for a cost that is only partly business — a phone bill, a
  -- home-office share. NULL, the normal case, claims the whole payment. Stored
  -- positive: `transactions.amount` is negative for money out, and this is read
  -- as an amount claimed rather than as a movement.
  deductible_amount NUMERIC(12,2) CHECK (deductible_amount > 0),

  -- What the money was for. Required of a deduction — it is the one thing a
  -- claim cannot be defended without, and the thing that is impossible to
  -- reconstruct a year later, so it is demanded while it is still known. NOT
  -- required of a personal row: what a private payment was for is nobody's
  -- business, and demanding it would make marking a month's groceries a writing
  -- exercise.
  purpose        TEXT,

  -- Kind of expense, for grouping at tax time (materials, packaging, postage,
  -- studio rent, bank charges, …). Free text: the categories that matter are the
  -- ones the accountant asks for, and a CHECK here would just have to be
  -- migrated every time that list changed.
  expense_type   TEXT,

  -- The supporting document. A deduction has to be substantiated on request and
  -- the document kept for five years, so record who issued it, its number and
  -- its own date (an invoice is often dated before the payment clears), and a
  -- link to wherever the scan is filed. `proof_url` NULL means the claim is made
  -- but the paperwork is not filed yet — worth querying for before year end.
  supplier       TEXT,
  invoice_number TEXT,
  invoice_date   DATE,
  proof_url      TEXT,

  note           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT business_needs_purpose
    CHECK (kind <> 'business' OR purpose IS NOT NULL),

  CONSTRAINT personal_claims_nothing
    CHECK (kind <> 'personal' OR (
      purpose           IS NULL AND
      deductible_amount IS NULL AND
      expense_type      IS NULL AND
      supplier          IS NULL AND
      invoice_number    IS NULL AND
      invoice_date      IS NULL AND
      proof_url         IS NULL
    ))
);

-- Reading the books by kind — "what did I claim", "what is still unclassified" —
-- is the query this table exists to answer, and the one the primary key cannot
-- help with.
CREATE INDEX IF NOT EXISTS transaction_classifications_kind_idx
  ON transaction_classifications (kind);

ALTER TABLE transaction_classifications ENABLE ROW LEVEL SECURITY;

-- Two rules a CHECK cannot express, because both need the referenced row. Both
-- are about deductions, so both apply to business rows only: money IN can be
-- personal — a private transfer into the account is money that arrived and is
-- not the business's — it simply can never be claimed.
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

DROP TRIGGER IF EXISTS classification_validate ON transaction_classifications;
CREATE TRIGGER classification_validate
  BEFORE INSERT OR UPDATE ON transaction_classifications
  FOR EACH ROW EXECUTE FUNCTION classification_validate();

-- ===========================================================================
-- The rules that recognise personal transactions.
-- ===========================================================================
--
-- A business expense is claimed one document at a time, because each one has to
-- be substantiated. Personal spending is the opposite shape: there is nothing to
-- substantiate, there is far more of it, and what identifies it is the
-- statement's own words — Pick n Pay is Pick n Pay every month.
--
-- So it is recognised by pattern, and the patterns live HERE rather than in a
-- file next to the importer. They are data the owner edits and the books depend
-- on, they belong to the account rather than to whichever machine ran the last
-- import, and keeping them here is also what lets the rules be applied by the
-- database itself (below) — the importer holds no key that could read them.
--
-- Rules only ever mark things PERSONAL. A deduction needs a document behind it,
-- and a pattern in a description is not one; allowing a rule to claim would
-- quietly undo the thing the rest of this file is careful about.
CREATE TABLE IF NOT EXISTS personal_rules (
  id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- Case-insensitive substring of the transaction's description: 'pick n pay'.
  match    TEXT,
  -- The bank's own category for the row, matched whole: 'Groceries'. Capitec
  -- categorises most card purchases, which makes this the broader lever.
  category TEXT,

  -- What to record on the rows it marks — 'household groceries'. Optional.
  note     TEXT,

  -- Lower runs first. Where two rules match one transaction the more specific
  -- one should win, and nothing but an ordering can say which that is.
  priority INTEGER NOT NULL DEFAULT 100,

  -- A rule switched off rather than deleted keeps its place and its note, which
  -- is what you want while working out whether it was right.
  enabled  BOOLEAN NOT NULL DEFAULT TRUE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A rule with neither test would match the entire ledger, claimed payments
  -- and all. There is no reading of that which is not a mistake.
  CONSTRAINT rule_matches_something CHECK (match IS NOT NULL OR category IS NOT NULL)
);

ALTER TABLE personal_rules ENABLE ROW LEVEL SECURITY;

-- apply_personal_rules marks every transaction a rule recognises, and returns
-- what it did alongside what is still unaccounted for.
--
-- It only ever fills in a transaction that has NO classification yet, which is
-- the whole of its safety: a rule can never overwrite an invoice-backed claim,
-- and it can never overwrite a decision someone made by hand. Evidence first,
-- habit second.
--
-- Called by `import-transactions` after every import, so a rule added today
-- takes effect on the next one without anything else being run; and callable by
-- hand after editing the rules, to sweep the ledger already on record:
--
--   SELECT * FROM apply_personal_rules();
CREATE OR REPLACE FUNCTION apply_personal_rules()
RETURNS TABLE (marked INTEGER, unclassified INTEGER)
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_marked INTEGER;
BEGIN
  WITH unclassified AS (
    SELECT t.id, t.description, t.category
      FROM transactions t
     WHERE NOT EXISTS (
       SELECT 1 FROM transaction_classifications c WHERE c.transaction_id = t.id
     )
  ),
  -- The first rule that matches, by priority then by age, so the file of rules
  -- reads top to bottom the way its author meant it to.
  hits AS (
    SELECT DISTINCT ON (u.id) u.id, r.note
      FROM unclassified u
      JOIN personal_rules r
        ON r.enabled
       AND (r.match    IS NULL OR u.description ILIKE '%' || r.match || '%')
       AND (r.category IS NULL OR lower(btrim(u.category)) = lower(btrim(r.category)))
     ORDER BY u.id, r.priority, r.id
  )
  INSERT INTO transaction_classifications (transaction_id, kind, source, note)
  SELECT id, 'personal', 'rule', note FROM hits
  ON CONFLICT (transaction_id) DO NOTHING;

  GET DIAGNOSTICS v_marked = ROW_COUNT;

  RETURN QUERY
  SELECT v_marked, (
    SELECT COUNT(*)::INTEGER FROM transactions t
     WHERE NOT EXISTS (
       SELECT 1 FROM transaction_classifications c WHERE c.transaction_id = t.id
     )
  );
END;
$$;

-- ===========================================================================
-- The monthly summary.
-- ===========================================================================
--
-- The ledger answers "what moved", one row at a time. This answers it a month at
-- a time:
--
--   income             everything that came in — every credit
--   expenses           everything that went out — every debit, fees included
--   business_expenses  the slice of those expenses claimed as deductible
--   personal_expenses  the slice marked personal
--   personal_income    the credits marked personal
--   transaction_count  every transaction in the month, classified or not
--   classified_count   how many of them have been said to be one or the other
--
-- `income` and `expenses` are the month's two RAW sides and are deliberately
-- left that way: marking something personal does not remove it from them, so
-- `income - expenses` still steps through the same figures as the statement's
-- own balance chain — which is what makes the summary checkable against the PDF,
-- and would be lost by filtering. The classified slices sit alongside instead.
--
-- Counting every credit as income is the deliberate simple case: a transfer in
-- from savings reads as income until it is marked personal, and then it is still
-- in `income` but also in `personal_income`, where it can be netted off.
--
-- `classified_count` is a COUNT and not a total on purpose: once
-- `deductible_amount` apportions a payment, no arithmetic on the money columns
-- can say what is left to look at, because the unclaimed part of an apportioned
-- payment is neither claimed nor personal. Counts answer "have I been through
-- September?" exactly; money cannot.
CREATE TABLE IF NOT EXISTS monthly_aggregations (
  month             DATE          PRIMARY KEY,   -- first day of the month
  income            NUMERIC(12,2) NOT NULL DEFAULT 0,
  expenses          NUMERIC(12,2) NOT NULL DEFAULT 0,  -- positive: a total spent
  business_expenses NUMERIC(12,2) NOT NULL DEFAULT 0,
  personal_expenses NUMERIC(12,2) NOT NULL DEFAULT 0,
  personal_income   NUMERIC(12,2) NOT NULL DEFAULT 0,
  transaction_count INTEGER       NOT NULL DEFAULT 0,
  classified_count  INTEGER       NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

ALTER TABLE monthly_aggregations ENABLE ROW LEVEL SECURITY;

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
  INSERT INTO monthly_aggregations (
    month, income, expenses, business_expenses,
    personal_expenses, personal_income, transaction_count, classified_count, updated_at
  )
  SELECT
    date_trunc('month', t.transaction_date)::date,
    COALESCE(SUM(t.amount)  FILTER (WHERE t.amount > 0), 0),
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
-- Keeping the summary current.
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

-- Classifying, reclassifying or withdrawing changes its month's total, so it
-- refreshes the same way. The month comes from the referenced transaction — the
-- classification carries no date of its own, on purpose: an expense belongs to
-- the month the money moved, like everything else here.
CREATE OR REPLACE FUNCTION classifications_refresh_aggregations()
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
  -- since re-pointing a classification at another transaction changes two months.
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

DROP TRIGGER IF EXISTS classifications_aggregate_insert ON transaction_classifications;
CREATE TRIGGER classifications_aggregate_insert
  AFTER INSERT ON transaction_classifications
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION classifications_refresh_aggregations();

DROP TRIGGER IF EXISTS classifications_aggregate_update ON transaction_classifications;
CREATE TRIGGER classifications_aggregate_update
  AFTER UPDATE ON transaction_classifications
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION classifications_refresh_aggregations();

DROP TRIGGER IF EXISTS classifications_aggregate_delete ON transaction_classifications;
CREATE TRIGGER classifications_aggregate_delete
  AFTER DELETE ON transaction_classifications
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION classifications_refresh_aggregations();

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

DROP TRIGGER IF EXISTS classifications_aggregate_truncate ON transaction_classifications;
CREATE TRIGGER classifications_aggregate_truncate
  AFTER TRUNCATE ON transaction_classifications
  FOR EACH STATEMENT EXECUTE FUNCTION refresh_monthly_aggregations_all();

-- Backfill for an existing ledger. A no-op on a fresh database, and idempotent,
-- so re-running this file simply recomputes what is already correct.
SELECT refresh_monthly_aggregations();
