#!/usr/bin/env node
/* ============================================================================
 * make/seo-pages.js — per-piece landing pages (`<id>-art.html`)
 *
 * The catalogue UI is rendered client-side from one `product.html` keyed by a
 * query string, which gives every piece the same URL, title and description —
 * nothing for a search engine to rank against "<town> art". This generator
 * gives each piece its own indexable page instead: it stamps `dist/product.html`
 * (so the chrome can never drift from the real product page) with that piece's
 * title, description, canonical, Open Graph tags, structured data and static
 * copy, and writes `dist/<id>-art.html`.
 *
 * Usage: node make/seo-pages.js <demo.js> <dist-dir> <base-url>
 *
 * The piece metadata (titles, places, blurbs, images) is read from `ui/demo.js`
 * at BUILD time — it is the in-repo mirror of the catalogue tables. Nothing is
 * copied into the output: prices stay authoritative in the back-end and are
 * filled into the page (and into its JSON-LD offers) at RUN time from the live
 * catalogue, so this generator never bakes a price into the shipped HTML.
 * ==========================================================================*/

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const [, , demoPath, dist, base] = process.argv;
if (!demoPath || !dist || !base) {
  console.error('usage: seo-pages.js <demo.js> <dist-dir> <base-url>');
  process.exit(2);
}

/* ---- load the catalogue mirror ------------------------------------------ */
/* demo.js is a browser script: it declares `const DEMO` and seeds localStorage.
   Run it in a sandbox with a localStorage stub and hand DEMO back out. */
function loadDemo(file) {
  const src = fs.readFileSync(file, 'utf8') + '\n;globalThis.__DEMO = DEMO;';
  const store = new Map();
  const sandbox = {
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k)
    },
    console
  };
  vm.createContext(sandbox);
  new vm.Script(src, { filename: file }).runInContext(sandbox);
  return sandbox.__DEMO;
}

/* ---- helpers ------------------------------------------------------------ */
const esc = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/* Meta descriptions are built a sentence at a time and stop at the last one
   that still fits the length a search engine actually shows — a whole sentence
   reads better in a result than a mid-word truncation. */
function clamp(parts, n = 158) {
  let out = '';
  for (const part of parts) {
    const next = out ? out + ' ' + part : part;
    if (next.length > n) break;
    out = next;
  }
  if (out) return out;
  const cut = parts[0].slice(0, n - 1);
  return cut.slice(0, cut.lastIndexOf(' ')) + '…';
}

function replaceOnce(html, needle, value, what) {
  if (!html.includes(needle)) {
    throw new Error(`seo-pages: product.html no longer contains ${what}`);
  }
  return html.replace(needle, value);
}

/* ---- per-piece copy ----------------------------------------------------- */
const CATS = {
  townscapes: {
    page: 'townscapes.html',
    label: 'Townscapes',
    eyebrow: 'Hand-drawn townscape',
    title: p => `${p.title} Art — Hand-drawn Townscape Print & Original | Where There's Light`,
    heading: p => `${p.title} townscape art`,
    desc: p => [
      `${p.title} townscape art — an original pen-and-ink drawing of ${p.title}, ${p.place}, by Laurita le Roux.`,
      'Fine-art prints ship in South Africa.'
    ],
    body: p => [
      `An original pen-and-ink drawing of <strong>${esc(p.title)}</strong> — ${esc(p.place)} — by South African artist Laurita le Roux.` +
        (p.year ? ` Drawn in ${p.year}` : '') +
        (p.size ? `${p.year ? ' at ' : ' Drawn at '}${esc(p.size)}` : '') +
        ` on 200gsm Fabriano cold-pressed paper, sold unframed and signed by hand.`,
      `${esc(p.title)} is available as the one-of-a-kind original artwork and as an archival fine-art print, shipped within South Africa. Browse the rest of the <a href="townscapes.html">townscape collection</a>, or <a href="index.html#commission">commission your own town</a>.`
    ]
  },
  amelias: {
    page: 'amelias-house.html',
    label: "Amelia's House",
    eyebrow: "Amelia's House · miniature interior",
    title: p => `${p.title} — Miniature Interior Illustration | Where There's Light`,
    heading: p => `${p.title} — a miniature interior`,
    desc: p => [
      `${p.title} — a miniature interior illustration from Amelia's House by Laurita le Roux.`,
      'Hand-drawn in pen and ink; original and fine-art prints.'
    ],
    body: p => [
      `<strong>${esc(p.title)}</strong> is a miniature interior illustration from Amelia's House, drawn in pen and ink by Laurita le Roux` +
        (p.year ? ` in ${p.year}` : '') + (p.size ? ` at ${esc(p.size)}` : '') + `.`,
      `It is sold unframed as an original illustration and as a fine-art print — small enough to group into a collection or to fill an awkward corner. See the rest of <a href="amelias-house.html">Amelia's House</a>.`
    ]
  }
};

/* ---- build -------------------------------------------------------------- */
const DEMO = loadDemo(demoPath);
const template = fs.readFileSync(path.join(dist, 'product.html'), 'utf8');

const pieces = (DEMO.products || [])
  .filter(p => CATS[p.category])
  .slice()
  .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));

if (!pieces.length) throw new Error('seo-pages: no catalogue pieces found in ' + demoPath);

