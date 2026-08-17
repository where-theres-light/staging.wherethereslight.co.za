import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// subscribe — records a mailing-list email ("Signup for future communication").
//
// The subscriptions table is not writable with the publishable key (RLS on, no
// public policies), so every subscribe comes through here and is written as
// service role. Routing it through a function is what makes rate limiting
// possible: the browser cannot bypass the limiter by POSTing straight to
// PostgREST.
//
// Rate limit: at most RL_LIMIT subscribes per client IP per RL_WINDOW, counted
// in the database so the limit holds across function instances.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// Allowed browser origins (same set the checkout functions accept).
const ORIGINS = new Set([
  'https://staging.wherethereslight.co.za',
  'https://wherethereslight.co.za',
]);

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const RL_LIMIT = 5;       // subscribes allowed…
const RL_WINDOW = 3600;   // …per client IP per hour

// Best-effort client IP: the first hop in x-forwarded-for, else x-real-ip.
function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return req.headers.get('x-real-ip')?.trim() || 'unknown';
}

// ---------------------------------------------------------------------------
// One-way IP hashing.
//
// The raw client IP is used only transiently (the rate-limit key) and never
// stored; what the limiter sees is this salted SHA-256 hash. The salt is a
// secret (function env `IP_HASH_SALT`) so the small IPv4 space cannot simply be
// brute-forced back from a hash — set it in production. Without it the hash
// still removes plaintext IPs, but offers no real pre-image resistance.

const SALT = Deno.env.get('IP_HASH_SALT') ?? '';

async function hashIp(ip: string): Promise<string> {
  const data = new TextEncoder().encode(`${SALT}|${ip}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Fixed-window rate limiter.
//
// Backed by the `rate_limits` table via the `rate_limit_hit` SQL function
// (db/004_rate_limits.sql), which increments the current window's counter and
// reports the verdict atomically. Keeping the state in the database means the
// limit holds across function instances and cold starts, which an in-memory
// counter cannot.

// Structural type: just the `.rpc` we use, so this needs no dependency on the
// supabase-js type exports.
type RpcClient = {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;
};

interface RateLimitResult {
  allowed: boolean;
  remaining: number;   // remaining allowance in this window
  retryAfter: number;  // seconds until the window resets (0 while allowed)
}

// Record a hit against `key` and return whether it is within `limit` for the
// current `windowSeconds` window. Returns null if the limiter itself errors, so
// callers can decide to fail open (a limiter outage shouldn't block real users).
async function rateLimit(
  supabase: RpcClient,
  key: string,
  opts: { limit: number; windowSeconds: number },
): Promise<RateLimitResult | null> {
  const { data, error } = await supabase.rpc('rate_limit_hit', {
    p_key: key,
    p_limit: opts.limit,
    p_window_seconds: opts.windowSeconds,
  });
  if (error) {
    console.error('[rate-limit]', error.message);
    return null;
  }
  // The SQL function RETURNS TABLE, so PostgREST hands back a one-row array.
  const row = (Array.isArray(data) ? data[0] : data) as
    | { allowed: boolean; remaining: number; retry_after: number }
    | undefined;
  if (!row) return null;
  return { allowed: row.allowed, remaining: row.remaining, retryAfter: row.retry_after };
}

// ---------------------------------------------------------------------------

Deno.serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get('origin') ?? '';
  const allowed = ORIGINS.has(origin);
  const cors: Record<string, string> = {
    'Access-Control-Allow-Origin':  allowed ? origin : 'null',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
  };
  const json = (b: unknown, s = 200, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify(b), {
      status: s,
      headers: { ...cors, ...extra, 'Content-Type': 'application/json' },
    });

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (!allowed)                 return json({ error: 'Forbidden origin' }, 403);
  if (req.method !== 'POST')    return json({ error: 'Method not allowed' }, 405);

  let payload: any;
  try { payload = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }

  const email = String(payload?.email ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254)
    return json({ error: 'Please enter a valid email' }, 400);
  // 1 = future communication (footer), 2 = Grasse notification (Upcoming);
  // default to the general list for anything unexpected.
  const subscribeType = Number(payload?.subscribe_type) === 2 ? 2 : 1;

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

  // Rate-limit by client IP (hashed — the raw IP is never persisted, not even in
  // the limiter key), per subscribe type, so hitting the limit on one (e.g. the
  // Grasse notification) doesn't lock the other out. Fail open if the limiter
  // itself errors, so a transient database problem never blocks a genuine subscribe.
  const rl = await rateLimit(supabase, `subscribe:${subscribeType}:${await hashIp(clientIp(req))}`, {
    limit: RL_LIMIT, windowSeconds: RL_WINDOW,
  });
  if (rl && !rl.allowed)
    return json({ error: 'Too many signups — please try again later' }, 429,
      { 'Retry-After': String(rl.retryAfter) });

  const { error } = await supabase.from('subscriptions').insert({ email, subscribe_type: subscribeType });
  if (error) {
    if (error.code === '23505') return json({ ok: true, already: true });  // duplicate email
    console.error('[subscribe]', error.message);
    return json({ error: 'Could not sign you up' }, 500);
  }
  return json({ ok: true });
});
