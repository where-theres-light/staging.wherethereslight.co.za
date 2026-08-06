import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { crypto } from 'https://deno.land/std@0.224.0/crypto/mod.ts';

// payfast-notify — PayFast ITN (Instant Transaction Notification) endpoint.
//
// PayFast POSTs here server-to-server after a payment. This is the ONLY source
// of truth for marking an order paid (never the browser return_url). It runs
// four checks before trusting the notice:
//   1. signature — recompute over the received fields (+ passphrase) and match
//   2. validate  — post the raw body back to PayFast, expect 'VALID'
//   3. amount    — amount_gross must equal the order's stored amount
//   4. status    — only payment_status COMPLETE marks the order paid
//
// The order's `env` (sandbox|live) selects which PayFast host + passphrase to
// use, so one project handles both — we look the order up first (by the
// unverified m_payment_id) and verify everything against that env.
//
// Deploy with JWT verification OFF (PayFast sends no Supabase key):
//   supabase functions deploy payfast-notify --no-verify-jwt

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

function pfEnv(sandbox: boolean) {
  return sandbox
    ? { passphrase: Deno.env.get('PF_SANDBOX_PASSPHRASE') ?? '', validate: 'https://sandbox.payfast.co.za/eng/query/validate' }
    : { passphrase: Deno.env.get('PF_PASSPHRASE')         ?? '', validate: 'https://www.payfast.co.za/eng/query/validate' };
}

const pfEncode = (v: unknown) =>
  encodeURIComponent(String(v))
    .replace(/%20/g, '+')
    .replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

async function md5(s: string): Promise<string> {
  const d = await crypto.subtle.digest('MD5', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const raw = await req.text();                 // keep the exact received order
  const params = new URLSearchParams(raw);
  const data = Object.fromEntries(params);

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

  // Look the order up first (env decides how we verify). Return 200 for
  // unrecoverable cases so PayFast stops retrying.
  const { data: order } = await supabase.from('orders')
    .select('id, amount, status, env').eq('id', data.m_payment_id).maybeSingle();
  if (!order) return new Response('unknown order', { status: 200 });

  const env = pfEnv(order.env === 'sandbox');

  // 1. Signature — rebuild from received fields (minus signature), in order.
  const pairs = [...params].filter(([k]) => k !== 'signature');
  let sigStr = pairs.map(([k, v]) => `${k}=${pfEncode(v)}`).join('&');
  if (env.passphrase) sigStr += `&passphrase=${pfEncode(env.passphrase)}`;
  if ((await md5(sigStr)) !== (data.signature ?? '').toLowerCase()) {
    return new Response('invalid signature', { status: 400 });
  }

  // 2. Validate — echo the raw body back to PayFast.
  try {
    const vres = await fetch(env.validate, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: raw,
    });
    if ((await vres.text()).trim() !== 'VALID') return new Response('not validated', { status: 400 });
  } catch {
    return new Response('validate failed', { status: 400 });
  }

  if (order.status === 'paid') return new Response('already paid', { status: 200 });

  // 3. Amount — the ITN gross must match what we stored.
  if (Math.abs(Number(data.amount_gross) - Number(order.amount)) > 0.01) {
    await supabase.from('orders').update({ status: 'failed' }).eq('id', order.id);
    return new Response('amount mismatch', { status: 200 });
  }

  // 4. Status.
  if (data.payment_status === 'COMPLETE') {
    await supabase.from('orders').update({
      status: 'paid',
      pf_payment_id: data.pf_payment_id ?? null,
      paid_at: new Date().toISOString(),
    }).eq('id', order.id);
  } else {
    await supabase.from('orders').update({ status: 'failed' }).eq('id', order.id);
  }

  return new Response('ok', { status: 200 });
});