for (const p of pieces) {
  const c = CATS[p.category];
  const slug = `${p.id}-art.html`;
  const url = `${base}/${slug}`;
  const img = `${base}/${p.imageLarge || p.image}`;
  const title = c.title(p);
  const desc = clamp(c.desc(p));
  const alt = p.category === 'amelias'
    ? `${p.title} — miniature interior illustration by Laurita le Roux`
    : `${p.title} townscape — hand-drawn town art by Laurita le Roux`;

  /* Identity only. `offers` is added at run time from the live catalogue. */
  const ld = {
    '@context': 'https://schema.org',
    '@type': ['Product', 'VisualArtwork'],
    name: p.title,
    url,
    image: img,
    description: p.blurb || desc,
    artform: 'Pen and ink drawing',
    artMedium: 'Archival pen on Fabriano cold-pressed paper',
    artworkSurface: 'Paper',
    inLanguage: 'en-ZA',
    creator: { '@type': 'Person', '@id': `${base}/#laurita`, name: 'Laurita le Roux' },
    brand: { '@type': 'Brand', name: "Where There's Light" },
    isPartOf: { '@type': 'CollectionPage', name: c.label, url: `${base}/${c.page}` }
  };
  if (p.category === 'townscapes' && p.place) ld.locationCreated = { '@type': 'Place', name: p.place };
  if (p.year) ld.dateCreated = String(p.year);
  if (p.size) ld.size = p.size;

  const crumbLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${base}/` },
      { '@type': 'ListItem', position: 2, name: c.label, item: `${base}/${c.page}` },
      { '@type': 'ListItem', position: 3, name: p.title, item: url }
    ]
  };

  const head = [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(desc)}">`,
    `<link rel="canonical" href="${url}">`,
    `<meta name="author" content="Laurita le Roux">`,
    `<meta name="theme-color" content="#2D3644">`,
    `<meta property="og:type" content="product">`,
    `<meta property="og:site_name" content="Where There's Light">`,
    `<meta property="og:locale" content="en_ZA">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(desc)}">`,
    `<meta property="og:url" content="${url}">`,
    `<meta property="og:image" content="${img}">`,
    `<meta property="og:image:alt" content="${esc(alt)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<link rel="icon" href="assets/logo.svg" type="image/svg+xml">`,
    `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>`,
    `<script type="application/ld+json" id="pieceLd">${JSON.stringify(ld)}</script>`,
    `<script type="application/ld+json">${JSON.stringify(crumbLd)}</script>`
  ].join('\n');

  const copy = [
    `<section class="seo-notes">`,
    `    <h2>${esc(c.heading(p))}</h2>`,
    ...c.body(p).map(t => `    <p>${t}</p>`),
    `  </section>`
  ].join('\n  ');

  let html = template;
  html = html.replace(/<!--seo-->[\s\S]*?<!--\/seo-->/, head);
  html = replaceOnce(html, '<h1 id="pTitle">—</h1>', `<h1 id="pTitle">${esc(p.title)}</h1>`, 'the piece title');
  html = replaceOnce(html, '<div class="place" id="pPlace">—</div>', `<div class="place" id="pPlace">${esc(p.place || '')}</div>`, 'the piece place');
  html = replaceOnce(html, '<p class="blurb" id="pBlurb">—</p>', `<p class="blurb" id="pBlurb">${esc(p.blurb || '')}</p>`, 'the piece blurb');
  html = replaceOnce(html, '<span class="eyebrow" id="pEyebrow">Hand-drawn townscape</span>', `<span class="eyebrow" id="pEyebrow">${esc(c.eyebrow)}</span>`, 'the piece eyebrow');
  html = replaceOnce(html, '<span class="here" id="crumbHere">—</span>', `<span class="here" id="crumbHere">${esc(p.title)}</span>`, 'the breadcrumb');
  html = replaceOnce(html, '<a id="crumbCollection"></a>', `<a id="crumbCollection" href="${c.page}">${esc(c.label)}</a>`, 'the collection breadcrumb');
  html = replaceOnce(html, '<img id="pImg" src="" alt="">', `<img id="pImg" src="${esc(p.imageLarge || p.image)}" alt="${esc(alt)}">`, 'the piece image');
  html = replaceOnce(html, '<!--seo-copy-->', copy, 'the copy marker');
  html = replaceOnce(html, '<script src="shared.js"></script>',
    `<script>window.__PIECE_ID=${JSON.stringify(p.id)};</script>\n<script src="shared.js"></script>`, 'the shared.js tag');

  fs.writeFileSync(path.join(dist, slug), html);
}

/* ---- the plain-text index on each collection page ------------------------ */
for (const [cat, c] of Object.entries(CATS)) {
  const file = path.join(dist, c.page);
  if (!fs.existsSync(file)) continue;
  let html = fs.readFileSync(file, 'utf8');
  if (!html.includes('<!--piece-index-->')) continue;
  const items = pieces.filter(p => p.category === cat).map(p =>
    `        <li><a href="${p.id}-art.html">${esc(p.title)}${cat === 'townscapes' ? ' art' : ''}</a>` +
    (p.place ? `<span class="where">${esc(p.place)}</span>` : '') + `</li>`);
  const heading = cat === 'townscapes' ? 'Every town in the collection' : 'Every room in the collection';
  html = html.replace('<!--piece-index-->', [
    `<nav class="piece-index" aria-label="${esc(heading)}">`,
    `      <h2>${heading}</h2>`,
    `      <ul>`,
    ...items,
    `      </ul>`,
    `    </nav>`
  ].join('\n'));
  fs.writeFileSync(file, html);
}

console.log(`seo-pages: wrote ${pieces.length} per-piece pages → ${dist}`);
