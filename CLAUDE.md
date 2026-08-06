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

`stg` and `prd` are the same online build; they differ only in the `CNAME`, and
the sandbox-vs-live choice is made server-side by origin, not by the build.

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
into nor referenced by the `prd` build.

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
