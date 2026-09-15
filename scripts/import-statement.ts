#!/usr/bin/env -S deno run --allow-read --allow-net --allow-env
//
// import-statement — parse a Capitec statement PDF and import its transactions.
//
//   deno run --allow-read --allow-net --allow-env \
//     scripts/import-statement.ts data/statements/account_statement.pdf
//
// Reads the PDF locally, extracts the Transaction History table, and POSTs the
// parsed rows to the `import-transactions` edge function, which writes them as
// service role (the table is not writable with the publishable key). Nothing is
// written to disk and no service-role key is needed here.
//
// Statements overlap and get re-downloaded, so the import is idempotent: the
// function upserts ON CONFLICT DO NOTHING against the natural key, and reports
// how many rows were new. Running the same statement twice inserts nothing.
//
// Environment:
//   IMPORT_TOKEN        required — the shared secret set on the edge function
//   SUPABASE_URL        optional — defaults to the project in ui/shared.js
//   STATEMENT_PASSWORD  optional — the PDF password, if the statement is
//                       encrypted (Capitec uses the last 4 digits of the
//                       registered mobile number). Never pass it as an
//                       argument: it would land in your shell history.
//
// Flags:
//   --dry-run   parse and reconcile only; print the rows, write nothing
//   --source    override the source_statement label (defaults to the filename)
//   --password-env NAME   read the password from NAME instead of STATEMENT_PASSWORD

import { extractText, getDocumentProxy } from 'npm:unpdf@1.3.2';

// The project the site talks to (ui/shared.js). Public, so it is fine here.
const DEFAULT_SUPABASE_URL = 'https://ihwtedrjfusvpmkmrgxa.supabase.co';

const BATCH = 200;   // rows per request; the function accepts up to 500

// ---------------------------------------------------------------------------
// Statement parsing
//
// pdf.js gives back the page as text lines in reading order, which for the
// Transaction History table is one line per row:
//
//   01/01/2026 Example Store Somewhere (Card 1234) Groceries -49.00 259.00
//   <date>     <description>                      <category> <amount> <balance>
//
// …except that long descriptions wrap onto their own lines, so a row is
// accumulated from its date until the trailing numbers appear.
//
// The trailing numbers are the Money In / Money Out, Fee* and Balance columns.
// Money In and Money Out share one column position and already carry their sign
// in the text, so a row ends in either two numbers (amount, balance) or three
// (amount, fee, balance). The balance chain is what proves that reading, and is
// verified below.

// A rand amount as the statement prints it: space-grouped thousands, always two
// decimals, minus sign for money out. The decimals matter — they are what keeps
// payment reference numbers and card digits inside a description out of the match.
const NUM = String.raw`-?\d{1,3}(?:[ \u00a0\u202f]\d{3})*\.\d{2}`;

// One to three amounts at the very end of the row. Anchoring to the end is what
// makes this safe: a decimal inside a description cannot be mistaken for a
// column, because the text after it would then have to be columns too.
const TAIL_RE = new RegExp(String.raw`^(.*?)\s+((?:${NUM}\s+){0,2}${NUM})\s*$`);
const NUM_RE = new RegExp(NUM, 'g');

const DATE_RE = /^(\d{2})\/(\d{2})\/(\d{4})\s+(.*)$/;

const TABLE_HEADER = 'Date Description Category Money In Money Out Fee* Balance';
// Anything after these ends the table: the VAT footnote closes each page's
// table, and pending card transactions have not been posted to the balance yet,
// so they are deliberately not imported.
const TABLE_END = [/^\*\s*Includes VAT/i, /^Pending Card Transactions/i];

// Summary sections that list the bank's own category names against a total.
// These are the authoritative vocabulary for a given statement; the defaults
// below only cover a statement whose summaries are missing or renamed.
const SUMMARY_SECTIONS = ['Spending Summary', 'Money In Summary', 'Money Out Summary'];
const SUMMARY_LINE_RE = /^(.+?)\s+-?R\s?\d[\d \u00a0\u202f]*\.\d{2}$/;

const DEFAULT_CATEGORIES = [
  'Uncategorised', 'Groceries', 'Takeaways', 'Fuel', 'Parking', 'Education',
  'Books/Stationery', 'Sport & Hobbies', 'Home Maintenance', 'Digital Payments',
  'Digital Subscriptions', 'Card Payments', 'Card Subscriptions', 'Transfer',
  'Fees', 'Other Income', 'Payment Received', 'Loans',
];

interface Row {
  transaction_date: string;
  description: string;
  amount: number;
  transaction_type: 'credit' | 'debit' | 'fee';
  category: string | null;
  raw_reference: string;
}

