package noola

import (
	"context"
	"fmt"
)

// SyncReport summarizes a Sync run. Everything that needs attention is in the Issue lists.
type SyncReport struct {
	Contacts  BulkTotals
	Companies BulkTotals
	// ContactIssues are rows that were not saved: "conflict" (email held by another person — see
	// Conflict) or "invalid" (see Error).
	ContactIssues []ContactRowResult
	// CompanyIssues are rows that were not saved ("invalid" / "error").
	CompanyIssues []CompanyRowResult
	// UnknownMembers maps a company external id to member ids that matched no person.
	UnknownMembers map[string][]string
}

// BulkTotals counts outcomes.
type BulkTotals struct {
	Created, Updated, Failed int
}

// OK reports whether every row was saved and every member resolved.
func (r *SyncReport) OK() bool {
	return len(r.ContactIssues) == 0 && len(r.CompanyIssues) == 0 && len(r.UnknownMembers) == 0
}

func (r *SyncReport) String() string {
	return fmt.Sprintf("contacts: %d created, %d updated, %d failed; companies: %d created, %d updated, %d failed; %d companies with unknown members",
		r.Contacts.Created, r.Contacts.Updated, r.Contacts.Failed,
		r.Companies.Created, r.Companies.Updated, r.Companies.Failed, len(r.UnknownMembers))
}

// Sync pushes a full snapshot: people first (so memberships resolve), then clients with their
// members and projects. It is idempotent — run it as often as you like (e.g. nightly, plus on
// change). Row-level problems don't stop the run; they're collected in the report. An error is
// returned only when a request itself fails (network, auth, rate limit after retries).
func (c *Client) Sync(ctx context.Context, contacts []ContactInput, companies []CompanyInput) (*SyncReport, error) {
	rep := &SyncReport{UnknownMembers: map[string][]string{}}
	if len(contacts) > 0 {
		res, err := c.BulkUpsertContacts(ctx, contacts)
		if err != nil {
			return rep, fmt.Errorf("sync contacts: %w", err)
		}
		rep.Contacts = BulkTotals{Created: res.Created, Updated: res.Updated, Failed: res.Conflicts + res.Invalid}
		for _, r := range res.Results {
			if r.Status != "created" && r.Status != "updated" {
				rep.ContactIssues = append(rep.ContactIssues, r)
			}
		}
	}
	if len(companies) > 0 {
		res, err := c.BulkUpsertCompanies(ctx, companies)
		if err != nil {
			return rep, fmt.Errorf("sync companies: %w", err)
		}
		rep.Companies = BulkTotals{Created: res.Created, Updated: res.Updated, Failed: res.Invalid + res.Errors}
		for _, r := range res.Results {
			if r.Status != "created" && r.Status != "updated" {
				rep.CompanyIssues = append(rep.CompanyIssues, r)
			}
			if len(r.UnknownMembers) > 0 {
				rep.UnknownMembers[companies[r.Index].ExternalID] = r.UnknownMembers
			}
		}
	}
	return rep, nil
}
