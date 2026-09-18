package main

// Matching invoices to payments.
//
// An invoice on its own claims nothing. It becomes a deduction only once it is
// tied to money that actually left the account — which is the row the statement
// scan already produced — because the ledger is what the claim is defended
// against, not the paperwork.
//
// A match therefore has to be EARNED, and the amount is what earns it: an
// invoice is only ever tied to a payment of exactly its total, made within a
// few days of its date. Where that leaves more than one candidate, the
// supplier's name is compared against the statement's description to separate
// them. Anything still ambiguous is reported and left alone — a claim against
// the wrong payment is worse than no claim, since the wrong one is invisible
// once it is in the books.

import (
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
	"time"
)

// The layout the ledger's dates are written in — parse.go's isoDate() writes
// them, and this reads them back to measure the gap to an invoice.
const isoLayout = "2006-01-02"

var isoDateRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// Claim is one invoice tied to one payment: a business expense, ready to post.
type Claim struct {
	Invoice     Invoice
	Transaction Transaction
	DaysApart   int // payment date minus invoice date, for the dry-run listing
}

// Unmatched is an invoice that was not tied to a payment, and why not.
type Unmatched struct {
	Invoice Invoice
	Reason  string
}

// Words that carry no identity. The statement's own vocabulary ("Banking App
// External Payment:") appears on every row and would otherwise score as a match
// against any supplier; the company suffixes appear on every invoice.
var noiseWords = map[string]bool{
	"the": true, "and": true, "for": true, "pty": true, "ltd": true, "limited": true,
	"inc": true, "cc": true, "close": true, "corporation": true, "holdings": true,
	"group": true, "trading": true, "banking": true, "app": true, "external": true,
	"payment": true, "payments": true, "transfer": true, "received": true,
	"recurring": true, "immediate": true, "purchase": true, "card": true,
	"payshap": true, "cashback": true, "fee": true, "debit": true, "order": true,
}

var nonWord = regexp.MustCompile(`[^a-z0-9]+`)

// words reduces a name to its distinctive lowercase words.
func words(s string) []string {
	var out []string
	for _, w := range nonWord.Split(strings.ToLower(s), -1) {
		if len(w) < 3 || noiseWords[w] {
			continue
		}
		out = append(out, w)
	}
	return out
}

// nameScore counts the distinctive words a supplier and a statement description
// share. Zero means the description says nothing either way — common, since a
// card purchase prints the shop's trading name and the invoice its registered
// one — so it is used to rank candidates, never to reject one.
func nameScore(supplier, description string) int {
	if supplier == "" {
		return 0
	}
	inDescription := map[string]bool{}
	for _, w := range words(description) {
		inDescription[w] = true
	}
	seen := map[string]bool{}
	score := 0
	for _, w := range words(supplier) {
		if seen[w] {
			continue
		}
		seen[w] = true
		if inDescription[w] {
			score++
		}
	}
	return score
}

// candidate is one possible payment for an invoice, with what ranks it.
type candidate struct {
	index     int // into the transactions slice, so a match is traceable back
	score     int
	daysApart int
}

// matchInvoices ties each invoice to the payment it belongs to. windowDays is
// how far either side of the invoice date a payment may fall.
//
// Both returned slices are in the order the invoices were read, so the dry-run
// listing follows the folder.
func matchInvoices(invoices []Invoice, txs []Transaction, windowDays int) ([]Claim, []Unmatched) {
	var (
		claims    []Claim
		unmatched []Unmatched
	)

	// Which invoice has taken which payment. A payment can back only one claim —
	// business_expenses.transaction_id is UNIQUE — so two invoices landing on the
	// same row is a real conflict, not a tie to be broken.
	takenBy := map[int]int{}
	claimAt := map[int]int{} // transaction index → position in claims

	for i, inv := range invoices {
		cands, err := candidatesFor(inv, txs, windowDays)
		if err != nil {
			unmatched = append(unmatched, Unmatched{Invoice: inv, Reason: err.Error()})
			continue
		}

		best := cands[0]
		if len(cands) > 1 {
			next := cands[1]
			if best.score == next.score && best.daysApart == next.daysApart {
				unmatched = append(unmatched, Unmatched{
					Invoice: inv,
					Reason: fmt.Sprintf("%d payments of %.2f are equally good matches — claim it by hand",
						len(cands), inv.Total),
				})
				continue
			}
		}

		if earlier, taken := takenBy[best.index]; taken {
			// Withdraw the earlier claim as well: one payment cannot back both
			// invoices, and nothing here can say which of them it belongs to.
			pos := claimAt[best.index]
			claims = append(claims[:pos], claims[pos+1:]...)
			for idx, p := range claimAt {
				if p > pos {
					claimAt[idx] = p - 1
				}
			}
			delete(claimAt, best.index)
			delete(takenBy, best.index)

			conflict := func(other Invoice) string {
				return fmt.Sprintf("the payment it matches is also matched by %s — claim both by hand", other.File)
			}
			unmatched = append(unmatched,
				Unmatched{Invoice: invoices[earlier], Reason: conflict(inv)},
				Unmatched{Invoice: inv, Reason: conflict(invoices[earlier])},
			)
			continue
		}

		takenBy[best.index] = i
		claimAt[best.index] = len(claims)
		claims = append(claims, Claim{
			Invoice:     inv,
			Transaction: txs[best.index],
			DaysApart:   best.daysApart,
		})
	}

	return claims, unmatched
}

