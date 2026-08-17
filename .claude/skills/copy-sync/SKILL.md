---
name: copy-sync
description: Check, compare, or update the Where There's Light site copy against its Google Docs source of truth. Use when the user asks to check/compare/verify/sync/update copy, text, wording, prices, or content on the site (home, townscapes, Amelia's House, gift tags, or the footer) — the Google Doc is authoritative; the HTML in ui/ (and the catalog in ui/demo.js) is the target.
---

# Copy sync — Google Doc → website

Laurita writes and maintains the site copy in **one Google Doc** (the source of
truth). This skill maps that doc to the repo's HTML and catalog and helps
**check / compare / update** the copy.

Direction is **Doc → site**. Edit the site to match the doc, never the reverse,
unless the user explicitly asks to update the doc.

## 1. Find and read the doc

The copy lives in a **single** Google Doc — all pages in one file, split by
markdown `#` headings:

- **Title:** `Where Theres Light`
- **Owner:** `laurita@wherethereslight.co.za`
- **File id:** `1DydOoknEx9XidtnfGkm5zhtpu21Ax6GiUerEuasPnZI`

Read it with the Google Drive tools: `read_file_content` with that `fileId`.
The doc is shared with the connected Drive account — it is **not** in a Drive
folder we own. If the id ever changes, relocate it with `search_files`:
`title = 'Where Theres Light' and owner = 'laurita@wherethereslight.co.za'`.
If the search returns nothing, the doc has not been shared with the connected
account — tell the user to share it (or reconnect Drive as laurita) rather than
guessing at another file.

## 2. Doc section → target mapping

Each top-level markdown heading in the doc is one page. The doc also carries a
`Page:` field (e.g. `Page: /`) naming the live path.

| Doc heading | Target |
|---|---|
| `# Home Page` (`Page: /`) | `ui/index.html` |
| `# FOOTER` | the `<footer class="site-foot">` block — **shared on every page** |
| `# Townscapes` | `ui/townscapes.html` **+ catalog** (see below) |
| `# Amelia's House` | `ui/amelias-house.html` **+ catalog** |
| `# Gift Tags` | `ui/gift-tags.html` **+ catalog** |

Edit the source files in **`ui/`** — never `ui/dist/` (that folder is generated
by `make` and git-ignored).

### The collection pages are catalog-driven — this is the big one

`townscapes.html`, `amelias-house.html`, and `gift-tags.html` share a
`coll-hero` whose `#collEyebrow` and `#collTitle` are **empty in the HTML**;
`shared.js` fills them at runtime from the catalog. The **works** on those pages
(each `WORK` block — the artwork title, place, blurb, quote, price) are catalog
rows too, not static HTML. So for these pages the copy target is usually the
**catalog data**, not the page markup:

- **`dev` build (this staging repo):** the catalog is seeded from **`ui/demo.js`**
  into `localStorage`. Edit the matching object there.
- **`prd` build:** the catalog comes from the **Supabase** `categories` and
  `products` tables. Static-HTML edits do **not** change catalog copy in prod —
  the DB is authoritative there.

Field → catalog mapping for a collection page:

| Doc field / block | Catalog field |
|---|---|
| `Eyebrow:` | `categories[].eyebrow` |
| `Header:` (the page title) | `categories[].title` |
| the intro paragraph under the header | `categories[].intro` |
| a `WORK` block's name line | `products[].title` |
| its place line (e.g. `Bellville, Cape Town`) | `products[].place` |
| its year | `products[].year` |
| its description / artist quote | `products[].blurb` |
| price lines (`From R1500`, `R 360`, …) | `product_variants[].price` |

**Only the gift-tags page has static card copy in HTML:** the three range cards
(`Water-colour range`, `Signature monochrome`, `Stationery staples`) and the
"The designs" heading are hard-coded in `ui/gift-tags.html`. Those `CARD` blocks
in the doc map to that markup. The purchasable tiers (`Singles`, `Mono set of 5`,
`Mixed set of 10`) and the individual tag designs are catalog data.

The **home page** (`ui/index.html`) is static HTML end to end — its hero,
welcome, about, and "three ways to own a piece" copy all live in the markup.

## 3. What is copy vs. what is a marker

**Prose paragraphs → verbatim.** A plain block with no `Label:` prefix, not a
`SECTION`/`WORK`/`CARD`/`IMAGE`/`LOGO` marker, not wrapped in `%…%`, and not an
author note is body copy. It must appear **word-for-word** in the target. Report
any drift (e.g. the doc's originals price `From R1500` vs the HTML's
`from R 8 600`, or a reworded footer blurb).