const squash = (s: string) => s.replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ').trim();
const toNumber = (s: string) => Number(s.replace(/[\s\u00a0\u202f]/g, ''));
const isoDate = (d: string, m: string, y: string) => `${y}-${m}-${d}`;

// Harvest the category names this statement actually uses, from its summary
// sections, and fall back to the built-in list for anything not printed there.
function collectCategories(lines: string[]): string[] {
  const found = new Set(DEFAULT_CATEGORIES);
  let inSummary = false;
  for (const line of lines) {
    if (SUMMARY_SECTIONS.includes(line)) { inSummary = true; continue; }
    if (!inSummary) continue;
    const m = line.match(SUMMARY_LINE_RE);
    if (m) found.add(squash(m[1]));
    else if (line) inSummary = false;   // a non-summary line closes the section
  }
  // Longest first, so "Payment Received" wins over a hypothetical "Payment".
  return [...found].sort((a, b) => b.length - a.length);
}

// Split "<description> <Category>" by taking the longest known category that
// ends the text. An unrecognised category simply stays in the description —
// wrong-but-visible beats silently truncating someone's description.
function splitCategory(text: string, categories: string[]): [string, string | null] {
  for (const c of categories) {
    if (text.length > c.length && text.endsWith(' ' + c)) {
      return [text.slice(0, -(c.length + 1)).trim(), c];
    }
  }
  return [text, null];
}

interface Parsed { rows: Row[]; warnings: string[] }

function parseStatement(pages: string[]): Parsed {
  const lines = pages.flatMap(p => p.split('\n').map(squash));
  const categories = collectCategories(lines);
  const rows: Row[] = [];
  const warnings: string[] = [];

  let inTable = false;
  let pending: string[] = [];   // the row being accumulated across wrapped lines

  // Each row's printed running balance, and the step that should produce it.
  const balances: { raw: string; balance: number; moved: number }[] = [];

  // Turn one complete row of text into its transaction, plus a second
  // transaction for the Fee column when the row carries one. Splitting the fee
  // out is what keeps the amounts summing back to the closing balance: the
  // schema has a single `amount`, and the fee is a real, separate debit.
  const flush = (raw: string) => {
    const dm = raw.match(DATE_RE);
    if (!dm) return;
    const [, dd, mm, yyyy, rest] = dm;

    const tm = rest.match(TAIL_RE);
    if (!tm) { warnings.push(`could not read columns: ${raw}`); return; }

    const nums: string[] = tm[2].match(NUM_RE) ?? [];
    if (nums.length < 2 || nums.length > 3) {
      warnings.push(`unexpected column count (${nums.length}): ${raw}`);
      return;
    }

    // Two numbers are (amount, balance); three insert the Fee* column between
    // them. The balance chain below is what confirms the reading.
    const amount = toNumber(nums[0]);
    const fee = nums.length === 3 ? toNumber(nums[1]) : 0;
    const balance = toNumber(nums[nums.length - 1]);

    const [description, category] = splitCategory(squash(tm[1]), categories);
    if (!description) { warnings.push(`empty description: ${raw}`); return; }

    const date = isoDate(dd, mm, yyyy);
    rows.push({
      transaction_date: date,
      description,
      amount,
      transaction_type: amount < 0 ? 'debit' : 'credit',
      category,
      raw_reference: raw,
    });

    if (fee) {
      rows.push({
        transaction_date: date,
        description: `${description} (fee)`,
        amount: fee,
        transaction_type: 'fee',
        category: 'Fees',
        raw_reference: raw,
      });
    }

    // The balance the statement printed for this row, kept for the chain check.
    balances.push({ raw, balance, moved: amount + fee });
  };

  for (const line of lines) {
    if (line === TABLE_HEADER) { inTable = true; pending = []; continue; }
    if (!inTable) continue;
    if (TABLE_END.some(re => re.test(line))) {
      if (pending.length) warnings.push(`incomplete row dropped: ${pending.join(' ')}`);
      inTable = false; pending = [];
      continue;
    }
    if (!line) continue;

    if (DATE_RE.test(line)) {
      // A new row starts, so whatever was pending never completed.
      if (pending.length) warnings.push(`incomplete row dropped: ${pending.join(' ')}`);
      pending = [line];
    } else if (pending.length) {
      pending.push(line);
    } else {
      continue;   // stray line between the header and the first row
    }

    const candidate = pending.join(' ');
    // A row is complete once it ends in its numeric columns.
    if (TAIL_RE.test(candidate.replace(DATE_RE, '$4'))) { flush(candidate); pending = []; }
  }
  if (pending.length) warnings.push(`incomplete row dropped: ${pending.join(' ')}`);

  // Reconcile against the printed running balance. Every row's amount (plus its
  // fee) must be exactly the step from the previous balance to this one — which
  // is the proof that the trailing numbers were read as the right columns.
  for (let i = 1; i < balances.length; i++) {
    const expected = Math.round((balances[i - 1].balance + balances[i].moved) * 100) / 100;
    if (expected !== balances[i].balance) {
      warnings.push(
        `balance does not reconcile (expected ${expected}, statement says ` +
        `${balances[i].balance}): ${balances[i].raw}`,
      );
    }
  }

  return { rows, warnings };
}

