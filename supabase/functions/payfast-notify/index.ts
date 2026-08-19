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
// The order's session carries the `env` (sandbox|live) that selects which
// PayFast host + passphrase to use, so one project handles both — we look the
// order up first (by the unverified m_payment_id), read env from its session,
// and verify everything against that env.
//
// On the first transition to paid it sends the buyer a notice-of-order email
// (an HTML invoice) via the Gmail API — best-effort, so a mail failure never
// fails the ITN (the order is already marked paid). See the "Order email"
// section below; it no-ops unless the GMAIL_* secrets are configured.
//
// Deploy with JWT verification OFF (PayFast sends no Supabase key):
//   supabase functions deploy payfast-notify --no-verify-jwt

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

function pfEnv(sandbox: boolean) {
  const pass = (k: string) => (Deno.env.get(k) ?? '').trim();
  return sandbox
    ? { passphrase: pass('PF_SANDBOX_PASSPHRASE'), validate: 'https://sandbox.payfast.co.za/eng/query/validate' }
    : { passphrase: pass('PF_PASSPHRASE'),         validate: 'https://www.payfast.co.za/eng/query/validate' };
}

const pfEncode = (v: unknown) =>
  encodeURIComponent(String(v))
    .replace(/%20/g, '+')
    .replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

async function md5(s: string): Promise<string> {
  const d = await crypto.subtle.digest('MD5', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ===========================================================================
// Order email — the notice-of-order (HTML invoice), sent via the Gmail API.
// ===========================================================================
//
// Sends as a Google Workspace mailbox using a service account with
// domain-wide delegation (scope https://www.googleapis.com/auth/gmail.send).
// It is pure HTTPS (no SMTP), which is the reliable transport in the edge
// runtime: sign a short JWT with the service-account key, exchange it for an
// access token, then POST an RFC-822 message to gmail.users.messages.send.
//
// Configured entirely through function secrets; if GMAIL_SENDER or the
// service-account credentials are absent, sending is a silent no-op (so the
// checkout keeps working before email is wired up).
//   GMAIL_SENDER          the mailbox to send as, e.g. orders@wherethereslight.co.za
//   GMAIL_SA_EMAIL        the service account's email address
//   GMAIL_SA_PRIVATE_KEY  the service account's PEM private key (\n may be escaped)
//   ORDER_EMAIL_BCC       optional — BCC a copy of every order email here

const CURRENCY = (n: number) => {
  const v = Math.round(Number(n) * 100) / 100;
  return `${v < 0 ? '-R' : 'R'}${Math.abs(v).toFixed(2)}`;   // -R50.00, not R-50.00
};

const escapeHtml = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

// Standard base64 of bytes (used for the message body part), wrapped at 76 cols
// so no MIME line exceeds the limit.
function base64Wrapped(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return (btoa(bin).match(/.{1,76}/g) ?? []).join('\r\n');
}

// base64url of bytes / string (JWT segments and the whole raw message).
function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const base64urlStr = (s: string) => base64url(new TextEncoder().encode(s));

// Import the service-account PEM (PKCS#8) as an RS256 signing key.
async function importServiceKey(pem: string): Promise<CryptoKey> {
  const body = pem
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '');
  const der = Uint8Array.from(atob(body), c => c.charCodeAt(0));
  // globalThis.crypto (native WebCrypto), not the std `crypto` imported above
  // for MD5 — the same distinction create-order makes for its SHA-256 hashing.
  return globalThis.crypto.subtle.importKey(
    'pkcs8', der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign'],
  );
}

// Mint a Gmail send access token for the impersonated sender via the JWT-bearer
// grant (service account + domain-wide delegation).
async function gmailAccessToken(saEmail: string, saKey: string, sender: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: saEmail,
    sub: sender,                              // impersonate the sending mailbox
    scope: 'https://www.googleapis.com/auth/gmail.send',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${base64urlStr(JSON.stringify(header))}.${base64urlStr(JSON.stringify(claim))}`;
  const key = await importServiceKey(saKey);
  const sig = await globalThis.crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' }, key, new TextEncoder().encode(unsigned),
  );
  const jwt = `${unsigned}.${base64url(new Uint8Array(sig))}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`token ${res.status}: ${await res.text()}`);
  const { access_token } = await res.json();
  if (!access_token) throw new Error('no access_token');
  return access_token as string;
}

