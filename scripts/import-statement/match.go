package main

// Matching invoices to payments.
//
// An invoice on its own claims nothing. It becomes a deduction only once it is
// tied to money that actually left the account — which is the row the statement
// scan already produced — because the ledger is what the claim is defended
// against, not the paperwork.
//
// A match therefore has to be EARNED, and the amount is what earns it: an
// invoice is only ever tied to a payment of its total, made within a few days of
// its date. Where that leaves more than one candidate, the supplier's name is
// compared against the statement's description to separate them. Anything still
// ambiguous is reported and left alone — a claim against the wrong payment is
// worse than no claim, since the wrong one is invisible once it is in the books.
//
// "Of its total" allows a little rounding, because payments are rounded in
// practice: an invoice for R195.99 is settled with R196.00, and the cent is not
// evidence of anything. --amount-tolerance sets how much rounding is allowed,
// and a payment that matches to the cent always outranks one that needed the
// tolerance. Every claim that used it says so in the listing, which is what
// keeps the allowance honest: a rounded match is never silent.

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

// Money is compared in whole cents. Rands are floats on the way in from both
// the statement and the readings, and two of them that print the same do not
// reliably subtract to zero.
func cents(v float64) int64 { return int64(math.Round(v * 100)) }

// Claim is one invoice tied to one payment: a business expense, ready to post.
type Claim struct {
	Invoice     Invoice
	Transaction Transaction
	DaysApart   int   // payment date minus invoice date, for the dry-run listing
	Rounding    int64 // cents the payment exceeded the invoice by, signed; 0 when exact

	// Set when this claim is the bank's charge for making the payment rather
	// than the payment itself: the description of the payment it was charged
	// on. Its Invoice is that payment's invoice, which is what the charge was
	// incurred for.
	FeeOn string
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
	index     int   // into the transactions slice, so a match is traceable back
	score     int   // distinctive words shared with the supplier's name
	daysApart int   // payment date minus invoice date
	rounding  int64 // cents the payment differs from the invoice total by, signed
}

// matchInvoices ties each invoice to the payment it belongs to. windowDays is
// how far either side of the invoice date a payment may fall, and tolerance is
// how much rounding is allowed between an invoice's total and what was paid.
//
// Both returned slices are in the order the invoices were read, so the dry-run
// listing follows the folder.
func matchInvoices(invoices []Invoice, txs []Transaction, windowDays int, tolerance float64) ([]Claim, []Unmatched) {
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
		cands, err := candidatesFor(inv, txs, windowDays, tolerance)
		if err != nil {
			unmatched = append(unmatched, Unmatched{Invoice: inv, Reason: err.Error()})
			continue
		}

		best := cands[0]
		if len(cands) > 1 {
			next := cands[1]
			if best.score == next.score && best.rounding == next.rounding && best.daysApart == next.daysApart {
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
			Rounding:    best.rounding,
		})
	}

	return claims, unmatched
}

// withFeeClaims adds, for every claimed payment, the bank's charge for making
// it.
//
// A charge has no invoice and never will, so nothing above can reach it: the
// statement line is the whole of the evidence. But it needs no invoice. The
// parser splits one statement line carrying both an amount and a Fee* into two
// transactions — the payment, and "<description> (fee)" — so the charge is the
// same line as the payment, and a charge for making a payment that is deductible
// is deductible on the same grounds. That is a stronger link than any invoice
// match: it is not inferred at all, it is how the row came to exist.
//
// The fee therefore follows its payment. It is never claimed on its own, so a
// charge on a private payment is not swept up by this.
func withFeeClaims(claims []Claim, txs []Transaction) []Claim {
	out := make([]Claim, 0, len(claims))
	for _, c := range claims {
		out = append(out, c)

		for _, tx := range txs {
			if tx.Amount >= 0 || tx.TransactionType != "fee" {
				continue
			}
			// Same line of the statement — same date and the verbatim line the
			// natural key is built on — and the description the parser derives
			// for the fee it split off.
			if tx.TransactionDate != c.Transaction.TransactionDate ||
				tx.RawReference != c.Transaction.RawReference ||
				tx.Description != c.Transaction.Description+" (fee)" {
				continue
			}
			out = append(out, Claim{
				Invoice:     c.Invoice,
				Transaction: tx,
				DaysApart:   c.DaysApart,
				FeeOn:       c.Transaction.Description,
			})
			break
		}
	}
	return out
}

