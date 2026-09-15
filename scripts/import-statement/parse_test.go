package main

import "testing"

// Column anchors as the real statements place them. The header row is built from
// these too, so a test exercises the same anchor discovery the parser uses.
const (
	xDate    = 35.1
	xDesc    = 84.6
	xCat     = 298.6
	xIn      = 388.0
	xOut     = 433.1
	xFee     = 500.7
	xBalance = 529.5
)

func header() line {
	return line{y: 580, cells: []cell{
		{xDate, "Date"}, {xDesc, "Description"}, {xCat, "Category"},
		{xIn, "Money In"}, {xOut, "Money Out"}, {xFee, "Fee*"}, {xBalance, "Balance"},
	}}
}

// Amounts are right-aligned in their columns, so a wider number starts further
// left. The tests place them where the real statements do.
func row(cells ...cell) line { return line{y: 500, cells: cells} }

func parse(t *testing.T, ls ...line) ([]Transaction, []string) {
	t.Helper()
	return ParseStatement([][]line{append([]line{header()}, ls...)})
}

func TestMoneyInAndMoneyOutAreToldApartByColumn(t *testing.T) {
	// Both are plain signed amounts; only the column says which is which.
	txs, warns := parse(t,
		row(cell{34.4, "09/08/2026"}, cell{83.8, "Corner Shop Smalltown"}, cell{297.8, "Groceries"},
			cell{451.0, "-49.00"}, cell{539.4, "-49.00"}),
		row(cell{34.4, "10/08/2026"}, cell{83.8, "Payment Received: Example Client"}, cell{297.8, "Other Income"},
			cell{397.4, "600.00"}, cell{535.0, "551.00"}),
	)
	if len(warns) != 0 {
		t.Fatalf("unexpected warnings: %v", warns)
	}
	if len(txs) != 2 {
		t.Fatalf("got %d transactions, want 2", len(txs))
	}
	if txs[0].Amount != -49 || txs[0].TransactionType != "debit" {
		t.Errorf("money out: got %+v", txs[0])
	}
	if txs[1].Amount != 600 || txs[1].TransactionType != "credit" {
		t.Errorf("money in: got %+v", txs[1])
	}
}

func TestFeeColumnBecomesItsOwnTransaction(t *testing.T) {
	// The schema has a single amount, so the Fee* column is split into a second
	// row — that is what keeps the amounts summing back to the balance.
	txs, warns := parse(t,
		row(cell{34.4, "02/09/2026"}, cell{83.8, "Banking App External Payment"}, cell{297.8, "Uncategorised"},
			cell{446.6, "-800.00"}, cell{498.6, "-2.00"}, cell{528.3, "-802.00"}),
	)
	if len(warns) != 0 {
		t.Fatalf("unexpected warnings: %v", warns)
	}
	if len(txs) != 2 {
		t.Fatalf("got %d transactions, want 2", len(txs))
	}
	if txs[0].Amount != -800 || txs[0].TransactionType != "debit" {
		t.Errorf("main leg: got %+v", txs[0])
	}
	if txs[1].Amount != -2 || txs[1].TransactionType != "fee" || txs[1].Category != "Fees" {
		t.Errorf("fee leg: got %+v", txs[1])
	}
	if txs[0].RawReference != txs[1].RawReference {
		t.Error("both legs should carry the same statement line")
	}
	if want := "Banking App External Payment (fee)"; txs[1].Description != want {
		t.Errorf("fee description = %q, want %q", txs[1].Description, want)
	}
}

func TestFeeOnlyRowIsOneFeeTransaction(t *testing.T) {
	// A card-issue fee posts into the Fee* column with no Money In / Money Out,
	// so it is a single transaction, typed as a fee rather than a debit.
	txs, warns := parse(t,
		row(cell{34.4, "03/08/2026"}, cell{83.8, "Entrepreneur Card Issue Fee"}, cell{297.8, "Fees"},
			cell{494.2, "-70.00"}, cell{536.8, "-70.00"}),
	)
	if len(warns) != 0 {
		t.Fatalf("unexpected warnings: %v", warns)
	}
	if len(txs) != 1 {
		t.Fatalf("got %d transactions, want 1", len(txs))
	}
	if txs[0].Amount != -70 || txs[0].TransactionType != "fee" {
		t.Errorf("got %+v", txs[0])
	}
}

func TestWrappedDescriptionAndCategoryAreRejoined(t *testing.T) {
	// A continuation line carries the x of the column it continues, which is how
	// the reference number lands on the description and "Received" on the
	// category instead of either being read as a new row.
	txs, warns := parse(t,
		row(cell{34.4, "11/09/2026"}, cell{83.8, "Payment Received: 000000 Rtc Acme"},
			cell{297.8, "Account Payment "}, cell{390.8, "1 500.00"}, cell{528.3, "1 500.00"}),
		row(cell{297.8, "Received"}),
		row(cell{83.8, "1234567890"}),
	)
	if len(warns) != 0 {
		t.Fatalf("unexpected warnings: %v", warns)
	}
	if len(txs) != 1 {
		t.Fatalf("got %d transactions, want 1", len(txs))
	}
	if want := "Payment Received: 000000 Rtc Acme 1234567890"; txs[0].Description != want {
		t.Errorf("description = %q, want %q", txs[0].Description, want)
	}
	if want := "Account Payment Received"; txs[0].Category != want {
		t.Errorf("category = %q, want %q", txs[0].Category, want)
	}
	if txs[0].Amount != 1500 {
		t.Errorf("amount = %v, want 1500", txs[0].Amount)
	}
}

