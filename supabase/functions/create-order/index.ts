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
  return sandbox
    ? {
        merchant_id:  Deno.env.get('PF_SANDBOX_MERCHANT_ID')  ?? '10000100',
        merchant_key: Deno.env.get('PF_SANDBOX_MERCHANT_KEY') ?? '46f0cd694581a',
        passphrase:   Deno.env.get('PF_SANDBOX_PASSPHRASE')   ?? '',
        process:      'https://sandbox.payfast.co.za/eng/process',
      }
    : {
        merchant_id:  Deno.env.get('PF_MERCHANT_ID')  ?? '',
        merchant_key: Deno.env.get('PF_MERCHANT_KEY') ?? '',
        passphrase:   Deno.env.get('PF_PASSPHRASE')   ?? '',
        process:      'https://www.payfast.co.za/eng/process',
      };
}

// PHP urlencode-compatible: spaces as '+', uppercase hex, encode the extra chars
// encodeURIComponent leaves alone. Must match PayFast's own encoding.
const pfEncode = (v: unknown) =>
  encodeURIComponent(String(v))
    .replace(/%20/g, '+')
    .replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

async function md5(s: string): Promise<string> {
  const d = await crypto.subtle.digest('MD5', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
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

  if (!buyer?.name || !buyer?.email)                  return json({ error: 'Missing your name or email' }, 400);
  if (!ship?.line1 || !ship?.city || !ship?.postcode) return json({ error: 'Missing shipping address' }, 400);
  if (!Array.isArray(items) || !items.length)         return json({ error: 'Your cart is empty' }, 400);
  if (items.length > 50)                              return json({ error: 'Too many items' }, 400);

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

  // Re-price every line from the catalogue.
  const lines: unknown[] = [];
  let subtotal = 0;
  for (const it of items) {
    const ref = it?.ref;
    const qty = Math.max(1, Math.min(99, parseInt(it?.qty ?? 1, 10) || 1));
    let price: number | null = null;
    let title = '';

    if (ref?.t === 'v') {
      const { data } = await supabase.from('product_variants')
        .select('price, status, name, products(title)')
        .eq('product_id', ref.p).eq('key', ref.k).maybeSingle();
      if (!data)                  return json({ error: 'Unknown item' }, 400);
      const pTitle = (data as any).products?.title ?? ref.p;
      if (data.status === 'sold') return json({ error: `${pTitle} is sold` }, 409);
      if (data.price == null)     return json({ error: `${pTitle} is not for sale online` }, 409);
      price = Number(data.price);
      title = `${pTitle} — ${data.name}`;
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
  const shipping = SHIPPING_FLAT;
  const amount = Math.round((subtotal + shipping) * 100) / 100;
  if (amount < 5) return json({ error: 'Order total too low' }, 400);

  // Insert the pending order (tagged with the PayFast env it will use).
  const parts = String(buyer.name).trim().split(/\s+/);
  const nameFirst = parts.shift() ?? '';
  const nameLast  = parts.join(' ');

  const { data: order, error } = await supabase.from('orders').insert({
    buyer_name: String(buyer.name).trim(),
    buyer_email: String(buyer.email).trim(),
    ship_address: ship,
    items: lines,
    subtotal, shipping, amount,
    env: sandbox ? 'sandbox' : 'live',
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

  let sigStr = pairs.map(([k, v]) => `${k}=${pfEncode(v)}`).join('&');
  if (pf.passphrase) sigStr += `&passphrase=${pfEncode(pf.passphrase)}`;
  const signature = await md5(sigStr);

  const fields = Object.fromEntries(pairs);
  fields.signature = signature;

  return json({ process_url: pf.process, fields });
});
