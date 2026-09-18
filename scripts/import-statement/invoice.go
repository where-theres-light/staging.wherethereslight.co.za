package main

// Invoice reading.
//
// A statement row says money left the account; it never says what for. That is
// what an invoice carries, and it is the thing a deduction cannot be defended
// without (see `purpose` in db/004_monthly_aggregations.sql).
//
// Invoices are read by CLAUDE rather than parsed, which is the opposite choice
// to the statement next door. The statement is one bank's fixed layout, so its
// columns can be read by position and checked against the balance chain. An
// invoice is whatever the supplier's software prints — a table, a letterhead, a
// photo of a till slip — and there is no second source to check it against, so
// there is nothing for a parser to lock onto. The model reads each file and
// fills in one strict schema.
//
// What comes back is therefore UNVERIFIED in a way the statement never is. The
// safeguard is the match in match.go: an invoice is only ever believed as far
// as a real payment of the same amount, so a misread total matches nothing and
// is reported rather than imported.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/anthropics/anthropic-sdk-go"
)

// The model that reads the invoices. Overridable with --model.
const defaultModel = "claude-opus-5"

// Files bigger than this are skipped rather than sent. The API caps a request at
// 32 MB and base64 adds a third, so this leaves ample room; anything larger is a
// scan that wants downsampling, not an invoice.
const maxInvoiceBytes = 12 << 20

// Invoice is one supplier document, as the model read it.
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

// The extraction schema. Strict, so the model's arguments are guaranteed to
// validate against it — every field required, nullable where a document may
// genuinely not carry it.
var invoiceTool = anthropic.ToolParam{
	Name: "record_invoice",
	Description: anthropic.String(
		"Record the details of one supplier invoice, receipt or till slip. " +
			"Call this exactly once for the document provided."),
	Strict: anthropic.Bool(true),
	InputSchema: anthropic.ToolInputSchemaParam{
		Properties: map[string]any{
			"is_invoice": map[string]any{
				"type": "boolean",
				"description": "True if this document is an invoice, receipt, till slip or bill. " +
					"False for anything else (a bank statement, a delivery note, a letter).",
			},
			"total": map[string]any{
				"type": []string{"number", "null"},
				"description": "The total amount payable, including VAT — the number the customer " +
					"actually pays. Positive. Null if the document carries no total.",
			},
			"currency": map[string]any{
				"type":        []string{"string", "null"},
				"description": "The currency of the total, as a three-letter ISO code (ZAR, USD, EUR).",
			},
			"invoice_date": map[string]any{
				"type": []string{"string", "null"},
				"description": "The date the invoice was issued, as YYYY-MM-DD. Not the due date " +
					"and not the payment date. South African documents write dates day-first.",
			},
			"supplier": map[string]any{
				"type":        []string{"string", "null"},
				"description": "The business that issued the invoice — who is being paid, not the customer.",
			},
			"purpose": map[string]any{
				"type": []string{"string", "null"},
				"description": "What was bought, in a short phrase built from the line items — " +
					"e.g. 'A2 canvas prints × 3' or 'picture framing, 4 frames'. This is the " +
					"record of what the money was for, so name the goods or service; do not " +
					"repeat the supplier's name and do not describe the document.",
			},
			"invoice_number": map[string]any{
				"type":        []string{"string", "null"},
				"description": "The supplier's own invoice or receipt number, if printed.",
			},
			"expense_type": map[string]any{
				"type": []string{"string", "null"},
				"description": "A short category for grouping at tax time: materials, packaging, " +
					"postage, printing, framing, studio rent, equipment, software, bank charges, travel.",
			},
		},
		Required: []string{
			"is_invoice", "total", "currency", "invoice_date",
			"supplier", "purpose", "invoice_number", "expense_type",
		},
		ExtraFields: map[string]any{"additionalProperties": false},
	},
}

const invoiceSystemPrompt = `You read supplier invoices for a small South African art business and record what each one says, by calling the record_invoice tool exactly once.

Record only what the document actually shows. Never infer, round or complete a value that is not printed — a null is always better than a guess, because every field here ends up in a tax record. In particular, the total is the amount payable including VAT: where a document shows a subtotal, VAT and a total, take the total; where it shows amounts both due and already paid, take the amount of the document itself.`

// The tool's arguments, as the model fills them in. Pointers for the nullable
// fields, so "absent" and "empty" stay distinguishable.
type invoiceArgs struct {
	IsInvoice     bool     `json:"is_invoice"`
	Total         *float64 `json:"total"`
	Currency      *string  `json:"currency"`
	InvoiceDate   *string  `json:"invoice_date"`
	Supplier      *string  `json:"supplier"`
	Purpose       *string  `json:"purpose"`
	InvoiceNumber *string  `json:"invoice_number"`
	ExpenseType   *string  `json:"expense_type"`
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return strings.TrimSpace(*s)
}

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
		if e.IsDir() {
			continue
		}
		if mediaType(e.Name()) == "" {
			continue
		}
		files = append(files, filepath.Join(dir, e.Name()))
	}
	sort.Strings(files)
	return files, nil
}

