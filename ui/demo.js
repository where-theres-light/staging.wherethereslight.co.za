/* ============================================================================
 * demo.js — offline (dev) seed data
 *
 * In production the catalog comes from a Supabase table; in the offline `dev`
 * build the online calls are stripped, so this file seeds the same data into
 * localStorage (key `wtl_catalog`) once, giving the site content with no
 * back-end. It is copied into the build by `make dev` only — never by `make prd`.
 *
 * ── Data model ──────────────────────────────────────────────────────────────
 * The shape below is designed to map onto a Supabase schema:
 *
 *   categories        → table `categories`        (PK: slug)
 *   editions          → table `print_editions`    (the shared A4…A2 ladder)
 *   products          → table `products`          (PK: id/slug, FK: category)
 *   products[].variants → table `product_variants`(FK: product_id)  or a JSONB column
 *
 * A **product** is one catalogue item (an artwork or a gift-tag design). A
 * **variant** is a single purchasable option of that product — the thing that
 * goes in the cart and carries a price. This unifies the three product types:
 *
 *   • townscape   → variants: [ print, original ]
 *   • miniature   → variants: [ print, original ]   (original often sold)
 *   • gift tag    → variants: [ single ]            (sets are category tiers)
 *
 *   product fields
 *     id          slug, unique                     (PK)
 *     category    'townscapes' | 'amelias' | 'gifttags'
 *     title       display name
 *     place       location line          (artworks; null for gift tags)
 *     year        integer                (artworks; null for gift tags)
 *     size        physical size string   (artworks; null for gift tags)
 *     orientation 'landscape' | 'portrait' (artworks; null for gift tags)
 *     range       gift-tag colour range  (gift tags; null for artworks)
 *     blurb       description            (nullable)
 *     image       thumbnail asset path
 *     imageLarge  hero asset path        (nullable — falls back to image)
 *     sort        display order          (assigned below; see foot of file)
 *     variants    array of purchasable options (see below)
 *
 *   variant fields
 *     key     stable id within the product   ('print' | 'orig' | 'single' | …)
 *     kind    'print' | 'original' | 'edition' | 'single' | 'set'
 *     name    option label
 *     sub     supporting line
 *     price   number in ZAR, or null for POA / price-on-application
 *     status  'available' | 'sold'           (one-of-a-kind originals)
 * ========================================================================== */

/* Variant builders — keep the repeated option shapes consistent. */
const _print = (size, price, exclShipping = false) => ({
  key: 'print', kind: 'print', name: 'Fine-art print',
  sub: `Unframed · ${size}${exclShipping ? ' · excl. shipping' : ''}`,
  price
});
const _original = (price, status, illustration = false) => ({
  key: 'orig', kind: 'original',
  name: illustration ? 'Original illustration' : 'Original artwork',
  sub: 'Unframed · one of a kind',
  price, status
});
const _single = (range) => ({
  key: 'single', kind: 'single', name: 'Single gift tag',
  sub: `${range} · on cardstock`, price: 15
});