// ---------------------------------------------------------------------------
// CLI

function usage(msg?: string): never {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(`usage: import-statement.ts <statement.pdf> [--dry-run] [--source NAME]
                            [--password-env VAR]

  IMPORT_TOKEN        the edge function's shared secret (required unless --dry-run)
  SUPABASE_URL        override the project URL
  STATEMENT_PASSWORD  the PDF password, if the statement is encrypted`);
  Deno.exit(msg ? 2 : 0);
}

function parseArgs(argv: string[]) {
  let path = '', source = '', passwordEnv = 'STATEMENT_PASSWORD', dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') dryRun = true;
    else if (a === '--help' || a === '-h') usage();
    else if (a === '--source') source = argv[++i] ?? usage('--source needs a value');
    else if (a === '--password-env') passwordEnv = argv[++i] ?? usage('--password-env needs a value');
    else if (a.startsWith('-')) usage(`unknown flag ${a}`);
    else if (!path) path = a;
    else usage('only one statement can be imported at a time');
  }
  if (!path) usage('no statement given');
  return { path, source, passwordEnv, dryRun };
}

async function readPages(path: string, password: string): Promise<string[]> {
  const data = await Deno.readFile(path);
  let doc;
  try {
    doc = await getDocumentProxy(data, password ? { password } : undefined);
  } catch (e) {
    // pdf.js reports both "no password given" and "wrong password" here. Report
    // the situation, never the value.
    const m = String((e as Error)?.message ?? e);
    if (/password/i.test(m)) {
      throw new Error(
        password
          ? 'the statement password was not accepted'
          : 'the statement is password-protected — set STATEMENT_PASSWORD',
      );
    }
    throw e;
  }
  const { text } = await extractText(doc, { mergePages: false });
  return text;
}

async function postBatch(url: string, token: string, source: string, rows: Row[]) {
  const res = await fetch(`${url}/functions/v1/import-transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ source_statement: source, transactions: rows }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `import failed (HTTP ${res.status})`);
  return body as { inserted: number; skipped: number };
}

async function main() {
  const { path, source, passwordEnv, dryRun } = parseArgs(Deno.args);
  const sourceName = source || path.split('/').pop() || path;

  const { rows, warnings } = await readPages(path, Deno.env.get(passwordEnv) ?? '')
    .then(parseStatement);

  for (const w of warnings) console.error(`warning: ${w}`);
  if (!rows.length) throw new Error('no transactions found — is this a Capitec statement?');

  const net = rows.reduce((t, r) => t + r.amount, 0);
  const moneyIn = rows.filter(r => r.amount > 0).reduce((t, r) => t + r.amount, 0);
  console.log(`Parsed ${rows.length} transactions from ${sourceName}`);
  console.log(`  ${rows[0].transaction_date} → ${rows[rows.length - 1].transaction_date}`);
  console.log(`  money in  ${moneyIn.toFixed(2)}`);
  console.log(`  money out ${(moneyIn - net).toFixed(2)}`);
  console.log(`  net       ${net.toFixed(2)}`);

  if (dryRun) {
    console.log('\n--dry-run: nothing written\n');
    for (const r of rows) {
      console.log(
        `${r.transaction_date}  ${r.amount.toFixed(2).padStart(10)}  ` +
        `${(r.category ?? '-').padEnd(22)}  ${r.description}`,
      );
    }
    return;
  }

  const token = Deno.env.get('IMPORT_TOKEN') ?? '';
  if (!token) throw new Error('IMPORT_TOKEN is not set');
  const url = (Deno.env.get('SUPABASE_URL') || DEFAULT_SUPABASE_URL).replace(/\/+$/, '');

  let inserted = 0, skipped = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const r = await postBatch(url, token, sourceName, rows.slice(i, i + BATCH));
    inserted += r.inserted;
    skipped += r.skipped;
  }
  console.log(`\nImported into ${url}`);
  console.log(`  inserted ${inserted}`);
  console.log(`  skipped  ${skipped} (already on record)`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (e) {
    // A stack trace here would be noise — and for a password failure it would
    // put the statement path next to the reason in the terminal scrollback.
    console.error(`error: ${(e as Error)?.message ?? e}`);
    Deno.exit(1);
  }
}