// candidatesFor returns the payments an invoice could belong to, best first, or
// an error saying why there are none — an error a person has to act on, so it
// says what was nearly right rather than only that nothing was.
func candidatesFor(inv Invoice, txs []Transaction, windowDays int, tolerance float64) ([]candidate, error) {
	invoiceDate, err := time.Parse(isoLayout, inv.Date)
	if err != nil {
		return nil, fmt.Errorf("unreadable invoice date %q", inv.Date)
	}
	allowed := cents(tolerance)
	if allowed < 0 {
		allowed = 0
	}
	total := cents(inv.Total)

	var (
		cands      []candidate
		inWindow   int // debits inside the window, whatever the amount
		rightMoney int // debits of the right amount, wherever they fall
		nearest    *Transaction
		nearestBy  int64
	)
	for i, tx := range txs {
		// Money out only. A credit is a refund or income; the ledger's own
		// trigger rejects a claim against one.
		if tx.Amount >= 0 {
			continue
		}
		rounding := cents(-tx.Amount) - total
		if absCents(rounding) <= allowed {
			rightMoney++
		}

		paid, err := time.Parse(isoLayout, tx.TransactionDate)
		if err != nil {
			continue
		}
		days := int(math.Round(paid.Sub(invoiceDate).Hours() / 24))
		if days < -windowDays || days > windowDays {
			continue
		}
		inWindow++

		// The closest payment in the window, for the report when none is close
		// enough — the amount to check the document against.
		if nearest == nil || absCents(rounding) < absCents(nearestBy) {
			t := tx
			nearest, nearestBy = &t, rounding
		}

		if absCents(rounding) > allowed {
			continue
		}
		cands = append(cands, candidate{
			index:     i,
			score:     nameScore(inv.Supplier, tx.Description),
			daysApart: days,
			rounding:  rounding,
		})
	}

	if len(cands) == 0 {
		switch {
		case rightMoney > 0:
			return nil, fmt.Errorf("no payment of %.2f within %d days of %s (there are %d elsewhere in the statement)",
				inv.Total, windowDays, inv.Date, rightMoney)
		case nearest != nil:
			return nil, fmt.Errorf("no payment of %.2f within %d days of %s — the closest is %.2f on %s, %.2f away",
				inv.Total, windowDays, inv.Date, -nearest.Amount, nearest.TransactionDate, float64(absCents(nearestBy))/100)
		case inWindow == 0:
			return nil, fmt.Errorf("no money went out within %d days of %s", windowDays, inv.Date)
		default:
			return nil, fmt.Errorf("no payment of %.2f in this statement", inv.Total)
		}
	}

	// Best name match first; then the payment that agrees with the total most
	// exactly, so a payment to the cent always outranks one that needed the
	// tolerance; then the one closest to the invoice date, and a payment after
	// the invoice ahead of one the same distance before it, which is the
	// ordinary way round.
	sort.SliceStable(cands, func(a, b int) bool {
		x, y := cands[a], cands[b]
		if x.score != y.score {
			return x.score > y.score
		}
		if absCents(x.rounding) != absCents(y.rounding) {
			return absCents(x.rounding) < absCents(y.rounding)
		}
		if abs(x.daysApart) != abs(y.daysApart) {
			return abs(x.daysApart) < abs(y.daysApart)
		}
		return x.daysApart > y.daysApart
	})
	return cands, nil
}

func absCents(n int64) int64 {
	if n < 0 {
		return -n
	}
	return n
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
	// A bank charge carries none of the invoice's own detail — it was not
	// invoiced, and putting the supplier's number on it would say a document
	// covers it that does not. What it carries is what the charge was for.
	if c.FeeOn != "" {
		return claimPayload{
			Transaction: txRef{
				TransactionDate: c.Transaction.TransactionDate,
				Description:     c.Transaction.Description,
				Amount:          c.Transaction.Amount,
				RawReference:    c.Transaction.RawReference,
			},
			Purpose:     feePurpose(c.Invoice),
			ExpenseType: "bank charges",
			Note:        "bank charge on the payment claimed from " + c.Invoice.File,
		}
	}

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
		// produced with if the deduction is ever queried — and whatever the
		// reader had to qualify about it.
		Note: note(c.Invoice),
	}
}

// feePurpose says what the charge was incurred for, which is what makes it
// deductible — naming the payment, not the bank.
func feePurpose(inv Invoice) string {
	if inv.Supplier != "" {
		return "Bank charge on the payment to " + inv.Supplier
	}
	return "Bank charge on the payment for " + inv.Purpose
}

func note(inv Invoice) string {
	n := "invoice: " + inv.File
	if inv.Note != "" {
		n += "; " + inv.Note
	}
	return n
}
