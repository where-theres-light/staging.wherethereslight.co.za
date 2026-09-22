import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// import-transactions — appends parsed bank-statement rows to `transactions`.
//
// The transactions table is owner-only (RLS on, no policies), so it is not
// writable with the publishable key. Every import comes through here and is
// written as service role — the same shape as subscribe/track, and the reason
// the statement importer never needs a service-role key on a laptop.
//
// Unlike the other functions this one is NOT called by the browser. It is
// called by scripts/import-statement, which parses the PDF locally and POSTs
// only the extracted rows. There is therefore no origin allowlist and no CORS:
// the caller must present the shared IMPORT_TOKEN secret, and without that
// secret set the endpoint is closed entirely.
//
// Statements overlap, so inserts are ON CONFLICT DO NOTHING against the natural
// key in db/003_transactions.sql. PostgREST returns only the rows that were
// actually inserted, which is how the caller is told inserted-vs-skipped.
//
// The same request may carry `classifications`: what each transaction was. A
// business one is a supplier invoice the importer has tied to a payment in the
// batch (scripts/import-statement/match.go); a personal one is a payment a rule
// recognised. They are written after the rows they reference, and each names its
// transaction by that same natural key rather than by id — the importer never
// reads the database, so it has no id to send, and a key lookup also resolves
// against a transaction that arrived with an earlier, overlapping statement.
// Classifications are ON CONFLICT DO NOTHING too, on the one-per-transaction
// UNIQUE in db/005_classifications.sql, so re-running an import reclassifies
// nothing and the monthly totals are left alone — and an existing row is
// reported rather than overwritten, since the one already there may have been
// put there by hand.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// Shared secret the importer presents as `Authorization: Bearer <token>`.
// Unset means the endpoint refuses everything — it fails closed, so deploying
// the function before setting the secret cannot open a write path.
const IMPORT_TOKEN = (Deno.env.get('IMPORT_TOKEN') ?? '').trim();

const MAX_ROWS = 500;           // rows accepted in one request
const MAX_CLASSIFICATIONS = 500; // classifications accepted in one request
const CONFLICT = 'transaction_date,description,amount,raw_reference';
const CLASSIFICATION_CONFLICT = 'transaction_id';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TYPES = new Set(['credit', 'debit', 'fee']);
const KINDS = new Set(['business', 'personal']);
const SOURCES = new Set(['invoice', 'rule', 'by hand']);

// Everything a business row may carry and a personal one may not: a personal
// payment has no document behind it, so naming a supplier or an invoice number
// on one would assert that it has. The database says the same (see
// `personal_claims_nothing`); this says it first, by field, so the caller is
// told which one it sent rather than being handed a constraint name.
const BUSINESS_ONLY = [
  'purpose', 'deductible_amount', 'expense_type',
  'supplier', 'invoice_number', 'invoice_date',
] as const;

// Length-independent comparison, so a wrong token cannot be narrowed down by
// timing. Both sides are hashed first, which also makes the compare safe for
// strings of differing length.
async function tokenMatches(presented: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(presented)),
    crypto.subtle.digest('SHA-256', enc.encode(IMPORT_TOKEN)),
  ]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// One row as the importer sends it. Anything else on the object is dropped —
// the row written is built field by field, never spread from the request.
interface Incoming {
  transaction_date?: unknown;
  description?: unknown;
  amount?: unknown;
  transaction_type?: unknown;
  category?: unknown;
  raw_reference?: unknown;
}

// One classification as the importer sends it: what the transaction was, how
// that was decided, the invoice's details when there is one, and the transaction
// itself named by the transactions natural key.
interface IncomingClassification {
  transaction?: Incoming;
  kind?: unknown;
  source?: unknown;
  purpose?: unknown;
  supplier?: unknown;
  expense_type?: unknown;
  invoice_number?: unknown;
  invoice_date?: unknown;
  deductible_amount?: unknown;
  note?: unknown;
}

// A classification, validated, still holding the key of the transaction it is
// waiting to be resolved against.
interface PendingClassification {
  key: { transaction_date: string; description: string; amount: number; raw_reference: string };
  row: Record<string, unknown>;
}

function clean(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/\s+/g, ' ');
  return s ? s.slice(0, max) : null;
}

