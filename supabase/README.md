# Supabase back-end

The production catalogue, checkout/orders, mailing list, and page-visit metrics
live in Supabase. The offline `dev` build never touches it — it seeds the same
catalogue data from `ui/demo.js`.

The schema is **five migrations**: `db/001_catalog.sql` for the public,
read-only product catalogue, `db/002_sessions.sql` for everything the site
writes — `sessions` (the hub) plus every table that references it (`orders`,
`subscriptions`, `page_visits`) and the shared `rate_limits` — and, for the
books, which the site never touches at all, `db/003_transactions.sql` (the bank
ledger), `db/004_monthly_aggregations.sql` (the month-by-month summary derived
from it) and `db/005_classifications.sql` (what each transaction was — business
or personal — which generalises 004's `business_expenses` into
`transaction_classifications`). See *Bank transactions* and *Monthly
aggregations* below.

## Sessions (the hub)

`sessions` is the single home for everything describing a visitor's browser: the
client token, the salted **IP hash**, the **environment** (`sandbox` for the
staging origin, `live` for production), the user agent, the coarse geolocation,
and the ISP / network (`isp` / `asn`). None of that is duplicated onto the other
tables — they carry a `session_id` and read those attributes through it:

- **`orders`** — `NOT NULL`, `ON DELETE RESTRICT` (an order is always tied to a
  session, which cannot be purged while the order exists — so the order's env is
  always reachable).
- **`subscriptions`** — nullable, `ON DELETE SET NULL` (best-effort link).
- **`page_visits`** — `NOT NULL`, `ON DELETE CASCADE` (visits die with their session).

`rate_limits` is the one exception: it is infrastructure keyed by the transient
IP hash (never a stored session column), so a client can't reset its allowance by
rotating its session token — it does **not** reference `sessions`.

A session is written by `track` on every page visit, and resolved-or-created by
`create-order` too, so an order always has one. All of `db/002_sessions.sql` is
service-role only (RLS on, no policies); the edge functions are the only write path.

## Catalogue

The catalogue is **public, read-only** data, served **straight from the Supabase
REST API** (PostgREST) — no edge function.

- **`../db/001_catalog.sql`** — schema + seed for the catalogue
  (`categories`, `category_tiers`, `print_editions`, `products`,
  `product_variants`). Each table has RLS enabled with a permissive `SELECT`
  policy and `SELECT` granted to `anon`/`authenticated`; no write access.
- **`ui/shared.js`** (inside the `//online` block) fetches the tables directly
  with the publishable key and reshapes them into the `demo.js` shape.

### Setup (once the project exists)

1. **Run the schema + seed.** Paste `db/001_catalog.sql` into the Supabase SQL
   editor and run it (or `supabase db push` with the CLI). It is idempotent
   (`CREATE ... IF NOT EXISTS`, `DROP POLICY IF EXISTS` + `CREATE POLICY`,
   `INSERT ... ON CONFLICT DO NOTHING`).
2. **Point the site at the project.** In `ui/shared.js` (`//online` block), set
   `SUPABASE_URL` → `https://<project-ref>.supabase.co` and `SUPABASE_ANON` →
   the project's **publishable** key. These are public and ship in the
   production bundle; until they are set the catalogue fetch is a guarded no-op.

No CORS setup is needed — the Supabase REST API sends permissive CORS headers.
The reshaped payload matches `ui/demo.js` exactly, so the site renders the same
whether the data came from Supabase (prod) or the demo seed (dev).

## Checkout (guest, PayFast)

Orders are **user data** — restrictive RLS, no public policies — written only by
the edge functions (service role). Buyers check out as guests (no login).

- **`../db/002_sessions.sql`** — defines the `orders` table (RLS on, no policies),
  which references `sessions`. There is **no `env` column on orders** — the env
  lives on the order's session (see *Sessions* above).
- **`functions/create-order/`** — re-prices the cart from the catalogue, resolves
  or creates the browsing session (tagging it with the env from the origin),
  inserts a pending order tied to that session, and returns the signed PayFast
  fields. Called by the browser.
- **`functions/payfast-notify/`** — PayFast's ITN endpoint; verifies signature,
  validates with PayFast, checks the amount, and marks the order paid. The only
  thing that flips an order to `paid`. On that first transition it also sends the
  buyer the **notice-of-order email** (see below).
- **`config.toml`** — sets `verify_jwt = false` for both functions.

### Notice-of-order email (Gmail API)

When `payfast-notify` marks an order `paid` for the first time it emails the
buyer an **HTML invoice** (an order confirmation / receipt — the business is not
VAT-registered, so it is not a tax invoice). The send:

- is built from the stored order snapshot (`items`, `subtotal`, `shipping`,
  `amount`, buyer + shipping details), so nothing is recomputed;
- fires **once** — the `already paid` guard short-circuits repeat ITNs;
- is **best-effort** — any mail failure is logged and swallowed, never failing
  the ITN (the order is paid regardless);
