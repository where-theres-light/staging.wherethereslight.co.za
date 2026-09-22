# CLAUDE.md

> **Current state:** the repo still serves its HTML/CSS/JS flat from the
> repository root (the Pages workflow uploads `path: '.'`), and the `Makefile`,
> `make/`, and `ui/` layout described below are the target it is being migrated
> onto — do not assume `make dev` works until the `Makefile` is actually
> present. Everything below is the intended structure; keep new work aligned to
> it.

## Build

The site is built with `make`. The builds differ in whether the **back-end
(online) calls are included**:

- **`make dev`** — the offline preview. It **strips the back-end calls**
  (Supabase catalog fetch + PayFast checkout) and seeds the catalogue from
  `demo.js`, so it runs with no secrets and no live traffic. Used by every
  staging branch **except `main`**.
- **`make stg`** — the online build for the **staging site's `main`**. Keeps the
  back-end calls (no demo seed). It talks to the real Supabase project, and
  PayFast runs in **sandbox** (the edge functions pick sandbox vs live from the
  request origin — staging → sandbox). The staging `CNAME` is written by the
  workflow.
- **`make prd`** — the production build. Keeps the back-end calls, writes the
  production `CNAME`; PayFast runs **live** (prod origin).
- **`make clean`** (`make c`) — removes the build output (`ui/dist`).

`stg` and `prd` are the same online build; they differ in the `CNAME` and the
`robots.txt` (see below), and the sandbox-vs-live choice is made server-side by
origin, not by the build.

### `robots.txt`

Each build writes a `robots.txt` so only the live site is indexed. `prd` ships
`ui/robots.prd.txt` (`Allow: /`); `dev` and `stg` — both deploy to
`staging.wherethereslight.co.za` — ship `ui/robots.staging.txt` (`Disallow: /`)
to keep staging out of search results. The two source files are copied to
`dist/robots.txt` by the matching target, so the source variants never ship.

### On-page SEO

Search engines are served from the **live catalogue at run time**, not from
anything the build knows. One `product.html` renders every piece, keyed by
`?piece=<id>`, and its `describe()` sets that piece's `<title>`, meta
description, canonical, Open Graph tags and `Product`/`VisualArtwork` +
`BreadcrumbList` JSON-LD from the catalogue once it has loaded; the JSON-LD
`offers` are patched in after the options are priced. Google indexes distinct
query strings as distinct pages, so each piece can rank on its own.

Nothing about a piece is snapshotted into the build. A town added to the
catalogue describes itself on the next page view, with no redeploy and no
second copy of the catalogue to keep in step. The cost is that this metadata
exists only in the rendered DOM — a crawler that does not run JavaScript sees
the generic head this page ships with.

The rest is static per page: every source page carries its own `<title>`, meta
description, canonical, `author`, `theme-color`, Open Graph/Twitter tags,
favicon and `lang="en-ZA"`. `success`/`cancel` are `noindex`. The home page
carries `Organization`/`WebSite` JSON-LD and the collection pages carry
`BreadcrumbList`.

**No page copy lives here.** The collection pages' eyebrow, `<h1>` and intro
ship with the same words `shared.js` would write in, so the subject is in the
HTML before any script runs — but site copy belongs to the Google Doc that
`.claude/skills/copy-sync` syncs from. If a page needs new words, they go
through that.

`prd` also generates a `sitemap.xml` (and its `robots.txt` links to it): the
`prd` target emits `dist/sitemap.xml` from the `SITEMAP_PAGES` list — the
indexable content pages, stamping each `lastmod` from the page's last git commit
date. The dynamic `product.html` template and the transactional
`success`/`cancel` pages are deliberately excluded. Staging builds ship no
sitemap (they disallow indexing).

### How online calls are stripped

Back-end code in the JS source is fenced with comment markers, and `make dev`
deletes it with `sed` before composing the output:

- A **block** of back-end code is wrapped:

  ```js
  //online-start
  … Supabase / PayFast wiring …
  //online-end
  ```

- A **single line** of back-end code is tagged with a trailing `//online`.

`make dev` removes both (the `//online-start … //online-end` range and any
`//online` lines); `make prd` leaves them in place. Keep every line that talks
to Supabase or PayFast inside one of these markers so the offline build stays
clean.

### `make/` — the templating helper

- **`make/tpl.mk`** defines a `compose` function (an `awk` script) that reads a
  **map file** and, for each placeholder token it finds in the source, splices
  in the contents of the mapped file (preserving indentation). The `Makefile`
  `include`s this.
- **`make/web.map`** is the placeholder map: lines of `{{token}}:path/to/file`.
  For example a `{{…-css}}` placeholder in the source HTML is replaced by the
  matching CSS file at build time.

The build composes the source entry files (HTML/CSS/JS) through `compose` into
`ui/dist/`, copies the standalone pages and article files across, and — for
`prd` — writes the `CNAME`.

## Catalog & pricing data

The prices and catalog content are **not hard-coded in the shipped JS** — they
come from a **Supabase DB table** in production. This keeps prices authoritative
on the back-end (the same reason the checkout total must be recomputed
server-side).