func TestThousandsSeparatorAndRightmostIsAlwaysTheBalance(t *testing.T) {
	// A balance wide enough to start under the Fee column is still the balance:
	// the rightmost number always is, whatever its width.
	txs, warns := parse(t,
		row(cell{34.4, "01/09/2026"}, cell{83.8, "Big Payment"}, cell{297.8, "Other Income"},
			cell{384.0, "100 000.00"}, cell{504.0, "1 234 567.89"}),
	)
	if len(warns) != 0 {
		t.Fatalf("unexpected warnings: %v", warns)
	}
	if len(txs) != 1 {
		t.Fatalf("got %d transactions, want 1", len(txs))
	}
	if txs[0].Amount != 100000 {
		t.Errorf("amount = %v, want 100000", txs[0].Amount)
	}
}

func TestBalanceThatDoesNotReconcileIsWarnedAbout(t *testing.T) {
	// The chain is the proof that the columns were read correctly, so a break in
	// it must surface rather than import a wrong number silently.
	_, warns := parse(t,
		row(cell{34.4, "01/09/2026"}, cell{83.8, "First"}, cell{297.8, "Groceries"},
			cell{451.0, "-10.00"}, cell{539.4, "90.00"}),
		row(cell{34.4, "02/09/2026"}, cell{83.8, "Second"}, cell{297.8, "Groceries"},
			cell{451.0, "-10.00"}, cell{539.4, "50.00"}), // should be 80.00
	)
	if len(warns) != 1 {
		t.Fatalf("got %d warnings, want 1: %v", len(warns), warns)
	}
}

func TestPendingTransactionsAndVATFootnoteCloseTheTable(t *testing.T) {
	// Pending card transactions have not posted to the balance and arrive as
	// real rows on a later statement, so they must not be imported.
	txs, warns := parse(t,
		row(cell{34.4, "13/09/2026"}, cell{83.8, "Filling Station Anytown"}, cell{297.8, "Fuel"},
			cell{451.0, "-100.00"}, cell{539.4, "-100.00"}),
		row(cell{479.5, "* Includes VAT at 15%"}),
		row(cell{40.4, "Pending Card Transactions"}),
		row(cell{34.4, "14/09/2026"}, cell{83.8, "Supermarket Anytown"}, cell{297.8, "Groceries"},
			cell{451.0, "-277.58"}, cell{539.4, "-377.58"}),
	)
	if len(warns) != 0 {
		t.Fatalf("unexpected warnings: %v", warns)
	}
	if len(txs) != 1 {
		t.Fatalf("got %d transactions, want 1 (pending must be skipped)", len(txs))
	}
}

func TestRawReferenceRebuildsTheStatementLine(t *testing.T) {
	// raw_reference is part of the natural key and carries the running balance,
	// which is what separates two otherwise identical purchases.
	txs, _ := parse(t,
		row(cell{34.4, "26/08/2026"}, cell{83.8, "Hardware Store Anytown (Card 1234)"}, cell{297.8, "Home Maintenance"},
			cell{451.0, "-53.03"}, cell{539.4, "96.42"}),
	)
	want := "26/08/2026 Hardware Store Anytown (Card 1234) Home Maintenance -53.03 96.42"
	if txs[0].RawReference != want {
		t.Errorf("raw_reference =\n  %q\nwant\n  %q", txs[0].RawReference, want)
	}
}

func TestIsoDate(t *testing.T) {
	if got := isoDate("03/08/2026"); got != "2026-08-03" {
		t.Errorf("isoDate = %q, want 2026-08-03", got)
	}
	if got := isoDate("not a date"); got != "" {
		t.Errorf("isoDate(non-date) = %q, want empty", got)
	}
}

func TestParseAmountRejectsReferenceNumbers(t *testing.T) {
	// Requiring the two decimals is what keeps payment references and card
	// digits inside a description from being read as amounts.
	for _, s := range []string{"1234567890", "1234", "Card 1234", "", "12.3"} {
		if _, ok := parseAmount(s); ok {
			t.Errorf("parseAmount(%q) should not parse", s)
		}
	}
	for _, tc := range []struct {
		in   string
		want float64
	}{{"-70.00", -70}, {"1 537.96", 1537.96}, {"0.00", 0}, {"1 234 567.89", 1234567.89}} {
		got, ok := parseAmount(tc.in)
		if !ok || got != tc.want {
			t.Errorf("parseAmount(%q) = %v, %v; want %v", tc.in, got, ok, tc.want)
		}
	}
}
