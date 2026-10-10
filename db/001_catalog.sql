-- Catalog: categories, gift-tag set tiers and products (with their prices)
--
-- This is the production source of truth for the shop catalogue. The offline
-- dev build seeds the same data into localStorage from ui/demo.js instead.
--
-- The catalogue is public, read-only data. RLS is enabled with a permissive
-- SELECT policy, and SELECT is granted to the API roles, so the browser reads
-- these tables straight from the Supabase REST API (PostgREST) with the
-- publishable key — no edge function. No write access is granted. User/order
-- data added later gets its own restrictive RLS, independent of these.

-- Categories (collection pages: townscapes / amelias / gifttags)
CREATE TABLE IF NOT EXISTS categories (
  slug     TEXT   PRIMARY KEY,
  title    TEXT   NOT NULL,
  eyebrow  TEXT,
  intro    TEXT,
  empty    TEXT,                    -- empty-state copy (optional)
  sort     INT    NOT NULL DEFAULT 0
);

-- Gift-tag set-pricing tiers (belong to a category)
CREATE TABLE IF NOT EXISTS category_tiers (
  id             BIGSERIAL PRIMARY KEY,
  category_slug  TEXT   NOT NULL REFERENCES categories(slug) ON DELETE CASCADE,
  key            TEXT   NOT NULL,
  name           TEXT   NOT NULL,
  sub            TEXT,
  price          NUMERIC(10,2) NOT NULL,
  sort           INT    NOT NULL DEFAULT 0,
  UNIQUE (category_slug, key)
);

-- Products (one catalogue item: an artwork or a gift-tag design). The
-- purchasable options are flat columns, addressed in the cart by key:
-- 'print' / 'single' → price, 'orig' → original_price + original_status.
CREATE TABLE IF NOT EXISTS products (
  id              TEXT   PRIMARY KEY,                   -- slug
  category_slug   TEXT   NOT NULL REFERENCES categories(slug) ON DELETE RESTRICT,
  title           TEXT   NOT NULL,
  place           TEXT,                                 -- artworks; NULL for gift tags
  year            INT,                                  -- artworks; NULL for gift tags
  size            TEXT,                                 -- artworks; NULL for gift tags
  orientation     TEXT,                                 -- artworks; NULL for gift tags
  tag_range       TEXT,                                 -- gift-tag colour range; NULL for artworks
  blurb           TEXT,
  image           TEXT   NOT NULL,
  image_large     TEXT,                                 -- hero; falls back to image
  price           NUMERIC(10,2),                        -- print (artworks) / single (gift tags); NULL = not sold online
  original_price  NUMERIC(10,2),                        -- NULL = price on application
  original_status TEXT   CHECK (original_status IN ('available', 'sold')),  -- NULL = no original
  sort            INT    NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS products_category_idx ON products (category_slug, sort);

-- Public, read-only access: enable RLS, add a SELECT-only policy, and grant
-- SELECT to the API roles. The browser reads these directly over the REST API.
ALTER TABLE categories       ENABLE ROW LEVEL SECURITY;
ALTER TABLE category_tiers   ENABLE ROW LEVEL SECURITY;
ALTER TABLE products         ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read" ON categories;
DROP POLICY IF EXISTS "Public read" ON category_tiers;
DROP POLICY IF EXISTS "Public read" ON products;

CREATE POLICY "Public read" ON categories       FOR SELECT USING (true);
CREATE POLICY "Public read" ON category_tiers   FOR SELECT USING (true);
CREATE POLICY "Public read" ON products         FOR SELECT USING (true);

GRANT SELECT ON categories, category_tiers, products
  TO anon, authenticated;
