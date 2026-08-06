-- Orders: guest checkout (no login required)
--
-- Written only by the `create-order` and `payfast-notify` edge functions, which
-- connect as service role. Unlike the catalogue, this table is user data: RLS is
-- enabled with NO policies, so anon/authenticated cannot read or write it
-- directly. A buyer views their order through an edge function that takes the
-- unguessable `order_token` (emailed / shown on the success page).
--
-- The `amount` column is authoritative: `create-order` computes it server-side
-- from the catalogue (never from the browser cart) and it is what PayFast is
-- asked to charge and what `payfast-notify` reconciles the ITN against.

CREATE TABLE IF NOT EXISTS orders (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_token   TEXT NOT NULL UNIQUE
                  DEFAULT replace(gen_random_uuid()::text, '-', ''),  -- 32-hex lookup token
  buyer_name    TEXT  NOT NULL,
  buyer_email   TEXT  NOT NULL,
  ship_address  JSONB NOT NULL,          -- {line1, line2, city, province, postcode, country, phone}
  items         JSONB NOT NULL,          -- snapshot: [{ref, title, unit_price, qty, line_total}]
  subtotal      NUMERIC(10,2) NOT NULL,
  shipping      NUMERIC(10,2) NOT NULL DEFAULT 0,
  amount        NUMERIC(10,2) NOT NULL,  -- subtotal + shipping; the charged total
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'paid', 'failed', 'cancelled')),
  env           TEXT NOT NULL DEFAULT 'live'
                  CHECK (env IN ('sandbox', 'live')),  -- which PayFast the order used
  pf_payment_id TEXT,                     -- PayFast pf_payment_id, from the ITN
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at       TIMESTAMPTZ
  -- user_id UUID REFERENCES auth.users(id)  ← added later to link guest orders
  --                                            to accounts by matching buyer_email
);

CREATE INDEX IF NOT EXISTS orders_email_idx   ON orders (buyer_email);
CREATE INDEX IF NOT EXISTS orders_status_idx  ON orders (status);
CREATE INDEX IF NOT EXISTS orders_created_idx ON orders (created_at DESC);

-- Deny all direct access; the edge functions connect as service role.
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