Everything below is **structure / instruction** — map its value to the right
slot; don't treat the marker itself as literal text:

- **`Page: <path>`** — the live URL of the section that follows. Routing hint,
  not copy.
- **`SECTION`** — starts a new `<section>`. The `class:` / `Class:` line right
  after it (e.g. `class:hero`, `Class:ways`) names that section's CSS class —
  match it to the `<section class="…">` in the HTML. Label case varies in the
  doc; treat it case-insensitively.
- **Field lines `Label: value`** — structured copy for one slot. Seen so far:
  `Eyebrow:` → `<span class="eyebrow">`; `Heading:` → the section `<h2>`;
  `Header:` → a collection page's `<h1>`/`#collTitle`; `Lede:` → the hero lede
  `<p>`; `Scroll-que:` → the scroll-cue line; `Count:` → the `.sec-head .count`
  line. The **label** is structural; only the **value** is content.
- **`IMAGE` + `file:<name>`** — an image; `<name>` is an asset in `ui/assets/`
  (e.g. `file:laurita-photo.jpg` → `<img src="assets/laurita-photo.jpg">`).
  No prose to match; confirm the asset exists.
- **`LOGO`** — the logo component (`<img class="logo|foot-logo" src="assets/logo.svg">`).
- **`WORK`** — one artwork/portfolio item → a catalog product (see §2).
- **`CARD`** — one gift-tag range card (see §2, gift-tags).
- **`%emphasise X%` / `%emphasised%`** — wrap X in `<em>` in that slot
  (British spelling — it's `emphasise`, not `emphasize`). E.g.
  `Where there's light. %emphasise light.%` → `Where there's <em>light.</em>`.
  A bare `%emphasised%` after a line marks that line's emphasis without
  repeating the word.
- **`!!!remove`** (often escaped in the export as `\!\!\!remove`) — an author
  instruction that this line/element is **not live**: do **not** render it, and
  if it's currently in the HTML, that's a discrepancy to flag. (The hero `Lede:`
  and `Scroll-que:` are both marked `!!!remove`, and the shipped hero correctly
  omits them.) `!!!remove year` next to a work means drop just the year.
- **`<ref "label" target>`** — a link → `<a href="target">label</a>`. Target
  forms seen: a bare path (`/townscapes.html`), `link:gift-tags.html`,
  `mailto:…`, and a full `https://…` URL. The quotes may be curly (`“ ”`).
- **`% author note %`** — a single-`%` aside to self (e.g.
  `% the footer is the same on all the pages %`, `% column 1 %`). **Ignore** it;
  it's not copy and not an emphasis marker.
- **`**bold**`** — markdown bold, used for sub-headings inside a column or
  section (`**Shop**`, `**Water-colour range**`). Maps to the corresponding
  `<h3>`/`<h4>`/`<strong>` in the target, not literal asterisks.
- **Markdown `#` heading** — a page boundary inside the doc (see §2).

## 4. Workflow

- **Check / compare:** read the doc and the mapped target(s). Walk the doc top to
  bottom; for each paragraph confirm a verbatim match, for each field confirm the
  value sits in the right slot. Produce a discrepancy list: missing copy, drifted
  wording, wrong price, extra site text not in the doc, or an element the doc
  marks `!!!remove` that's still live. For a collection page, check the **catalog**
  (`ui/demo.js`) as well as the HTML — much of its copy lives there.
- **Update:** apply the doc's copy to the target. Preserve the surrounding markup
  and the doc conventions above — only the copy changes. Match prose verbatim;
  place field values in their slots; put collection copy/prices in `ui/demo.js`
  (and note to the user that prod needs the same change in Supabase). After
  editing, you can verify the composed output with `make dev`.

## 5. Ask when unsure

Laurita prefers being asked over guessed at. Ask when:

- A doc section has no clear target (heading doesn't match a page and there's no
  `Page:`), or a `WORK`/`CARD` block can't be matched to a catalog row.
- A marker or block you haven't seen before appears, or its intent is ambiguous.
- The doc reorders/removes a section, or copy exists on the site but not the doc
  (delete it, or keep it?).
- A price or field in the doc would need a **Supabase** change to take effect in
  production, so the user knows the `demo.js` edit only covers staging.
- A field value seems to belong to a slot that doesn't exist on the page.