- **no-ops silently** unless the `GMAIL_*` secrets below are set, so checkout
  works before email is wired up.

Mail is sent through the **Gmail API** (pure HTTPS, no SMTP) as a Google
Workspace mailbox, authenticated with an **OAuth 2.0 client + refresh token**
that the mailbox owner consented once (scope `gmail.send`) — the reliable
transport from the edge runtime. A refresh token is used **instead of a
service-account key** so this works under orgs that disable service-account key
creation (`iam.managed.disableServiceAccountKeyCreation`). One project serves
both environments, so a paid **sandbox** (staging) test order emails too — test
with an address you control.

**Google setup (once):**

1. In a Google Cloud project, **enable the Gmail API**.
2. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   (configure the consent screen as **Internal** if prompted, so the refresh
   token doesn't expire on the 7-day "testing" clock). Note the **client ID**
   and **client secret**.
3. **Consent once** as the sending mailbox (e.g. `orders@wherethereslight.co.za`)
   for the single scope `https://www.googleapis.com/auth/gmail.send`, requesting
   **offline access**, and capture the **refresh token** it returns. (The
   [OAuth 2.0 Playground](https://developers.google.com/oauthplayground/) with
   "Use your own OAuth credentials" is the quickest way; make sure the
   client's authorized redirect URI includes the Playground.)

**Function secrets:**

- `GMAIL_SENDER` — the mailbox that consented / sends (e.g. `orders@wherethereslight.co.za`).
- `GMAIL_CLIENT_ID` — the OAuth 2.0 client ID.
- `GMAIL_CLIENT_SECRET` — the OAuth 2.0 client secret.
- `GMAIL_REFRESH_TOKEN` — the refresh token from the one-time consent.
- `ORDER_EMAIL_BCC` — optional; BCC a copy of every order email here.

### Setup

1. **Run the migration** — paste `db/002_sessions.sql` into the SQL editor (it
   defines `orders` and its `sessions` hub). One project serves both
   environments. The edge functions choose PayFast **sandbox vs live from the
   request origin** — `staging.wherethereslight.co.za` → sandbox,
   `wherethereslight.co.za` → live — and tag the order's **session** with that
   env, so test and real orders stay distinguishable and `payfast-notify`
   verifies each against the right PayFast.

2. **Set function secrets** (Project → Edge Functions → Secrets, or
   `supabase secrets set`):
   - **Sandbox** (staging origin) — optional; defaults to PayFast's public
     sandbox merchant if unset: `PF_SANDBOX_MERCHANT_ID`,
     `PF_SANDBOX_MERCHANT_KEY`, `PF_SANDBOX_PASSPHRASE`.
   - **Live** (prod origin): `PF_MERCHANT_ID`, `PF_MERCHANT_KEY`, `PF_PASSPHRASE`.
     Until these are set, checkout from the production origin returns "Payments
     are not configured" (staging keeps working on the sandbox defaults).
   - `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are provided automatically.
   - Return/cancel URLs are derived from the request origin — no `SITE_URL` needed.
   - **Order email** (optional) — `GMAIL_SENDER`, `GMAIL_CLIENT_ID`,
     `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` (and optional `ORDER_EMAIL_BCC`)
     to email the buyer a notice-of-order invoice on payment. See *Notice-of-order
     email* above; unset means no email is sent.
3. **Deploy the functions with JWT verification off** (or toggle "Verify JWT"
   off for both in the dashboard):

   ```bash
   supabase functions deploy create-order   --no-verify-jwt
   supabase functions deploy payfast-notify  --no-verify-jwt
   ```

4. **Test from staging** end-to-end (add to cart → checkout → PayFast sandbox →
   ITN marks the order `paid`). When ready, set the live credentials and
   production checkout goes live automatically — no flag to flip.

The browser calls these with the publishable key; `create-order` recomputes the
price server-side, so a tampered cart can never change what is charged.

## Bank transactions

The **`transactions`** table is the running bank ledger — what actually moved
through the Capitec business account, which is how much cash is really available
and how much of it is owed as tax. It is imported from the statement PDFs, not
derived from `orders`: an order is what a buyer *owes*, a transaction is money
that *arrived*, and the two do not line up (fees, transfers, refunds, cash).
Nothing in the shipped site reads or writes this table.

- **`../db/003_transactions.sql`** — the schema. RLS on with no policies, like
  everything in `002`, so only the service role touches it.
- **`functions/import-transactions/`** — the only write path. Validates every
  row and upserts with `ON CONFLICT DO NOTHING`, returning how many rows were
  actually new.
- **`../scripts/import-statement/`** — a Go program that parses a statement PDF
  locally and POSTs the parsed rows to that function.

### Why the import is idempotent

Statements overlap — a September statement repeats the last days of August — and
the same PDF gets re-downloaded. Every import is therefore an upsert against the
natural key `(transaction_date, description, amount, raw_reference)`, and the
importer reports inserted-vs-skipped so a re-run is visibly a no-op.

`raw_reference` is the statement line verbatim, **including the running
balance**, and that is what makes the key work: two genuine purchases on the same
day, for the same amount, at the same shop are identical in every other column,
and the balance is the only thing that separates them. `source_statement` is
deliberately *not* in the key, so the same transaction arriving in two different
statements still de-duplicates.

### What the parser does

The table is read by **column position**, not by splitting text. The PDF gives
every fragment an x coordinate, and the table's header row

```
Date  Description  Category  Money In  Money Out  Fee*  Balance
```

supplies an anchor for each column, so each fragment is assigned to whichever
column it sits under. The anchors are read off the header on every page rather
than hard-coded, so a layout shift moves them with it.

Positions matter because the columns cannot be told apart from the text alone:
Money In and Money Out are both plain signed amounts, and a row may carry any
combination of amount, fee and balance. It is also how a long description that
wraps onto its own line is rejoined rather than mistaken for a new row — the
wrapped fragment carries the description column's x, so it appends to the
description (and a wrapped *category* appends to the category).

Three things are worth knowing about the output:

- **Fees become their own rows.** The schema has a single `amount`, and the
  statement's `Fee*` column is a real separate debit, so a row carrying both
  yields a second transaction (`<description> (fee)`, `transaction_type` `fee`).
  That is what keeps the amounts summing back to the closing balance. A row that
  is *only* a fee — a card-issue fee, say, which posts into `Fee*` with no Money
  In or Money Out — stays one transaction, typed `fee`.
- **The rightmost number is always the balance.** Amounts are right-aligned, so a
  large enough balance starts under the `Fee*` anchor; taking the rightmost
  removes that ambiguity regardless of width.
- **The balance chain is checked.** Every row's amount plus its fee must be
  exactly the step from the previous printed balance to this one. A row that
  does not reconcile is reported as a warning rather than silently imported
  wrong — which is also the proof that the columns were assigned correctly, so a
  layout change surfaces as a warning instead of a wrong number.

**Pending card transactions are skipped**: they have not been posted to the
balance yet, and they arrive again as real rows on the next statement.

`go test ./scripts/import-statement/` covers the column logic with synthetic
rows — no statement fixture, so the tests carry no real data.

### Invoices — read in two steps, matched to a payment

A statement row says money left the account; it never says what for. That is what
the supplier's invoice carries, and it is what a deduction cannot be defended
without — see *Business expenses* under *Monthly aggregations* below.

Invoices are **not parsed**, which is the opposite choice to the statement next
door and for the opposite reason. The statement is one bank's fixed layout, so
its columns can be read by position and checked against the printed balance
chain. An invoice is whatever the supplier's software prints — a table, a
letterhead, a photo of a till slip — and there is no second figure to check it
against, so there is nothing for a parser to lock onto. Reading one is a
judgement, and the importer does not make it.

So the job splits in half, with the reader in between:

```bash
# 1. Write the worksheet: every invoice's text, with the statement's payments.
go run . --invoices ../../data/invoices --prepare sheet.json statement.pdf

# 2. Something reads it and writes the readings (below).

# 3. Import the statement, claiming what the readings can be matched to.
go run . --invoices ../../data/invoices --readings readings.json statement.pdf
```

**The worksheet** (`--prepare`) carries, per file, the text laid out as the PDF
lays it out — the same reader the statement uses, so nothing extra is installed
— or `needs_image: true` when there was no text to pull out, which is a
photograph or a scan with no text layer. Two more flags say how far to trust
what came out: `text_partial` when some of it extracted as gibberish (a PDF can
carry a font with no map back to real characters, and it is often the printed
labels and dates that go while the amounts come through), and `pdf_created`, the
file's own timestamp — *not* the invoice's date, since the file may be generated
or emailed days after the sale, but it bounds a date that will not decode. It
also carries a `reading_template`, a `how_to_fill` note, and the statement's
payments for context, and writes nothing to the ledger.

Some generators emit every glyph as its own fragment, which would extract as
`T A X I N V O I C E`. The fragments carry their x positions, so each gap is
compared against the line's own median to tell a space from a letter's width.
The threshold leans towards joining rather than splitting — it would rather
print `TAXINVOICE` than break a number in half — so occasionally two words run
together, while the columns of a table, whose gaps are many times wider, always
separate.

**The readings** are one filled-in record per invoice: total, currency, invoice
date, supplier, what was bought, invoice number, expense type, and an optional
`note`.

```json
{ "invoices": [ {
  "file": "orms-1041.pdf", "is_invoice": true, "total": 588.00, "currency": "ZAR",
  "invoice_date": "2026-09-02", "supplier": "Orms Pty Ltd",
  "purpose": "A2 canvas prints × 3", "invoice_number": "INV-1041",
  "expense_type": "materials", "note": "date taken from the PDF timestamp"
} ] }
```

The `note` is where anything the reader had to qualify goes — a field that would
not decode, a value taken from somewhere other than the document. It is filed
with the claim, alongside the filename, because the claim is what gets defended
later and the worksheet is not kept.

A **Claude Code session** with the folder open is what the worksheet is built
for: it reads the text, opens the files flagged `needs_image`, and writes the
readings. A person with a text editor works exactly as well. Either way nothing
here calls an API, holds a key, or sends an invoice anywhere — the invoices and
the statement both stay on the machine.

The readings are checked rather than trusted. A record naming a file that is not
in the folder, or naming one twice, or carrying a misspelt field, is refused
outright; one without a total, a date or a description of what was bought is
reported and skipped, as is a total in a currency other than rands. An invoice in
the folder with **no reading at all** is reported too — it would otherwise go
quietly unclaimed, which is the kind of thing nobody notices until tax time.

What a reading says is still **unverified** in a way the parsed statement never
is, however careful the reader was. That is what the match is for.

#### The match is the check

An invoice is only ever claimed against a payment of **its total**, made within
`--match-window` days of the invoice's own date (14 by default). Where that
leaves more than one candidate, the supplier's name is compared against the
statement's description to separate them — the bank's own vocabulary ("Banking
App External Payment") is ignored, since it appears on every row. Anything still
ambiguous is reported and left alone:

- two payments equally good — neither is claimed;
- two invoices matching the same payment — **both** are withdrawn, because one
  payment backs at most one claim and nothing here can say which invoice it is;
- a total that matches nothing — reported, saying whether that amount appears
  elsewhere in the statement (usually a date outside the window).

So a misread total matches nothing and is printed rather than filed. That is the
whole safeguard, and it is why the amount does nearly all the work: a wrong claim
is invisible once it is in the books, an unclaimed invoice is not. When nothing
is close enough, the report names the closest payment in the window and how far
off it was — which is the number to check the document against.

**Rounding.** Payments are rounded in practice: an Orms invoice for R195.99 is
settled with R196.00, and the cent is evidence of nothing. `--amount-tolerance`
is how much of that is allowed, **R1.00** by default — enough for a payment
rounded to the rand, small enough that it rarely reaches a second payment. A
payment matching to the cent always outranks one that needed the tolerance, and
every claim that used it says so in the listing:

```
CU15076682J-1.pdf   195.99  Orms (Pty) Ltd — bevel box 100×100mm, white
  → 2026-09-04  -196.00  …PayShap Payment: Orms Pty Ltd (paid 3 days earlier, 0.01 more than the invoice)
```

That line is what keeps the allowance honest — a rounded match is never silent.
`--amount-tolerance 0` restores matching to the cent.

The matching is in Go, from the amounts and dates alone, and whoever read the
invoices gets no say in it: they write down what a document says, and the ledger
decides whether a payment agrees. It is also why claiming belongs to this command
rather than a separate one — the payments an invoice is matched against are the
ones the statement scan has just produced.

#### Bank charges follow their payment

A bank charge has no invoice and never will, so nothing above can reach it — and
it needs none. The parser splits a statement line carrying both an amount and a
`Fee*` into two transactions, the payment and `<description> (fee)`, so the
charge **is** the same line as the payment: a stronger link than any invoice
match, since it is not inferred at all but how the row came to exist. A charge
for making a payment that is deductible is deductible on the same grounds, so
each claimed payment's charge is claimed with it:

```
  → 2026-09-04  -196.00  …PayShap Payment: Orms Pty Ltd (paid 3 days earlier, 0.01 more than the invoice)
  + 2026-09-04    -6.00  …PayShap Payment: Orms Pty Ltd (fee)
```

The charge is never claimed on its own, so the charges on private payments are
not swept up. It carries `expense_type: bank charges`, a purpose naming the
payment it was charged on, and none of the invoice's own identifiers — no
document covers the charge, and recording a supplier's invoice number against it
would say one does. `--claim-fees=false` leaves charges alone.

#### What gets written

Each match is posted **with the statement, in the same request**, as a
`transaction_classifications` row: `purpose` from what was bought, plus `supplier`,
`invoice_number`, `invoice_date` and `expense_type` as read, and `note` naming
the file it came from. The claim identifies its payment by the `transactions`
natural key rather than by id — the importer never reads the database, so it has
no id to send — and `import-transactions` resolves it, which also means an
invoice can claim a payment that arrived with an earlier, overlapping statement.
Claims are `ON CONFLICT DO NOTHING` on the one-claim-per-transaction `UNIQUE`, so
re-running an import re-claims nothing and the monthly totals do not move.

`deductible_amount` is left `NULL` — the whole payment is claimed, which is what
matching the exact total means. A cost that is only partly business is
apportioned by hand. `proof_url` is left `NULL` too, since the scan stays in the
Drive folder; `note` records which file it was.

`go test ./scripts/import-statement/` covers the matching rules with synthetic
invoices and rows, and the readings file with every way it can be wrong.

### Personal transactions — marked by rule

A business expense is claimed one document at a time, because each one has to be
substantiated. Personal spending is the opposite shape: there is nothing to
substantiate, there is far more of it, and what identifies it is the statement's
own description — Pick n Pay is Pick n Pay every month. So it is marked by rule,
from a file you keep:

```json
{ "rules": [
  { "category": "Groceries", "note": "household groceries" },
  { "category": "Fuel",      "note": "private vehicle" },
  { "match": "wizardz",      "note": "school" }
] }
```

`match` is a case-insensitive substring of the description; `category` is the
bank's own category for the row, matched whole — Capitec categorises most card
purchases, which makes it the broader lever. Give a rule both and both must
match. A rule with neither is refused rather than matching the whole statement,
and so is a misspelt field name, since `"matches"` would silently become exactly
that. The first rule that matches a transaction wins, so the file reads top to
bottom.

```bash
go run . --personal ../../data/personal-rules.json statement.pdf
```

The rules run **after** the invoices and never touch a payment they claimed: an
invoice matched to a payment is evidence, a pattern in a description is a habit,
and where they disagree the evidence wins without argument. The row a rule writes
carries `source: rule` and nothing else but its note — no purpose, no supplier,
no invoice — so it can never be mistaken for a claim, and a row someone decided
by hand (`source: by hand`) can be told from one a pattern decided.

The report is the point of it:

```
Marked 15 transaction(s) personal from personal-rules.json
  Groceries                          10
  Fuel                               2
  …
  26 transaction(s) in this statement were neither claimed nor matched by a rule
```

That last number is what marking personal is *for*. An unclassified transaction
means either personal or not looked at yet, and only saying which turns "I
imported September" into "I have been through September". A rule that recognised
nothing is reported too — a rule for a shop you no longer use is worth knowing
about. The count is deliberately phrased as "neither claimed nor matched" rather
than "unclassified": this run cannot see what was classified before it, and
saying more than it knows is how a books tool starts lying.

The rules file lives in `data/` with the statements and invoices, git-ignored:
it is a list of where the household shops.

### Using it

Statements and supplier invoices are downloaded from the **`Account` folder
shared on Google Drive** (where they now live) into `data/statements/` and
`data/invoices/`. All of `data/` is **git-ignored** — a bank statement or an
invoice must never be committed. The password
(Capitec uses the last four digits of the registered mobile number) is read from
an environment variable, never an argument, so it stays out of shell history;
leave it unset for an unencrypted statement.

```bash
cd scripts/import-statement

# Parse and check, writing nothing. Do this first.
go run . --dry-run ../../data/statements/account_statement.pdf

# Import.
export IMPORT_TOKEN=…            # the function secret, below
export STATEMENT_PASSWORD=…      # only if the PDF is encrypted
go run . ../../data/statements/account_statement.pdf

# With the invoices that go with it — see Invoices above for the middle step.
go run . --invoices ../../data/invoices --prepare  sheet.json    ../../data/statements/account_statement.pdf
go run . --invoices ../../data/invoices --readings readings.json ../../data/statements/account_statement.pdf --dry-run
go run . --invoices ../../data/invoices --readings readings.json ../../data/statements/account_statement.pdf

# And the personal ones, in the same run.
go run . --invoices ../../data/invoices --readings readings.json \
         --personal ../../data/personal-rules.json ../../data/statements/account_statement.pdf
```

`go build -o import-statement .` gives a standalone binary instead, which needs
no Go on the machine that runs it.

It prints the statement's totals (money in, money out, net), which should match
the summary boxes printed on page 1 — the quickest way to confirm a clean parse
— and then `inserted` / `skipped`.

`--source NAME` overrides the `source_statement` label (it defaults to the
filename); `--password-env VAR` reads the password from a different variable; and
`--match-window N` widens or narrows how far an invoice may sit from its
payment, `--amount-tolerance N` how much rounding is allowed between an invoice's
total and what was paid, and `--personal FILE` marks the personal transactions
from a rules file.
The only dependency is `github.com/ledongthuc/pdf` (BSD, no transitive deps),
which reads both AES- and RC4-encrypted statements, and reads the invoices too.

### Setup

1. **Run the migration** — paste `db/003_transactions.sql` into the SQL editor
   (or `supabase db push`). Idempotent.
2. **Set the import secret.** This function is not called by the browser, so it
   has no origin allowlist; the shared secret is its only authentication, and
   while it is unset the endpoint refuses everything (`503`) — it fails closed,
   so deploying before setting the secret cannot open a write path.

   ```bash
   supabase secrets set IMPORT_TOKEN="$(openssl rand -hex 32)"
   ```

3. **Deploy with JWT verification off** (the importer holds no Supabase key):

   ```bash
   supabase functions deploy import-transactions --no-verify-jwt
   ```

   Redeploy it before the first `--invoices` run: a deployment predating the
   claims ignores them and files nothing. The importer says so when it happens,
   rather than reporting a clean import that claimed nothing.

Nothing here is given a service-role key: the machine running the import holds
only `IMPORT_TOKEN`, which can do exactly one thing — append statement rows.

## Monthly aggregations

`transactions` answers *what moved*, one row at a time. **`monthly_aggregations`**
answers it a month at a time — one row per calendar month:

| column | meaning |
| --- | --- |
| `month` | first day of the month (the primary key) |
| `income` | everything that came in — every credit |
| `expenses` | everything that went out — every debit, fees included |
| `business_expenses` | the slice of those expenses claimed as deductible |
| `personal_expenses` | the slice marked personal, as a positive total |
| `personal_income` | the month's credits marked personal |
| `transaction_count` | every transaction in the month, classified or not — how you tell "no income" from "never imported" |
| `classified_count` | how many of them have been said to be business or personal — how you tell "been through it" from "imported it" |

`income` and `expenses` are the month's two raw sides, so `income - expenses` is
its net movement — the same figure the statement's own balance chain steps
through, which is what makes the summary checkable against the PDF.
`business_expenses` and `personal_expenses` are both **subsets** of `expenses`,
never separate totals: a claim or a mark is made against a debit and can never
exceed it. Marking something personal deliberately does **not** remove it from
`income` or `expenses` — those stay the month's two raw sides, so the summary
stays checkable against the statement's own balance chain, which is the one
property that would be lost by filtering them.

Nothing but the classification asks anything of you.

### Income and expenses — counted, not classified

Both are taken straight off the ledger: `income` is every credit in the month,
`expenses` every debit. Nothing has to be said about a transaction for its month
to be summarised.

That is the deliberate simple case rather than an oversight: it does mean a
transfer in from savings reads as income, and a transfer out to savings as an
expense. If that starts to matter, the place to fix it is the income (or
expenses) filter in `refresh_monthly_aggregations`, fed by whatever says a credit
is not income — a rule per bank category, a column on `transactions`, or both.

### Classifications — what each transaction was

**`transaction_classifications`** (`db/005_classifications.sql`) holds one row
per transaction saying what it was: `kind` is `business` or `personal`. The two
are one fact with two values, and they are mutually exclusive — a payment is one
or the other, never both — so they share a table, where `transaction_id` being
`UNIQUE` makes that exclusivity free. Two tables would need a pair of
cross-table triggers to say the same thing.

Nothing is deductible until it is **claimed**: a `business` row is the assertion
"this payment was a business expense, and here is what backs it up", and the
month's total is the sum of those rows — never inferred from a description or a
bank category. A `personal` row asserts only "this was not the business's",
which needs no proof and offers none.

What differs between them is evidence, which is why one table does not mean one
shape:

| column | business | personal |
| --- | --- | --- |
| `transaction_id` | the transaction — `UNIQUE`, so nothing is classified twice, and `ON DELETE CASCADE` | same |
| `kind` | `business` | `personal` |
| `source` | how it was decided: `invoice`, `rule` or `by hand` | same |
| `purpose` | what the money was for — **required** | must be `NULL` |
| `deductible_amount` | apportionment for a partly-business cost; `NULL` claims the whole payment | must be `NULL` |
| `expense_type`, `supplier`, `invoice_number`, `invoice_date`, `proof_url` | the supporting document | must be `NULL` |
| `note` | anything else worth recording | same |

`purpose` is required of a deduction because what the money was for is the one
thing it cannot be defended without, and the thing that is impossible to
reconstruct a year later. It is *not* required of a personal row: what a private
payment was for is nobody's business, and demanding it would make marking a
month's groceries a writing exercise. In the other direction, a personal row may
carry none of the document fields — recording a supplier or an invoice number
against one would assert a document covers it that does not. Both are `CHECK`
constraints (`business_needs_purpose`, `personal_claims_nothing`).

```sql
-- A claim, with its proof.
INSERT INTO transaction_classifications
  (transaction_id, kind, source, purpose, expense_type, supplier, invoice_number, invoice_date, proof_url)
VALUES
  (412, 'business', 'by hand', 'Mountboard and glass for the January print run', 'materials',
   'Art Supplies CC', 'INV-2026-0041', '2026-01-11', 'https://…/inv-41.pdf');

-- Not the business's. That is the whole of it.
INSERT INTO transaction_classifications (transaction_id, kind, source, note)
VALUES (413, 'personal', 'by hand', 'school fees');
```

`source` records how the row was decided, which is how far it should be trusted:
`invoice` means a document was matched to the payment, `rule` that a pattern
matched the statement's own description, `by hand` that someone decided. It
defaults to `by hand`, because a row inserted without saying where it came from
was put there by a person.

`proof_url` left `NULL` on a claim means the paperwork is not filed yet, which is
worth querying for before year end — as is what has not been classified at all:

```sql
-- Claimed, but the document is not filed.
SELECT t.transaction_date, t.description, c.purpose
  FROM transaction_classifications c JOIN transactions t ON t.id = c.transaction_id
 WHERE c.kind = 'business' AND c.proof_url IS NULL ORDER BY t.transaction_date;

-- Still to go through.
SELECT t.transaction_date, t.description, t.amount FROM transactions t
 WHERE NOT EXISTS (SELECT 1 FROM transaction_classifications c WHERE c.transaction_id = t.id)
 ORDER BY t.transaction_date;
```

Two rules a `CHECK` cannot express are enforced by a row trigger, because both
need the referenced transaction, and both are about deductions so both apply to
`business` rows only: only **money out** can be claimed (a refund arrives as a
credit, but that reduces an existing claim rather than being one), and
`deductible_amount` can never exceed the payment. Money **in** can be personal —
a private transfer into the account is money that arrived and is not the
business's — it simply can never be claimed.

The claim carries no date of its own — the expense belongs to the month the money
moved, like everything else here.

### How it stays current

Nothing has to be run after an import. **`db/004_monthly_aggregations.sql`** puts
statement-level triggers on `transactions` and on `transaction_classifications`
(insert / update / delete / truncate) that recompute exactly the months affected
— including *both* months when a transaction's date moves across a boundary, or
when a claim is re-pointed at a transaction in another month.

They are **statement**-level rather than row-level on purpose: an import writes a
whole statement in one `INSERT`, and a row-level trigger would recompute the same
month once per row. A re-imported statement where every row already exists
inserts nothing and therefore refreshes nothing.

The whole maintenance path is one idempotent function, so a rebuild by hand is
the same code the triggers run:

```sql
SELECT refresh_monthly_aggregations();                           -- every month
SELECT refresh_monthly_aggregations(ARRAY['2026-01-01'::date]);  -- just January
```

It both upserts months that have transactions and deletes months that no longer
do, so removing the last transaction in a month removes its row rather than
leaving a stale one behind.

### Setup

1. **Run the migrations** — paste `db/004_monthly_aggregations.sql` and then
   `db/005_classifications.sql` into the SQL editor (or `supabase db push`),
   after `db/003_transactions.sql`. Both are idempotent, and each ends by
   backfilling every month already in the ledger, so an existing ledger is
   summarised the moment they run. `005` renames `business_expenses` to
   `transaction_classifications` in place — the claims already in it carry over
   as `kind: business`, `source: invoice`.
2. **Classify as you go** — nothing is required up front; add a row for each
   payment you intend to deduct, or let the importer add it from that payment's
   invoice, and mark the personal ones by rule (*Invoices* and *Personal
   transactions*, above).

Both tables are RLS on with no policies, like the ledger they derive from. The
site never touches either of them, and `monthly_aggregations` has no write path
at all — it is maintained entirely by the triggers above. The one way into
`transaction_classifications` from outside the dashboard is
`import-transactions`, which writes only alongside the statement the transaction
came from.

## Mailing-list subscriptions

Two places collect emails into the `subscriptions` table: the footer's **"Signup
for future communication"** link (`subscribe.html`) and the **"Notify me when
available"** button on the Upcoming page. Like orders, the table is **not
writable with the publishable key** (RLS on, no public policies) — every
subscribe goes through the **`subscribe` edge function**, which writes as service
role. Routing it through a function is what makes it **rate-limited**: the
browser has no write path that skips the limiter, and the address list can never
be read back from the client (only via the dashboard / service role).

Each row records **what** was subscribed to via `subscribe_type`:

- **`1`** — future communication (the footer general list).
- **`2`** — "Grasse van die Veld" availability notification (the Upcoming button).

Uniqueness is per `(email, subscribe_type)`, so one person can be on the general
list and request the Grasse notification independently; a repeat of the same
type is reported as "already on the list".

Each signup is also tied back to the **browsing session** it came from (the
metrics `sessions` row — see *Page-visit metrics* below), via a nullable
`session_id` foreign key, so the owner can see where a signup originated (coarse
location, user agent, first/last seen) without any raw IP on the subscription.
The browser sends the same per-browser metrics token, the function resolves the
session by `(token, ip_hash)` — the same key `track` uses — and the link is
best-effort: it stays null if no matching session is on record yet.

- **`../db/002_sessions.sql`** — defines the `subscriptions` table (RLS on, no
  policies; a `CHECK` validates the email; `subscribe_type` is a `SMALLINT`
  checked to `IN (1, 2)`; a unique index on `(lower(email), subscribe_type)`
  de-dupes; a nullable `session_id` references `sessions`).
- **`functions/subscribe/`** — validates the email, rate-limits by client IP
  **per subscribe type** (default **5 per IP per hour**, counted separately for
  each type so one doesn't lock out the other), resolves the browsing session
  from the token + hashed IP, and inserts the row. A duplicate returns
  `{ ok: true, already: true }`, which the page shows as "already on the list";
  over the limit returns `429`.
- **`ui/shared.js`** (inside the `//online` block) POSTs to
  `functions/v1/subscribe` with the publishable key, including the `wtl_session`
  token so the signup can be attributed to its session.

### Setup

1. Run **`db/002_sessions.sql`** in the SQL editor (or `supabase db push`) if you
   have not already — it defines `subscriptions`, its `sessions` hub, and the
   `rate_limits` limiter. Idempotent.
2. Deploy the function with JWT verification off:

   ```bash
   supabase functions deploy subscribe --no-verify-jwt
   ```

   It needs no extra secrets (`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are
   provided automatically). The dev build strips the online call, so the offline
   preview just acknowledges the form without sending anything.

## Rate limiting

`db/002_sessions.sql` includes a small **fixed-window** rate limiter that any edge
function can use. Edge functions are stateless and may run as several instances,
so the count is kept in the database, where it is incremented atomically:

- **`rate_limits`** table — one row per `(key, window)` bucket, keyed by the
  transient IP hash (**not** the session, so a rotated token can't reset the
  limit); RLS on with no policies (service role only).
- **`rate_limit_hit(key, limit, window_seconds)`** — records a hit and returns
  `allowed` / `remaining` / `retry_after` in a single atomic statement, so
  concurrent callers cannot race past the limit.
- The **`rateLimit(...)` helper** the functions call. Each function carries its
  own copy (edge functions are deployed standalone, so the helpers are duplicated
  rather than shared). It **fails open** (returns `null`) if the limiter itself
  errors, so a transient database problem never blocks genuine requests.

Old buckets are harmless but accumulate; a scheduled job (e.g. pg_cron) can
purge them — see the cleanup query at the foot of `db/002_sessions.sql`.

## Page-visit metrics

Anonymous page-visit tracking, written only by the **`track` edge function**
(service role) — both tables are RLS on with no policies, so the browser can
neither read nor write them, and the owner reads them via the dashboard.

The raw IP is **never stored**. The function uses it only in-memory — to
geolocate the session and as a rate-limit key — and persists only a salted
SHA-256 hash, so a session can't be tied back to an address.

- **`../db/002_sessions.sql`** — defines both:
  - **`sessions`** — one anonymous browser, unique on `(token, ip_hash)`: a
    random token kept in the visitor's `localStorage` paired with the hashed IP,
    tagged with its `env`. Geolocated **once**, when first recorded — coarse
    location plus the network operator (`isp` / `asn`), all best-effort and nullable.
  - **`page_visits`** — one row per page view, referencing a session.
- **`functions/track/`** — pairs the token with the client IP, rate-limits by
  (hashed) IP (**100 visits per IP per 10 min**), geolocates the IP on the
  session's first sight, and appends the visit storing only `ip_hash`. A
  returning session just bumps `last_seen`. Requests whose **User-Agent** looks
  like a bot/crawler (search engines, link-preview unfurlers, uptime monitors,
  headless automation — the `BOT_UA_RE` denylist) are dropped up front with a
  `200 { ok: true, bot: true }` and never recorded, so the metrics count real
  human visits. This is metrics-only filtering: the site is static Pages, so
  crawlers still load every page and **SEO is unaffected**.
- The **`geolocate(...)` helper** inside `functions/track/index.ts` — the IP →
  location lookup. Uses **ipapi.co** (free, no key) by default; override with the
  `GEO_API_URL` / `GEO_API_KEY` function secrets. It is best-effort — any failure
  or a private/unknown IP just stores the session without a location.
- The **`hashIp(...)` helper** — the salted-SHA-256 IP hash, duplicated in
  `subscribe` and `create-order` (both resolve the session by `(token, ip_hash)`,
  and `subscribe` also hashes the IP in its rate-limit key). Set **`IP_HASH_SALT`**
  as a function secret so hashes can't be brute-forced back across the small IPv4
  space — and use the **same salt** for all three functions, or the hashes won't
  match and sessions won't resolve.
- **`ui/shared.js`** (inside the `//online` block) fires a fire-and-forget
  beacon to `functions/v1/track` on every page load. Metrics never block or
  affect the page; the offline `dev` build strips the call entirely.

### Setup

1. Run **`db/002_sessions.sql`** in the SQL editor if you have not already — it
   defines `sessions`, `page_visits`, and the limiter. Idempotent.
2. Deploy the function with JWT verification off:

   ```bash
   supabase functions deploy track --no-verify-jwt
   ```

   Set **`IP_HASH_SALT`** to a long random secret (`supabase secrets set
   IP_HASH_SALT=…`) so IP hashes have real pre-image resistance — the **same**
   salt across `track`, `subscribe`, and `create-order` so sessions resolve.
   `GEO_API_URL` / `GEO_API_KEY` are optional — only to point at a different geo provider.

Both staging and production share one project, so staging visits are recorded
alongside production ones; the geolocation lets you tell them apart if needed.
