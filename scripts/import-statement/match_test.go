package main

import (
	"strings"
	"testing"
)

// The matcher is what stands between a misread invoice and a wrong deduction,
// so these cover the cases where it must refuse as closely as the ones where it
// must match. Synthetic rows throughout — no real statement, no real invoice.

func tx(date, description string, amount float64) Transaction {
	return Transaction{
		TransactionDate: date,
		Description:     description,
		Amount:          amount,
		TransactionType: "debit",
		RawReference:    date + " " + description + " 1000.00",
	}
}

func invoice(file, date, supplier string, total float64) Invoice {
	return Invoice{
		File:      file,
		IsInvoice: true,
		Total:     total,
		Currency:  "ZAR",
		Date:      date,
		Supplier:  supplier,
		Purpose:   "canvas prints",
	}
}

func TestMatchesPaymentOfTheSameAmount(t *testing.T) {
	txs := []Transaction{
		tx("2026-09-04", "Pick n Pay Bellville (Card 5581)", -58.38),
		tx("2026-09-04", "Banking App External Payment: Orms Pty Ltd", -588.00),
	}
	claims, unmatched := matchInvoices([]Invoice{invoice("orms.pdf", "2026-09-02", "Orms Pty Ltd", 588)}, txs, 14, defaultTolerance)

	if len(unmatched) != 0 {
		t.Fatalf("expected no unmatched invoices, got %v", unmatched)
	}
	if len(claims) != 1 {
		t.Fatalf("expected 1 claim, got %d", len(claims))
	}
	if got := claims[0].Transaction.Description; got != txs[1].Description {
		t.Errorf("matched the wrong payment: %s", got)
	}
	if claims[0].DaysApart != 2 {
		t.Errorf("days apart = %d, want 2", claims[0].DaysApart)
	}
}

func TestIgnoresCreditsOfTheSameAmount(t *testing.T) {
	// Money in of the same amount is a refund or a sale, never a deductible
	// expense — the ledger's own trigger would reject the claim.
	txs := []Transaction{tx("2026-09-04", "Payment Received: Orms Pty Ltd", 588.00)}
	claims, unmatched := matchInvoices([]Invoice{invoice("orms.pdf", "2026-09-04", "Orms Pty Ltd", 588)}, txs, 14, defaultTolerance)

	if len(claims) != 0 {
		t.Fatalf("claimed a credit: %v", claims)
	}
	if len(unmatched) != 1 {
		t.Fatalf("expected the invoice to be reported, got %d", len(unmatched))
	}
}

func TestRefusesAPaymentOutsideTheWindow(t *testing.T) {
	txs := []Transaction{tx("2026-09-30", "Banking App External Payment: Orms Pty Ltd", -588.00)}
	claims, unmatched := matchInvoices([]Invoice{invoice("orms.pdf", "2026-09-02", "Orms Pty Ltd", 588)}, txs, 14, defaultTolerance)

	if len(claims) != 0 {
		t.Fatalf("matched outside the window: %v", claims)
	}
	if len(unmatched) != 1 {
		t.Fatalf("expected the invoice to be reported, got %d", len(unmatched))
	}
}

func TestTheSupplierNameSeparatesTwoPaymentsOfTheSameAmount(t *testing.T) {
	txs := []Transaction{
		tx("2026-09-03", "Banking App External Payment: Miss L Small", -250.00),
		tx("2026-09-04", "Orms Bellville Cape Town (Card 5581)", -250.00),
	}
	claims, unmatched := matchInvoices([]Invoice{invoice("orms.pdf", "2026-09-02", "Orms Pty Ltd", 250)}, txs, 14, defaultTolerance)

	if len(unmatched) != 0 {
		t.Fatalf("expected the name to settle it, got %v", unmatched)
	}
	if len(claims) != 1 || claims[0].Transaction.Description != txs[1].Description {
		t.Fatalf("matched the wrong payment: %v", claims)
	}
}

