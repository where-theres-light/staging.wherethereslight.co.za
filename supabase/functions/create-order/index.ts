import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { crypto } from 'https://deno.land/std@0.224.0/crypto/mod.ts';

// create-order — starts a checkout.
//
// Receives the cart (line refs only) + buyer + shipping from the browser,
// RE-PRICES every line from the catalogue (never trusts the browser price),
// inserts a pending order, and returns the signed PayFast fields for the
// browser to POST. The amount PayFast is asked to charge is computed here and
// stored on the order; payfast-notify reconciles the ITN against it.
//
// One project serves both environments: the PayFast env (sandbox vs live) is
// chosen from the request origin — staging → sandbox, production → live — and
// stored on the order so payfast-notify validates against the right PayFast.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SHIPPING_FLAT = 150;

// Allowed browser origins → whether they transact against the PayFast sandbox.
const ORIGINS: Record<string, { sandbox: boolean }> = {
  'https://staging.wherethereslight.co.za': { sandbox: true },
  'https://wherethereslight.co.za':         { sandbox: false },
};

function pfConfig(sandbox: boolean) {
  const env = (k: string, d = '') => (Deno.env.get(k) ?? d).trim();
  return sandbox
    ? {
        merchant_id:  env('PF_SANDBOX_MERCHANT_ID', '10000100'),
        merchant_key: env('PF_SANDBOX_MERCHANT_KEY', '46f0cd694581a'),
        passphrase:   env('PF_SANDBOX_PASSPHRASE'),
        process:      'https://sandbox.payfast.co.za/eng/process',
      }
    : {
        merchant_id:  env('PF_MERCHANT_ID'),
        merchant_key: env('PF_MERCHANT_KEY'),
        passphrase:   env('PF_PASSPHRASE'),
        process:      'https://www.payfast.co.za/eng/process',
      };
}

// PHP urlencode-compatible: trim (PayFast signs urlencode(trim(value))), spaces
// as '+', uppercase hex, and encode the extra chars encodeURIComponent leaves.
const pfEncode = (v: unknown) =>
  encodeURIComponent(String(v).trim())
    .replace(/%20/g, '+')
    .replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