const DEMO = {
  version: 1,

  /* Collection-page metadata. Gift tags also carry set-pricing `tiers`. */
  categories: {
    townscapes: {
      title: 'Townscapes',
      eyebrow: 'The flagship range',
      intro: 'Our flagship range — collections of towns drawn in pen on high-quality Fabriano paper. We are always on the lookout for more beautiful places to capture.'
    },
    amelias: {
      title: "Amelia's House",
      eyebrow: 'Miniature interiors',
      intro: 'Amelia’s House is a small collection of illustrations. Perfect to fill a small space on your gallery wall, group together as a collection or to add interest to a small space.',
      empty: 'New little rooms are being drawn. Join the studio letter and we’ll tell you the moment Amelia’s House opens its doors.'
    },
    gifttags: {
      title: 'Gift Tags',
      eyebrow: 'In collaboration with Koue Koffie Boeke',
      intro: 'We are very proud to be collaborating with Koue Koffie Boeke on our range of gift tags. Our range includes cards perfect for all ages and can be purchased individually or in sets.',
      tiers: [
        { key: 'single', name: 'Singles',           sub: 'Individual gift tag',            price: 15 },
        { key: 'mono5',  name: 'Mono set of 5',      sub: 'Signature monochrome',           price: 50 },
        { key: 'mix10',  name: 'Mixed set of 10',    sub: 'Colour · water-colour range',    price: 95 }
      ]
    }
  },

  /* Shared fine-art print edition ladder — for pieces sold as an A4…A2 range
     rather than a single print price. (Not used by the current pieces, but
     part of the model; a product opts in with variants of kind 'edition'.) */
  editions: [
    { key: 'a4',  kind: 'edition', name: 'Fine-art print · A4', sub: 'Open edition · 21 × 30 cm',                 price: 690 },
    { key: 'a3',  kind: 'edition', name: 'Fine-art print · A3', sub: 'Limited edition of 50 · 30 × 42 cm',        price: 1250 },
    { key: 'a2',  kind: 'edition', name: 'Fine-art print · A2', sub: 'Limited edition of 25 · 42 × 59 cm',        price: 1950 },
    { key: 'a3f', kind: 'edition', name: 'Framed A3 print',     sub: 'Oak frame, museum glass · edition of 50',   price: 2450 },
    { key: 'orig', kind: 'original', name: 'Original ink drawing', sub: 'One of a kind · ink on 300gsm cotton paper', price: null }
  ],

  products: [
    /* ── Townscapes ───────────────────────────────────────────────────────── */
    {
      id: 'boston', category: 'townscapes', title: 'Boston',
      place: 'Bellville, Cape Town', year: 2019,
      size: '412 × 297 mm', orientation: 'landscape',
      image: 'assets/boston-small.jpg', imageLarge: 'assets/boston-small.jpg',
      blurb: 'The old Boston shopfronts gather beneath a dotted dome of Karoo light, hemmed in by a riot of fynbos and garden green.',
      variants: [_print('412 × 297 mm', 360), _original(1300, 'available')]
    },
    {
      id: 'swellendam', category: 'townscapes', title: 'Swellendam',
      place: 'Overberg, Western Cape', year: 2018,
      size: '412 × 297 mm', orientation: 'landscape',
      image: 'assets/swellendam-small.jpg', imageLarge: null,
      blurb: 'The Drostdy and its oaks, drawn in patient ink — one of the oldest towns in the country, kept in a single quiet frame.',
      variants: [_print('412 × 297 mm', 360), _original(1300, 'available')]
    },
    {
      id: 'somersetwest', category: 'townscapes', title: 'Somerset West',
      place: 'Helderberg, Western Cape', year: 2018,
      size: '412 × 297 mm', orientation: 'landscape',
      image: 'assets/somersetwest-small.jpg', imageLarge: null,
      blurb: 'Steeples, verandahs and a fountained square nestle below the Helderberg, wrapped in a hedge of hand-inked blooms.',
      variants: [_print('412 × 297 mm', 360), _original(1300, 'available')]
    },
    {
      id: 'windhoek', category: 'townscapes', title: 'Windhoek',
      place: 'Khomas, Namibia', year: 2020,
      size: '412 × 297 mm', orientation: 'landscape',
      image: 'assets/windhoek-small.jpg', imageLarge: null,
      blurb: 'The Christuskirche and the old colonial roofline rise from a desert garden, the mountains pencilled soft behind.',
      variants: [_print('412 × 297 mm', 360), _original(1300, 'available')]
    },
    {
      id: 'caledon', category: 'townscapes', title: 'Caledon',
      place: 'Overberg, Western Cape', year: 2017,
      size: '412 × 297 mm', orientation: 'landscape',
      image: 'assets/caledon-small.jpg', imageLarge: null,
      blurb: 'The Dutch Reformed church and its gables, cradled in the wild garden that gave the town its hot-spring fame.',
      variants: [_print('412 × 297 mm', 360), _original(1300, 'sold')]
    },
    {
      id: 'london', category: 'townscapes', title: 'London',
      place: 'England, United Kingdom', year: 2023,
      size: '412 × 297 mm', orientation: 'landscape',
      image: 'assets/london-small.jpg', imageLarge: null,
      blurb: 'Big Ben, the Eye and a skyline of landmarks gathered into a single dome of light, wreathed in an English cottage garden.',
      variants: [_print('412 × 297 mm', 360), _original(1300, 'available')]
    },
    {
      id: 'polperro', category: 'townscapes', title: 'Polperro',
      place: 'Cornwall, United Kingdom', year: 2023,
      size: '412 × 297 mm', orientation: 'landscape',
      image: 'assets/polperro-small.jpg', imageLarge: null,
      blurb: 'The tumbling harbour cottages of a Cornish fishing village, climbing the hillside above the quay.',
      variants: [_print('412 × 297 mm', 360), _original(1300, 'available')]
    },
    {
      id: 'shanghai', category: 'townscapes', title: 'Shanghai',
      place: 'China', year: 2023,
      size: '412 × 297 mm', orientation: 'landscape',
      image: 'assets/shanghai-small.jpg', imageLarge: null,
      blurb: 'Layered rooftops and the distant tower, drawn inside a circular window of ink and colour — old lanes meeting the modern skyline.',
      variants: [_print('412 × 297 mm', 360), _original(1300, 'available')]
    },
    {
      id: 'stanford', category: 'townscapes', title: 'Stanford',
      place: 'Overberg, Western Cape', year: 2022,
      size: '412 × 297 mm', orientation: 'landscape',
      image: 'assets/stanford-small.jpg', imageLarge: null,
      blurb: 'The white church spire and village cottages below the Klein River mountains, held in a wild garden of fynbos.',
      variants: [_print('412 × 297 mm', 360), _original(1300, 'available')]
    },
    {
      id: 'stellenbosch', category: 'townscapes', title: 'Stellenbosch',
      place: 'Cape Winelands, Western Cape', year: 2022,
      size: '412 × 297 mm', orientation: 'landscape',
      image: 'assets/stellenbosch-small.jpg', imageLarge: null,
      blurb: 'The oak-lined town of gables and the old church tower, cradled below the mountains in a hedge of hand-inked blooms.',
      variants: [_print('412 × 297 mm', 360), _original(1300, 'available')]
    },

    /* ── Amelia's House · miniature interiors ─────────────────────────────── */
    {
      id: 'amelias-house', category: 'amelias', title: 'Home',
      place: 'Miniature interior · 412 × 297 mm', year: 2021,
      size: '412 × 297 mm', orientation: 'landscape',
      image: 'assets/home-small.jpg', imageLarge: null,
      blurb: 'A gabled cottage nestled in its garden — one of the small, lit houses in the Amelia’s House collection. Perfect to fill a small space on your gallery wall or to group together as a collection.',
      variants: [_print('412 × 297 mm', 360), _original(null, 'sold', true)]
    },
    {
      id: 'amelias-kitchen', category: 'amelias', title: "Amelia's Kitchen",
      place: 'Miniature interior · 120 × 170 mm', year: 2024,
      size: '120 × 170 mm', orientation: 'landscape',
      image: 'assets/kitchen-small.jpg', imageLarge: null,
      blurb: 'A busy little kitchen full of light — herbs at the window, a cat on the bench and everything in its place. From the Amelia’s House collection.',
      variants: [_print('120 × 170 mm', 170, true), _original(null, 'sold', true)]
    },
    {
      id: 'amelias-reading-room', category: 'amelias', title: "Amelia's Reading Room",
      place: 'Miniature interior · 120 × 170 mm', year: 2024,
      size: '120 × 170 mm', orientation: 'landscape',
      image: 'assets/readingroom-small.jpg', imageLarge: null,
      blurb: 'A quiet corner to curl up in — a soft armchair, a lamp and a window onto the city. From the Amelia’s House collection.',
      variants: [_print('120 × 170 mm', 170, true), _original(null, 'sold', true)]
    },
    {
      id: 'amelias-study', category: 'amelias', title: "Amelia's Study",
      place: 'Miniature interior · 120 × 170 mm', year: 2024,
      size: '120 × 170 mm', orientation: 'landscape',
      image: 'assets/study-small.jpg', imageLarge: null,
      blurb: 'An open book, a cup of coffee and a street view — the perfect spot to think. From the Amelia’s House collection.',
      variants: [_print('120 × 170 mm', 170, true), _original(null, 'sold', true)]
    },

    /* ── Gift tags (designs; sets are priced via categories.gifttags.tiers) ── */
    { id: 'gifttag-icecream', category: 'gifttags', title: 'Ice-Cream Cone', range: 'Water-colour', image: 'assets/tag-icecream.jpg', variants: [_single('Water-colour')] },
    { id: 'gifttag-boots',    category: 'gifttags', title: 'Garden Boots',   range: 'Water-colour', image: 'assets/tag-boots.jpg',    variants: [_single('Water-colour')] },
    { id: 'gifttag-mouse',    category: 'gifttags', title: 'Party Mouse',    range: 'Water-colour', image: 'assets/tag-mouse.jpg',    variants: [_single('Water-colour')] },
    { id: 'gifttag-dots',     category: 'gifttags', title: 'Happy Dots',     range: 'Water-colour', image: 'assets/tag-dots.jpg',     variants: [_single('Water-colour')] },
    { id: 'gifttag-penguins', category: 'gifttags', title: 'Party Penguins', range: 'Colour',       image: 'assets/tag-penguins.jpg', variants: [_single('Colour')] },
    { id: 'gifttag-rocket',   category: 'gifttags', title: 'Rocket',         range: 'Colour',       image: 'assets/tag-rocket.jpg',   variants: [_single('Colour')] },
    { id: 'gifttag-octopus',  category: 'gifttags', title: 'Octopus',        range: 'Colour',       image: 'assets/tag-octopus.jpg',  variants: [_single('Colour')] },
    { id: 'gifttag-bunny',    category: 'gifttags', title: 'Meadow Bunny',   range: 'Colour',       image: 'assets/tag-bunny.jpg',    variants: [_single('Colour')] },
    { id: 'gifttag-blossom',  category: 'gifttags', title: 'Cherry Blossom', range: 'Colour',       image: 'assets/tag-blossom.jpg',  variants: [_single('Colour')] },
    { id: 'gifttag-roses',    category: 'gifttags', title: 'Rose Garden',    range: 'Monochrome',   image: 'assets/tag-roses.jpg',    variants: [_single('Monochrome')] },
    { id: 'gifttag-dahlias',  category: 'gifttags', title: 'Dahlias',        range: 'Monochrome',   image: 'assets/tag-dahlias.jpg',  variants: [_single('Monochrome')] },
    { id: 'gifttag-town',     category: 'gifttags', title: 'Townscape',      range: 'Monochrome',   image: 'assets/tag-town.jpg',     variants: [_single('Monochrome')] },
    { id: 'gifttag-window',   category: 'gifttags', title: 'Windowsill',     range: 'Monochrome',   image: 'assets/tag-window.jpg',   variants: [_single('Monochrome')] }
  ]
};

/* Stamp display order (the `sort` column) from array position. The collection
   grids feature the first item in each category, so order is significant. */
DEMO.products.forEach((p, i) => { p.sort = i; });

/* Seed localStorage for the offline build. Reseeds when `version` bumps, so
   editing this file during dev refreshes the stored copy on next load. */
(function () {
  const KEY = 'wtl_catalog';
  let cur = null;
  try { cur = JSON.parse(localStorage.getItem(KEY)); } catch (e) { cur = null; }
  if (!cur || cur.version !== DEMO.version) {
    localStorage.setItem(KEY, JSON.stringify(DEMO));
  }
})();
