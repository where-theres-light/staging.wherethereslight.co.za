package main

// Capitec statement parsing.
//
// The Transaction History table is read by COLUMN POSITION, not by splitting
// text. The PDF gives every fragment an x coordinate, and the table's header row
//
//   Date  Description  Category  Money In  Money Out  Fee*  Balance
//
// supplies an anchor for each column, so each fragment is assigned to whichever
// column it sits under. That matters because the columns cannot be told apart
// from the text alone: Money In and Money Out are both plain signed amounts, and
// a row may carry any combination of amount, fee and balance. Reading positions
// removes the guesswork — and it is why a long description that wraps onto its
// own line is appended to the description rather than mistaken for a new row:
// the wrapped fragment carries the description column's x.
//
// Anchors are taken from the header on every page rather than hard-coded, so a
// layout shift moves the anchors with it.

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// A single positioned fragment of text from the PDF.
type cell struct {
	x float64
	s string
}

// One line of the PDF, as fragments in left-to-right order.
type line struct {
	y     float64
	cells []cell
}

// x anchors for the table's seven columns, read off the header row.
type columns struct {
	date, desc, category, moneyIn, moneyOut, fee, balance float64
}

// Everything left of this is text (date / description / category); everything
// right of it is a number. The midpoint between the last text column and the
// first numeric one, so it moves with the layout.
func (c columns) numericZone() float64 { return (c.category + c.moneyIn) / 2 }

// A transaction as read off the statement, before it is split into the rows that
// get imported. The *String fields keep the amounts exactly as printed, so
// rawReference can reproduce the statement line verbatim.
type record struct {
	date, description, category string

	moneyIn, moneyOut, fee, balance            float64
	hasIn, hasOut, hasFee, hasBalance          bool
	inString, outString, feeString, balanceStr string
}

// The statement line this record came from, rebuilt in column order. This is
// what lands in raw_reference, and it carries the running balance — which is
// what makes the natural key unique (see db/003_transactions.sql).
func (r record) rawReference() string {
	parts := []string{r.date, r.description, r.category}
	for _, s := range []string{r.inString, r.outString, r.feeString, r.balanceStr} {
		if s != "" {
			parts = append(parts, s)
		}
	}
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return strings.Join(out, " ")
}

// Transaction is one row as the import endpoint expects it.
type Transaction struct {
	TransactionDate string  `json:"transaction_date"`
	Description     string  `json:"description"`
	Amount          float64 `json:"amount"`
	TransactionType string  `json:"transaction_type"`
	Category        string  `json:"category,omitempty"`
	RawReference    string  `json:"raw_reference"`
}

var (
	dateRe = regexp.MustCompile(`^(\d{2})/(\d{2})/(\d{4})$`)
	// An amount as the statement prints it: space-grouped thousands, always two
	// decimals, minus for money out. Requiring the decimals is what keeps
	// reference numbers and card digits from being read as amounts.
	amountRe = regexp.MustCompile(`^-?\d{1,3}(?:[ \x{00a0}\x{202f}]\d{3})*\.\d{2}$`)
)

func squash(s string) string {
	s = strings.NewReplacer(" ", " ", " ", " ").Replace(s)
	return strings.Join(strings.Fields(s), " ")
}

func parseAmount(s string) (float64, bool) {
	t := squash(s)
	if !amountRe.MatchString(t) {
		return 0, false
	}
	v, err := strconv.ParseFloat(strings.ReplaceAll(t, " ", ""), 64)
	return v, err == nil
}

// The header row that opens the table, and the markers that close it. Pending
// card transactions are deliberately excluded: they have not been posted to the
// balance yet, and they arrive as real rows on a later statement.
func isHeader(text string) bool {
	return strings.Contains(text, "Date") && strings.Contains(text, "Description") &&
		strings.Contains(text, "Money In") && strings.Contains(text, "Balance")
}

func endsTable(text string) bool {
	t := strings.TrimSpace(text)
	return strings.HasPrefix(t, "* Includes VAT") || strings.HasPrefix(t, "Pending Card Transactions")
}

// Read the seven column anchors off a header row.
func anchorsFrom(l line) (columns, bool) {
	var c columns
	seen := 0
	for _, cl := range l.cells {
		switch squash(cl.s) {
		case "Date":
			c.date, seen = cl.x, seen|1
		case "Description":
			c.desc, seen = cl.x, seen|2
		case "Category":
			c.category, seen = cl.x, seen|4
		case "Money In":
			c.moneyIn, seen = cl.x, seen|8
		case "Money Out":
			c.moneyOut, seen = cl.x, seen|16
		case "Fee*", "Fee":
			c.fee, seen = cl.x, seen|32
		case "Balance":
			c.balance, seen = cl.x, seen|64
		}
	}
	return c, seen == 127
}

// Which of the given anchors a fragment sits under.
func nearest(x float64, anchors ...float64) int {
	best, bestD := 0, -1.0
	for i, a := range anchors {
		d := x - a
		if d < 0 {
			d = -d
		}
		if bestD < 0 || d < bestD {
			best, bestD = i, d
		}
	}
	return best
}

