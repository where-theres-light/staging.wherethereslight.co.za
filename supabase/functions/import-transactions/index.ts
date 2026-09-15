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

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// Shared secret the importer presents as `Authorization: Bearer <token>`.
// Unset means the endpoint refuses everything — it fails closed, so deploying
// the function before setting the secret cannot open a write path.
const IMPORT_TOKEN = (Deno.env.get('IMPORT_TOKEN') ?? '').trim();

const MAX_ROWS = 500;           // rows accepted in one request
const CONFLICT = 'transaction_date,description,amount,raw_reference';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TYPES = new Set(['credit', 'debit', 'fee']);

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

  let payload: { source_statement?: unknown; transactions?: unknown };
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
  console.log(`[import-transactions] received=${rows.length} inserted=${inserted}`);

  return json({ ok: true, received: rows.length, inserted, skipped: rows.length - inserted });
});
