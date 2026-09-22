// import-statement parses a Capitec statement PDF and imports its transactions,
// optionally claiming the supplier invoices that go with them.
//
//	cd scripts/import-statement
//	go run . --dry-run statement.pdf
//	go run . statement.pdf
//
//	# Invoices, in two steps with a reader in between (see invoice.go):
//	go run . --invoices ../../data/invoices --prepare sheet.json statement.pdf
//	go run . --invoices ../../data/invoices --readings read.json statement.pdf
//
// Reads the PDF locally, extracts the Transaction History table, and POSTs the
// parsed rows to the import-transactions edge function, which writes them as
// service role (the table is not writable with the publishable key). Nothing is
// written to disk and no Supabase key is needed here — only IMPORT_TOKEN, which
// can do exactly one thing: append statement rows.
//
// Statements overlap and get re-downloaded, so the import is idempotent: the
// function upserts ON CONFLICT DO NOTHING against the natural key and reports
// how many rows were new. Running the same statement twice inserts nothing.
//
// With --invoices, the folder's invoices are prepared for reading and then, once
// read, tied to the payments this statement parsed (match.go) and posted
// alongside them as `business_expenses` claims. Claiming is part of this command
// rather than its own because the match needs both halves: an invoice is only
// ever claimed against a payment of exactly its total, and the payments are what
// this program has just read off the statement.
//
// Environment:
//
//	IMPORT_TOKEN        required (unless --dry-run) — the edge function's secret
//	SUPABASE_URL        optional — defaults to the project in ui/shared.js
//	STATEMENT_PASSWORD  optional — the PDF password, if the statement is
//	                    encrypted. Capitec uses the last four digits of the
//	                    registered mobile number. It is read from the
//	                    environment and never taken as an argument, so it stays
//	                    out of shell history.
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/ledongthuc/pdf"
)

// The project the site talks to (ui/shared.js). Public, so it is fine here.
const defaultSupabaseURL = "https://ihwtedrjfusvpmkmrgxa.supabase.co"

// Rows per request. The function accepts up to 500; a monthly statement is well
// under one batch, so this only matters for a long back-fill.
const batchSize = 200

