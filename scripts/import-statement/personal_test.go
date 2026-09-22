package main

import (
	"os"
	"path/filepath"
	"testing"
)

// A rule marks money as nobody's business but the owner's, which is a weaker
// claim than an invoice makes and must never override one. That, and never
// matching more than it was asked to, is what these cover.

func categorised(date, description, category string, amount float64) Transaction {
	t := tx(date, description, amount)
	t.Category = category
	return t
}

func writeRules(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "personal.json")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestARuleMarksWhatItRecognises(t *testing.T) {
	txs := []Transaction{
		categorised("2026-09-04", "Pick n Pay Durbanville (Card 5581)", "Groceries", -58.38),
		categorised("2026-09-04", "Orms Bellville Cape Town (Card 5581)", "Sport & Hobbies", -256.00),
	}
	rules := []rule{{Match: "pick n pay", Note: "groceries"}}

	marked, unused, untouched := markPersonal(rules, txs, nil)

	if len(marked) != 1 || marked[0].Transaction.Amount != -58.38 {
		t.Fatalf("marked %v, want the groceries alone", marked)
	}
	if len(unused) != 0 {
		t.Errorf("a rule that matched was reported unused: %v", unused)
	}
	// The Orms purchase is neither claimed nor matched, which is exactly the
	// number that says how much of the month is left to go through.
	if untouched != 1 {
		t.Errorf("untouched = %d, want 1", untouched)
	}
}

func TestARuleMatchesTheBanksOwnCategory(t *testing.T) {
	// The broader lever: Capitec categorises most card purchases, so one rule
	// covers a shop that prints its name three different ways.
	txs := []Transaction{
		categorised("2026-09-04", "Pick n Pay Durbanville (Card 5581)", "Groceries", -58.38),
		categorised("2026-09-16", "Best End Welgemoed (Card 5581)", "groceries", -101.40),
		categorised("2026-09-13", "Engen Cape Town (Card 5581)", "Fuel", -100.00),
	}
	rules := []rule{{Category: "Groceries"}}

	marked, _, untouched := markPersonal(rules, txs, nil)

	if len(marked) != 2 {
		t.Fatalf("marked %d, want both groceries — the category is matched whole, not by case", len(marked))
	}
	if untouched != 1 {
		t.Errorf("untouched = %d, want the fuel", untouched)
	}
}

func TestBothTestsMustPassWhenBothAreGiven(t *testing.T) {
	txs := []Transaction{
		categorised("2026-09-04", "Pick n Pay Durbanville (Card 5581)", "Groceries", -58.38),
		categorised("2026-09-17", "Pick n Pay Bellville (Card 5581)", "Digital Payments", -38.99),
	}
	rules := []rule{{Match: "pick n pay", Category: "Groceries"}}

	marked, _, _ := markPersonal(rules, txs, nil)

	if len(marked) != 1 || marked[0].Transaction.Amount != -58.38 {
		t.Fatalf("marked %v, want only the row matching both tests", marked)
	}
}

func TestARuleNeverTakesAPaymentAnInvoiceClaimed(t *testing.T) {
	// Evidence beats habit: an invoice matched to a payment is proof, a pattern
	// in a description is only a tendency, and the claim must survive it.
	payment := categorised("2026-09-04", "Orms Bellville Cape Town (Card 5581)", "Sport & Hobbies", -256.00)
	txs := []Transaction{payment}
	claims := []Claim{{Invoice: invoice("orms.pdf", "2026-09-04", "Orms Pty Ltd", 256), Transaction: payment}}

	marked, unused, untouched := markPersonal([]rule{{Match: "orms"}}, txs, claims)

	if len(marked) != 0 {
		t.Fatalf("a rule marked a payment that was claimed as a business expense: %v", marked)
	}
	if untouched != 0 {
		t.Errorf("untouched = %d — a claimed payment is accounted for", untouched)
	}
	// And the rule reads as unused, which is true of this statement: everything
	// it would have matched was already spoken for.
	if len(unused) != 1 {
		t.Errorf("unused = %v, want the rule reported", unused)
	}
}

