package main

// Invoice reading — in two steps, with a reader in the middle.
//
// A statement row says money left the account; it never says what for. That is
// what the supplier's invoice carries, and it is the thing a deduction cannot be
// defended without (see `purpose` in db/004_monthly_aggregations.sql).
//
// Invoices are not parsed, which is the opposite choice to the statement next
// door. The statement is one bank's fixed layout, so its columns can be read by
// position and checked against the balance chain. An invoice is whatever the
// supplier's software prints — a table, a letterhead, a photo of a till slip —
// and there is no second source to check it against, so there is nothing for a
// parser to lock onto. Reading one is a judgement, and this program does not
// make it.
//
// So it splits the job in half and leaves the judgement outside:
//
//	--prepare   writes a WORKSHEET: every invoice's text, laid out as the PDF
//	            lays it out, with the statement's payments alongside it.
//	--readings  takes back a READINGS file — one filled-in record per invoice —
//	            and imports the claims it can place.
//
// In between, something reads the worksheet and fills in the readings: a Claude
// Code session with the folder open is what this is built for, and a person with
// a text editor works exactly as well. Nothing here calls an API, holds a key,
// or sends an invoice anywhere.
//
// What comes back is therefore UNVERIFIED, however careful the reader was. The
// safeguard is the match in match.go, which this file cannot influence: an
// invoice is only ever believed as far as a real payment of the same amount, so
// a misread total matches nothing and is reported rather than imported.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Invoice is one supplier document, as it was read.
type Invoice struct {
	File string // the file it was read from, for the audit trail

	IsInvoice bool    // false when the file is not an invoice at all
	Total     float64 // the amount payable, positive, as printed
	Currency  string  // ISO code, to catch a total that is not in rands
	Date      string  // YYYY-MM-DD, the invoice's own date
	Supplier  string  // who issued it
	Purpose   string  // what was bought — this becomes the claim's purpose
	Number    string  // the supplier's invoice number, when it carries one
	Type      string  // materials / packaging / postage / …
}

// reading is one invoice as the readings file carries it. Separate from Invoice
// so the file's shape is explicit, and pointers so a field left out is told
// apart from one deliberately emptied.
type reading struct {
	File          string   `json:"file"`
	IsInvoice     *bool    `json:"is_invoice"`
	Total         *float64 `json:"total"`
	Currency      *string  `json:"currency"`
	InvoiceDate   *string  `json:"invoice_date"`
	Supplier      *string  `json:"supplier"`
	Purpose       *string  `json:"purpose"`
	InvoiceNumber *string  `json:"invoice_number"`
	ExpenseType   *string  `json:"expense_type"`
}

type readingsFile struct {
	Invoices []reading `json:"invoices"`
}

// ---------------------------------------------------------------------------
// Step one: the worksheet.
// ---------------------------------------------------------------------------

// worksheet is what --prepare writes: everything needed to read the invoices,
// and nothing that decides anything. The matching is not in here on purpose —
// it stays in match.go, where the amount has to agree to the cent.
type worksheet struct {
	Statement     string          `json:"statement"`
	InvoiceFolder string          `json:"invoice_folder"`
	HowToFill     []string        `json:"how_to_fill"`
	Template      reading         `json:"reading_template"`
	Invoices      []worksheetItem `json:"invoices"`
	Payments      []worksheetPay  `json:"payments"`
}

type worksheetItem struct {
	File string `json:"file"`
	Path string `json:"path"` // where to open it, when the text is not enough
	Text string `json:"text,omitempty"`
	// True when nothing could be pulled out of the file: a photograph, or a
	// scan with no text layer. The file itself has to be looked at.
	NeedsImage bool `json:"needs_image"`
}

// worksheetPay is one payment from the statement, for context only. Reading an
// invoice is easier with the payments in view — a total that matches nothing is
// worth a second look at the document before it is written down — but nothing
// here is matched by hand: `--readings` re-derives every match in Go.
type worksheetPay struct {
	Date        string  `json:"date"`
	Amount      float64 `json:"amount"`
	Description string  `json:"description"`
}

