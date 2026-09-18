package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The readings file is written by hand, or by something reading a worksheet, so
// these cover the ways it can be wrong as closely as the way it is right. A
// reading that is quietly dropped is the failure worth catching: an invoice that
// goes unclaimed is money left on the table at tax time, and nothing else in the
// system would ever mention it.

func invoiceDirWith(t *testing.T, names ...string) string {
	t.Helper()
	dir := t.TempDir()
	for _, n := range names {
		if err := os.WriteFile(filepath.Join(dir, n), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func writeReadings(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "readings.json")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

const oneReading = `{"invoices": [{
  "file": "orms.jpg", "is_invoice": true, "total": 588.00, "currency": "ZAR",
  "invoice_date": "2026-09-02", "supplier": "Orms Pty Ltd",
  "purpose": "A2 canvas prints × 3", "invoice_number": "INV-1041",
  "expense_type": "materials"
}]}`

func TestAReadingBecomesAClaimableInvoice(t *testing.T) {
	dir := invoiceDirWith(t, "orms.jpg")

	invoices, warnings, err := loadReadings(writeReadings(t, oneReading), dir)
	if err != nil {
		t.Fatalf("loadReadings: %v", err)
	}
	if len(warnings) != 0 {
		t.Fatalf("unexpected warnings: %v", warnings)
	}
	if len(invoices) != 1 {
		t.Fatalf("expected 1 invoice, got %d", len(invoices))
	}

	got := invoices[0]
	if got.File != "orms.jpg" || got.Total != 588.00 || got.Date != "2026-09-02" {
		t.Errorf("invoice does not carry what was read: %+v", got)
	}
	if got.Supplier != "Orms Pty Ltd" || got.Purpose != "A2 canvas prints × 3" {
		t.Errorf("invoice does not carry what was read: %+v", got)
	}
	if got.Number != "INV-1041" || got.Type != "materials" {
		t.Errorf("invoice does not carry the supporting detail: %+v", got)
	}
	if problem := got.incomplete(); problem != "" {
		t.Errorf("expected it to be claimable, got %q", problem)
	}
}

func TestAnInvoiceWithNoReadingIsWarnedAbout(t *testing.T) {
	// The quiet failure: a file in the folder that nobody read would simply
	// never be claimed, and nothing else would ever say so.
	dir := invoiceDirWith(t, "orms.jpg", "framing.pdf")

	invoices, warnings, err := loadReadings(writeReadings(t, oneReading), dir)
	if err != nil {
		t.Fatalf("loadReadings: %v", err)
	}
	if len(invoices) != 1 {
		t.Fatalf("expected 1 invoice, got %d", len(invoices))
	}
	if len(warnings) != 1 || !strings.Contains(warnings[0], "framing.pdf") {
		t.Fatalf("expected framing.pdf to be reported, got %v", warnings)
	}
}

func TestAReadingForAFileThatIsNotThereIsRefused(t *testing.T) {
	// A typo would otherwise claim a payment against a document that does not
	// exist, which is exactly what a claim may never do.
	dir := invoiceDirWith(t, "orms-1041.jpg")

	if _, _, err := loadReadings(writeReadings(t, oneReading), dir); err == nil {
		t.Fatal("expected a reading naming a missing file to be refused")
	}
}

func TestTheSameFileReadTwiceIsRefused(t *testing.T) {
	dir := invoiceDirWith(t, "orms.jpg")
	body := `{"invoices": [
	  {"file": "orms.jpg", "total": 588.00, "invoice_date": "2026-09-02", "purpose": "prints"},
	  {"file": "orms.jpg", "total": 120.00, "invoice_date": "2026-09-03", "purpose": "postage"}
	]}`

	if _, _, err := loadReadings(writeReadings(t, body), dir); err == nil {
		t.Fatal("expected the same invoice read twice to be refused")
	}
}

func TestAMisspeltFieldIsRefusedRatherThanIgnored(t *testing.T) {
	// Silently dropping an unknown key would mean a typo'd "totals" reads as an
	// invoice with no total — skipped with a warning nobody connects to a typo.
	dir := invoiceDirWith(t, "orms.jpg")
	body := `{"invoices": [{"file": "orms.jpg", "totals": 588.00, "invoice_date": "2026-09-02", "purpose": "prints"}]}`

	err := func() error { _, _, err := loadReadings(writeReadings(t, body), dir); return err }()
	if err == nil {
		t.Fatal("expected an unknown field to be refused")
	}
	if !strings.Contains(err.Error(), "totals") {
		t.Errorf("error does not name the field: %v", err)
	}
}

func TestSomethingThatIsNotAnInvoiceIsSkipped(t *testing.T) {
	// The statement itself often sits in the same folder.
	dir := invoiceDirWith(t, "statement.pdf")
	body := `{"invoices": [{"file": "statement.pdf", "is_invoice": false}]}`

	invoices, warnings, err := loadReadings(writeReadings(t, body), dir)
	if err != nil {
		t.Fatalf("loadReadings: %v", err)
	}
	if len(invoices) != 0 {
		t.Fatalf("expected nothing claimable, got %v", invoices)
	}
	if len(warnings) != 1 || !strings.Contains(warnings[0], "not an invoice") {
		t.Fatalf("expected it to be reported as not an invoice, got %v", warnings)
	}
}

func TestAnIncompleteReadingIsSkippedWithItsReason(t *testing.T) {
	dir := invoiceDirWith(t, "blurry.jpg")
	body := `{"invoices": [{"file": "blurry.jpg", "invoice_date": "2026-09-02", "purpose": "frames"}]}`

	invoices, warnings, err := loadReadings(writeReadings(t, body), dir)
	if err != nil {
		t.Fatalf("loadReadings: %v", err)
	}
	if len(invoices) != 0 {
		t.Fatalf("claimed an invoice with no total: %v", invoices)
	}
	if len(warnings) != 1 || !strings.Contains(warnings[0], "no total") {
		t.Fatalf("expected the reason to be given, got %v", warnings)
	}
}

func TestAnUnstatedCurrencyIsRands(t *testing.T) {
	// The account is a rand account and every document in the folder should be
	// one, so silence is not a reason to refuse a claim — but a stated currency
	// that is not rands is, since the total would not be comparable.
	dir := invoiceDirWith(t, "orms.jpg")
	body := `{"invoices": [{"file": "orms.jpg", "total": 588.00, "invoice_date": "2026-09-02", "purpose": "prints"}]}`

	invoices, _, err := loadReadings(writeReadings(t, body), dir)
	if err != nil {
		t.Fatalf("loadReadings: %v", err)
	}
	if len(invoices) != 1 || invoices[0].Currency != "ZAR" {
		t.Fatalf("expected an unstated currency to read as ZAR, got %v", invoices)
	}

	body = strings.Replace(body, `"total": 588.00`, `"currency": "USD", "total": 588.00`, 1)
	invoices, warnings, err := loadReadings(writeReadings(t, body), dir)
	if err != nil {
		t.Fatalf("loadReadings: %v", err)
	}
	if len(invoices) != 0 {
		t.Fatalf("claimed a total that is not in rands: %v", invoices)
	}
	if len(warnings) != 1 || !strings.Contains(warnings[0], "not rands") {
		t.Fatalf("expected the reason to be given, got %v", warnings)
	}
}

func TestTheWorksheetCarriesTheFilesAndThePayments(t *testing.T) {
	dir := invoiceDirWith(t, "slip.jpg", "notes.txt", "orms.png")
	out := filepath.Join(t.TempDir(), "worksheet.json")

	txs := []Transaction{
		tx("2026-09-04", "Banking App External Payment: Orms Pty Ltd", -588.00),
		tx("2026-09-04", "Payment Received: Anthea", 600.00),
	}
	if err := prepareWorksheet(out, dir, "statement.pdf", txs); err != nil {
		t.Fatalf("prepareWorksheet: %v", err)
	}

	body, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	var sheet worksheet
	if err := json.Unmarshal(body, &sheet); err != nil {
		t.Fatalf("the worksheet is not readable JSON: %v", err)
	}

	// The .txt is not a document; the two images are, and neither carries text.
	if len(sheet.Invoices) != 2 {
		t.Fatalf("listed %d invoices, want 2: %+v", len(sheet.Invoices), sheet.Invoices)
	}
	for _, i := range sheet.Invoices {
		if !i.NeedsImage {
			t.Errorf("%s: a photograph has no text, so it must be flagged for looking at", i.File)
		}
		if i.Path == "" {
			t.Errorf("%s: no path to open the file at", i.File)
		}
	}

	// Money out only: a credit can never be a claim, so offering one as context
	// would only invite a match the ledger's own trigger rejects.
	if len(sheet.Payments) != 1 || sheet.Payments[0].Amount != -588.00 {
		t.Fatalf("payments = %+v, want the debit alone", sheet.Payments)
	}

	if len(sheet.HowToFill) == 0 || sheet.Template.File == "" {
		t.Error("the worksheet does not say how to fill it in")
	}
	// The template has to be a valid reading, or it is teaching the wrong shape.
	if _, err := json.Marshal(sheet.Template); err != nil {
		t.Errorf("the template does not round-trip: %v", err)
	}
}

func TestTheWorksheetRefusesAnEmptyFolder(t *testing.T) {
	out := filepath.Join(t.TempDir(), "worksheet.json")
	if err := prepareWorksheet(out, invoiceDirWith(t, "notes.txt"), "statement.pdf", nil); err == nil {
		t.Fatal("expected an empty folder to be refused")
	}
}

func TestOnlyDocumentsAreListed(t *testing.T) {
	dir := invoiceDirWith(t, "b.pdf", "a.pdf", "slip.JPG", "notes.txt", "thumbs.db")
	if err := os.Mkdir(filepath.Join(dir, "archive"), 0o700); err != nil {
		t.Fatal(err)
	}

	files, err := invoiceFiles(dir)
	if err != nil {
		t.Fatal(err)
	}

	var got []string
	for _, f := range files {
		got = append(got, filepath.Base(f))
	}
	// Sorted, so a run is repeatable; no .txt, no .db, and no recursion into
	// whatever else is filed alongside the invoices.
	want := []string{"a.pdf", "b.pdf", "slip.JPG"}
	if len(got) != len(want) {
		t.Fatalf("listed %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("listed %v, want %v", got, want)
		}
	}
}

func TestIncompleteInvoicesAreNotClaimable(t *testing.T) {
	cases := map[string]Invoice{
		"no total":    {Total: 0, Purpose: "prints", Date: "2026-09-02", Currency: "ZAR"},
		"no purpose":  {Total: 10, Purpose: "", Date: "2026-09-02", Currency: "ZAR"},
		"no date":     {Total: 10, Purpose: "prints", Date: "", Currency: "ZAR"},
		"bad date":    {Total: 10, Purpose: "prints", Date: "02/09/2026", Currency: "ZAR"},
		"not in rand": {Total: 10, Purpose: "prints", Date: "2026-09-02", Currency: "USD"},
	}
	for name, inv := range cases {
		if inv.incomplete() == "" {
			t.Errorf("%s: expected the invoice to be rejected", name)
		}
	}

	ok := Invoice{Total: 10, Purpose: "prints", Date: "2026-09-02", Currency: "ZAR"}
	if problem := ok.incomplete(); problem != "" {
		t.Errorf("expected a complete invoice to be claimable, got %q", problem)
	}
}