// mediaType maps a filename to what the API should be told it is, or "" for a
// file type that is not a document at all.
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

// readInvoices reads every invoice in dir. A file the model cannot make sense of
// is reported as a warning and left out — one unreadable scan must not stop the
// statement it arrived with from importing.
func readInvoices(ctx context.Context, dir, model string) ([]Invoice, []string, error) {
	files, err := invoiceFiles(dir)
	if err != nil {
		return nil, nil, err
	}
	if len(files) == 0 {
		return nil, nil, fmt.Errorf("no invoices found in %s", dir)
	}

	// NewClient reads ANTHROPIC_API_KEY. Ask for it up front rather than after
	// the first file has already been read off disk.
	if os.Getenv("ANTHROPIC_API_KEY") == "" {
		return nil, nil, fmt.Errorf("ANTHROPIC_API_KEY is not set — it is what reads the invoices in %s", dir)
	}
	client := anthropic.NewClient()

	var (
		invoices []Invoice
		warnings []string
	)
	for _, path := range files {
		name := filepath.Base(path)
		inv, err := readInvoice(ctx, &client, model, path)
		if err != nil {
			warnings = append(warnings, fmt.Sprintf("%s: %v", name, err))
			continue
		}
		if !inv.IsInvoice {
			warnings = append(warnings, fmt.Sprintf("%s: not an invoice — skipped", name))
			continue
		}
		if problem := inv.incomplete(); problem != "" {
			warnings = append(warnings, fmt.Sprintf("%s: %s — skipped", name, problem))
			continue
		}
		invoices = append(invoices, inv)
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
	case i.Currency != "" && !strings.EqualFold(i.Currency, "ZAR"):
		return fmt.Sprintf("total is in %s, not rands", i.Currency)
	case !isoDateRe.MatchString(i.Date):
		return fmt.Sprintf("unreadable invoice date %q", i.Date)
	}
	return ""
}

// readInvoice sends one document to the model and returns what it recorded.
func readInvoice(ctx context.Context, client *anthropic.Client, model, path string) (Invoice, error) {
	media := mediaType(path)
	if media == "" {
		return Invoice{}, fmt.Errorf("unsupported file type")
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return Invoice{}, err
	}
	if len(data) == 0 {
		return Invoice{}, fmt.Errorf("the file is empty")
	}
	if len(data) > maxInvoiceBytes {
		return Invoice{}, fmt.Errorf("the file is %d MB — too large to send", len(data)>>20)
	}
	encoded := base64.StdEncoding.EncodeToString(data)

	var document anthropic.ContentBlockParamUnion
	if media == "application/pdf" {
		document = anthropic.NewDocumentBlock(anthropic.Base64PDFSourceParam{Data: encoded})
	} else {
		document = anthropic.NewImageBlockBase64(media, encoded)
	}

	resp, err := client.Messages.New(ctx, anthropic.MessageNewParams{
		Model:     anthropic.Model(model),
		MaxTokens: 4096,
		System:    []anthropic.TextBlockParam{{Text: invoiceSystemPrompt}},
		Tools:     []anthropic.ToolUnionParam{{OfTool: &invoiceTool}},
		Messages: []anthropic.MessageParam{
			anthropic.NewUserMessage(
				document,
				anthropic.NewTextBlock("Record this document with the record_invoice tool."),
			),
		},
	})
	if err != nil {
		return Invoice{}, err
	}
	if resp.StopReason == anthropic.StopReasonRefusal {
		return Invoice{}, fmt.Errorf("the model declined to read the document (%s)", resp.StopDetails.Category)
	}

	// The tool is offered rather than forced, so a document the model cannot
	// read comes back as plain text instead of a call. Say so with whatever it
	// said, which is usually the reason.
	for _, block := range resp.Content {
		if use, ok := block.AsAny().(anthropic.ToolUseBlock); ok && use.Name == invoiceTool.Name {
			var args invoiceArgs
			if err := json.Unmarshal([]byte(use.JSON.Input.Raw()), &args); err != nil {
				return Invoice{}, fmt.Errorf("could not read the extracted fields: %w", err)
			}
			inv := Invoice{
				File:      filepath.Base(path),
				IsInvoice: args.IsInvoice,
				Currency:  strings.ToUpper(deref(args.Currency)),
				Date:      deref(args.InvoiceDate),
				Supplier:  deref(args.Supplier),
				Purpose:   deref(args.Purpose),
				Number:    deref(args.InvoiceNumber),
				Type:      deref(args.ExpenseType),
			}
			if args.Total != nil {
				// Negative would be a credit note, which is not a claim.
				inv.Total = round2(*args.Total)
			}
			return inv, nil
		}
	}
	return Invoice{}, fmt.Errorf("the model did not record any fields: %s", firstText(resp))
}

// firstText is the model's own words, for an error message.
func firstText(resp *anthropic.Message) string {
	for _, block := range resp.Content {
		if text, ok := block.AsAny().(anthropic.TextBlock); ok {
			if s := squash(text.Text); s != "" {
				return s
			}
		}
	}
	return "no explanation given"
}