var howToFill = []string{
	"Read each entry in `invoices`. Where `needs_image` is true there was no text to pull out — open the file at `path` and look at it.",
	"Write a readings file: {\"invoices\": [ … ]}, one object per entry, shaped like `reading_template`, with the same `file` name.",
	"Record only what the document shows. A null is always better than a guess — every field here ends up in a tax record.",
	"`total` is the amount payable including VAT: the total, not the subtotal, and the amount of this document rather than a balance brought forward.",
	"`purpose` is what was bought, in a short phrase from the line items ('A2 canvas prints × 3'). Name the goods or service; do not repeat the supplier or describe the document.",
	"`is_invoice` is false for anything that is not an invoice, receipt, till slip or bill — a bank statement or a delivery note filed in the same folder.",
	"`payments` is context for sanity-checking a total you are unsure of. Do not match anything: --readings does that, and only against a payment of exactly the total you write down.",
	"Then: go run . --invoices <folder> --readings <file> <statement.pdf>",
}

func templateReading() reading {
	s := func(v string) *string { return &v }
	f := func(v float64) *float64 { return &v }
	b := func(v bool) *bool { return &v }
	return reading{
		File:          "orms-1041.pdf",
		IsInvoice:     b(true),
		Total:         f(588.00),
		Currency:      s("ZAR"),
		InvoiceDate:   s("2026-09-02"),
		Supplier:      s("Orms Pty Ltd"),
		Purpose:       s("A2 canvas prints × 3"),
		InvoiceNumber: s("INV-1041"),
		ExpenseType:   s("materials"),
	}
}

