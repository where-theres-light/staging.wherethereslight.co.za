import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { rateLimit } from '../_shared/rate-limit.ts';
import { geolocate } from '../_shared/geo.ts';

// track — records an anonymous page visit.
//
// The browser sends a random session token (localStorage) plus the page path;
// the server pairs the token with the client IP to identify the session,
// geolocates the IP once when the session is first seen, and appends a row to
// page_visits. Both tables are service-role only (RLS on, no policies), so this
// function is the only write path — which is what lets visits be rate-limited.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const ORIGINS = new Set([
  'https://staging.wherethereslight.co.za',
  'https://wherethereslight.co.za',
]);

const RL_LIMIT = 100;     // visits recorded…
const RL_WINDOW = 600;    // …per client IP per 10 minutes

// Best-effort client IP: the first hop in x-forwarded-for, else x-real-ip.
function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return req.headers.get('x-real-ip')?.trim() || 'unknown';
}

const cap = (v: unknown, n: number): string => String(v ?? '').slice(0, n);

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

  const token = cap(payload?.token, 128).trim();
  const path  = cap(payload?.path ?? '/', 1024).trim() || '/';
  const referrer = payload?.referrer ? cap(payload.referrer, 2048) : null;
  if (!token) return json({ error: 'Missing session token' }, 400);

  const ip = clientIp(req);
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

  // Rate-limit visit entries by IP. Fail open on limiter error so a transient
  // database problem never drops metrics.
  const rl = await rateLimit(supabase, `visit:${ip}`, { limit: RL_LIMIT, windowSeconds: RL_WINDOW });
  if (rl && !rl.allowed)
    return json({ error: 'Rate limited' }, 429, { 'Retry-After': String(rl.retryAfter) });

  // Find the session (token + IP) or create it, geolocating only on first sight.
  const nowIso = new Date().toISOString();
  let sessionId: string | undefined;

  const { data: found } = await supabase.from('sessions')
    .select('id').eq('token', token).eq('ip', ip).maybeSingle();

  if (found) {
    sessionId = found.id;
    await supabase.from('sessions').update({ last_seen: nowIso }).eq('id', sessionId);
  } else {
    const geo = await geolocate(ip);
    const { data: created, error } = await supabase.from('sessions')
      .insert({ token, ip, user_agent: cap(req.headers.get('user-agent'), 512) || null, ...geo })
      .select('id').single();
    if (error) {
      // A concurrent first visit may have created it — fetch that row.
      const { data: retry } = await supabase.from('sessions')
        .select('id').eq('token', token).eq('ip', ip).maybeSingle();
      if (!retry) { console.error('[track]', error.message); return json({ error: 'Could not record session' }, 500); }
      sessionId = retry.id;
    } else {
      sessionId = created.id;
    }
  }

  const { error: vErr } = await supabase.from('page_visits')
    .insert({ session_id: sessionId, path, referrer });
  if (vErr) { console.error('[track]', vErr.message); return json({ error: 'Could not record visit' }, 500); }

  return json({ ok: true });
});
