/* ============================================================================
 * demo.js — offline (dev) seed data
 *
 * In production the catalog comes from a Supabase table; in the offline `dev`
 * build the online calls are stripped, so this file seeds the same data into
 * localStorage (key `wtl_catalog`) once, giving the site content with no
 * back-end. It is copied into the build by `make dev` only — never by `make prd`.
 *
 * ── Data model ──────────────────────────────────────────────────────────────
 * The shape below maps onto the Supabase schema:
 *
 *   categories        → table `categories`        (PK: slug)
 *   categories.*.tiers → table `category_tiers`   (FK: category_slug)
 *   products          → table `products`          (PK: id/slug, FK: category)
 *
 * A **product** is one catalogue item (an artwork or a gift-tag design). Its
 * purchasable options are flat columns, addressed in the cart by a key:
 *
 *   • townscape   → 'print' (price) + 'orig' (originalPrice / originalStatus)
 *   • miniature   → 'print' (price) + 'orig' (original often sold)
 *   • gift tag    → 'single' (price)            (sets are category tiers)
 *
 *   product fields
 *     id             slug, unique                     (PK)
 *     category       'townscapes' | 'amelias' | 'gifttags'
 *     title          display name
 *     place          location line          (artworks; null for gift tags)
 *     year           integer                (artworks; null for gift tags)
 *     size           physical size string   (artworks; null for gift tags)
 *     orientation    'landscape' | 'portrait' (artworks; null for gift tags)
 *     range          gift-tag colour range  (gift tags; null for artworks)
 *     blurb          description            (nullable)
 *     image          thumbnail asset path
 *     imageLarge     hero asset path        (nullable — falls back to image)
 *     sort           display order          (assigned below; see foot of file)
 *     price          print price (artworks) / single price (gift tags), ZAR;
 *                    null = not sold online
 *     originalPrice  ZAR, or null for POA     (artworks only)
 *     originalStatus 'available' | 'sold'    (artworks; null = no original)
 * ========================================================================== */