func main() {
	if err := run(); err != nil {
		// No stack trace: for a password failure it would put the statement's
		// path next to the reason in the terminal scrollback.
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run() error {
	var (
		dryRun      = flag.Bool("dry-run", false, "parse and reconcile only; print the rows, write nothing")
		source      = flag.String("source", "", "override the source_statement label (default: the filename)")
		passwordEnv = flag.String("password-env", "STATEMENT_PASSWORD", "environment variable holding the PDF password")
		invoiceDir  = flag.String("invoices", "", "folder of supplier invoices to prepare or claim")
		prepare     = flag.String("prepare", "", "with --invoices: write the worksheet here for reading, and stop")
		readings    = flag.String("readings", "", "with --invoices: the filled-in worksheet readings to claim from")
		window      = flag.Int("match-window", defaultMatchWindow, "days either side of an invoice's date a payment may fall")
		tolerance   = flag.Float64("amount-tolerance", defaultTolerance, "rands a payment may differ from an invoice's total by, for rounding")
		claimFees   = flag.Bool("claim-fees", true, "also claim the bank's charge for making a claimed payment")
	)
	flag.Usage = func() {
		fmt.Fprintln(os.Stderr, "usage: import-statement [flags] <statement.pdf>")
		flag.PrintDefaults()
	}
	flag.Parse()

	if flag.NArg() != 1 {
		flag.Usage()
		return errors.New("exactly one statement PDF is required")
	}
	switch {
	case *prepare != "" && *readings != "":
		return errors.New("--prepare writes the worksheet and --readings claims from it; do one at a time")
	case *invoiceDir == "" && (*prepare != "" || *readings != ""):
		return errors.New("--prepare and --readings need --invoices, the folder they are about")
	case *invoiceDir != "" && *prepare == "" && *readings == "":
		return errors.New("--invoices needs either --prepare (to write the worksheet) or --readings (to claim from it)")
	}
	path := flag.Arg(0)
	sourceName := *source
	if sourceName == "" {
		sourceName = filepath.Base(path)
	}

	pages, err := readPages(path, os.Getenv(*passwordEnv))
	if err != nil {
		return err
	}

	txs, warnings := ParseStatement(pages)
	for _, w := range warnings {
		fmt.Fprintln(os.Stderr, "warning:", w)
	}
	if len(txs) == 0 {
		return errors.New("no transactions found — is this a Capitec statement?")
	}

	var in, net float64
	for _, t := range txs {
		net += t.Amount
		if t.Amount > 0 {
			in += t.Amount
		}
	}
	fmt.Printf("Parsed %d transactions from %s\n", len(txs), sourceName)
	fmt.Printf("  %s → %s\n", txs[0].TransactionDate, txs[len(txs)-1].TransactionDate)
	fmt.Printf("  money in  %.2f\n", in)
	fmt.Printf("  money out %.2f\n", in-net)
	fmt.Printf("  net       %.2f\n", net)

	// Preparing the worksheet writes nothing to the ledger, so it ends here. The
	// payments go into it for context, which is why it waits for the parse.
	if *prepare != "" {
		return prepareWorksheet(*prepare, *invoiceDir, sourceName, txs)
	}

	// Claims are matched against the payments above, so this has to follow the
	// parse — and it runs before anything is written, so --dry-run shows exactly
	// what an import would claim.
	var claims []Claim
	if *readings != "" {
		var err error
		if claims, err = claimInvoices(*readings, *invoiceDir, *window, *tolerance, *claimFees, txs); err != nil {
			return err
		}
	}

	if *dryRun {
		fmt.Print("\n--dry-run: nothing written\n\n")
		for _, t := range txs {
			cat := t.Category
			if cat == "" {
				cat = "-"
			}
			fmt.Printf("%s  %10.2f  %-22s  %s\n", t.TransactionDate, t.Amount, cat, t.Description)
		}
		return nil
	}

	token := os.Getenv("IMPORT_TOKEN")
	if token == "" {
		return errors.New("IMPORT_TOKEN is not set")
	}
	baseURL := os.Getenv("SUPABASE_URL")
	if baseURL == "" {
		baseURL = defaultSupabaseURL
	}
	baseURL = strings.TrimRight(baseURL, "/")

	var res *importResponse
	var inserted, skipped int
	for start := 0; start < len(txs); start += batchSize {
		end := min(start+batchSize, len(txs))

		// The claims go with the last batch, whichever batch their own payment
		// was in: by then every row of this statement is on record, and the
		// function resolves each claim against the ledger by natural key.
		var batchClaims []Claim
		if end == len(txs) {
			batchClaims = claims
		}

		var err error
		if res, err = postBatch(baseURL, token, sourceName, txs[start:end], batchClaims); err != nil {
			return err
		}
		inserted += res.Inserted
		skipped += res.Skipped
	}

	fmt.Printf("\nImported into %s\n", baseURL)
	fmt.Printf("  inserted %d\n", inserted)
	fmt.Printf("  skipped  %d (already on record)\n", skipped)
	if len(claims) > 0 {
		fmt.Printf("  claimed  %d business expense(s), %d already claimed\n", res.Claimed, res.ClaimsSkipped)
		// A deployment predating business_expenses support ignores the claims
		// and answers about the rows alone. Say so, rather than letting a run
		// that filed nothing read like one that had nothing to file.
		if res.Claimed+res.ClaimsSkipped == 0 {
			fmt.Fprintf(os.Stderr,
				"warning: the deployed import-transactions recorded none of the %d claim(s) — redeploy it\n",
				len(claims))
		}
	}
	return nil
}

// readPages opens the statement — decrypting it when a password is given — and
// returns each page as positioned lines.
func readPages(path, password string) ([][]line, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	st, err := f.Stat()
	if err != nil {
		return nil, err
	}

	// The reader asks for the password repeatedly until it is given an empty
	// string, so hand it over exactly once — returning it forever would spin.
	asked := 0
	r, err := pdf.NewReaderEncrypted(f, st.Size(), func() string {
		asked++
		if asked > 1 {
			return ""
		}
		return password
	})
	if err != nil {
		// Report the situation, never the password itself.
		if strings.Contains(strings.ToLower(err.Error()), "password") {
			if password == "" {
				return nil, errors.New("the statement is password-protected — set STATEMENT_PASSWORD")
			}
			return nil, errors.New("the statement password was not accepted")
		}
		return nil, err
	}

	var pages [][]line
	for i := 1; i <= r.NumPage(); i++ {
		p := r.Page(i)
		if p.V.IsNull() {
			continue
		}
		rows, err := p.GetTextByRow()
		if err != nil {
			return nil, fmt.Errorf("page %d: %w", i, err)
		}
		var ls []line
		for _, row := range rows {
			l := line{y: float64(row.Position)}
			for _, w := range row.Content {
				l.cells = append(l.cells, cell{x: w.X, s: w.S})
			}
			ls = append(ls, l)
		}
		pages = append(pages, ls)
	}
	return pages, nil
}

type importRequest struct {
	SourceStatement string         `json:"source_statement"`
	Transactions    []Transaction  `json:"transactions"`
	Claims          []claimPayload `json:"business_expenses,omitempty"`
}

type importResponse struct {
	OK            bool   `json:"ok"`
	Received      int    `json:"received"`
	Inserted      int    `json:"inserted"`
	Skipped       int    `json:"skipped"`
	Claimed       int    `json:"claimed"`
	ClaimsSkipped int    `json:"claims_skipped"`
	Error         string `json:"error"`
}

func postBatch(baseURL, token, source string, txs []Transaction, claims []Claim) (*importResponse, error) {
	payloads := make([]claimPayload, 0, len(claims))
	for _, c := range claims {
		payloads = append(payloads, c.payload())
	}

	body, err := json.Marshal(importRequest{
		SourceStatement: source,
		Transactions:    txs,
		Claims:          payloads,
	})
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequest(http.MethodPost, baseURL+"/functions/v1/import-transactions", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)

	res, err := (&http.Client{Timeout: 60 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()

	var parsed importResponse
	if err := json.NewDecoder(res.Body).Decode(&parsed); err != nil && res.StatusCode == http.StatusOK {
		return nil, fmt.Errorf("could not read the import response: %w", err)
	}
	if res.StatusCode != http.StatusOK {
		if parsed.Error != "" {
			return nil, errors.New(parsed.Error)
		}
		return nil, fmt.Errorf("import failed (HTTP %d)", res.StatusCode)
	}
	return &parsed, nil
}

// defaultMatchWindow is how far either side of an invoice's date its payment may
// fall: wide enough for an invoice settled on terms, narrow enough that two
// unrelated payments of the same amount rarely both land inside it.
const defaultMatchWindow = 14

// defaultTolerance is how much rounding is allowed between an invoice's total
// and what was paid. A rand covers what actually happens — an invoice for
// R195.99 settled with R196.00, a cash sale rounded to the nearest 5c — and is
// small enough that it rarely reaches a second payment. A match to the cent
// always wins over one that used it, and any claim that did is printed as such.
const defaultTolerance = 1.00

// claimInvoices takes the filled-in readings and ties each invoice to one of this
// statement's payments. Only what earned a match comes back; everything else is
// reported and left for the owner, because a claim against the wrong payment is
// worse than no claim — it is invisible once it is in the books.
//
// The matching happens here, in Go, from the amounts and dates alone. Whoever
// read the invoices does not get a say in it: they write down what a document
// says, and the ledger decides whether a payment agrees.
func claimInvoices(readings, dir string, window int, tolerance float64, claimFees bool, txs []Transaction) ([]Claim, error) {
	invoices, warnings, err := loadReadings(readings, dir)
	if err != nil {
		return nil, err
	}
	for _, w := range warnings {
		fmt.Fprintln(os.Stderr, "warning:", w)
	}

	claims, unmatched := matchInvoices(invoices, txs, window, tolerance)
	matched := len(claims)
	if claimFees {
		claims = withFeeClaims(claims, txs)
	}

	fmt.Printf("\nRead %d invoice(s) from %s, matched %d\n", len(invoices), dir, matched)
	for _, c := range claims {
		tx := c.Transaction
		// A fee is printed under the payment it was charged on, which is the
		// line above it — it is that payment's charge, not a claim of its own.
		if c.FeeOn != "" {
			fmt.Printf("    + %s %10.2f  %s\n", tx.TransactionDate, tx.Amount, tx.Description)
			continue
		}
		inv := c.Invoice
		fmt.Printf("  %-28s %10.2f  %s — %s\n", inv.File, inv.Total, supplierOr(inv), inv.Purpose)
		fmt.Printf("    → %s %10.2f  %s (%s%s)\n", tx.TransactionDate, tx.Amount, tx.Description,
			apart(c.DaysApart), rounded(c.Rounding))
	}
	for _, u := range unmatched {
		fmt.Fprintf(os.Stderr, "unclaimed: %s — %s\n", u.Invoice.File, u.Reason)
	}
	return claims, nil
}

// rounded names the gap between the invoice's total and what was paid, so a
// claim that leant on --amount-tolerance says so where it is read. An exact
// match adds nothing.
func rounded(c int64) string {
	switch {
	case c == 0:
		return ""
	case c > 0:
		return fmt.Sprintf(", %.2f more than the invoice", float64(c)/100)
	default:
		return fmt.Sprintf(", %.2f less than the invoice", float64(-c)/100)
	}
}

func supplierOr(inv Invoice) string {
	if inv.Supplier == "" {
		return "supplier not named"
	}
	return inv.Supplier
}

// apart says how the payment sits against the invoice's own date, which is the
// one part of a match that is worth eyeballing.
func apart(days int) string {
	switch {
	case days == 0:
		return "same day"
	case days == 1:
		return "paid 1 day later"
	case days > 1:
		return fmt.Sprintf("paid %d days later", days)
	case days == -1:
		return "paid 1 day earlier"
	default:
		return fmt.Sprintf("paid %d days earlier", -days)
	}
}