func TestTheFirstMatchingRuleWins(t *testing.T) {
	txs := []Transaction{categorised("2026-09-04", "Pick n Pay Durbanville (Card 5581)", "Groceries", -58.38)}
	rules := []rule{{Match: "pick n pay", Note: "groceries"}, {Category: "Groceries", Note: "everything else"}}

	marked, unused, _ := markPersonal(rules, txs, nil)

	if len(marked) != 1 || marked[0].Rule.Note != "groceries" {
		t.Fatalf("the file is read top to bottom, so the first rule should win: %v", marked)
	}
	if len(unused) != 1 {
		t.Errorf("the second rule matched nothing and should be reported: %v", unused)
	}
}

func TestAMarkedTransactionClaimsNothing(t *testing.T) {
	txs := []Transaction{categorised("2026-09-04", "Pick n Pay Durbanville (Card 5581)", "Groceries", -58.38)}
	marked, _, _ := markPersonal([]rule{{Match: "pick n pay", Note: "groceries"}}, txs, nil)

	got := marked[0].payload()

	if got.Kind != "personal" {
		t.Errorf("kind = %q, want personal", got.Kind)
	}
	// Never "by hand": a pattern decided this, and a later rule change has to be
	// distinguishable from a decision someone made.
	if got.Source != "rule" {
		t.Errorf("source = %q, want rule", got.Source)
	}
	if got.Note != "groceries" {
		t.Errorf("note = %q, want the rule's note", got.Note)
	}
	// Nothing that would assert a document covers it — the endpoint and the
	// database both refuse those on a personal row.
	if got.Purpose != "" || got.Supplier != "" || got.InvoiceNumber != "" ||
		got.InvoiceDate != "" || got.ExpenseType != "" {
		t.Errorf("a personal row carries a claim's fields: %+v", got)
	}
	if got.Transaction.RawReference != txs[0].RawReference {
		t.Errorf("raw_reference = %q, want the statement's own line", got.Transaction.RawReference)
	}
}

func TestMoneyInCanBePersonal(t *testing.T) {
	// A private transfer into the account is money that arrived and is not the
	// business's. It cannot be claimed, but it can be accounted for.
	txs := []Transaction{categorised("2026-09-01", "Payment Received: Absa Bank Troost Transfer", "Other Income", 1800.00)}

	marked, _, _ := markPersonal([]rule{{Match: "troost"}}, txs, nil)

	if len(marked) != 1 || marked[0].payload().Kind != "personal" {
		t.Fatalf("a credit could not be marked personal: %v", marked)
	}
}

func TestARuleThatMatchesOnNothingIsRefused(t *testing.T) {
	// It would mark the whole statement personal, claimed payments included.
	if _, err := loadRules(writeRules(t, `{"rules": [{"note": "everything"}]}`)); err == nil {
		t.Fatal("expected a rule with no test to be refused")
	}
}

func TestAMisspeltRuleFieldIsRefused(t *testing.T) {
	// "matches" instead of "match" would silently become a rule matching
	// everything, which is the most damaging typo this file can carry.
	err := func() error { _, err := loadRules(writeRules(t, `{"rules": [{"matches": "pick n pay"}]}`)); return err }()
	if err == nil {
		t.Fatal("expected an unknown field to be refused")
	}
}

func TestAnEmptyRulesFileIsRefused(t *testing.T) {
	if _, err := loadRules(writeRules(t, `{"rules": []}`)); err == nil {
		t.Fatal("expected an empty rules file to be refused")
	}
}

func TestRulesAreReadAsWritten(t *testing.T) {
	rules, err := loadRules(writeRules(t, `{"rules": [
	  {"match": "pick n pay", "note": "groceries"},
	  {"category": "Fuel"}
	]}`))
	if err != nil {
		t.Fatalf("loadRules: %v", err)
	}
	if len(rules) != 2 || rules[0].Match != "pick n pay" || rules[1].Category != "Fuel" {
		t.Fatalf("rules = %+v", rules)
	}
	if rules[0].String() != `"pick n pay"` || rules[1].String() != "Fuel" {
		t.Errorf("a rule does not describe itself for the report: %q, %q", rules[0], rules[1])
	}
}