// prepareWorksheet writes the worksheet for a folder of invoices.
func prepareWorksheet(path, dir, statement string, txs []Transaction) error {
	files, err := invoiceFiles(dir)
	if err != nil {
		return err
	}
	if len(files) == 0 {
		return fmt.Errorf("no invoices found in %s", dir)
	}

	sheet := worksheet{
		Statement:     statement,
		InvoiceFolder: dir,
		HowToFill:     howToFill,
		Template:      templateReading(),
	}

	for _, file := range files {
		item := worksheetItem{File: filepath.Base(file), Path: file}
		if mediaType(file) == "application/pdf" {
			// The same reader the statement uses, so an invoice with a text
			// layer needs nothing extra installed. Errors are not fatal: an
			// unreadable PDF just falls through to being looked at.
			if text, err := invoiceText(file); err == nil {
				item.Text = text
			}
		}
		item.NeedsImage = strings.TrimSpace(item.Text) == ""
		sheet.Invoices = append(sheet.Invoices, item)
	}

	// Money out only — a credit can never be a claim, so listing one would only
	// invite a match that the ledger's own trigger would reject.
	for _, tx := range txs {
		if tx.Amount < 0 {
			sheet.Payments = append(sheet.Payments, worksheetPay{
				Date:        tx.TransactionDate,
				Amount:      tx.Amount,
				Description: tx.Description,
			})
		}
	}

	body, err := json.MarshalIndent(sheet, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(path, append(body, '\n'), 0o600); err != nil {
		return err
	}

	var needImage int
	for _, i := range sheet.Invoices {
		if i.NeedsImage {
			needImage++
		}
	}
	fmt.Printf("\nWrote %s\n", path)
	fmt.Printf("  %d invoice(s) from %s", len(sheet.Invoices), dir)
	if needImage > 0 {
		fmt.Printf(", %d with no text to read (open the file itself)", needImage)
	}
	fmt.Printf("\n  %d payment(s) listed for context\n", len(sheet.Payments))
	fmt.Printf("\nFill it in, then: --invoices %s --readings <file>\n", dir)
	return nil
}

// invoiceText renders a PDF as text, line by line, in the order the page lays it
// out. Positions are kept only as far as the line breaks: an invoice has no
// fixed columns to read by, unlike the statement, so anything more would be
// inventing structure that isn't there.
func invoiceText(path string) (string, error) {
	pages, err := readPages(path, "")
	if err != nil {
		return "", err
	}

	var out []string
	for i, page := range pages {
		if i > 0 {
			out = append(out, fmt.Sprintf("--- page %d ---", i+1))
		}
		for _, l := range page {
			var parts []string
			for _, c := range l.cells {
				if s := strings.TrimSpace(c.s); s != "" {
					parts = append(parts, s)
				}
			}
			if line := squash(strings.Join(parts, " ")); line != "" {
				out = append(out, line)
			}
		}
	}
	return strings.Join(out, "\n"), nil
}

// ---------------------------------------------------------------------------
// Step two: the readings.
// ---------------------------------------------------------------------------

// loadReadings reads a filled-in readings file and returns the invoices that can
// be claimed, with a warning for every one that cannot. An invoice in the folder
// with no reading at all is warned about too — it would otherwise go quietly
// unclaimed, which is exactly the thing that is hard to notice later.
func loadReadings(path, dir string) ([]Invoice, []string, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return nil, nil, err
	}

	var file readingsFile
	decoder := json.NewDecoder(strings.NewReader(string(body)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&file); err != nil {
		return nil, nil, fmt.Errorf("%s: %w", filepath.Base(path), err)
	}
	if len(file.Invoices) == 0 {
		return nil, nil, fmt.Errorf("%s carries no invoices", filepath.Base(path))
	}

	// What is actually in the folder, so a reading cannot name a file that was
	// never there — a typo would otherwise claim a payment against nothing.
	inFolder := map[string]bool{}
	files, err := invoiceFiles(dir)
	if err != nil {
		return nil, nil, err
	}
	for _, f := range files {
		inFolder[filepath.Base(f)] = false // false: not yet read
	}

	var (
		invoices []Invoice
		warnings []string
	)
	for i, r := range file.Invoices {
		name := strings.TrimSpace(r.File)
		if name == "" {
			return nil, nil, fmt.Errorf("%s: reading %d names no file", filepath.Base(path), i)
		}
		read, known := inFolder[name]
		if !known {
			return nil, nil, fmt.Errorf("%s: there is no %s in %s", filepath.Base(path), name, dir)
		}
		if read {
			return nil, nil, fmt.Errorf("%s: %s is read twice", filepath.Base(path), name)
		}
		inFolder[name] = true

		if r.IsInvoice != nil && !*r.IsInvoice {
			warnings = append(warnings, fmt.Sprintf("%s: not an invoice — skipped", name))
			continue
		}

		inv := Invoice{
			File:      name,
			IsInvoice: true,
			Currency:  strings.ToUpper(deref(r.Currency)),
			Date:      deref(r.InvoiceDate),
			Supplier:  deref(r.Supplier),
			Purpose:   deref(r.Purpose),
			Number:    deref(r.InvoiceNumber),
			Type:      deref(r.ExpenseType),
		}
		if r.Total != nil {
			inv.Total = round2(*r.Total)
		}
		// An unstated currency is taken as rands: the account is a rand account
		// and every document in the folder should be one. A stated one that is
		// not ZAR is rejected below.
		if inv.Currency == "" {
			inv.Currency = "ZAR"
		}

		if problem := inv.incomplete(); problem != "" {
			warnings = append(warnings, fmt.Sprintf("%s: %s — skipped", name, problem))
			continue
		}
		invoices = append(invoices, inv)
	}

	var unread []string
	for name, read := range inFolder {
		if !read {
			unread = append(unread, name)
		}
	}
	sort.Strings(unread)
	for _, name := range unread {
		warnings = append(warnings, fmt.Sprintf("%s: in the folder but not in the readings — not claimed", name))
	}

	return invoices, warnings, nil
}

// incomplete reports why an invoice cannot be claimed, or "" when it can. A
// claim needs a real amount to match a payment against and a purpose to be
// defended with; everything else is optional detail.
func (i Invoice) incomplete() string {
	switch {
	case i.Total <= 0:
		return "no total"
	case i.Purpose == "":
		return "no description of what was bought"
	case i.Date == "":
		return "no invoice date"
	case !strings.EqualFold(i.Currency, "ZAR"):
		return fmt.Sprintf("total is in %s, not rands", i.Currency)
	case !isoDateRe.MatchString(i.Date):
		return fmt.Sprintf("unreadable invoice date %q", i.Date)
	}
	return ""
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return strings.TrimSpace(*s)
}

// ---------------------------------------------------------------------------
// The folder.
// ---------------------------------------------------------------------------

// invoiceFiles lists the documents in dir, in a stable order. Non-recursive: a
// folder of invoices is a flat folder, and recursing would sweep up whatever
// else is filed alongside it.
func invoiceFiles(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var files []string
	for _, e := range entries {
		if e.IsDir() || mediaType(e.Name()) == "" {
			continue
		}
		files = append(files, filepath.Join(dir, e.Name()))
	}
	sort.Strings(files)
	return files, nil
}

// mediaType maps a filename to what it is, or "" for a file that is not a
// document at all.
func mediaType(name string) string {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".pdf":
		return "application/pdf"
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".webp":
		return "image/webp"
	case ".gif":
		return "image/gif"
	}
	return ""
}