// Fold one line into the record being built. Text fragments are appended to
// their column's field, so a wrapped description or category accumulates.
func (r *record) addLine(l line, c columns) {
	// Collect the numeric fragments first: the rightmost is always the balance,
	// whatever its width. Balances can grow wide enough to start under the Fee
	// column, and taking the rightmost removes that ambiguity entirely.
	type num struct {
		x float64
		s string
		v float64
	}
	var nums []num

	for _, cl := range l.cells {
		text := squash(cl.s)
		if text == "" {
			continue
		}
		if cl.x >= c.numericZone() {
			if v, ok := parseAmount(text); ok {
				nums = append(nums, num{cl.x, text, v})
				continue
			}
		}
		switch nearest(cl.x, c.date, c.desc, c.category) {
		case 0:
			if dateRe.MatchString(text) && r.date == "" {
				r.date = text
			}
		case 1:
			r.description = strings.TrimSpace(r.description + " " + text)
		case 2:
			r.category = strings.TrimSpace(r.category + " " + text)
		}
	}

	if len(nums) == 0 {
		return
	}
	last := len(nums) - 1
	r.balance, r.balanceStr, r.hasBalance = nums[last].v, nums[last].s, true

	for _, n := range nums[:last] {
		switch nearest(n.x, c.moneyIn, c.moneyOut, c.fee) {
		case 0:
			r.moneyIn, r.inString, r.hasIn = n.v, n.s, true
		case 1:
			r.moneyOut, r.outString, r.hasOut = n.v, n.s, true
		default:
			r.fee, r.feeString, r.hasFee = n.v, n.s, true
		}
	}
}

// Turn a finished record into the transactions to import. A row carrying a fee
// alongside its amount yields TWO transactions: the schema has a single amount,
// and the Fee* column is a real separate debit, so splitting it is what keeps
// the amounts summing back to the closing balance. A row that is only a fee (a
// card-issue fee, say) is one transaction, typed as a fee.
func (r record) transactions() []Transaction {
	raw := r.rawReference()
	iso := isoDate(r.date)
	if iso == "" || r.description == "" {
		return nil
	}

	var out []Transaction
	amount, has := 0.0, false
	switch {
	case r.hasIn:
		amount, has = r.moneyIn, true
	case r.hasOut:
		amount, has = r.moneyOut, true
	}

	if has {
		out = append(out, Transaction{iso, r.description, amount, typeOf(amount), r.category, raw})
		if r.hasFee {
			out = append(out, Transaction{iso, r.description + " (fee)", r.fee, "fee", "Fees", raw})
		}
		return out
	}
	if r.hasFee {
		return []Transaction{{iso, r.description, r.fee, "fee", r.category, raw}}
	}
	return nil
}

func typeOf(amount float64) string {
	if amount < 0 {
		return "debit"
	}
	return "credit"
}

func isoDate(ddmmyyyy string) string {
	m := dateRe.FindStringSubmatch(ddmmyyyy)
	if m == nil {
		return ""
	}
	return fmt.Sprintf("%s-%s-%s", m[3], m[2], m[1])
}

// The net movement this record should produce, for the balance check.
func (r record) moved() float64 {
	var t float64
	if r.hasIn {
		t += r.moneyIn
	}
	if r.hasOut {
		t += r.moneyOut
	}
	if r.hasFee {
		t += r.fee
	}
	return t
}

// ParseStatement reads the Transaction History out of a statement's pages.
//
// It also reconciles every row against the printed running balance: a row's
// movement must be exactly the step from the previous balance to this one. That
// both catches a misread and confirms the columns were assigned correctly, so a
// layout change surfaces as a warning instead of a wrong number.
func ParseStatement(pages [][]line) (txs []Transaction, warnings []string) {
	var (
		cols     columns
		inTable  bool
		cur      *record
		prevBal  float64
		havePrev bool
	)

	flush := func() {
		if cur == nil {
			return
		}
		r := *cur
		cur = nil
		got := r.transactions()
		if len(got) == 0 {
			warnings = append(warnings, "could not read row: "+r.rawReference())
			return
		}
		if r.hasBalance {
			if havePrev {
				want := round2(prevBal + r.moved())
				if want != round2(r.balance) {
					warnings = append(warnings, fmt.Sprintf(
						"balance does not reconcile (expected %.2f, statement says %.2f): %s",
						want, r.balance, r.rawReference()))
				}
			}
			prevBal, havePrev = r.balance, true
		}
		txs = append(txs, got...)
	}

	for _, page := range pages {
		for _, l := range page {
			var sb strings.Builder
			for _, cl := range l.cells {
				sb.WriteString(cl.s)
				sb.WriteString(" ")
			}
			text := squash(sb.String())
			if text == "" {
				continue
			}

			if isHeader(text) {
				if c, ok := anchorsFrom(l); ok {
					flush()
					cols, inTable = c, true
				}
				continue
			}
			if !inTable {
				continue
			}
			if endsTable(text) {
				flush()
				inTable = false
				continue
			}

			// A fragment in the date column starts a new row; anything else
			// continues the one being built.
			starts := false
			for _, cl := range l.cells {
				if nearest(cl.x, cols.date, cols.desc, cols.category) == 0 && dateRe.MatchString(squash(cl.s)) {
					starts = true
					break
				}
			}
			if starts {
				flush()
				cur = &record{}
			}
			if cur == nil {
				continue // stray line between the header and the first row
			}
			cur.addLine(l, cols)
		}
	}
	flush()
	return txs, warnings
}

func round2(v float64) float64 {
	return float64(int64(v*100+copysign(0.5, v))) / 100
}

func copysign(v, sign float64) float64 {
	if sign < 0 {
		return -v
	}
	return v
}