`shared.js` always reads the catalog from `localStorage` under the key
**`wtl_catalog`** and adapts it to the render model, so the render path is
identical for both builds. What differs is who fills that key:

- **`prd`** — `shared.js` fetches the catalog straight from the **Supabase REST
  API** (PostgREST; the catalogue tables are public-read, no edge function),
  reshapes it into the render model, caches it into `wtl_catalog`, and
  re-renders. That fetch is back-end code, so it lives inside the `//online`
  markers and is present only in the production build.
- **`dev`** — with the online calls stripped, nothing fetches. A **`demo.js`**
  file seeds `wtl_catalog` with demo data (reseeding when its `version` bumps).
  The `dev` build **injects `<script src="demo.js">` before `shared.js`** into
  every page, so demo data is present before `shared.js` reads it. The source
  pages carry no `demo.js` tag — it exists only in the composed `dev` output.

So the source of truth flips by build: **DB table in `prd`, `localStorage`
(seeded by `demo.js`) in `dev`**. `demo.js` is dev-only — it is neither copied
into nor referenced by the `prd` build, and nothing in the build reads it. It is
a preview seed, not a second source of truth, so it is free to lag the table.

### Product data model

`demo.js` (and the future Supabase table) store `categories`, `editions`, and
`products`. A **product** is one catalogue item; each carries a **`variants`**
array — the purchasable options that hold price and stock (`print` / `original`
/ `single` / …). This one shape covers townscapes, miniatures and gift tags, and
maps onto `products` + `product_variants` tables. See the header of `demo.js` for
the full field reference.

## Source layout (`ui/`)

Everything under `ui/` is **source**; the build output goes to `ui/dist/`.

- **`ui/`** — the page content: entry HTML, the CSS (`root.css` +
  theme/variant CSS), the JS (`root.js` and any components), and standalone
  pages.
- **`ui/assets/`** — static assets (images, SVGs, fonts). Reference assets from
  here; do **not** scatter them next to the HTML.
- **`ui/dist/`** — the composed, deployable site produced by `make`. This is
  **generated and git-ignored** (`dist` is in `.gitignore`) — never edit files
  here by hand and never commit it. It is what the Pages workflow deploys.

## `scripts/` — operational tooling

Standalone **Go** programs that are not part of the site build and never ship in
`dist`. Each is its own module, so the site's build stays dependency-free and
`go test ./...` inside one covers it.

- **`scripts/import-statement/`** — parses a Capitec bank-statement PDF and
  imports its transactions into the `transactions` table, through the
  `import-transactions` edge function (the table is service-role only, so the
  program never holds a Supabase key). With `--invoices <dir>` it also claims the
  supplier invoices that go with the statement, in two steps: `--prepare` writes a
  worksheet of every invoice's text for a Claude Code session (or a person) to
  read, and `--readings` takes the filled-in records back, ties each to a payment
  of its total (allowing a little rounding — R195.99 is settled with R196.00), and
  posts the matches as `transaction_classifications` rows in the same request,
  each with the bank's charge for making that payment, which the parser split off
  the same statement line. Reading an invoice is a judgement — the layout changes
  from company to company — so the program does not make it; matching is all it
  decides. `--personal <rules>` marks the other side of the books, by pattern
  rather than by document, so what is left is what has not been looked at. No
  API, no key. See *Bank transactions* in `supabase/README.md`.

Go rather than Deno because the statement table is read by **column position**
rather than by splitting text, which needs the x coordinate of every fragment —
and because a compiled binary needs no runtime installed on whatever machine
does the import.

Statements and invoices live in `data/statements/` and `data/invoices/` — all of
`data/` is git-ignored, so bank statements, invoices and the PDF password never
go in the repo.

## GitHub Pages — staging and production repos

Deployment mirrors the `anroleroux` two-repo pattern. There is a **staging
repo** and a separate **production repo**, and one Pages workflow governs both:

- **Staging repo** — `where-theres-light/staging.wherethereslight.co.za`
  (this repo). Pushes build the **dev** version and deploy it to
  **`staging.wherethereslight.co.za`**. No secrets are needed because `make dev`
  is the offline build.
- **Production repo** — `where-theres-light/wherethereslight.co.za`, the live
  site at **`wherethereslight.co.za`**. Its `main` builds the **prod** version
  and deploys to the live domain. No secrets are needed for the build (the
  Supabase URL + publishable key are public, hard-coded in `shared.js`).

The promotion flow (as in `anroleroux`): a single workflow file
(`.github/workflows/deploy-pages.yml`) is committed **identically to both
repos** and branches on `github.repository` so the same file behaves correctly
in each. Pushing to `main` only ever updates **staging** (any staging branch
except `prod` deploys the dev preview). **Production is promoted** by merging
`main` into the **`prod`** branch and pushing it: the staging repo's
`promote-prod` job pushes `HEAD` to the production repo's `main`, which triggers
its `deploy-prod` job. The cross-repo push uses a write-enabled deploy key
(private half in the staging repo's **`PROD_DEPLOY_KEY`** secret, public half
registered on the production repo), and is a plain fast-forward so a diverged
history is rejected rather than force-pushed.
