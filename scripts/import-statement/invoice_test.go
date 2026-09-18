package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"
)

// These stand the API up locally rather than calling it: what is worth pinning
// down is the request this program builds and what it makes of the reply, and
// both are exercised without a key, a network or a cent of spend.

// stubAPI serves one canned Messages response and captures the request body.
func stubAPI(t *testing.T, response string) (*anthropic.Client, *map[string]any) {
	t.Helper()
	captured := map[string]any{}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&captured); err != nil {
			t.Errorf("could not read the request body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(response))
	}))
	t.Cleanup(srv.Close)

	client := anthropic.NewClient(option.WithBaseURL(srv.URL), option.WithAPIKey("test"))
	return &client, &captured
}

func writeFile(t *testing.T, name string, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

const toolUseReply = `{
  "id": "msg_1", "type": "message", "role": "assistant", "model": "claude-opus-5",
  "stop_reason": "tool_use",
  "content": [{
    "type": "tool_use", "id": "toolu_1", "name": "record_invoice",
    "input": {
      "is_invoice": true,
      "total": 588.004,
      "currency": "zar",
      "invoice_date": "2026-09-02",
      "supplier": "  Orms Pty Ltd  ",
      "purpose": "A2 canvas prints × 3",
      "invoice_number": "INV-1041",
      "expense_type": "materials"
    }
  }],
  "usage": {"input_tokens": 1, "output_tokens": 1}
}`

func TestReadsWhatTheModelRecorded(t *testing.T) {
	client, _ := stubAPI(t, toolUseReply)

	got, err := readInvoice(context.Background(), client, defaultModel, writeFile(t, "orms.pdf", "%PDF-1.4"))
	if err != nil {
		t.Fatalf("readInvoice: %v", err)
	}

	if got.File != "orms.pdf" {
		t.Errorf("file = %q, want the invoice's own name", got.File)
	}
	// Money is carried to the cent: the total is matched against a payment
	// exactly, so a third decimal must not survive.
	if got.Total != 588.00 {
		t.Errorf("total = %v, want 588.00", got.Total)
	}
	if got.Currency != "ZAR" {
		t.Errorf("currency = %q, want it normalised to ZAR", got.Currency)
	}
	if got.Supplier != "Orms Pty Ltd" {
		t.Errorf("supplier = %q, want it trimmed", got.Supplier)
	}
	if got.Purpose != "A2 canvas prints × 3" || got.Number != "INV-1041" || got.Type != "materials" {
		t.Errorf("invoice does not carry what was recorded: %+v", got)
	}
	if problem := got.incomplete(); problem != "" {
		t.Errorf("expected the invoice to be claimable, got %q", problem)
	}
}

func TestSendsTheDocumentAndTheSchema(t *testing.T) {
	client, captured := stubAPI(t, toolUseReply)

	if _, err := readInvoice(context.Background(), client, "claude-test-model", writeFile(t, "orms.pdf", "%PDF-1.4")); err != nil {
		t.Fatalf("readInvoice: %v", err)
	}

	body, err := json.Marshal(*captured)
	if err != nil {
		t.Fatal(err)
	}
	sent := string(body)

	for _, want := range []string{
		`"model":"claude-test-model"`,
		`"name":"record_invoice"`,
		`"strict":true`,
		`"media_type":"application/pdf"`,
		// The base64 of "%PDF-1.4" — the file itself is what is sent, not text
		// pulled out of it, so a scanned invoice reads the same as a digital one.
		`"data":"JVBERi0xLjQ="`,
	} {
		if !strings.Contains(sent, want) {
			t.Errorf("request does not contain %s", want)
		}
	}

	// Every field the claim needs must be required, or the model may quietly
	// leave one out and the claim lose the thing it is defended with.
	for _, field := range []string{"total", "invoice_date", "supplier", "purpose", "is_invoice"} {
		if !strings.Contains(sent, `"`+field+`"`) {
			t.Errorf("schema does not mention %q", field)
		}
	}
}

func TestSendsAPhotographAsAnImage(t *testing.T) {
	client, captured := stubAPI(t, toolUseReply)

	if _, err := readInvoice(context.Background(), client, defaultModel, writeFile(t, "till-slip.jpg", "\xff\xd8\xff")); err != nil {
		t.Fatalf("readInvoice: %v", err)
	}

	body, _ := json.Marshal(*captured)
	if !strings.Contains(string(body), `"media_type":"image/jpeg"`) {
		t.Errorf("a photographed till slip was not sent as an image: %s", body)
	}
}

func TestAnAnswerWithoutFieldsIsAnError(t *testing.T) {
	// The tool is offered, not forced, so a document the model cannot read comes
	// back as prose. That has to surface as the reason, not as an empty invoice.
	client, _ := stubAPI(t, `{
	  "id": "msg_1", "type": "message", "role": "assistant", "model": "claude-opus-5",
	  "stop_reason": "end_turn",
	  "content": [{"type": "text", "text": "This page is blank."}],
	  "usage": {"input_tokens": 1, "output_tokens": 1}
	}`)

	_, err := readInvoice(context.Background(), client, defaultModel, writeFile(t, "blank.pdf", "%PDF-1.4"))
	if err == nil {
		t.Fatal("expected an error when nothing was recorded")
	}
	if !strings.Contains(err.Error(), "This page is blank.") {
		t.Errorf("error does not say why: %v", err)
	}
}

func TestAFileTheModelSaysIsNotAnInvoiceIsSkipped(t *testing.T) {
	// The statement itself often sits in the same folder.
	client, _ := stubAPI(t, `{
	  "id": "msg_1", "type": "message", "role": "assistant", "model": "claude-opus-5",
	  "stop_reason": "tool_use",
	  "content": [{"type": "tool_use", "id": "toolu_1", "name": "record_invoice", "input": {
	    "is_invoice": false, "total": null, "currency": null, "invoice_date": null,
	    "supplier": null, "purpose": null, "invoice_number": null, "expense_type": null
	  }}],
	  "usage": {"input_tokens": 1, "output_tokens": 1}
	}`)

	got, err := readInvoice(context.Background(), client, defaultModel, writeFile(t, "statement.pdf", "%PDF-1.4"))
	if err != nil {
		t.Fatalf("readInvoice: %v", err)
	}
	if got.IsInvoice {
		t.Error("a file the model rejected was taken for an invoice")
	}
}

func TestAnEmptyFileIsNotSent(t *testing.T) {
	client, captured := stubAPI(t, toolUseReply)

	if _, err := readInvoice(context.Background(), client, defaultModel, writeFile(t, "empty.pdf", "")); err == nil {
		t.Fatal("expected an empty file to be refused")
	}
	if len(*captured) != 0 {
		t.Error("an empty file was sent to the API anyway")
	}
}

func TestOnlyDocumentsAreRead(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"b.pdf", "a.pdf", "slip.JPG", "notes.txt", "thumbs.db"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
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
