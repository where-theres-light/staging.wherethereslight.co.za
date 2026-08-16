---
name: copy-sync
description: Check, compare, or update the website's copy against its Google Docs source of truth. Use when the user asks to check/compare/verify/sync/update copy, text, wording, or content on the site (home page or an article) — the Google Doc is authoritative; the HTML in ui/ is the target.
---

# Copy sync — Google Docs → website HTML

The user writes and maintains site copy in **Google Docs** (the source of
truth). Each page has one doc in the Drive **"Website"** folder. This skill
maps a doc to its HTML file and helps **check / compare / update** the copy.

Direction is **Doc → HTML**. Edit the HTML to match the doc, never the reverse,
unless the user explicitly asks to update the doc.

## 1. Find the doc

The "Website" folder id is `15s2tzxVQ5Lh6acMC_cVfdommOlCL-d5Z`. List/search it
with the Google Drive tools, then read with `read_file_content`:

- List docs: `search_files` with `parentId = '15s2tzxVQ5Lh6acMC_cVfdommOlCL-d5Z'`
  (if the id ever changes: `title = 'Website' and mimeType = 'application/vnd.google-apps.folder'`).
- Read a doc: `read_file_content` with its `fileId`.

**Doc → file mapping** (by doc title, unless the doc has a `File:` field):

| Doc title | HTML file |
|---|---|
| `home` | `ui/home.html` |
| `pic` | `ui/articles/pic.html` |
| any article | `ui/articles/<name>.html` |

If a doc has a `File:` field (e.g. `File: lsv.html`), that wins over the title.
Edit the source files in `ui/` — **not** `ui/dist/` (that folder is generated).

**`home.html` renders each doc twice:** once in `#alm-layer` (almanac) and once
in `#cos-layer` (cosmos). Shared fields (Title, Description, headings, discipline
bodies) feed both layers; some fields are layer-specific (`Almanac eyebrow:` vs
`Cosmos eyebrow:`). Check **both** layers. Wording may differ slightly per layer
by design — flag it, don't force them identical.

## 2. What is copy vs. what is formatting

**Paragraphs → verbatim.** A plain prose block with no `Label:` prefix, not
wrapped in `%…%`, and not part of an `Insert` block is body copy. It must appear
**word-for-word** in the HTML. Report any difference (e.g. the doc's
"driving success sincere leadership" vs the HTML's "driving success *through*
sincere leadership").

**Everything below is formatting / instructional matter** — map its value to the
right HTML slot, but don't treat the label or markers as literal text:

- **Field lines** `Label: value` — structured copy for a specific slot. Seen so
  far: `Title:`→`<h1>`, `Description:`→lede/blurb `<p>`, `Almanac eyebrow:` /
  `Cosmos eyebrow:`→eyebrow, `Heading:`→section `<h2 class="title">`,
  `Explanation:`→`.section-explain`, `Mark:`/`Scale:`/`Name:`→discipline card,
  `Caption:`→`<figcaption>`, `CTA:`→button, `ID:`→element id, `Label:`/`Input:`→
  form control, `Meta Bar:` / `Table of Contents:` / `Series:` / `File:`→page
  meta. The **label** is structural; only the **value** is content.
- **`%…%` inline instructions:**
  - `%emphasize X%` → wrap X in `<em>` in that slot.
  - `%class ref num rom%` → apply classes / numbering to the element.
  - `%yes%` / `%no%` → a boolean (e.g. `Table of Contents: %yes%`).
- **`%Start of X block …%` … `%End of X block%`** → a callout/component (WARNING,
  INSIGHT, …), optionally with `ID:`. The prose **inside** it is a paragraph →
  verbatim.
- **`%% … %%`** → an author note to himself. **Ignore** it (e.g. "%% Ignore the
  following two blocks for now %%").
- **`<ref word id>` / `<insight word id>`** → a cross-reference. The first token
  is the **label word** ("section", "figure", "Figure", "Insight"), the rest is
  the target **id**. It renders as `<span class="figure-number" data-fid="id">word</span>`
  — the word lives **inside** the span so the whole "word number" becomes one link
  ("`<ref figure diamondDisciplines>`" → clickable "figure 1"). The span is empty
  in the source; `initRef` fills in the number at runtime, so don't expect the
  resolved number in the HTML. An older form put the word as plain text *before*
  the span (`figure <span class="figure-number" data-fid="…"></span>`) — treat that
  as equivalent when comparing, but write the word-inside-span form.
- **`<pill X>`** → a pill component (`<span class="pill …">X</span>`).
- **`<date>`, `<version dropdown>`, `_space_`, `<space>`** → dynamic/interactive
  placeholders; no static text to match.
- **`Insert figure` / `Insert Input Field` / `Insert Output …` blocks** (with
  their own `Description:` / `ID:` / `Caption:` / `Label:` fields) → an inserted
  component. The `Description:` under an `Insert` is a **spec for building the
  figure/widget**, not body copy — don't paste it into the page.
- **Markdown headings `#` / `##`** → section / subsection structure (`#`→a
  `<section>`, `##`→a card/subsection), not literal headings.

## 3. Workflow

- **Check / compare:** read the doc and the mapped HTML file(s). Walk the doc
  top to bottom; for each paragraph confirm a verbatim match, for each field
  confirm the value is in the right slot. Produce a list of discrepancies:
  missing copy, drifted wording, extra HTML text not in the doc. For `home.html`,
  check both the almanac and cosmos layers.
- **Update:** apply the doc's copy to the HTML. Preserve the existing markup and
  the `%…%` / `<…>` / `Insert` conventions above — only the copy changes. Match
  paragraphs verbatim; place field values in their slots.

## 4. Ask when unsure

The user explicitly wants to be asked rather than guessed at. Ask when:

- A doc has no clear target file (title doesn't match and there's no `File:`).
- A marker or `Insert` block you haven't seen before appears, or its intent is
  ambiguous.
- Almanac and cosmos copy differ and it's unclear whether that's intentional.
- The doc reorders/removes a section, or copy exists in the HTML but not the doc
  (delete? keep?).
- A field value seems to belong to a slot that doesn't exist in the HTML.
