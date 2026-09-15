// import-statement parses a Capitec statement PDF and imports its transactions.
//
//	go run ./scripts/import-statement statement.pdf --dry-run
//	go run ./scripts/import-statement statement.pdf
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

	var inserted, skipped int
	for start := 0; start < len(txs); start += batchSize {
		end := min(start+batchSize, len(txs))
		res, err := postBatch(baseURL, token, sourceName, txs[start:end])
		if err != nil {
			return err
		}
		inserted += res.Inserted
		skipped += res.Skipped
	}

	fmt.Printf("\nImported into %s\n", baseURL)
	fmt.Printf("  inserted %d\n", inserted)
	fmt.Printf("  skipped  %d (already on record)\n", skipped)
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
	SourceStatement string        `json:"source_statement"`
	Transactions    []Transaction `json:"transactions"`
}

type importResponse struct {
	OK       bool   `json:"ok"`
	Received int    `json:"received"`
	Inserted int    `json:"inserted"`
	Skipped  int    `json:"skipped"`
	Error    string `json:"error"`
}

func postBatch(baseURL, token, source string, txs []Transaction) (*importResponse, error) {
	body, err := json.Marshal(importRequest{SourceStatement: source, Transactions: txs})
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
