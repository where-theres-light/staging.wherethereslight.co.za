package main

// Marking personal transactions.
//
// A business expense is claimed one document at a time, because each one has to
// be substantiated. Personal spending is the opposite shape: there is nothing to
// substantiate and far more of it, and what identifies it is the statement's own
// description — Pick n Pay is Pick n Pay every month. So it is marked by RULE,
// and the rules are a file the owner keeps.
//
// This is not the same claim as a business one and must not read like it. A rule
// asserts only "this was not the business's", which needs no proof and offers
// none: the row it writes carries no supplier, no invoice, no purpose. What it
// does carry is `source: rule`, so a row decided by a pattern is never mistaken
// for one a person decided.
//
// Marking personal is worth doing for one reason: an unclassified transaction
// means EITHER personal OR not looked at yet, and only saying which turns "I
// imported September" into "I have been through September".

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// A rule recognises personal transactions by what the statement says about them.
// Both tests are optional and both apply when both are given, but a rule with
// neither would match the whole statement, which is refused below.
type rule struct {
	// Case-insensitive substring of the description: "pick n pay".
	Match string `json:"match"`
	// The bank's own category for the row, matched whole: "Groceries". Capitec
	// categorises most card purchases, which makes this the broader lever.
	Category string `json:"category"`
	// What to record on the rows it marks. Optional.
	Note string `json:"note"`
}

type rulesFile struct {
	Rules []rule `json:"rules"`
}

func (r rule) String() string {
	switch {
	case r.Match != "" && r.Category != "":
		return fmt.Sprintf("%q in %s", r.Match, r.Category)
	case r.Category != "":
		return r.Category
	default:
		return fmt.Sprintf("%q", r.Match)
	}
}

// matches reports whether this rule recognises a transaction.
func (r rule) matches(tx Transaction) bool {
	if r.Match != "" && !strings.Contains(strings.ToLower(tx.Description), strings.ToLower(r.Match)) {
		return false
	}
	if r.Category != "" && !strings.EqualFold(strings.TrimSpace(tx.Category), r.Category) {
		return false
	}
	return true
}

// Personal is one transaction a rule recognised.
type Personal struct {
	Transaction Transaction
	Rule        rule
}

func loadRules(path string) ([]rule, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	var file rulesFile
	decoder := json.NewDecoder(strings.NewReader(string(body)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&file); err != nil {
		return nil, fmt.Errorf("%s: %w", filepath.Base(path), err)
	}
	if len(file.Rules) == 0 {
		return nil, fmt.Errorf("%s carries no rules", filepath.Base(path))
	}
	for i, r := range file.Rules {
		// A rule with nothing to match on would mark the entire statement
		// personal, including the payments just claimed as business.
		if strings.TrimSpace(r.Match) == "" && strings.TrimSpace(r.Category) == "" {
			return nil, fmt.Errorf("%s: rule %d matches on nothing", filepath.Base(path), i)
		}
	}
	return file.Rules, nil
}

// markPersonal applies the rules to a statement's transactions.
//
// Anything this run is claiming as a business expense is left alone: an invoice
// matched to a payment is evidence, a pattern in a description is a habit, and
// where they disagree the evidence wins without argument.
//
// It returns what was marked, a line per rule that recognised nothing (a rule
// for a shop you no longer use is worth knowing about), and how much of the
// statement neither half accounted for — which is the number that says how much
// of the month is left to go through.
func markPersonal(rules []rule, txs []Transaction, claims []Claim) (marked []Personal, unused []string, untouched int) {
	claimed := map[string]bool{}
	for _, c := range claims {
		claimed[claimKey(c.Transaction)] = true
	}

	used := make([]bool, len(rules))
	for _, tx := range txs {
		if claimed[claimKey(tx)] {
			continue
		}
		hit := -1
		for i, r := range rules {
			if r.matches(tx) {
				hit = i
				break // first rule wins, so the file reads top to bottom
			}
		}
		if hit < 0 {
			untouched++
			continue
		}
		used[hit] = true
		marked = append(marked, Personal{Transaction: tx, Rule: rules[hit]})
	}

	for i, r := range rules {
		if !used[i] {
			unused = append(unused, r.String())
		}
	}
	sort.Strings(unused)
	return marked, unused, untouched
}

// claimKey identifies a transaction within one run, by the same fields the
// ledger keys it on.
func claimKey(tx Transaction) string {
	return strings.Join([]string{
		tx.TransactionDate, tx.Description,
		fmt.Sprintf("%.2f", tx.Amount), tx.RawReference,
	}, "\x00")
}

func (p Personal) payload() classificationPayload {
	return classificationPayload{
		Transaction: txRef{
			TransactionDate: p.Transaction.TransactionDate,
			Description:     p.Transaction.Description,
			Amount:          p.Transaction.Amount,
			RawReference:    p.Transaction.RawReference,
		},
		Kind: "personal",
		// Never "by hand": a pattern decided this, and the row says so, so that
		// a later rule change can be told from a decision someone made.
		Source: "rule",
		Note:   p.Rule.Note,
	}
}