func TestRefusesTwoEquallyGoodPayments(t *testing.T) {
	// Same amount, same day, nothing in either description to tell them apart:
	// there is no honest answer here, so it must not pick one.
	txs := []Transaction{
		tx("2026-09-04", "Banking App External Payment: Supplier A", -250.00),
		tx("2026-09-04", "Banking App External Payment: Supplier B", -250.00),
	}
	claims, unmatched := matchInvoices([]Invoice{invoice("frames.pdf", "2026-09-04", "Woodwork Framing", 250)}, txs, 14, defaultTolerance)

	if len(claims) != 0 {
		t.Fatalf("guessed between two payments: %v", claims)
	}
	if len(unmatched) != 1 {
		t.Fatalf("expected the invoice to be reported, got %d", len(unmatched))
	}
}

func TestTwoInvoicesCannotClaimThePaymentBetweenThem(t *testing.T) {
	// One payment backs at most one claim (business_expenses.transaction_id is
	// UNIQUE), and nothing here can say which invoice it belongs to — so both
	// are withdrawn, including the one that matched first.
	txs := []Transaction{tx("2026-09-04", "Banking App External Payment: Orms Pty Ltd", -588.00)}
	invoices := []Invoice{
		invoice("orms-1.pdf", "2026-09-02", "Orms Pty Ltd", 588),
		invoice("orms-2.pdf", "2026-09-03", "Orms Pty Ltd", 588),
	}
	claims, unmatched := matchInvoices(invoices, txs, 14, defaultTolerance)

	if len(claims) != 0 {
		t.Fatalf("claimed one payment twice: %v", claims)
	}
	if len(unmatched) != 2 {
		t.Fatalf("expected both invoices to be reported, got %d", len(unmatched))
	}
}

func TestAnUnrelatedInvoiceLeavesEarlierClaimsAlone(t *testing.T) {
	txs := []Transaction{
		tx("2026-09-04", "Banking App External Payment: Orms Pty Ltd", -588.00),
		tx("2026-09-05", "Postnet Bellville (Card 5581)", -120.00),
	}
	invoices := []Invoice{
		invoice("orms.pdf", "2026-09-02", "Orms Pty Ltd", 588),
		invoice("postage.pdf", "2026-09-05", "PostNet", 120),
		invoice("missing.pdf", "2026-09-05", "Someone Else", 999),
	}
	claims, unmatched := matchInvoices(invoices, txs, 14, defaultTolerance)

	if len(claims) != 2 {
		t.Fatalf("expected 2 claims, got %d: %v", len(claims), claims)
	}
	if len(unmatched) != 1 || unmatched[0].Invoice.File != "missing.pdf" {
		t.Fatalf("expected only missing.pdf to be reported, got %v", unmatched)
	}
}

func TestAPaymentRoundedToTheRandStillMatches(t *testing.T) {
	// What actually happens: the invoice is for 195.99 and 196.00 is paid. The
	// cent is evidence of nothing, and refusing it would leave a real expense
	// unclaimed.
	txs := []Transaction{tx("2026-09-04", "Banking App External PayShap Payment: Orms Pty Ltd", -196.00)}
	claims, unmatched := matchInvoices([]Invoice{invoice("orms.pdf", "2026-09-04", "Orms Pty Ltd", 195.99)}, txs, 14, defaultTolerance)

	if len(unmatched) != 0 {
		t.Fatalf("refused a payment rounded to the rand: %v", unmatched)
	}
	if len(claims) != 1 {
		t.Fatalf("expected 1 claim, got %d", len(claims))
	}
	// Recorded, so the listing can say the claim leant on the tolerance.
	if claims[0].Rounding != 1 {
		t.Errorf("rounding = %d cents, want 1", claims[0].Rounding)
	}
}

func TestADifferenceBeyondTheToleranceIsRefused(t *testing.T) {
	// Two rand is not rounding, it is a different payment.
	txs := []Transaction{tx("2026-09-04", "Banking App External Payment: Orms Pty Ltd", -198.00)}
	claims, unmatched := matchInvoices([]Invoice{invoice("orms.pdf", "2026-09-04", "Orms Pty Ltd", 195.99)}, txs, 14, defaultTolerance)

	if len(claims) != 0 {
		t.Fatalf("matched a payment 2.01 away: %v", claims)
	}
	// And the report has to name it, or there is nothing to act on: this is the
	// case where the total was misread, or the tolerance is genuinely too tight.
	if len(unmatched) != 1 || !strings.Contains(unmatched[0].Reason, "198.00") {
		t.Fatalf("expected the closest payment to be named, got %v", unmatched)
	}
}