Deno.serve(async (req: Request): Promise<Response> => {
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!IMPORT_TOKEN)         return json({ error: 'Imports are not configured' }, 503);

  const presented = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!presented || !(await tokenMatches(presented))) return json({ error: 'Unauthorized' }, 401);

  let payload: { source_statement?: unknown; transactions?: unknown; classifications?: unknown };
  try { payload = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }

  const source = clean(payload?.source_statement, 200);
  const incoming = payload?.transactions;
  if (!Array.isArray(incoming) || !incoming.length) return json({ error: 'No transactions' }, 400);
  if (incoming.length > MAX_ROWS)                   return json({ error: 'Too many transactions' }, 400);

  // Validate and normalise every row before touching the database. A bad row
  // fails the whole request by index — the importer sends a whole statement, and
  // a half-written statement is worse than a rejected one.
  const rows = [];
  for (let i = 0; i < incoming.length; i++) {
    const t = incoming[i] as Incoming;

    const date = clean(t.transaction_date, 10);
    if (!date || !DATE_RE.test(date) || Number.isNaN(Date.parse(date)))
      return json({ error: `Row ${i}: bad transaction_date` }, 400);

    const description = clean(t.description, 500);
    if (!description) return json({ error: `Row ${i}: missing description` }, 400);

    // The running balance lives in raw_reference and is what makes the natural
    // key unique, so it is required — see db/003_transactions.sql.
    const raw = clean(t.raw_reference, 1000);
    if (!raw) return json({ error: `Row ${i}: missing raw_reference` }, 400);

    const amount = typeof t.amount === 'number' ? t.amount : Number(t.amount);
    if (!Number.isFinite(amount) || Math.abs(amount) >= 1e10)
      return json({ error: `Row ${i}: bad amount` }, 400);

    const type = clean(t.transaction_type, 20);
    if (type && !TYPES.has(type)) return json({ error: `Row ${i}: bad transaction_type` }, 400);

    rows.push({
      transaction_date: date,
      description,
      amount: Math.round(amount * 100) / 100,
      transaction_type: type,
      category: clean(t.category, 100),
      source_statement: source,
      raw_reference: raw,
    });
  }

  // The classifications are validated here, before the transactions are written:
  // the whole request is rejected or none of it is, and a statement half
  // imported with its classifications refused would be the worst of both.
  const classifying = payload?.classifications ?? [];
  if (!Array.isArray(classifying))                 return json({ error: 'Bad classifications' }, 400);
  if (classifying.length > MAX_CLASSIFICATIONS)    return json({ error: 'Too many classifications' }, 400);

  const classifications: PendingClassification[] = [];
  for (let i = 0; i < classifying.length; i++) {
    const c = classifying[i] as IncomingClassification;
    const t = c.transaction ?? {};

    // The transaction, by the same natural key and normalised the same way as
    // the rows above — otherwise a stray double space would fail to resolve.
    const date = clean(t.transaction_date, 10);
    if (!date || !DATE_RE.test(date) || Number.isNaN(Date.parse(date)))
      return json({ error: `Classification ${i}: bad transaction_date` }, 400);

    const description = clean(t.description, 500);
    if (!description) return json({ error: `Classification ${i}: missing description` }, 400);

    const raw = clean(t.raw_reference, 1000);
    if (!raw) return json({ error: `Classification ${i}: missing raw_reference` }, 400);

    const amount = typeof t.amount === 'number' ? t.amount : Number(t.amount);
    if (!Number.isFinite(amount) || Math.abs(amount) >= 1e10)
      return json({ error: `Classification ${i}: bad amount` }, 400);

    const kind = clean(c.kind, 20);
    if (!kind || !KINDS.has(kind)) return json({ error: `Classification ${i}: bad kind` }, 400);

    // How it was decided. Recorded because it says how far the row should be
    // trusted, and whether anything may revise it later.
    const source = clean(c.source, 20);
    if (!source || !SOURCES.has(source)) return json({ error: `Classification ${i}: bad source` }, 400);

    const row: Record<string, unknown> = { kind, source, note: clean(c.note, 500) };

    if (kind === 'personal') {
      // A personal transaction may be money in or money out — a private
      // transfer into the account is not the business's income — but it carries
      // no paperwork, so anything that would claim one is refused by name.
      for (const field of BUSINESS_ONLY) {
        if (c[field] !== undefined && c[field] !== null)
          return json({ error: `Classification ${i}: personal cannot carry ${field}` }, 400);
      }
      classifications.push({
        key: { transaction_date: date, description, amount: Math.round(amount * 100) / 100, raw_reference: raw },
        row,
      });
      continue;
    }

    // Only money out can be deducted. The table's own trigger says so too; this
    // is the same answer with a better message, before anything is written.
    if (amount >= 0) return json({ error: `Classification ${i}: only money out can be claimed` }, 400);

    // What the money was for. Required of a deduction — it cannot be defended
    // without it (see db/005_classifications.sql).
    const purpose = clean(c.purpose, 500);
    if (!purpose) return json({ error: `Classification ${i}: missing purpose` }, 400);

    const invoiceDate = clean(c.invoice_date, 10);
    if (invoiceDate && (!DATE_RE.test(invoiceDate) || Number.isNaN(Date.parse(invoiceDate))))
      return json({ error: `Classification ${i}: bad invoice_date` }, 400);

    // Apportionment, for a cost only partly business. Absent claims the whole
    // payment, which is what the importer sends.
    let deductible: number | null = null;
    if (c.deductible_amount !== undefined && c.deductible_amount !== null) {
      const d = typeof c.deductible_amount === 'number' ? c.deductible_amount : Number(c.deductible_amount);
      if (!Number.isFinite(d) || d <= 0 || d > Math.abs(amount))
        return json({ error: `Classification ${i}: bad deductible_amount` }, 400);
      deductible = Math.round(d * 100) / 100;
    }

    classifications.push({
      key: { transaction_date: date, description, amount: Math.round(amount * 100) / 100, raw_reference: raw },
      row: {
        ...row,
        purpose,
        supplier: clean(c.supplier, 200),
        expense_type: clean(c.expense_type, 100),
        invoice_number: clean(c.invoice_number, 100),
        invoice_date: invoiceDate,
        deductible_amount: deductible,
      },
    });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  // ignoreDuplicates → ON CONFLICT DO NOTHING, and the RETURNING clause behind
  // .select() yields only the rows that were really inserted. Everything else
  // was already on record.
  const { data, error } = await supabase
    .from('transactions')
    .upsert(rows, { onConflict: CONFLICT, ignoreDuplicates: true })
    .select('id');

  if (error) {
    // Counts and the database's own message only — never the rows themselves,
    // which are the account holder's financial data.
    console.error('[import-transactions]', error.message);
    return json({ error: 'Could not import transactions' }, 500);
  }

  const inserted = data?.length ?? 0;

  const { classified, alreadyClassified, failure } = await writeClassifications(supabase, classifications);
  if (failure) return json({ error: failure.error }, failure.status);

  console.log(
    `[import-transactions] received=${rows.length} inserted=${inserted} ` +
    `classifications=${classifications.length} classified=${classified}`,
  );

  return json({
    ok: true,
    received: rows.length,
    inserted,
    skipped: rows.length - inserted,
    classified,
    already_classified: alreadyClassified,
  });
});