const DEMO = {
  version: 2,

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

  products: [
    /* ── Townscapes ───────────────────────────────────────────────────────── */
    {
      id: 'boston', category: 'townscapes', title: 'Boston',
      place: 'Bellville, Cape Town', year: 2019,
      size: '412 × 297 mm', orientation: 'landscape',
      image: 'assets/boston-small.jpg', imageLarge: 'assets/boston-small.jpg',
      blurb: 'The old Boston shopfronts gather beneath a dotted dome of Karoo light, hemmed in by a riot of fynbos and garden green.',
      price: 360, originalPrice: 1300, originalStatus: 'available'
    },
    {
      id: 'swellendam', category: 'townscapes', title: 'Swellendam',
      place: 'Overberg, Western Cape', year: 2018,
      size: '412 × 297 mm', orientation: 'landscape',
      image: 'assets/swellendam-small.jpg', imageLarge: null,
      blurb: 'The Drostdy and its oaks, drawn in patient ink — one of the oldest towns in the country, kept in a single quiet frame.',
      price: 360, originalPrice: 1300, originalStatus: 'available'
    },
    {
      id: 'somersetwest', category: 'townscapes', title: 'Somerset West',
      place: 'Helderberg, Western Cape', year: 2018,
      size: '412 × 297 mm', orientation: 'landscape',
      image: 'assets/somersetwest-small.jpg', imageLarge: null,
      blurb: 'Steeples, verandahs and a fountained square nestle below the Helderberg, wrapped in a hedge of hand-inked blooms.',
      price: 360, originalPrice: 1300, originalStatus: 'available'
    },
    {
      id: 'windhoek', category: 'townscapes', title: 'Windhoek',
      place: 'Khomas, Namibia', year: 2020,
      size: '412 × 297 mm', orientation: 'landscape',
      image: 'assets/windhoek-small.jpg', imageLarge: null,
      blurb: 'The Christuskirche and the old colonial roofline rise from a desert garden, the mountains pencilled soft behind.',
      price: 360, originalPrice: 1300, originalStatus: 'available'
    },
    {
      id: 'caledon', category: 'townscapes', title: 'Caledon',
      place: 'Overberg, Western Cape', year: 2017,
      size: '412 × 297 mm', orientation: 'landscape',
      image: 'assets/caledon-small.jpg', imageLarge: null,
      blurb: 'The Dutch Reformed church and its gables, cradled in the wild garden that gave the town its hot-spring fame.',
      price: 360, originalPrice: 1300, originalStatus: 'sold'
    },
    {
      id: 'london', category: 'townscapes', title: 'London',
      place: 'England, United Kingdom', year: 2023,
      size: '412 × 297 mm', orientation: 'landscape',
      image: 'assets/london-small.jpg', imageLarge: null,
      blurb: 'Big Ben, the Eye and a skyline of landmarks gathered into a single dome of light, wreathed in an English cottage garden.',
      price: 360, originalPrice: 1300, originalStatus: 'available'
    },
    {
      id: 'polperro', category: 'townscapes', title: 'Polperro',
      place: 'Cornwall, United Kingdom', year: 2023,
      size: '412 × 297 mm', orientation: 'landscape',
      image: 'assets/polperro-small.jpg', imageLarge: null,
      blurb: 'The tumbling harbour cottages of a Cornish fishing village, climbing the hillside above the quay.',
      price: 360, originalPrice: 1300, originalStatus: 'available'
    },
    {
      id: 'shanghai', category: 'townscapes', title: 'Shanghai',
      place: 'China', year: 2023,
      size: '412 × 297 mm', orientation: 'landscape',
      image: 'assets/shanghai-small.jpg', imageLarge: null,
      blurb: 'Layered rooftops and the distant tower, drawn inside a circular window of ink and colour — old lanes meeting the modern skyline.',
      price: 360, originalPrice: 1300, originalStatus: 'available'
    },
    {
      id: 'stanford', category: 'townscapes', title: 'Stanford',
      place: 'Overberg, Western Cape', year: 2022,
      size: '412 × 297 mm', orientation: 'landscape',
      image: 'assets/stanford-small.jpg', imageLarge: null,
      blurb: 'The white church spire and village cottages below the Klein River mountains, held in a wild garden of fynbos.',
      price: 360, originalPrice: 1300, originalStatus: 'available'
    },
    {
      id: 'stellenbosch', category: 'townscapes', title: 'Stellenbosch',
      place: 'Cape Winelands, Western Cape', year: 2022,
      size: '412 × 297 mm', orientation: 'landscape',
      image: 'assets/stellenbosch-small.jpg', imageLarge: null,
      blurb: 'The oak-lined town of gables and the old church tower, cradled below the mountains in a hedge of hand-inked blooms.',
      price: 360, originalPrice: 1300, originalStatus: 'available'
    },

    /* ── Amelia's House · miniature interiors ─────────────────────────────── */
    {
      id: 'amelias-house', category: 'amelias', title: 'Home',
      place: 'Miniature interior · 412 × 297 mm', year: 2021,
      size: '412 × 297 mm', orientation: 'landscape',
      image: 'assets/home-small.jpg', imageLarge: null,
      blurb: 'A gabled cottage nestled in its garden — one of the small, lit houses in the Amelia’s House collection. Perfect to fill a small space on your gallery wall or to group together as a collection.',
      price: 360, originalPrice: null, originalStatus: 'sold'
    },
    {
      id: 'amelias-kitchen', category: 'amelias', title: "Amelia's Kitchen",
      place: 'Miniature interior · 120 × 170 mm', year: 2024,
      size: '120 × 170 mm', orientation: 'landscape',
      image: 'assets/kitchen-small.jpg', imageLarge: null,
      blurb: 'A busy little kitchen full of light — herbs at the window, a cat on the bench and everything in its place. From the Amelia’s House collection.',
      price: 170, originalPrice: null, originalStatus: 'sold'
    },
    {
      id: 'amelias-reading-room', category: 'amelias', title: "Amelia's Reading Room",
      place: 'Miniature interior · 120 × 170 mm', year: 2024,
      size: '120 × 170 mm', orientation: 'landscape',
      image: 'assets/readingroom-small.jpg', imageLarge: null,
      blurb: 'A quiet corner to curl up in — a soft armchair, a lamp and a window onto the city. From the Amelia’s House collection.',
      price: 170, originalPrice: null, originalStatus: 'sold'
    },
    {
      id: 'amelias-study', category: 'amelias', title: "Amelia's Study",
      place: 'Miniature interior · 120 × 170 mm', year: 2024,
      size: '120 × 170 mm', orientation: 'landscape',
      image: 'assets/study-small.jpg', imageLarge: null,
      blurb: 'An open book, a cup of coffee and a street view — the perfect spot to think. From the Amelia’s House collection.',
      price: 170, originalPrice: null, originalStatus: 'sold'
    },

    /* ── Gift tags (designs; sets are priced via categories.gifttags.tiers) ── */
    { id: 'gifttag-icecream', category: 'gifttags', title: 'Ice-Cream Cone', range: 'Water-colour', image: 'assets/tag-icecream.jpg', price: 15 },
    { id: 'gifttag-boots',    category: 'gifttags', title: 'Garden Boots',   range: 'Water-colour', image: 'assets/tag-boots.jpg',    price: 15 },
    { id: 'gifttag-mouse',    category: 'gifttags', title: 'Party Mouse',    range: 'Water-colour', image: 'assets/tag-mouse.jpg',    price: 15 },
    { id: 'gifttag-dots',     category: 'gifttags', title: 'Happy Dots',     range: 'Water-colour', image: 'assets/tag-dots.jpg',     price: 15 },
    { id: 'gifttag-penguins', category: 'gifttags', title: 'Party Penguins', range: 'Colour',       image: 'assets/tag-penguins.jpg', price: 15 },
    { id: 'gifttag-rocket',   category: 'gifttags', title: 'Rocket',         range: 'Colour',       image: 'assets/tag-rocket.jpg',   price: 15 },
    { id: 'gifttag-octopus',  category: 'gifttags', title: 'Octopus',        range: 'Colour',       image: 'assets/tag-octopus.jpg',  price: 15 },
    { id: 'gifttag-bunny',    category: 'gifttags', title: 'Meadow Bunny',   range: 'Colour',       image: 'assets/tag-bunny.jpg',    price: 15 },
    { id: 'gifttag-blossom',  category: 'gifttags', title: 'Cherry Blossom', range: 'Colour',       image: 'assets/tag-blossom.jpg',  price: 15 },
    { id: 'gifttag-roses',    category: 'gifttags', title: 'Rose Garden',    range: 'Monochrome',   image: 'assets/tag-roses.jpg',    price: 15 },
    { id: 'gifttag-dahlias',  category: 'gifttags', title: 'Dahlias',        range: 'Monochrome',   image: 'assets/tag-dahlias.jpg',  price: 15 },
    { id: 'gifttag-town',     category: 'gifttags', title: 'Townscape',      range: 'Monochrome',   image: 'assets/tag-town.jpg',     price: 15 },
    { id: 'gifttag-window',   category: 'gifttags', title: 'Windowsill',     range: 'Monochrome',   image: 'assets/tag-window.jpg',   price: 15 }
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