func TestZeroToleranceMeansToTheCent(t *testing.T) {
	txs := []Transaction{tx("2026-09-04", "Banking App External Payment: Orms Pty Ltd", -196.00)}
	claims, _ := matchInvoices([]Invoice{invoice("orms.pdf", "2026-09-04", "Orms Pty Ltd", 195.99)}, txs, 14, 0)

	if len(claims) != 0 {
		t.Fatalf("--amount-tolerance 0 matched a cent apart: %v", claims)
	}
}

func TestAnExactPaymentOutranksARoundedOne(t *testing.T) {
	// The tolerance widens what may match; it must never cost an exact match.
	txs := []Transaction{
		tx("2026-09-04", "Banking App External Payment: Orms Pty Ltd", -196.00),
		tx("2026-09-05", "Banking App External Payment: Orms Pty Ltd", -195.99),
	}
	claims, unmatched := matchInvoices([]Invoice{invoice("orms.pdf", "2026-09-03", "Orms Pty Ltd", 195.99)}, txs, 14, defaultTolerance)

	if len(unmatched) != 0 {
		t.Fatalf("expected the exact payment to settle it, got %v", unmatched)
	}
	if len(claims) != 1 || claims[0].Transaction.Amount != -195.99 {
		t.Fatalf("took the rounded payment over the exact one: %v", claims)
	}
	if claims[0].Rounding != 0 {
		t.Errorf("rounding = %d cents, want 0", claims[0].Rounding)
	}
}

func TestNameScoreIgnoresTheStatementsOwnVocabulary(t *testing.T) {
	// "Payment" appears on most statement rows; matching on it would score every
	// supplier against every payment.
	if got := nameScore("Payment Solutions", "Banking App External Payment: Miss L Small"); got != 0 {
		t.Errorf("score = %d, want 0 — only noise words are shared", got)
	}
	if got := nameScore("Orms Pty Ltd", "Banking App External Payment: Orms Pty Ltd"); got != 1 {
		t.Errorf("score = %d, want 1", got)
	}
}

func TestPayloadCarriesTheInvoiceAndItsPaymentsKey(t *testing.T) {
	payment := tx("2026-09-04", "Banking App External Payment: Orms Pty Ltd", -588.00)
	inv := invoice("orms.pdf", "2026-09-02", "Orms Pty Ltd", 588)
	inv.Number = "INV-1041"
	inv.Type = "materials"

	got := Claim{Invoice: inv, Transaction: payment}.payload()

	if got.Transaction.RawReference != payment.RawReference {
		t.Errorf("raw_reference = %q, want the payment's own line", got.Transaction.RawReference)
	}
	if got.Transaction.Amount != payment.Amount {
		t.Errorf("amount = %v, want %v", got.Transaction.Amount, payment.Amount)
	}
	if got.Purpose != inv.Purpose || got.Supplier != inv.Supplier {
		t.Errorf("claim does not carry the invoice: %+v", got)
	}
	if got.InvoiceNumber != "INV-1041" || got.InvoiceDate != inv.Date || got.ExpenseType != "materials" {
		t.Errorf("claim does not carry the invoice's details: %+v", got)
	}
	// The file is the paperwork the deduction has to be produced with.
	if got.Note != "invoice: orms.pdf" {
		t.Errorf("note = %q, want the invoice's filename", got.Note)
	}

	// And what the reader could not be sure of travels with it, since the claim
	// is what gets defended, not the worksheet it was read from.
	inv.Note = "date taken from the PDF timestamp; the printed one did not decode"
	got = Claim{Invoice: inv, Transaction: payment}.payload()
	if got.Note != "invoice: orms.pdf; "+inv.Note {
		t.Errorf("note = %q, want the file and the reader's caveat", got.Note)
	}
}