// Send one HTML email as `sender` through the Gmail API.
async function sendGmail(opts: {
  saEmail: string; saKey: string; sender: string;
  to: string; bcc?: string; subject: string; html: string;
}): Promise<void> {
  const token = await gmailAccessToken(opts.saEmail, opts.saKey, opts.sender);
  const headers = [
    `From: Where There's Light <${opts.sender}>`,
    `To: ${opts.to}`,
    ...(opts.bcc ? [`Bcc: ${opts.bcc}`] : []),
    `Subject: ${opts.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Wrapped(new TextEncoder().encode(opts.html)),
  ].join('\r\n');
  const raw = base64url(new TextEncoder().encode(headers));

  const res = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw }),
    },
  );
  if (!res.ok) throw new Error(`send ${res.status}: ${await res.text()}`);
}

// Build the notice-of-order invoice HTML from the stored order snapshot. This is
// an order confirmation / receipt (the business is not VAT-registered), not a
// tax invoice — no VAT line or VAT number.
function invoiceHtml(order: any): string {
  const ref = String(order.order_token).slice(0, 8).toUpperCase();
  const ship = order.ship_address ?? {};
  const pickup = ship.method === 'pickup';
  const items: any[] = Array.isArray(order.items) ? order.items : [];

  const rows = items.map(it => {
    const qty = Number(it.qty) || 1;
    return `<tr>
      <td style="padding:8px 0;border-bottom:1px solid #eee">${escapeHtml(it.title)}</td>
      <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:center">${qty}</td>
      <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right">${CURRENCY(it.line_total)}</td>
    </tr>`;
  }).join('');

  const addr = pickup
    ? '<p style="margin:0">Collection — we\'ll be in touch to arrange a time.</p>'
    : [ship.line1, ship.line2, ship.city, ship.province, ship.postcode, ship.country]
        .filter(Boolean).map(escapeHtml).join('<br>');

  const placed = order.created_at
    ? new Date(order.created_at).toLocaleDateString('en-ZA', { year: 'numeric', month: 'long', day: 'numeric' })
    : '';

  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f6f5f2">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f5f2">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:8px;font-family:Georgia,'Times New Roman',serif;color:#2b2b2b">
  <tr><td style="padding:28px 32px 8px">
    <h1 style="margin:0 0 4px;font-size:22px">Thank you, ${escapeHtml(order.buyer_name)}</h1>
    <p style="margin:0;color:#666;font-size:14px">Your order is confirmed and paid.</p>
  </td></tr>
  <tr><td style="padding:8px 32px;color:#666;font-size:13px">
    Order <strong style="color:#2b2b2b">#${ref}</strong>${placed ? ` &middot; ${escapeHtml(placed)}` : ''}
  </td></tr>
  <tr><td style="padding:8px 32px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:15px">
      <tr>
        <th align="left"   style="padding:6px 0;border-bottom:2px solid #2b2b2b;font-size:13px">Item</th>
        <th align="center" style="padding:6px 0;border-bottom:2px solid #2b2b2b;font-size:13px">Qty</th>
        <th align="right"  style="padding:6px 0;border-bottom:2px solid #2b2b2b;font-size:13px">Total</th>
      </tr>
      ${rows}
      <tr>
        <td colspan="2" style="padding:8px 0;text-align:right;color:#666">Subtotal</td>
        <td style="padding:8px 0;text-align:right">${CURRENCY(order.subtotal)}</td>
      </tr>
      <tr>
        <td colspan="2" style="padding:2px 0;text-align:right;color:#666">Shipping</td>
        <td style="padding:2px 0;text-align:right">${Number(order.shipping) > 0 ? CURRENCY(order.shipping) : 'Free'}</td>
      </tr>
      <tr>
        <td colspan="2" style="padding:10px 0 0;text-align:right;font-size:17px;font-weight:bold">Total paid</td>
        <td style="padding:10px 0 0;text-align:right;font-size:17px;font-weight:bold">${CURRENCY(order.amount)}</td>
      </tr>
    </table>
  </td></tr>
  <tr><td style="padding:16px 32px;font-size:14px">
    <p style="margin:0 0 4px;font-weight:bold;font-size:13px;color:#666">${pickup ? 'Collection' : 'Delivery to'}</p>
    ${addr}
  </td></tr>
  <tr><td style="padding:16px 32px 28px;border-top:1px solid #eee;color:#888;font-size:12px">
    <p style="margin:0">We'll email you again when your order is on its way. Questions? Just reply to this email.</p>
    <p style="margin:8px 0 0">Where There's Light &middot; wherethereslight.co.za</p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

// Send the notice-of-order email for a paid order. Best-effort: swallows every
// error (logs it) so a mail problem never fails the ITN — the order is paid
// regardless. No-ops unless the Gmail secrets are configured.
async function sendOrderEmail(order: any): Promise<void> {
  const sender = (Deno.env.get('GMAIL_SENDER') ?? '').trim();
  const saEmail = (Deno.env.get('GMAIL_SA_EMAIL') ?? '').trim();
  const saKey = Deno.env.get('GMAIL_SA_PRIVATE_KEY') ?? '';
  const bcc = (Deno.env.get('ORDER_EMAIL_BCC') ?? '').trim() || undefined;
  if (!sender || !saEmail || !saKey) return;   // not configured — skip silently

  try {
    const ref = String(order.order_token).slice(0, 8).toUpperCase();
    await sendGmail({
      saEmail, saKey, sender, bcc,
      to: String(order.buyer_email).trim(),
      subject: `Your Where There's Light order - #${ref}`,
      html: invoiceHtml(order),
    });
  } catch (e) {
    console.error('[order-email]', e instanceof Error ? e.message : String(e));
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const raw = await req.text();                 // keep the exact received order
  const params = new URLSearchParams(raw);
  const data = Object.fromEntries(params);

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

  // Look the order up first (env decides how we verify). The env lives on the
  // order's session, not the order — embed it. The remaining columns are the
  // order snapshot the notice-of-order email is built from. Return 200 for
  // unrecoverable cases so PayFast stops retrying.
  const { data: order } = await supabase.from('orders')
    .select('id, order_token, buyer_name, buyer_email, ship_address, items, subtotal, shipping, amount, status, created_at, sessions(env)')
    .eq('id', data.m_payment_id).maybeSingle();
  if (!order) return new Response('unknown order', { status: 200 });

  const orderEnv = (order as any).sessions?.env;
  if (orderEnv !== 'sandbox' && orderEnv !== 'live')
    return new Response('unknown order env', { status: 200 });

  const env = pfEnv(orderEnv === 'sandbox');

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

    // Notice-of-order email. Reached only on the first COMPLETE (the `already
    // paid` guard above short-circuits repeat ITNs), so the buyer is emailed
    // exactly once. Best-effort — failures are logged, never surfaced to
    // PayFast, since the order is already paid.
    await sendOrderEmail(order);
  } else {
    await supabase.from('orders').update({ status: 'failed' }).eq('id', order.id);
  }

  return new Response('ok', { status: 200 });
});