// candidatesFor returns the payments an invoice could belong to, best first, or
// an error saying why there are none.
func candidatesFor(inv Invoice, txs []Transaction, windowDays int) ([]candidate, error) {
	invoiceDate, err := time.Parse(isoLayout, inv.Date)
	if err != nil {
		return nil, fmt.Errorf("unreadable invoice date %q", inv.Date)
	}

	var (
		cands      []candidate
		sameAmount int // payments of the right amount but outside the window
	)
	for i, tx := range txs {
		// Money out only. A credit is a refund or income; the ledger's own
		// trigger rejects a claim against one.
		if tx.Amount >= 0 || round2(-tx.Amount) != round2(inv.Total) {
			continue
		}
		sameAmount++

		paid, err := time.Parse(isoLayout, tx.TransactionDate)
		if err != nil {
			continue
		}
		days := int(math.Round(paid.Sub(invoiceDate).Hours() / 24))
		if days < -windowDays || days > windowDays {
			continue
		}
		cands = append(cands, candidate{
			index:     i,
			score:     nameScore(inv.Supplier, tx.Description),
			daysApart: days,
		})
	}

	if len(cands) == 0 {
		if sameAmount > 0 {
			return nil, fmt.Errorf("no payment of %.2f within %d days of %s (there are %d elsewhere in the statement)",
				inv.Total, windowDays, inv.Date, sameAmount)
		}
		return nil, fmt.Errorf("no payment of %.2f in this statement", inv.Total)
	}

	// Best name match first; then the payment closest to the invoice date, and a
	// payment after the invoice ahead of one the same distance before it, which
	// is the ordinary way round.
	sort.SliceStable(cands, func(a, b int) bool {
		x, y := cands[a], cands[b]
		if x.score != y.score {
			return x.score > y.score
		}
		if abs(x.daysApart) != abs(y.daysApart) {
			return abs(x.daysApart) < abs(y.daysApart)
		}
		return x.daysApart > y.daysApart
	})
	return cands, nil
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

// ---------------------------------------------------------------------------
// The wire shape.
// ---------------------------------------------------------------------------

// txRef identifies the payment a claim is made against, by the same natural key
// the transaction itself is keyed on (db/003_transactions.sql). The importer
// holds no database key and never learns the row's id — the edge function looks
// it up, which also means a claim resolves against a payment that was already on
// record from an earlier, overlapping statement.
type txRef struct {
	TransactionDate string  `json:"transaction_date"`
	Description     string  `json:"description"`
	Amount          float64 `json:"amount"`
	RawReference    string  `json:"raw_reference"`
}

// claimPayload is one row of `business_expenses`, as the import endpoint expects
// it. `deductible_amount` is deliberately absent: a claim is only made against a
// payment of exactly the invoice's total, so the whole payment is claimed, which
// is what the column means when it is NULL.
type claimPayload struct {
	Transaction   txRef  `json:"transaction"`
	Purpose       string `json:"purpose"`
	Supplier      string `json:"supplier,omitempty"`
	ExpenseType   string `json:"expense_type,omitempty"`
	InvoiceNumber string `json:"invoice_number,omitempty"`
	InvoiceDate   string `json:"invoice_date,omitempty"`
	Note          string `json:"note,omitempty"`
}

func (c Claim) payload() claimPayload {
	return claimPayload{
		Transaction: txRef{
			TransactionDate: c.Transaction.TransactionDate,
			Description:     c.Transaction.Description,
			Amount:          c.Transaction.Amount,
			RawReference:    c.Transaction.RawReference,
		},
		Purpose:       c.Invoice.Purpose,
		Supplier:      c.Invoice.Supplier,
		ExpenseType:   c.Invoice.Type,
		InvoiceNumber: c.Invoice.Number,
		InvoiceDate:   c.Invoice.Date,
		// Which file the claim was read from — the paperwork it has to be
		// produced with if the deduction is ever queried.
		Note: "invoice: " + c.Invoice.File,
	}
}
