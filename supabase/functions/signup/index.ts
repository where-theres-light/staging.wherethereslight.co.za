import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { rateLimit } from '../_shared/rate-limit.ts';

// signup — records a mailing-list email ("Signup for future communication").
//
// The signups table is not writable with the publishable key (RLS on, no public
// policies), so every signup comes through here and is written as service role.
// Routing it through a function is what makes rate limiting possible: the
// browser cannot bypass the limiter by POSTing straight to PostgREST.
//
// Rate limit: at most RL_LIMIT signups per client IP per RL_WINDOW, counted in
// the database so the limit holds across function instances.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// Allowed browser origins (same set the checkout functions accept).
const ORIGINS = new Set([
  'https://staging.wherethereslight.co.za',
  'https://wherethereslight.co.za',
]);

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const RL_LIMIT = 5;       // signups allowed…
const RL_WINDOW = 3600;   // …per client IP per hour

// Best-effort client IP: the first hop in x-forwarded-for, else x-real-ip.
function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return req.headers.get('x-real-ip')?.trim() || 'unknown';
}

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
  const source = String(payload?.source ?? 'footer').slice(0, 60);
  const topic = payload?.topic ? String(payload.topic).slice(0, 80) : null;  // e.g. an upcoming piece

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

  // Rate-limit by client IP. Fail open if the limiter itself errors, so a
  // transient database problem never blocks a genuine signup.
  const rl = await rateLimit(supabase, `signup:${clientIp(req)}`, {
    limit: RL_LIMIT, windowSeconds: RL_WINDOW,
  });
  if (rl && !rl.allowed)
    return json({ error: 'Too many signups — please try again later' }, 429,
      { 'Retry-After': String(rl.retryAfter) });

  const { error } = await supabase.from('signups').insert({ email, source, topic });
  if (error) {
    if (error.code === '23505') return json({ ok: true, already: true });  // duplicate email
    console.error('[signup]', error.message);
    return json({ error: 'Could not sign you up' }, 500);
  }
  return json({ ok: true });
});