// writeClassifications resolves each one's transaction to its row id and writes
// them.
//
// The transactions are already committed by the time this runs, so one resolves
// whether its transaction was inserted a moment ago or months back with an
// overlapping statement. Candidates are fetched by date — a small set, and dates
// are the one part of the key that needs no quoting — and then matched on the
// whole key in memory.
async function writeClassifications(
  supabase: ReturnType<typeof createClient>,
  classifications: PendingClassification[],
): Promise<{ classified: number; alreadyClassified: number; failure?: { error: string; status: number } }> {
  if (!classifications.length) return { classified: 0, alreadyClassified: 0 };

  const dates = [...new Set(classifications.map((c) => c.key.transaction_date))];
  const { data: candidates, error } = await supabase
    .from('transactions')
    .select('id, transaction_date, description, amount, raw_reference')
    .in('transaction_date', dates);

  if (error) {
    console.error('[import-transactions] classifications', error.message);
    return { classified: 0, alreadyClassified: 0, failure: { error: 'Could not import classifications', status: 500 } };
  }

  const byKey = new Map<string, number>();
  for (const t of candidates ?? []) {
    byKey.set(keyOf(t.transaction_date, t.description, Number(t.amount), t.raw_reference), t.id as number);
  }

  const rows = [];
  for (let i = 0; i < classifications.length; i++) {
    const { key, row } = classifications[i];
    const id = byKey.get(keyOf(key.transaction_date, key.description, key.amount, key.raw_reference));
    // Only reachable if the caller classified a transaction that is not in this
    // request and not on record — so say so rather than dropping it, which would
    // report a clean import that quietly classified nothing.
    if (id === undefined) {
      return {
        classified: 0,
        alreadyClassified: 0,
        failure: { error: `Classification ${i}: no such transaction`, status: 400 },
      };
    }
    rows.push({ transaction_id: id, ...row });
  }

  // ON CONFLICT DO NOTHING on the one-per-transaction UNIQUE: a transaction
  // already classified keeps what it has, so a re-import changes nothing — and
  // a rule can never overwrite a decision made by hand.
  const { data: written, error: writeError } = await supabase
    .from('transaction_classifications')
    .upsert(rows, { onConflict: CLASSIFICATION_CONFLICT, ignoreDuplicates: true })
    .select('id');

  if (writeError) {
    console.error('[import-transactions] classifications', writeError.message);
    return { classified: 0, alreadyClassified: 0, failure: { error: 'Could not import classifications', status: 500 } };
  }

  const classified = written?.length ?? 0;
  return { classified, alreadyClassified: rows.length - classified };
}

// The natural key as one string. Amounts are rounded to cents on both sides:
// PostgREST hands NUMERIC back as a JSON number, and the key has to compare
// equal to the one the importer sent.
function keyOf(date: string, description: string, amount: number, raw: string): string {
  return [date, description, (Math.round(amount * 100) / 100).toFixed(2), raw].join('\u0000');
}
