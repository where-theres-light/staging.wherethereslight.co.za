import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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

// ---------------------------------------------------------------------------
// Bot / crawler filtering.
//
// This only decides what gets *counted*, never what gets served: the site is
// static GitHub Pages, so a crawler always loads every page — SEO is untouched.
// A matching request just isn't written to sessions/page_visits, so the metrics
// reflect real human visits rather than automated traffic (search crawlers,
// link-preview unfurlers, uptime monitors, headless automation).
//
// Matched against the User-Agent. The generic tokens (bot/crawler/spider/…)
// catch the long tail — including search engines like Googlebot/Bingbot, which
// carry "bot" — while the named entries cover common crawlers that don't. An
// empty/absent UA is left through (recorded): real browsers always send one, and
// dropping on its absence risks excluding privacy tools that strip it.
const BOT_UA_RE = new RegExp([
  'bot', 'crawl', 'spider', 'slurp', 'mediapartners', 'archiver', 'scraper',
  'facebookexternalhit', 'facebot', 'ia_archiver', 'headless', 'phantomjs',
  'puppeteer', 'playwright', 'selenium', 'webdriver', 'lighthouse', 'pingdom',
  'uptimerobot', 'gtmetrix', 'chrome-lighthouse', 'google page speed',
  'whatsapp', 'telegrambot', 'slackbot', 'discordbot', 'skypeuripreview',
  'embedly', 'redditbot', 'applebot', 'petalbot', 'bytespider', 'dataforseo',
  'semrush', 'ahrefs', 'mj12bot', 'dotbot', 'python-requests', 'axios',
  'curl', 'wget', 'go-http-client', 'node-fetch', 'okhttp', 'java/', 'libwww',
].join('|'), 'i');

function isBot(ua: string | null): boolean {
  return !!ua && BOT_UA_RE.test(ua);
}

// ---------------------------------------------------------------------------
// One-way IP hashing.
//
// The raw client IP is used only transiently (rate-limit key, geolocation) and
// never stored; what lands in the database is this salted SHA-256 hash. The
// salt is a secret (function env `IP_HASH_SALT`) so the small IPv4 space cannot
// simply be brute-forced back from a hash — set it in production. Without it the
// hash still removes plaintext IPs, but offers no real pre-image resistance.

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
// IP → coarse location.
//
// Calls an external IP-geolocation service (default ipapi.co, free, no key —
// override with the GEO_API_URL / GEO_API_KEY env vars). Best-effort: any
// failure, timeout, or un-geolocatable IP returns an empty object so the caller
// can record the session without a location rather than fail.

interface Geo {
  country?: string;
  country_code?: string;
  region?: string;
  city?: string;
  latitude?: number;
  longitude?: number;
  timezone?: string;
  isp?: string;   // network operator / organization (ipapi `org`)
  asn?: string;   // autonomous-system number, e.g. "AS36994"
}

const GEO_URL = (Deno.env.get('GEO_API_URL') ?? 'https://ipapi.co').replace(/\/$/, '');
const GEO_KEY = Deno.env.get('GEO_API_KEY') ?? '';

// Private / loopback / link-local / unknown addresses can't be geolocated.
function locatable(ip: string): boolean {
  if (!ip || ip === 'unknown') return false;
  if (ip === '127.0.0.1' || ip === '::1') return false;
  if (/^(10\.|192\.168\.|169\.254\.|fc|fd|fe80:)/i.test(ip)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return false;
  return true;
}

async function geolocate(ip: string): Promise<Geo> {
  if (!locatable(ip)) return {};
  try {
    const url = `${GEO_URL}/${encodeURIComponent(ip)}/json/${GEO_KEY ? `?key=${GEO_KEY}` : ''}`;
    // Don't let a slow lookup hold the request open.
    const res = await fetch(url, {
      headers: { 'User-Agent': 'wtl-metrics/1.0' },
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return {};
    const d: any = await res.json();
    if (d?.error) return {};   // ipapi.co signals failure with { error: true }
    const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
    const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
    return {
      country:      str(d.country_name),
      country_code: str(d.country_code ?? d.country),
      region:       str(d.region),
      city:         str(d.city),
      latitude:     num(d.latitude),
      longitude:    num(d.longitude),
      timezone:     str(d.timezone),
      isp:          str(d.org),
      asn:          str(d.asn),
    };
  } catch {
    return {};
  }
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

  // Drop bot / crawler traffic before any work so it never lands in the metrics.
  // 200 (not an error) so the fire-and-forget beacon treats it as done and never
  // retries; nothing is served differently, so crawler access to the site — and
  // SEO — is unaffected.
  if (isBot(req.headers.get('user-agent'))) return json({ ok: true, bot: true });

  let payload: any;
  try { payload = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }

  const token = cap(payload?.token, 128).trim();
  const path  = cap(payload?.path ?? '/', 1024).trim() || '/';
  const referrer = payload?.referrer ? cap(payload.referrer, 2048) : null;
  if (!token) return json({ error: 'Missing session token' }, 400);

  // The raw IP is used only in-memory (rate-limit key, geolocation); only its
  // salted hash is ever stored, so sessions can't be tied back to an address.
  const ip = clientIp(req);
  const ipHash = await hashIp(ip);
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

  // Rate-limit visit entries by IP. Fail open on limiter error so a transient
  // database problem never drops metrics.
  const rl = await rateLimit(supabase, `visit:${ipHash}`, { limit: RL_LIMIT, windowSeconds: RL_WINDOW });
  if (rl && !rl.allowed)
    return json({ error: 'Rate limited' }, 429, { 'Retry-After': String(rl.retryAfter) });

  // Find the session (token + IP hash) or create it, geolocating only on first sight.
  const nowIso = new Date().toISOString();
  let sessionId: string | undefined;

  const { data: found } = await supabase.from('sessions')
    .select('id').eq('token', token).eq('ip_hash', ipHash).maybeSingle();

  if (found) {
    sessionId = found.id;
    await supabase.from('sessions').update({ last_seen: nowIso }).eq('id', sessionId);
  } else {
    const geo = await geolocate(ip);   // raw IP, not stored
    const { data: created, error } = await supabase.from('sessions')
      .insert({ token, ip_hash: ipHash, user_agent: cap(req.headers.get('user-agent'), 512) || null, ...geo })
      .select('id').single();
    if (error) {
      // A concurrent first visit may have created it — fetch that row.
      const { data: retry } = await supabase.from('sessions')
        .select('id').eq('token', token).eq('ip_hash', ipHash).maybeSingle();
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
