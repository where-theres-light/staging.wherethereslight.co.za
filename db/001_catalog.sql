-- Catalog: categories, print editions, products and their purchasable variants
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

-- Shared fine-art print edition ladder (A4…A2, framed, original)
CREATE TABLE IF NOT EXISTS print_editions (
  key    TEXT   PRIMARY KEY,
  kind   TEXT   NOT NULL,
  name   TEXT   NOT NULL,
  sub    TEXT,
  price  NUMERIC(10,2),             -- NULL = price on application
  sort   INT    NOT NULL DEFAULT 0
);

-- Products (one catalogue item: an artwork or a gift-tag design)
CREATE TABLE IF NOT EXISTS products (
  id            TEXT   PRIMARY KEY,           -- slug
  category_slug TEXT   NOT NULL REFERENCES categories(slug) ON DELETE RESTRICT,
  title         TEXT   NOT NULL,
  place         TEXT,                         -- artworks; NULL for gift tags
  year          INT,                          -- artworks; NULL for gift tags
  size          TEXT,                         -- artworks; NULL for gift tags
  orientation   TEXT,                         -- artworks; NULL for gift tags
  tag_range     TEXT,                         -- gift-tag colour range; NULL for artworks
  blurb         TEXT,
  image         TEXT   NOT NULL,
  image_large   TEXT,                         -- hero; falls back to image
  sort          INT    NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS products_category_idx ON products (category_slug, sort);

-- Product variants (the purchasable options that carry price + stock)
CREATE TABLE IF NOT EXISTS product_variants (
  id          BIGSERIAL PRIMARY KEY,
  product_id  TEXT   NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  key         TEXT   NOT NULL,               -- 'print' | 'orig' | 'single' | …
  kind        TEXT   NOT NULL,               -- 'print' | 'original' | 'edition' | 'single' | 'set'
  name        TEXT   NOT NULL,
  sub         TEXT,
  price       NUMERIC(10,2),                 -- NULL = price on application
  status      TEXT,                          -- 'available' | 'sold' (one-of-a-kind); NULL otherwise
  sort        INT    NOT NULL DEFAULT 0,
  UNIQUE (product_id, key)
);

CREATE INDEX IF NOT EXISTS product_variants_product_idx ON product_variants (product_id);

-- Public, read-only access: enable RLS, add a SELECT-only policy, and grant
-- SELECT to the API roles. The browser reads these directly over the REST API.
ALTER TABLE categories       ENABLE ROW LEVEL SECURITY;
ALTER TABLE category_tiers   ENABLE ROW LEVEL SECURITY;
ALTER TABLE print_editions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE products         ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_variants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read" ON categories;
DROP POLICY IF EXISTS "Public read" ON category_tiers;
DROP POLICY IF EXISTS "Public read" ON print_editions;
DROP POLICY IF EXISTS "Public read" ON products;
DROP POLICY IF EXISTS "Public read" ON product_variants;

CREATE POLICY "Public read" ON categories       FOR SELECT USING (true);
CREATE POLICY "Public read" ON category_tiers   FOR SELECT USING (true);
CREATE POLICY "Public read" ON print_editions   FOR SELECT USING (true);
CREATE POLICY "Public read" ON products         FOR SELECT USING (true);
CREATE POLICY "Public read" ON product_variants FOR SELECT USING (true);

GRANT SELECT ON categories, category_tiers, print_editions, products, product_variants
  TO anon, authenticated;


-- ============================== Seed data ==============================

-- Categories
INSERT INTO categories (slug, title, eyebrow, intro, empty, sort) VALUES
  ('townscapes', 'Townscapes', 'The flagship range', 'Our flagship range — collections of towns drawn in pen on high-quality Fabriano paper. Every gable, fountain and garden held inside a dome of light. We are always on the lookout for more beautiful places to capture.', NULL, 0)
  ON CONFLICT (slug) DO NOTHING;
INSERT INTO categories (slug, title, eyebrow, intro, empty, sort) VALUES
  ('amelias', 'Amelia''s House', 'Miniature interiors', 'Amelia’s House is a small collection of illustrations. Perfect to fill a small space on your gallery wall, group together as a collection or to add interest to a small space.', 'New little rooms are being drawn. Join the studio letter and we’ll tell you the moment Amelia’s House opens its doors.', 1)
  ON CONFLICT (slug) DO NOTHING;
INSERT INTO categories (slug, title, eyebrow, intro, empty, sort) VALUES
  ('gifttags', 'Gift Tags', 'In collaboration with Koue Koffie Boeke', 'We are very proud to be collaborating with Koue Koffie Boeke on our range of gift tags. Our range includes cards perfect for all ages and can be purchased individually or in sets.', NULL, 2)
  ON CONFLICT (slug) DO NOTHING;

-- Category tiers
INSERT INTO category_tiers (category_slug, key, name, sub, price, sort) VALUES
  ('gifttags', 'single', 'Singles', 'Individual gift tag', 15, 0)
  ON CONFLICT (category_slug, key) DO NOTHING;
INSERT INTO category_tiers (category_slug, key, name, sub, price, sort) VALUES
  ('gifttags', 'mono5', 'Mono set of 5', 'Signature monochrome', 60, 1)
  ON CONFLICT (category_slug, key) DO NOTHING;
INSERT INTO category_tiers (category_slug, key, name, sub, price, sort) VALUES
  ('gifttags', 'mix10', 'Mixed set of 10', 'Colour · water-colour range', 100, 2)
  ON CONFLICT (category_slug, key) DO NOTHING;

-- Print editions
INSERT INTO print_editions (key, kind, name, sub, price, sort) VALUES
  ('a4', 'edition', 'Fine-art print · A4', 'Open edition · 21 × 30 cm', 690, 0)
  ON CONFLICT (key) DO NOTHING;
INSERT INTO print_editions (key, kind, name, sub, price, sort) VALUES
  ('a3', 'edition', 'Fine-art print · A3', 'Limited edition of 50 · 30 × 42 cm', 1250, 1)
  ON CONFLICT (key) DO NOTHING;
INSERT INTO print_editions (key, kind, name, sub, price, sort) VALUES
  ('a2', 'edition', 'Fine-art print · A2', 'Limited edition of 25 · 42 × 59 cm', 1950, 2)
  ON CONFLICT (key) DO NOTHING;
INSERT INTO print_editions (key, kind, name, sub, price, sort) VALUES
  ('a3f', 'edition', 'Framed A3 print', 'Oak frame, museum glass · edition of 50', 2450, 3)
  ON CONFLICT (key) DO NOTHING;
INSERT INTO print_editions (key, kind, name, sub, price, sort) VALUES
  ('orig', 'original', 'Original ink drawing', 'One of a kind · ink on 300gsm cotton paper', NULL, 4)
  ON CONFLICT (key) DO NOTHING;

-- Products
INSERT INTO products (id, category_slug, title, place, year, size, orientation, tag_range, blurb, image, image_large, sort) VALUES
  ('boston', 'townscapes', 'Boston', 'Bellville, Cape Town', 2019, '412 × 297 mm', 'landscape', NULL, 'The old Boston shopfronts gather beneath a dotted dome of Karoo light, hemmed in by a riot of fynbos and garden green.', 'assets/boston-small.jpg', 'assets/boston-small.jpg', 0)
  ON CONFLICT (id) DO NOTHING;
INSERT INTO products (id, category_slug, title, place, year, size, orientation, tag_range, blurb, image, image_large, sort) VALUES
  ('swellendam', 'townscapes', 'Swellendam', 'Overberg, Western Cape', 2018, '412 × 297 mm', 'landscape', NULL, 'The Drostdy and its oaks, drawn in patient ink — one of the oldest towns in the country, kept in a single quiet frame.', 'assets/swellendam-small.jpg', NULL, 1)
  ON CONFLICT (id) DO NOTHING;
INSERT INTO products (id, category_slug, title, place, year, size, orientation, tag_range, blurb, image, image_large, sort) VALUES
  ('somersetwest', 'townscapes', 'Somerset West', 'Helderberg, Western Cape', 2018, '412 × 297 mm', 'landscape', NULL, 'Steeples, verandahs and a fountained square nestle below the Helderberg, wrapped in a hedge of hand-inked blooms.', 'assets/somersetwest-small.jpg', NULL, 2)
  ON CONFLICT (id) DO NOTHING;
INSERT INTO products (id, category_slug, title, place, year, size, orientation, tag_range, blurb, image, image_large, sort) VALUES
  ('windhoek', 'townscapes', 'Windhoek', 'Khomas, Namibia', 2020, '412 × 297 mm', 'landscape', NULL, 'The Christuskirche and the old colonial roofline rise from a desert garden, the mountains pencilled soft behind.', 'assets/windhoek-small.jpg', NULL, 3)
  ON CONFLICT (id) DO NOTHING;
INSERT INTO products (id, category_slug, title, place, year, size, orientation, tag_range, blurb, image, image_large, sort) VALUES
  ('caledon', 'townscapes', 'Caledon', 'Overberg, Western Cape', 2017, '412 × 297 mm', 'landscape', NULL, 'The Dutch Reformed church and its gables, cradled in the wild garden that gave the town its hot-spring fame.', 'assets/caledon-small.jpg', NULL, 4)
  ON CONFLICT (id) DO NOTHING;
INSERT INTO products (id, category_slug, title, place, year, size, orientation, tag_range, blurb, image, image_large, sort) VALUES
  ('london', 'townscapes', 'London', 'England, United Kingdom', 2023, '412 × 297 mm', 'landscape', NULL, 'Big Ben, the Eye and a skyline of landmarks gathered into a single dome of light, wreathed in an English cottage garden.', 'assets/london-small.jpg', NULL, 5)
  ON CONFLICT (id) DO NOTHING;
INSERT INTO products (id, category_slug, title, place, year, size, orientation, tag_range, blurb, image, image_large, sort) VALUES
  ('polperro', 'townscapes', 'Polperro', 'Cornwall, United Kingdom', 2023, '412 × 297 mm', 'landscape', NULL, 'The tumbling harbour cottages of a Cornish fishing village, climbing the hillside above the quay.', 'assets/polperro-small.jpg', NULL, 6)
  ON CONFLICT (id) DO NOTHING;
INSERT INTO products (id, category_slug, title, place, year, size, orientation, tag_range, blurb, image, image_large, sort) VALUES
  ('shanghai', 'townscapes', 'Shanghai', 'China', 2023, '412 × 297 mm', 'landscape', NULL, 'Layered rooftops and the distant tower, drawn inside a circular window of ink and colour — old lanes meeting the modern skyline.', 'assets/shanghai-small.jpg', NULL, 7)
  ON CONFLICT (id) DO NOTHING;
INSERT INTO products (id, category_slug, title, place, year, size, orientation, tag_range, blurb, image, image_large, sort) VALUES
  ('stanford', 'townscapes', 'Stanford', 'Overberg, Western Cape', 2022, '412 × 297 mm', 'landscape', NULL, 'The white church spire and village cottages below the Klein River mountains, held in a wild garden of fynbos.', 'assets/stanford-small.jpg', NULL, 8)
  ON CONFLICT (id) DO NOTHING;
INSERT INTO products (id, category_slug, title, place, year, size, orientation, tag_range, blurb, image, image_large, sort) VALUES
  ('stellenbosch', 'townscapes', 'Stellenbosch', 'Cape Winelands, Western Cape', 2022, '412 × 297 mm', 'landscape', NULL, 'The oak-lined town of gables and the old church tower, cradled below the mountains in a hedge of hand-inked blooms.', 'assets/stellenbosch-small.jpg', NULL, 9)
  ON CONFLICT (id) DO NOTHING;
INSERT INTO products (id, category_slug, title, place, year, size, orientation, tag_range, blurb, image, image_large, sort) VALUES
  ('amelias-house', 'amelias', 'Home', 'Miniature interior · 412 × 297 mm', 2021, '412 × 297 mm', 'landscape', NULL, 'A gabled cottage nestled in its garden — one of the small, lit houses in the Amelia’s House collection. Perfect to fill a small space on your gallery wall or to group together as a collection.', 'assets/home-small.jpg', NULL, 10)
  ON CONFLICT (id) DO NOTHING;
INSERT INTO products (id, category_slug, title, place, year, size, orientation, tag_range, blurb, image, image_large, sort) VALUES
  ('amelias-kitchen', 'amelias', 'Amelia''s Kitchen', 'Miniature interior · 120 × 170 mm', 2024, '120 × 170 mm', 'landscape', NULL, 'A busy little kitchen full of light — herbs at the window, a cat on the bench and everything in its place. From the Amelia’s House collection.', 'assets/kitchen-small.jpg', NULL, 11)
  ON CONFLICT (id) DO NOTHING;
INSERT INTO products (id, category_slug, title, place, year, size, orientation, tag_range, blurb, image, image_large, sort) VALUES
  ('amelias-reading-room', 'amelias', 'Amelia''s Reading Room', 'Miniature interior · 120 × 170 mm', 2024, '120 × 170 mm', 'landscape', NULL, 'A quiet corner to curl up in — a soft armchair, a lamp and a window onto the city. From the Amelia’s House collection.', 'assets/readingroom-small.jpg', NULL, 12)
  ON CONFLICT (id) DO NOTHING;
INSERT INTO products (id, category_slug, title, place, year, size, orientation, tag_range, blurb, image, image_large, sort) VALUES
  ('amelias-study', 'amelias', 'Amelia''s Study', 'Miniature interior · 120 × 170 mm', 2024, '120 × 170 mm', 'landscape', NULL, 'An open book, a cup of coffee and a street view — the perfect spot to think. From the Amelia’s House collection.', 'assets/study-small.jpg', NULL, 13)
  ON CONFLICT (id) DO NOTHING;
INSERT INTO products (id, category_slug, title, place, year, size, orientation, tag_range, blurb, image, image_large, sort) VALUES
  ('gifttag-icecream', 'gifttags', 'Ice-Cream Cone', NULL, NULL, NULL, NULL, 'Water-colour', NULL, 'assets/tag-icecream.jpg', NULL, 14)
  ON CONFLICT (id) DO NOTHING;
INSERT INTO products (id, category_slug, title, place, year, size, orientation, tag_range, blurb, image, image_large, sort) VALUES
  ('gifttag-boots', 'gifttags', 'Garden Boots', NULL, NULL, NULL, NULL, 'Water-colour', NULL, 'assets/tag-boots.jpg', NULL, 15)
  ON CONFLICT (id) DO NOTHING;
INSERT INTO products (id, category_slug, title, place, year, size, orientation, tag_range, blurb, image, image_large, sort) VALUES
  ('gifttag-mouse', 'gifttags', 'Party Mouse', NULL, NULL, NULL, NULL, 'Water-colour', NULL, 'assets/tag-mouse.jpg', NULL, 16)
  ON CONFLICT (id) DO NOTHING;
INSERT INTO products (id, category_slug, title, place, year, size, orientation, tag_range, blurb, image, image_large, sort) VALUES
  ('gifttag-dots', 'gifttags', 'Happy Dots', NULL, NULL, NULL, NULL, 'Water-colour', NULL, 'assets/tag-dots.jpg', NULL, 17)
  ON CONFLICT (id) DO NOTHING;
INSERT INTO products (id, category_slug, title, place, year, size, orientation, tag_range, blurb, image, image_large, sort) VALUES
  ('gifttag-penguins', 'gifttags', 'Party Penguins', NULL, NULL, NULL, NULL, 'Colour', NULL, 'assets/tag-penguins.jpg', NULL, 18)
  ON CONFLICT (id) DO NOTHING;
INSERT INTO products (id, category_slug, title, place, year, size, orientation, tag_range, blurb, image, image_large, sort) VALUES
  ('gifttag-rocket', 'gifttags', 'Rocket', NULL, NULL, NULL, NULL, 'Colour', NULL, 'assets/tag-rocket.jpg', NULL, 19)
  ON CONFLICT (id) DO NOTHING;
INSERT INTO products (id, category_slug, title, place, year, size, orientation, tag_range, blurb, image, image_large, sort) VALUES
  ('gifttag-octopus', 'gifttags', 'Octopus', NULL, NULL, NULL, NULL, 'Colour', NULL, 'assets/tag-octopus.jpg', NULL, 20)
  ON CONFLICT (id) DO NOTHING;
INSERT INTO products (id, category_slug, title, place, year, size, orientation, tag_range, blurb, image, image_large, sort) VALUES
  ('gifttag-bunny', 'gifttags', 'Meadow Bunny', NULL, NULL, NULL, NULL, 'Colour', NULL, 'assets/tag-bunny.jpg', NULL, 21)
  ON CONFLICT (id) DO NOTHING;
INSERT INTO products (id, category_slug, title, place, year, size, orientation, tag_range, blurb, image, image_large, sort) VALUES
  ('gifttag-blossom', 'gifttags', 'Cherry Blossom', NULL, NULL, NULL, NULL, 'Colour', NULL, 'assets/tag-blossom.jpg', NULL, 22)
  ON CONFLICT (id) DO NOTHING;
INSERT INTO products (id, category_slug, title, place, year, size, orientation, tag_range, blurb, image, image_large, sort) VALUES
  ('gifttag-roses', 'gifttags', 'Rose Garden', NULL, NULL, NULL, NULL, 'Monochrome', NULL, 'assets/tag-roses.jpg', NULL, 23)
  ON CONFLICT (id) DO NOTHING;
INSERT INTO products (id, category_slug, title, place, year, size, orientation, tag_range, blurb, image, image_large, sort) VALUES
  ('gifttag-dahlias', 'gifttags', 'Dahlias', NULL, NULL, NULL, NULL, 'Monochrome', NULL, 'assets/tag-dahlias.jpg', NULL, 24)
  ON CONFLICT (id) DO NOTHING;
INSERT INTO products (id, category_slug, title, place, year, size, orientation, tag_range, blurb, image, image_large, sort) VALUES
  ('gifttag-town', 'gifttags', 'Townscape', NULL, NULL, NULL, NULL, 'Monochrome', NULL, 'assets/tag-town.jpg', NULL, 25)
  ON CONFLICT (id) DO NOTHING;
INSERT INTO products (id, category_slug, title, place, year, size, orientation, tag_range, blurb, image, image_large, sort) VALUES
  ('gifttag-window', 'gifttags', 'Windowsill', NULL, NULL, NULL, NULL, 'Monochrome', NULL, 'assets/tag-window.jpg', NULL, 26)
  ON CONFLICT (id) DO NOTHING;

-- Product variants
INSERT INTO product_variants (product_id, key, kind, name, sub, price, status, sort) VALUES
  ('boston', 'print', 'print', 'Fine-art print', 'Unframed · 412 × 297 mm', 360, NULL, 0)
  ON CONFLICT (product_id, key) DO NOTHING;
INSERT INTO product_variants (product_id, key, kind, name, sub, price, status, sort) VALUES
  ('boston', 'orig', 'original', 'Original artwork', 'Unframed · one of a kind', 1300, 'available', 1)
  ON CONFLICT (product_id, key) DO NOTHING;
INSERT INTO product_variants (product_id, key, kind, name, sub, price, status, sort) VALUES
  ('swellendam', 'print', 'print', 'Fine-art print', 'Unframed · 412 × 297 mm', 360, NULL, 0)
  ON CONFLICT (product_id, key) DO NOTHING;
INSERT INTO product_variants (product_id, key, kind, name, sub, price, status, sort) VALUES
  ('swellendam', 'orig', 'original', 'Original artwork', 'Unframed · one of a kind', 1300, 'available', 1)
  ON CONFLICT (product_id, key) DO NOTHING;
INSERT INTO product_variants (product_id, key, kind, name, sub, price, status, sort) VALUES
  ('somersetwest', 'print', 'print', 'Fine-art print', 'Unframed · 412 × 297 mm', 360, NULL, 0)
  ON CONFLICT (product_id, key) DO NOTHING;
INSERT INTO product_variants (product_id, key, kind, name, sub, price, status, sort) VALUES
  ('somersetwest', 'orig', 'original', 'Original artwork', 'Unframed · one of a kind', 1300, 'available', 1)
  ON CONFLICT (product_id, key) DO NOTHING;
INSERT INTO product_variants (product_id, key, kind, name, sub, price, status, sort) VALUES
  ('windhoek', 'print', 'print', 'Fine-art print', 'Unframed · 412 × 297 mm', 360, NULL, 0)
  ON CONFLICT (product_id, key) DO NOTHING;
INSERT INTO product_variants (product_id, key, kind, name, sub, price, status, sort) VALUES
  ('windhoek', 'orig', 'original', 'Original artwork', 'Unframed · one of a kind', 1300, 'available', 1)
  ON CONFLICT (product_id, key) DO NOTHING;
INSERT INTO product_variants (product_id, key, kind, name, sub, price, status, sort) VALUES
  ('caledon', 'print', 'print', 'Fine-art print', 'Unframed · 412 × 297 mm', 360, NULL, 0)
  ON CONFLICT (product_id, key) DO NOTHING;
INSERT INTO product_variants (product_id, key, kind, name, sub, price, status, sort) VALUES
  ('caledon', 'orig', 'original', 'Original artwork', 'Unframed · one of a kind', 1300, 'sold', 1)
  ON CONFLICT (product_id, key) DO NOTHING;
INSERT INTO product_variants (product_id, key, kind, name, sub, price, status, sort) VALUES
  ('london', 'print', 'print', 'Fine-art print', 'Unframed · 412 × 297 mm', 360, NULL, 0)
  ON CONFLICT (product_id, key) DO NOTHING;
INSERT INTO product_variants (product_id, key, kind, name, sub, price, status, sort) VALUES
  ('london', 'orig', 'original', 'Original artwork', 'Unframed · one of a kind', 1300, 'available', 1)
  ON CONFLICT (product_id, key) DO NOTHING;
INSERT INTO product_variants (product_id, key, kind, name, sub, price, status, sort) VALUES
  ('polperro', 'print', 'print', 'Fine-art print', 'Unframed · 412 × 297 mm', 360, NULL, 0)
  ON CONFLICT (product_id, key) DO NOTHING;
INSERT INTO product_variants (product_id, key, kind, name, sub, price, status, sort) VALUES
  ('polperro', 'orig', 'original', 'Original artwork', 'Unframed · one of a kind', 1300, 'available', 1)
  ON CONFLICT (product_id, key) DO NOTHING;
INSERT INTO product_variants (product_id, key, kind, name, sub, price, status, sort) VALUES
  ('shanghai', 'print', 'print', 'Fine-art print', 'Unframed · 412 × 297 mm', 360, NULL, 0)
  ON CONFLICT (product_id, key) DO NOTHING;
INSERT INTO product_variants (product_id, key, kind, name, sub, price, status, sort) VALUES
  ('shanghai', 'orig', 'original', 'Original artwork', 'Unframed · one of a kind', 1300, 'available', 1)
  ON CONFLICT (product_id, key) DO NOTHING;
INSERT INTO product_variants (product_id, key, kind, name, sub, price, status, sort) VALUES
  ('stanford', 'print', 'print', 'Fine-art print', 'Unframed · 412 × 297 mm', 360, NULL, 0)
  ON CONFLICT (product_id, key) DO NOTHING;
INSERT INTO product_variants (product_id, key, kind, name, sub, price, status, sort) VALUES
  ('stanford', 'orig', 'original', 'Original artwork', 'Unframed · one of a kind', 1300, 'available', 1)
  ON CONFLICT (product_id, key) DO NOTHING;
INSERT INTO product_variants (product_id, key, kind, name, sub, price, status, sort) VALUES
  ('stellenbosch', 'print', 'print', 'Fine-art print', 'Unframed · 412 × 297 mm', 360, NULL, 0)
  ON CONFLICT (product_id, key) DO NOTHING;
INSERT INTO product_variants (product_id, key, kind, name, sub, price, status, sort) VALUES
  ('stellenbosch', 'orig', 'original', 'Original artwork', 'Unframed · one of a kind', 1300, 'available', 1)
  ON CONFLICT (product_id, key) DO NOTHING;
INSERT INTO product_variants (product_id, key, kind, name, sub, price, status, sort) VALUES
  ('amelias-house', 'print', 'print', 'Fine-art print', 'Unframed · 412 × 297 mm', 360, NULL, 0)
  ON CONFLICT (product_id, key) DO NOTHING;
INSERT INTO product_variants (product_id, key, kind, name, sub, price, status, sort) VALUES
  ('amelias-house', 'orig', 'original', 'Original illustration', 'Unframed · one of a kind', NULL, 'sold', 1)
  ON CONFLICT (product_id, key) DO NOTHING;
INSERT INTO product_variants (product_id, key, kind, name, sub, price, status, sort) VALUES
  ('amelias-kitchen', 'print', 'print', 'Fine-art print', 'Unframed · 120 × 170 mm · excl. shipping', 170, NULL, 0)
  ON CONFLICT (product_id, key) DO NOTHING;
INSERT INTO product_variants (product_id, key, kind, name, sub, price, status, sort) VALUES
  ('amelias-kitchen', 'orig', 'original', 'Original illustration', 'Unframed · one of a kind', NULL, 'sold', 1)
  ON CONFLICT (product_id, key) DO NOTHING;
INSERT INTO product_variants (product_id, key, kind, name, sub, price, status, sort) VALUES
  ('amelias-reading-room', 'print', 'print', 'Fine-art print', 'Unframed · 120 × 170 mm · excl. shipping', 170, NULL, 0)
  ON CONFLICT (product_id, key) DO NOTHING;
INSERT INTO product_variants (product_id, key, kind, name, sub, price, status, sort) VALUES
  ('amelias-reading-room', 'orig', 'original', 'Original illustration', 'Unframed · one of a kind', NULL, 'sold', 1)
  ON CONFLICT (product_id, key) DO NOTHING;
INSERT INTO product_variants (product_id, key, kind, name, sub, price, status, sort) VALUES
  ('amelias-study', 'print', 'print', 'Fine-art print', 'Unframed · 120 × 170 mm · excl. shipping', 170, NULL, 0)
  ON CONFLICT (product_id, key) DO NOTHING;
INSERT INTO product_variants (product_id, key, kind, name, sub, price, status, sort) VALUES
  ('amelias-study', 'orig', 'original', 'Original illustration', 'Unframed · one of a kind', NULL, 'sold', 1)
  ON CONFLICT (product_id, key) DO NOTHING;
INSERT INTO product_variants (product_id, key, kind, name, sub, price, status, sort) VALUES
  ('gifttag-icecream', 'single', 'single', 'Single gift tag', 'Water-colour · on cardstock', 15, NULL, 0)
  ON CONFLICT (product_id, key) DO NOTHING;
INSERT INTO product_variants (product_id, key, kind, name, sub, price, status, sort) VALUES
  ('gifttag-boots', 'single', 'single', 'Single gift tag', 'Water-colour · on cardstock', 15, NULL, 0)
  ON CONFLICT (product_id, key) DO NOTHING;
INSERT INTO product_variants (product_id, key, kind, name, sub, price, status, sort) VALUES
  ('gifttag-mouse', 'single', 'single', 'Single gift tag', 'Water-colour · on cardstock', 15, NULL, 0)
  ON CONFLICT (product_id, key) DO NOTHING;
INSERT INTO product_variants (product_id, key, kind, name, sub, price, status, sort) VALUES
  ('gifttag-dots', 'single', 'single', 'Single gift tag', 'Water-colour · on cardstock', 15, NULL, 0)
  ON CONFLICT (product_id, key) DO NOTHING;
INSERT INTO product_variants (product_id, key, kind, name, sub, price, status, sort) VALUES
  ('gifttag-penguins', 'single', 'single', 'Single gift tag', 'Colour · on cardstock', 15, NULL, 0)
  ON CONFLICT (product_id, key) DO NOTHING;
INSERT INTO product_variants (product_id, key, kind, name, sub, price, status, sort) VALUES
  ('gifttag-rocket', 'single', 'single', 'Single gift tag', 'Colour · on cardstock', 15, NULL, 0)
  ON CONFLICT (product_id, key) DO NOTHING;
INSERT INTO product_variants (product_id, key, kind, name, sub, price, status, sort) VALUES
  ('gifttag-octopus', 'single', 'single', 'Single gift tag', 'Colour · on cardstock', 15, NULL, 0)
  ON CONFLICT (product_id, key) DO NOTHING;
INSERT INTO product_variants (product_id, key, kind, name, sub, price, status, sort) VALUES
  ('gifttag-bunny', 'single', 'single', 'Single gift tag', 'Colour · on cardstock', 15, NULL, 0)
  ON CONFLICT (product_id, key) DO NOTHING;
INSERT INTO product_variants (product_id, key, kind, name, sub, price, status, sort) VALUES
  ('gifttag-blossom', 'single', 'single', 'Single gift tag', 'Colour · on cardstock', 15, NULL, 0)
  ON CONFLICT (product_id, key) DO NOTHING;
INSERT INTO product_variants (product_id, key, kind, name, sub, price, status, sort) VALUES
  ('gifttag-roses', 'single', 'single', 'Single gift tag', 'Monochrome · on cardstock', 15, NULL, 0)
  ON CONFLICT (product_id, key) DO NOTHING;
INSERT INTO product_variants (product_id, key, kind, name, sub, price, status, sort) VALUES
  ('gifttag-dahlias', 'single', 'single', 'Single gift tag', 'Monochrome · on cardstock', 15, NULL, 0)
  ON CONFLICT (product_id, key) DO NOTHING;
INSERT INTO product_variants (product_id, key, kind, name, sub, price, status, sort) VALUES
  ('gifttag-town', 'single', 'single', 'Single gift tag', 'Monochrome · on cardstock', 15, NULL, 0)
  ON CONFLICT (product_id, key) DO NOTHING;
INSERT INTO product_variants (product_id, key, kind, name, sub, price, status, sort) VALUES
  ('gifttag-window', 'single', 'single', 'Single gift tag', 'Monochrome · on cardstock', 15, NULL, 0)
  ON CONFLICT (product_id, key) DO NOTHING;