async function md5(s: string): Promise<string> {
  const d = await crypto.subtle.digest('MD5', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// One-way IP hashing — the same salted SHA-256 `track`/`subscribe` use, so the
// order's session resolves against the (token, ip_hash) row track recorded. The
// raw IP is used only in-memory (never stored); set IP_HASH_SALT to match the
// other functions. (crypto.subtle.digest, not the std MD5 import above.)
const SALT = Deno.env.get('IP_HASH_SALT') ?? '';

function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return req.headers.get('x-real-ip')?.trim() || 'unknown';
}

async function sha256Hex(s: string): Promise<string> {
  const d = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const hashIp = (ip: string) => sha256Hex(`${SALT}|${ip}`);

// Resolve the browsing session for this checkout, creating it if `track` never
// recorded one, so every order is tied to a session and its env lives there
// (payfast-notify reads env through the order's session — there is no env column
// on orders). Best-effort geo/isp are left to `track`; this only needs env.
async function resolveSession(
  supabase: ReturnType<typeof createClient>,
  req: Request,
  token: string,
  env: 'sandbox' | 'live',
): Promise<string | null> {
  const ipHash = await hashIp(clientIp(req));
  const nowIso = new Date().toISOString();
  const userAgent = (req.headers.get('user-agent') ?? '').slice(0, 512) || null;

  const { data: found } = await supabase.from('sessions')
    .select('id').eq('token', token).eq('ip_hash', ipHash).maybeSingle();
  if (found) {
    await supabase.from('sessions').update({ last_seen: nowIso }).eq('id', found.id);
    return found.id as string;
  }

  const { data: created, error } = await supabase.from('sessions')
    .insert({ token, ip_hash: ipHash, env, user_agent: userAgent })
    .select('id').single();
  if (!error && created) return created.id as string;

  // A concurrent visit may have created it — fetch that row.
  const { data: retry } = await supabase.from('sessions')
    .select('id').eq('token', token).eq('ip_hash', ipHash).maybeSingle();
  return retry?.id ?? null;
}

Deno.serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get('origin') ?? '';
  const envCfg = ORIGINS[origin];
  const cors: Record<string, string> = {
    'Access-Control-Allow-Origin':  envCfg ? origin : 'null',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
  };
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (!envCfg)                  return json({ error: 'Forbidden origin' }, 403);
  if (req.method !== 'POST')    return json({ error: 'Method not allowed' }, 405);

  const sandbox = envCfg.sandbox;
  const pf = pfConfig(sandbox);
  if (!pf.merchant_id) return json({ error: 'Payments are not configured' }, 503);

  let payload: any;
  try { payload = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }
  const { buyer, ship, items } = payload ?? {};
  // The browser's metrics session token (localStorage `wtl_session`); fall back
  // to a fresh one so the order can still be tied to a session (session_id is
  // NOT NULL and carries the env payfast-notify verifies against).
  const token = (String(payload?.token ?? '').trim() || globalThis.crypto.randomUUID()).slice(0, 128);

  if (!buyer?.name || !buyer?.email)                  return json({ error: 'Missing your name or email' }, 400);
  // Delivery method decides shipping cost; self-pickup needs no address.
  const method = ship?.method === 'pickup' ? 'pickup' : 'deliver';
  if (method === 'deliver' && (!ship?.line1 || !ship?.city || !ship?.postcode))
    return json({ error: 'Missing shipping address' }, 400);
  if (!Array.isArray(items) || !items.length)         return json({ error: 'Your cart is empty' }, 400);
  if (items.length > 50)                              return json({ error: 'Too many items' }, 400);

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

  // Re-price every line from the catalogue.
  const lines: unknown[] = [];
  let subtotal = 0;
  let giftQty = 0;   // number of single gift tags, for bulk (set-of-10) pricing
  for (const it of items) {
    const ref = it?.ref;
    const qty = Math.max(1, Math.min(99, parseInt(it?.qty ?? 1, 10) || 1));
    let price: number | null = null;
    let title = '';

    if (ref?.t === 'v') {
      const { data } = await supabase.from('product_variants')
        .select('price, status, name, products(title, category_slug)')
        .eq('product_id', ref.p).eq('key', ref.k).maybeSingle();
      if (!data)                  return json({ error: 'Unknown item' }, 400);
      const pTitle = (data as any).products?.title ?? ref.p;
      if (data.status === 'sold') return json({ error: `${pTitle} is sold` }, 409);
      if (data.price == null)     return json({ error: `${pTitle} is not for sale online` }, 409);
      price = Number(data.price);
      title = `${pTitle} — ${data.name}`;
      if ((data as any).products?.category_slug === 'gifttags' && ref.k === 'single') giftQty += qty;
    } else if (ref?.t === 't') {
      const { data } = await supabase.from('category_tiers')
        .select('price, name').eq('category_slug', ref.c).eq('key', ref.k).maybeSingle();
      if (!data)                  return json({ error: 'Unknown item' }, 400);
      price = Number(data.price);
      title = data.name;
    } else {
      return json({ error: 'Invalid item' }, 400);
    }

    const line_total = Math.round(price * qty * 100) / 100;
    subtotal += line_total;
    lines.push({ ref, title, unit_price: price, qty, line_total });
  }

  subtotal = Math.round(subtotal * 100) / 100;

  // Bulk gift-tag pricing: every complete 10 single gift tags is charged at the
  // 'mix10' set price instead of 10 × the single price. Prices come from the
  // catalogue (category_tiers), never the browser.
  if (giftQty >= 10) {
    const { data: tiers } = await supabase.from('category_tiers')
      .select('key, price').eq('category_slug', 'gifttags').in('key', ['single', 'mix10']);
    const per10  = Number(tiers?.find((t: any) => t.key === 'mix10')?.price);
    const single = Number(tiers?.find((t: any) => t.key === 'single')?.price);
    if (per10 > 0 && single > 0) {
      const sets = Math.floor(giftQty / 10);
      const discount = Math.round(Math.max(0, sets * (10 * single - per10)) * 100) / 100;
      if (discount > 0) {
        subtotal = Math.round((subtotal - discount) * 100) / 100;
        lines.push({ ref: { t: 'discount' }, title: `Gift-tag bulk discount (${sets}×10)`,
                     unit_price: -discount, qty: 1, line_total: -discount });
      }
    }
  }

  const shipping = method === 'pickup' ? 0 : SHIPPING_FLAT;
  const amount = Math.round((subtotal + shipping) * 100) / 100;
  if (amount < 5) return json({ error: 'Order total too low' }, 400);

  // Insert the pending order (tagged with the PayFast env it will use).
  const parts = String(buyer.name).trim().split(/\s+/);
  const nameFirst = parts.shift() ?? '';
  const nameLast  = parts.join(' ');

  // Tie the order to its browsing session; the session carries the env
  // (sandbox|live) that payfast-notify verifies against, so this must succeed.
  const sessionId = await resolveSession(supabase, req, token, sandbox ? 'sandbox' : 'live');
  if (!sessionId) return json({ error: 'Could not create order' }, 500);

  const { data: order, error } = await supabase.from('orders').insert({
    session_id: sessionId,
    buyer_name: String(buyer.name).trim(),
    buyer_email: String(buyer.email).trim(),
    ship_address: ship,
    items: lines,
    subtotal, shipping, amount,
  }).select('id, order_token').single();
  if (error || !order) return json({ error: 'Could not create order' }, 500);

  // Build the PayFast fields. Field order matters: the signature is computed
  // over the same ordered, urlencoded pairs that are POSTed. Return/cancel go
  // back to the origin that started the checkout.
  const pairs: [string, string][] = ([
    ['merchant_id',   pf.merchant_id],
    ['merchant_key',  pf.merchant_key],
    ['return_url',    `${origin}/success.html?token=${order.order_token}`],
    ['cancel_url',    `${origin}/cancel.html?token=${order.order_token}`],
    ['notify_url',    `${SUPABASE_URL}/functions/v1/payfast-notify`],
    ['name_first',    nameFirst],
    ['name_last',     nameLast],
    ['email_address', String(buyer.email).trim()],
    ['m_payment_id',  order.id],
    ['amount',        amount.toFixed(2)],
    ['item_name',     "Where There's Light order"],
    ['custom_str1',   order.order_token],
  ] as [string, string][]).filter(([, v]) => v !== '' && v != null);

  const fieldStr = pairs.map(([k, v]) => `${k}=${pfEncode(v)}`).join('&');
  const sigStr = pf.passphrase ? `${fieldStr}&passphrase=${pfEncode(pf.passphrase)}` : fieldStr;
  const signature = await md5(sigStr);

  // Set PF_DEBUG=true to log the signed field string (not the passphrase value)
  // to the function logs, to compare byte-for-byte on a signature mismatch.
  if (Deno.env.get('PF_DEBUG') === 'true') {
    console.log('[pf] sandbox=%s fields=%s', sandbox, fieldStr);
    console.log('[pf] passphrase set=%s len=%d signature=%s', pf.passphrase.length > 0, pf.passphrase.length, signature);
  }

  const fields = Object.fromEntries(pairs);
  fields.signature = signature;

  return json({ process_url: pf.process, fields });
});
