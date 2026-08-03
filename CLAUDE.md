# CLAUDE.md

> **Current state:** the repo still serves its HTML/CSS/JS flat from the
> repository root (the Pages workflow uploads `path: '.'`), and the `Makefile`,
> `make/`, and `ui/` layout described below are the target it is being migrated
> onto — do not assume `make dev` works until the `Makefile` is actually
> present. Everything below is the intended structure; keep new work aligned to
> it.

## Build

The site is built with `make`. There are two builds, driven by mode flags, and
they differ only in whether the **back-end (online) calls are included**:

- **`make dev`** — the offline/staging build. It **strips the back-end calls**
  (Supabase auth/DB and PayFast checkout wiring) so the staging site runs with
  no secrets and no live payment/data traffic.
- **`make prd`** — the production build. It **keeps the back-end calls** and
  writes the production `CNAME`.
- **`make clean`** (`make c`) — removes the build output (`ui/dist`).

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

The prices and catalog content (the equivalent of today's `CATALOG` / `EDITIONS`
in `shared.js`) are **not hard-coded in the shipped JS** — they come from a
**Supabase DB table** in production. This keeps prices authoritative on the
back-end (the same reason the checkout total must be recomputed server-side).

- **`prd`** — the JS fetches catalog + pricing from the Supabase table (this
  fetch is back-end code, so it lives inside the `//online` markers and is
  present only in the production build).
- **`dev`** — with the online calls stripped, the JS instead reads the catalog
  from **browser `localStorage`**. A **`demo.js`** file is included in the dev
  build that **seeds `localStorage` with demo catalog/pricing data if it isn't
  already present**, so the offline staging site has content to render without
  ever touching Supabase.

So the source of truth flips by build: **DB table in `prd`, `localStorage`
(seeded by `demo.js`) in `dev`**. `demo.js` is a dev-only file — it must not be
copied into the `prd` build.

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
- **Production repo** — the live site at **`wherethereslight.co.za`**. Its
  `main` builds the **prod** version (with the Supabase/PayFast secrets provided
  as GitHub Actions secrets) and deploys to the live domain.

The intended promotion flow (as in `anroleroux`): a single workflow file is
committed **identically to both repos** and branches on `github.repository` so
the same file behaves correctly in each. Pushing to `main` only ever updates
**staging**. **Production is promoted** by pushing a promotion branch (e.g.
`prod`) whose job pushes `HEAD` to the production repo's `main`, which triggers
the production build-and-deploy. The cross-repo push uses a write-enabled deploy
key stored as a secret, and is a plain fast-forward so a diverged history is
rejected rather than force-pushed.

> The current workflow (`.github/workflows/deploy-pages.yml`) is the simpler
> single-repo version: it deploys every branch push straight from the repo root
> to the one staging site. Bringing it onto the two-repo pattern above is part
> of the same migration as the `make`/`ui` restructure.
